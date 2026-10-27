import { Prisma } from "@prisma/client";

// Reciprocal Rank Fusion constant. 60 is the value from the original RRF
// paper and works well without tuning.
const RRF_K = 60;

// HNSW explores this many candidates per query (pgvector default: 40). Higher
// recovers results that tenant/audience filters remove after the index scan.
const HNSW_EF_SEARCH = 100;

const toVectorLiteral = (vector) => `[${vector.join(",")}]`;

// Hybrid retrieval: semantic search (pgvector cosine) finds paraphrases,
// keyword search (Postgres full-text) finds exact terms such as "KYC" or
// "QTE-1234". The two ranked lists are merged with Reciprocal Rank Fusion.
export function createRetriever({ db, embedder }) {
  // Chunks with no audience are public; otherwise they must share one with the caller.
  const audienceFilter = (audiences) =>
    Prisma.sql`(cardinality(c."audience") = 0 OR c."audience" && ${audiences}::text[])`;

  function semanticSearch(tenantId, vector, audiences, limit) {
    return db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${HNSW_EF_SEARCH}`);
      return tx.$queryRaw`
        SELECT c."id"
        FROM "Chunk" c
        WHERE c."tenantId" = ${tenantId}
          AND c."embedding" IS NOT NULL
          AND ${audienceFilter(audiences)}
        ORDER BY c."embedding" <=> ${vector}::vector
        LIMIT ${limit}`;
    });
  }

  // The to_tsvector expression must match "Chunk_content_fts_idx".
  function keywordSearch(tenantId, query, audiences, limit) {
    return db.$queryRaw`
      SELECT c."id"
      FROM "Chunk" c, websearch_to_tsquery('english', ${query}) q
      WHERE c."tenantId" = ${tenantId}
        AND ${audienceFilter(audiences)}
        AND to_tsvector('english', c."content") @@ q
      ORDER BY ts_rank_cd(to_tsvector('english', c."content"), q) DESC
      LIMIT ${limit}`;
  }

  function loadChunks(tenantId, ids, vector) {
    return db.$queryRaw`
      SELECT c."id" AS "chunkId", c."documentId", c."content", c."metadata"->>'section' AS "section",
             d."externalId", d."title", d."source",
             1 - (c."embedding" <=> ${vector}::vector) AS "similarity"
      FROM "Chunk" c
      JOIN "Document" d ON d."id" = c."documentId"
      WHERE c."tenantId" = ${tenantId} AND c."id" = ANY(${ids}::text[])`;
  }

  return {
    // Returns up to topK chunks, best first, each with:
    //   similarity  cosine similarity to the query (0-1), used for confidence
    //   score       fused RRF score, used for ranking
    //   matchedBy   ["semantic"], ["keyword"] or both
    async search(tenant, { query, audiences, topK }) {
      const vector = toVectorLiteral(await embedder.embedQuery(query));
      const candidates = Math.max(topK * 4, 20);

      const [semantic, keyword] = await Promise.all([
        semanticSearch(tenant.id, vector, audiences, candidates),
        keywordSearch(tenant.id, query, audiences, candidates),
      ]);

      const fused = fuseRankings({ semantic: semantic.map((r) => r.id), keyword: keyword.map((r) => r.id) }).slice(0, topK);
      if (fused.length === 0) return [];

      const rows = await loadChunks(tenant.id, fused.map((f) => f.id), vector);
      const byId = new Map(rows.map((row) => [row.chunkId, row]));

      return fused
        .filter((f) => byId.has(f.id))
        .map((f) => {
          const row = byId.get(f.id);
          return { ...row, similarity: Number(row.similarity), score: f.score, matchedBy: f.matchedBy };
        });
    },
  };
}

// Merges ranked id lists: each list contributes 1 / (RRF_K + rank) per id.
export function fuseRankings(lists) {
  const scores = new Map();
  for (const [name, ids] of Object.entries(lists)) {
    ids.forEach((id, index) => {
      const entry = scores.get(id) ?? { id, score: 0, matchedBy: [] };
      entry.score += 1 / (RRF_K + index + 1);
      entry.matchedBy.push(name);
      scores.set(id, entry);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score);
}
