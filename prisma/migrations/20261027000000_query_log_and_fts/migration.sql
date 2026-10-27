-- CreateTable
CREATE TABLE "QueryLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "question" TEXT NOT NULL,
    "audiences" TEXT[],
    "status" TEXT NOT NULL,
    "answer" TEXT,
    "confidence" DOUBLE PRECISION,
    "chunkIds" TEXT[],
    "citedChunkIds" TEXT[],
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QueryLog_tenantId_createdAt_idx" ON "QueryLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "QueryLog_tenantId_status_idx" ON "QueryLog"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "QueryLog" ADD CONSTRAINT "QueryLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Full-text index for the keyword half of hybrid search. The expression must
-- match the one in src/modules/ask/retriever.js exactly for Postgres to use it.
-- Maintained by hand (Prisma can't express expression indexes); if a future
-- `prisma migrate dev` tries to DROP it, delete that line.
CREATE INDEX "Chunk_content_fts_idx" ON "Chunk" USING GIN (to_tsvector('english', "content"));
