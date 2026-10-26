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
| 2 | Ingestion (load → chunk → embed → store) | ⏳ |
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

Errors are always `{ "error": { "code", "message" } }`.

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
