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
| 4 | Leddar knowledge base and evaluation | ⏳ |

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
                                    no ─▶ Claude with numbered <sources> ─▶ answer + [n] citations
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

- **`status`** is `answered`, `no_context` (nothing relevant enough, so the tenant’s
  `fallbackAnswer` is returned without calling the LLM) or `refused`.
- **Audiences:** chunks with no audience are public. Otherwise a chunk is returned
  only if it shares an audience with the request (`"brand"` or `["admin", "brand"]`).
  Without an audience, only public chunks are searched.
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

Generation uses Claude via the official SDK: `LLM_MODEL` (default `claude-opus-5-5`)
and `LLM_EFFORT` (default `medium`; try `low` for faster, cheaper answers).
Credentials come from `ANTHROPIC_API_KEY` or an `ant auth login` profile.
Requests opt into Anthropic’s server-side refusal fallback (`fallbacks: "default"`),
so a false-positive safety refusal is retried on a fallback model instead of failing.
To opt out, remove `betas` and `fallbacks` in `src/lib/llm.js`.

### Tuning

`Tenant.config.retrieval.topK` (default 5) and `minScore` (default 0.3) control how
much context is sent and when to fall back. The right `minScore` depends on the
embedding model, so tune it with Phase 4’s evaluation set.

Known limitation: the HNSW index is shared by all tenants and filters apply after
the index scan. Fine at this scale; for very large multi-tenant corpora use
per-tenant partial indexes or pgvector ≥ 0.8 iterative scans.

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
