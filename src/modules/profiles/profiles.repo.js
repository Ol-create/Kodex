import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

const INSERT_BATCH_SIZE = 100;

const toVectorLiteral = (vector) => `[${vector.join(",")}]`;

// Profile persistence. Every method takes tenantId and scopes by it.
export function createProfileRepo(db) {
  return {
    // externalId -> contentHash for the profiles that already exist.
    async findHashes(tenantId, kind, externalIds) {
      const rows = await db.profile.findMany({
        where: { tenantId, kind, externalId: { in: externalIds } },
        select: { externalId: true, contentHash: true },
      });
      return new Map(rows.map((r) => [r.externalId, r.contentHash]));
    },

    // Rows with `embedding` are inserted or fully replaced; rows without one
    // (unchanged text) only get their attributes refreshed.
    async upsertProfiles(tenantId, kind, rows) {
      const embedded = rows.filter((r) => r.embedding);
      const unchanged = rows.filter((r) => !r.embedding);

      await db.$transaction(
        async (tx) => {
          // Prisma can't write vector columns, so profiles go in with raw SQL.
          const values = embedded.map(
            (r) => Prisma.sql`(
              ${randomUUID()}, ${tenantId}, ${kind}, ${r.externalId}, ${r.text},
              ${JSON.stringify(r.attributes)}::jsonb, ${r.contentHash}, ${toVectorLiteral(r.embedding)}::vector, now()
            )`,
          );
          for (let i = 0; i < values.length; i += INSERT_BATCH_SIZE) {
            await tx.$executeRaw`
              INSERT INTO "Profile"
                ("id", "tenantId", "kind", "externalId", "text", "attributes", "contentHash", "embedding", "updatedAt")
              VALUES ${Prisma.join(values.slice(i, i + INSERT_BATCH_SIZE))}
              ON CONFLICT ("tenantId", "kind", "externalId") DO UPDATE SET
                "text" = EXCLUDED."text",
                "attributes" = EXCLUDED."attributes",
                "contentHash" = EXCLUDED."contentHash",
                "embedding" = EXCLUDED."embedding",
                "updatedAt" = now()`;
          }
          for (const r of unchanged) {
            await tx.profile.update({
              where: { tenantId_kind_externalId: { tenantId, kind, externalId: r.externalId } },
              data: { attributes: r.attributes },
            });
          }
        },
        { timeout: 30_000 },
      );
    },

    // Deletes profiles of `kind` that were not part of the latest full sync.
    async deleteMissing(tenantId, kind, keepExternalIds) {
      const { count } = await db.profile.deleteMany({
        where: { tenantId, kind, externalId: { notIn: keepExternalIds } },
      });
      return count;
    },

    async deleteProfile(tenantId, kind, externalId) {
      const { count } = await db.profile.deleteMany({ where: { tenantId, kind, externalId } });
      return count;
    },

    // Exact cosine ranking (see the migration for why there's no ANN index).
    match(tenantId, kind, vector, { externalIds, limit }) {
      const idFilter = externalIds ? Prisma.sql`AND p."externalId" = ANY(${externalIds}::text[])` : Prisma.empty;
      return db.$queryRaw`
        SELECT p."externalId", p."attributes", 1 - (p."embedding" <=> ${toVectorLiteral(vector)}::vector) AS "similarity"
        FROM "Profile" p
        WHERE p."tenantId" = ${tenantId}
          AND p."kind" = ${kind}
          AND p."embedding" IS NOT NULL
          ${idFilter}
        ORDER BY p."embedding" <=> ${toVectorLiteral(vector)}::vector
        LIMIT ${limit}`;
    },
  };
}
