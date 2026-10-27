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
| 3 | Retrieval and `POST /v1/ask` | ⏳ |

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
