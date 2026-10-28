import { Prisma } from "@prisma/client";
import { logger } from "../../lib/logger.js";

export function createQueryLogRepo(db) {
  return {
    // Logging must never fail or slow down an answer, so errors are swallowed.
    record(entry) {
      db.queryLog.create({ data: entry }).catch((err) => logger.error("Failed to write query log", { err: err.message }));
    },

    // Usage since `since`: counts per status, tokens, latency and the most
    // frequent unanswered questions (the gaps in the tenant's docs).
    async usage(tenantId, since) {
      const where = { tenantId, createdAt: { gte: since } };
      const [byStatus, totals, [latency], gaps] = await Promise.all([
        db.queryLog.groupBy({ by: ["status"], where, _count: { _all: true } }),
        db.queryLog.aggregate({ where, _sum: { inputTokens: true, outputTokens: true } }),
        db.$queryRaw`
          SELECT avg("latencyMs")::float AS "avg",
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs")::float AS "p95"
          FROM "QueryLog" WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${since}`,
        db.$queryRaw`
          SELECT lower(trim("question")) AS "question", count(*)::int AS "count", max("createdAt") AS "lastAsked"
          FROM "QueryLog"
          WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${since}
            AND "status" IN (${Prisma.join(["no_context", "no_answer"])})
          GROUP BY 1 ORDER BY 2 DESC, 3 DESC LIMIT 20`,
      ]);
      return { byStatus, totals, latency, gaps };
    },

    // Retention: questions can contain personal data, so old rows are removed.
    async deleteOlderThan(cutoff) {
      const { count } = await db.queryLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
      return count;
    },
  };
}
