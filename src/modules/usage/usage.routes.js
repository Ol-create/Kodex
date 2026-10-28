import { Router } from "express";
import { z } from "zod";

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const STATUSES = ["answered", "no_context", "no_answer", "refused", "error"];

// Mounted under /v1, after apiKeyAuth, so req.tenant is always set.
export function usageRoutes({ queryLog, now = () => new Date() }) {
  const router = Router();

  // GET /v1/usage?days=30 — what the tenant's users asked and what it cost.
  router.get("/usage", async (req, res) => {
    const { days } = querySchema.parse(req.query);
    const to = now();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    const { byStatus, totals, latency, gaps } = await queryLog.usage(req.tenant.id, from);

    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const row of byStatus) counts[row.status] = row._count._all;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    res.json({
      from,
      to,
      questions: { total, ...counts },
      // Share of questions answered from the docs.
      answerRate: total ? Math.round((counts.answered / total) * 1000) / 1000 : null,
      tokens: { input: totals._sum.inputTokens ?? 0, output: totals._sum.outputTokens ?? 0 },
      latencyMs: {
        avg: latency?.avg == null ? null : Math.round(latency.avg),
        p95: latency?.p95 == null ? null : Math.round(latency.p95),
      },
      // Most frequent questions the docs couldn't answer: what to write next.
      gaps,
    });
  });

  return router;
}
