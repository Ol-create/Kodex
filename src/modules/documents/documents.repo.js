import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

const INSERT_BATCH_SIZE = 100;

const toVectorLiteral = (vector) => `[${vector.join(",")}]`;

// All document/chunk persistence. Every method takes tenantId and scopes by it.
export function createDocumentRepo(db) {
  return {
    findDocument(tenantId, externalId) {
      return db.document.findUnique({
        where: { tenantId_externalId: { tenantId, externalId } },
        select: { id: true, contentHash: true, _count: { select: { chunks: true } } },
      });
    },

    // For unchanged content: refresh title/audience/metadata without re-embedding.
    async updateDocumentMetadata(tenantId, documentId, data) {
      await db.$transaction([
        db.document.update({ where: { id: documentId, tenantId }, data }),
        db.chunk.updateMany({ where: { documentId, tenantId }, data: { audience: data.audience } }),
      ]);
    },

    // Upserts the document and replaces all of its chunks atomically, so
    // readers never see a half-ingested document.
    saveDocumentWithChunks(tenantId, data, chunks, embeddings) {
      return db.$transaction(
        async (tx) => {
          const document = await tx.document.upsert({
            where: { tenantId_externalId: { tenantId, externalId: data.externalId } },
            create: { tenantId, ...data },
            update: data,
            select: { id: true },
          });

          await tx.chunk.deleteMany({ where: { documentId: document.id, tenantId } });

          // Prisma can't write vector columns, so chunks go in with raw SQL.
          const rows = chunks.map(
            (chunk, i) => Prisma.sql`(
              ${randomUUID()}, ${tenantId}, ${document.id}, ${chunk.index}, ${chunk.content},
              ${chunk.tokenCount}, ${data.audience}::text[], ${JSON.stringify({ section: chunk.section })}::jsonb,
              ${toVectorLiteral(embeddings[i])}::vector
            )`,
          );
          for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
            await tx.$executeRaw`
              INSERT INTO "Chunk"
                ("id", "tenantId", "documentId", "index", "content", "tokenCount", "audience", "metadata", "embedding")
              VALUES ${Prisma.join(rows.slice(i, i + INSERT_BATCH_SIZE))}`;
          }

          return document.id;
        },
        { timeout: 30_000 },
      );
    },

    async listDocuments(tenantId, { limit, cursor, source, entityType }) {
      const documents = await db.document.findMany({
        where: { tenantId, ...(source && { source }), ...(entityType && { entityType }) },
        orderBy: { id: "asc" },
        take: limit + 1,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
        select: {
          id: true,
          externalId: true,
          title: true,
          source: true,
          audience: true,
          entityType: true,
          entityId: true,
          metadata: true,
          updatedAt: true,
          _count: { select: { chunks: true } },
        },
      });

      const hasMore = documents.length > limit;
      const page = documents.slice(0, limit).map(({ _count, ...doc }) => ({ ...doc, chunkCount: _count.chunks }));
      return { documents: page, nextCursor: hasMore ? page.at(-1).id : null };
    },

    // Returns the number of documents deleted (chunks cascade).
    async deleteDocuments(tenantId, where) {
      const { count } = await db.document.deleteMany({ where: { tenantId, ...where } });
      return count;
    },

    // Deletes documents from `source` that were not part of the latest sync.
    async deleteMissing(tenantId, source, keepExternalIds) {
      const { count } = await db.document.deleteMany({
        where: { tenantId, source, externalId: { notIn: keepExternalIds } },
      });
      return count;
    },
  };
}
