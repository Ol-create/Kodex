# Kodex

Kodex is a standalone, multi-tenant retrieval-augmented generation (RAG) service built on
Express 5, Prisma 7 and Postgres with pgvector. Client apps (Leddar is tenant #1)
call it server-to-server with a tenant API key.

```
leddar-server ──(X-API-Key)──▶ Kodex ──▶ Postgres + pgvector
```

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Project setup, Postgres + pgvector | ✅ |
| 1 | Tenants, API keys, schema, health checks | ✅ |
| 2 | Ingestion (load → chunk → embed → store) | ✅ |
| 3 | Hybrid retrieval, `POST /v1/ask` (JSON + SSE), query logs | ✅ |
| 4 | Leddar FAQ knowledge base, eval set, `minScore` tuning | ✅ |
| 5 | Plug into Leddar (proxy route, feature flag, chat widget) | ✅ |
| 6 | Artisan matching (`/v1/profiles`, `/v1/match`) | ✅ |
| 7 | Production readiness | ⏳ |

## Local setup (Windows + WSL)

Postgres with pgvector runs in a dedicated WSL cluster on port **5433**, separate
from any Postgres already on 5432.

```bash
npm install
npm run db:setup:wsl     # once: installs pgvector, creates cluster "rag" on :5433
cp .env.example .env
npm run db:migrate
npm run db:seed          # creates tenant "leddar" and prints its first API key
```

WSL stops Ubuntu when nothing is attached, which stops Postgres. Keep it up while
developing by running this in a separate terminal:

```bash
npm run db:up
```

Then start the service:

```bash
npm run dev
```

## API

All `/v1/*` routes need a tenant API key, sent as `Authorization: Bearer <key>`
or `X-API-Key: <key>`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | – | Liveness |
| GET | `/health/ready` | – | Database and pgvector check |
| GET | `/v1/tenant` | key | The tenant the key belongs to, with its resolved config |
| POST | `/v1/ingest` | key | Create or update up to 100 documents |
| GET | `/v1/documents` | key | List documents (`limit`, `cursor`, `source`, `entityType`) |
| DELETE | `/v1/documents?externalId=…` | key | Delete by the caller’s id |
| DELETE | `/v1/documents/:id` | key | Delete by Kodex id |
| POST | `/v1/search` | key | Retrieval only: ranked chunks with scores, no LLM call |
| POST | `/v1/ask` | key | Grounded answer with cited sources (`stream: true` for SSE) |

Errors are always `{ "error": { "code", "message" } }`.

## Ingestion

```
content ─▶ split by markdown headings ─▶ pack paragraphs (~500 tokens, 60 overlap)
        ─▶ prefix "Title > Section" ─▶ embed (Voyage / Ollama) ─▶ Chunk rows + vector(1024)
```

`POST /v1/ingest`:

```json
{
  "documents": [{
    "externalId": "docs:payouts.md",
    "title": "Payouts",
    "content": "# Payouts

Artisans are paid ...",
    "format": "markdown",
    "source": "docs",
    "audience": ["artisan"],
    "metadata": {}
  }]
}
```

- **Idempotent:** `externalId` is the key. Re-sending a document updates it in place.
- **Cheap re-syncs:** a content hash (content, title, chunker version and embedding
  model) skips re-embedding unchanged documents. Audience, title and metadata
  changes still apply. Results report `created`, `updated` or `unchanged`.
- **Atomic:** a document and its chunks are replaced in one transaction.
- **Audiences** must be in the tenant’s `config.audiences` (when it defines any).

Bulk-load local files (.md, .markdown, .txt, .pdf) with the CLI:

```bash
npm run ingest -- ./docs/leddar --tenant leddar --source leddar-docs --audience brand,artisan
```

Markdown frontmatter (`audience: [artisan]`, `title: …`) overrides the flags per
file. `--prune` deletes documents of that `--source` that are no longer on disk, so
use a distinct source name per corpus.

### Leddar knowledge base

`docs/leddar/` holds hand-written FAQs, one `##` question per chunk, with the audience in
frontmatter (`audience: [brand]`; `audience: []` means public):

| File | Audience |
|---|---|
| `general-faq.md` | everyone |
| `brand-faq.md` | brand |
| `artisan-faq.md` | artisan |
| `admin-faq.md` | admin |

```bash
npm run ingest -- docs/leddar --source faq --prune
```

The Leddar repo's own docs (frontend READMEs, the flow guide, the API and database-schema
PDFs) were ingested alongside them, each with its own `--source` and `--audience`.
Write FAQ answers in users' words, and keep facts consistent across files: the model will
point out contradictions rather than pick one.

### Embedding providers

| `EMBEDDING_PROVIDER` | Default model | Needs |
|---|---|---|
| `voyage` (default) | `voyage-3.5` | `VOYAGE_API_KEY` |
| `ollama` | `mxbai-embed-large` | `ollama pull mxbai-embed-large` |

Both return 1024-dim vectors. Requests are batched and retried on 429/5xx (honouring
`Retry-After`). Voyage’s free tier is heavily rate-limited until a payment method
is added, so large first ingests may pause on retries. Switching model re-embeds
documents on their next ingest.

## Asking questions

```
question ─▶ embed ─┬▶ pgvector cosine (HNSW) ─┐
                   └▶ Postgres full-text ─────┴▶ Reciprocal Rank Fusion ─▶ top K chunks
         ─▶ confidence < minScore? ─yes─▶ tenant fallbackAnswer (no LLM call)
                                    no ─▶ LLM with numbered <sources>    ─▶ answer + [n] citations
                                                                     └─ NO_ANSWER ─▶ fallbackAnswer
```

`POST /v1/ask`:

```json
{
  "question": "When do artisans get paid?",
  "audience": "artisan",
  "userId": "artisan-123",
  "history": [{ "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }],
  "stream": false
}
```

Response:

```json
{
  "status": "answered",
  "answer": "Artisans are paid within 3 working days of delivery [1].",
  "confidence": 0.71,
  "sources": [
    { "id": 1, "title": "Payouts", "section": "Payouts > Timing", "externalId": "leddar-docs:payouts.md",
      "similarity": 0.71, "matchedBy": ["semantic", "keyword"], "snippet": "…", "cited": true }
  ],
  "model": "claude-opus-5-5",
  "usage": { "inputTokens": 1830, "outputTokens": 64 }
}
```

- **`status`** is one of:
  - `answered`
  - `no_context`: nothing relevant enough, so the tenant’s `fallbackAnswer` is returned without calling the LLM
  - `no_answer`: the sources looked relevant but didn’t answer the question; the model replied
    `NO_ANSWER` (never streamed to the client) and the `fallbackAnswer` is returned
  - `refused`: the model declined

  Only `answered` cites sources. `no_context` and `no_answer` rows in `QueryLog` are the
  questions your docs don’t cover yet.
- **Audiences:** chunks with no audience are public. Otherwise a chunk is returned
  only if it shares an audience with the request (`"brand"` or `["admin", "brand"]`).
  Without an audience, only public chunks are searched.
- **Follow-up questions:** retrieval uses the latest question. If it scores
  below `minScore` and there is history (“do I pay extra for those?”), Kodex
  searches again with the previous user question prepended and keeps the stronger
  result. That costs a second embedding only for weak mid-conversation questions.
- **Hybrid search** catches both paraphrases (semantic) and exact terms such as
  “KYC” or a reference number (keyword).
- **Prompt-injection hygiene:** sources go to the model as data, and the system
  prompt tells it to ignore instructions inside them.
- **Streaming** (`"stream": true`) returns Server-Sent Events: `sources`, then
  `delta` events, then `done` with the full response body (its `answer` is
  authoritative, e.g. after a refusal), or `error`.
- **Query logs:** every call writes a `QueryLog` row (question, status, retrieved
  and cited chunks, tokens, latency) for finding gaps and building evaluation sets.
  Questions may contain personal data, so treat the table accordingly.

### LLM

`LLM_PROVIDER` picks the model that writes answers; both use the official SDK and
return the same shape, so the rest of the service doesn't care which one runs.

| Provider | Key | Default `LLM_MODEL` | Notes |
|---|---|---|---|
| `openai` (default) | `OPENAI_API_KEY` | `gpt-5.4-mini` | Responses API with `store: false`, so documents aren't kept by OpenAI |
| `anthropic` | `ANTHROPIC_API_KEY` or `ant auth login` | `claude-opus-5-5` | Opts into Anthropic's server-side refusal fallback (`fallbacks: "default"`); remove `betas`/`fallbacks` in `src/lib/llm/anthropic.js` to opt out |

`LLM_EFFORT` (default `medium`) sets reasoning depth; try `low` for faster, cheaper
answers. Non-reasoning OpenAI models (e.g. `gpt-4.1-mini`) ignore it.

### Tuning

`Tenant.config.retrieval.topK` (default 5) and `minScore` (default 0.3; Leddar uses 0.4)
control how much context is sent and when to skip the LLM. The right `minScore` depends
on the embedding model, so measure it:

```bash
npm run eval                                  # retrieval only: one embedding request, no LLM cost
npm run eval -- --answers                     # also generates and grades every answer
npm run eval -- --answers --min-score 0.42    # try a threshold without changing the tenant
```

An eval set is JSON Lines (`eval/leddar.jsonl`); each case has a `question`, `audience`,
`expect` (`answer` or `no_answer`) and optionally the `sources` (externalIds) that should be
retrieved and `mustMention` / `mustNotMention` regexes. The script reports hit@K and MRR,
the confidence ranges of answerable vs unanswerable questions, a suggested `minScore`
(the middle of the best-separating range), and with `--answers` a pass/fail per case.
Results are saved to `eval/results/` (gitignored). Eval runs don’t write to `QueryLog`.

The gate is a cheap first filter, not the only one: off-topic questions ("who won the
World Cup?") score low and never reach the LLM, while on-topic gaps ("do you ship to the
UK?") score like real questions and are caught by the model’s `NO_ANSWER`.

**Leddar baseline** (voyage-3.5 + gpt-5.4-mini, 32 cases, minScore 0.4): retrieval hit@5
100%, MRR 1.0; answerable 0.428–0.739 vs unanswerable 0.303–0.483; answers 32/32 passed.

Known limitation: the HNSW index is shared by all tenants and filters apply after
the index scan. Fine at this scale; for very large multi-tenant corpora use
per-tenant partial indexes or pgvector ≥ 0.8 iterative scans.

## Matching

Clients keep **profiles** in Kodex (for Leddar, one per artisan) and rank them
against a free-text request. No LLM call is involved.

- `PUT /v1/profiles/:kind`: `{ profiles: [{ externalId, text, attributes? }], replace? }`
  creates or updates up to 1000 profiles of one kind (e.g. `artisan`). Only new or
  changed text is embedded, in one request; `replace: true` deletes profiles of that
  kind missing from the list. Returns `{ created, updated, unchanged, deleted }`.
- `DELETE /v1/profiles/:kind/:externalId` removes one.
- `POST /v1/match`: `{ kind, query, externalIds?, topK? }` returns
  `{ results: [{ externalId, similarity, attributes }] }`, best first. Pass
  `externalIds` to rank only those profiles (e.g. the artisans eligible right now).

Ranking is an exact cosine scan with no approximate index: tenants have at most
thousands of profiles, and an index would drop results filtered by `externalIds`.

## Leddar integration

Browsers never call Kodex directly. The Leddar API proxies questions, so the
Kodex key stays on its server and the audience comes from the user's JWT role:

```
widget (brand / artisan / admin app)
  └▶ POST /api/v1/help/ask   (Leddar API, signed-in user)
       role BRAND → ["brand"], ARTISAN → ["artisan"], ADMIN → ["admin", "brand", "artisan"]
       └▶ POST /v1/ask   (Kodex, Bearer KODEX_API_KEY, userId = Leddar user id)
```

- **Leddar server** (`server/src/modules/help/`): `GET /api/v1/help/status` and
  `POST /api/v1/help/ask` (`{ question, history? }` → `{ success, data: { status, answer, sources } }`).
  It sends the last 6 history turns, returns only cited sources (title and section),
  turns Kodex errors into plain messages, and limits each user to 20 questions per
  10 minutes.
- **Feature flag:** set `KODEX_ENABLED=true`, `KODEX_URL` and `KODEX_API_KEY` in the
  Leddar server `.env` (see `server/Env.additions`). When it is off, `/help/ask`
  returns 404 and the widget hides itself, so the frontends need no redeploy to
  turn it on or off.
- **Widget** (`components/help/HelpWidget.jsx` in each frontend; one copy per app,
  kept identical apart from the API client import): a floating Help button on every
  signed-in page, with suggested questions per role, citations and the sources list.
  The conversation is kept in `sessionStorage`, so it survives page changes.

- **Artisan suggestions** (`server/src/modules/matching/`):
  `GET /api/v1/admin/orders/:orderId/suggested-artisans` ranks the eligible artisans
  (active, available, KYC-verified) for an order, scored out of 100 with reasons and warnings:

  | Signal | Points | From |
  |---|---|---|
  | Specialty fits the product type | 35 | Leddar |
  | Track record (finished vs declined/expired) | 20 | Leddar |
  | Weekly capacity vs quantity and timeline (production) | 15 | Leddar |
  | Current workload | 10 | Leddar |
  | Produces for men / women / both | 10 | Leddar |
  | Past work and bio similar to the order | 10 | Kodex `/v1/match` |

  The artisan who made the approved sample always leads for production orders, and
  declining or letting this order expire before costs 30 points. Artisan profiles
  sent to Kodex hold skills and past work only (no names, contacts or addresses).
  If Kodex is off or takes over 10 seconds, ranking continues without similarity.
  The admin **Job Assignment** modal shows the top three, and sorts the full list by score.

## Multi-tenancy

- Every `Document` and `Chunk` row has a `tenantId`, and every query must filter by it.
- API keys are stored only as SHA-256 hashes. The raw key is shown once.
- Per-tenant behaviour (system prompt, audiences, `topK`, `minScore`) lives in
  `Tenant.config` and is validated by `src/lib/tenantConfig.js`.

```bash
npm run apikey:create -- leddar "leddar-server production"
```

## Notes

- `Chunk.embedding` is `vector(1024)`. Changing `EMBEDDING_DIMENSIONS` needs a migration.
- The HNSW index is written by hand in the init migration because Prisma can't
  express it. If `prisma migrate dev` later generates a `DROP INDEX
  "Chunk_embedding_hnsw_idx"`, delete that line.

## Tests

```bash
npm test
```
