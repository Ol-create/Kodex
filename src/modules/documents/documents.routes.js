import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../utils/AppError.js";
import { ingestRequestSchema } from "./ingest.service.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  source: z.string().optional(),
  entityType: z.string().optional(),
});

const deleteQuerySchema = z.object({
  externalId: z.string().min(1, "externalId query parameter is required"),
});

// Mounted under /v1, after apiKeyAuth, so req.tenant is always set.
export function documentRoutes({ ingestService, repo }) {
  const router = Router();

  // Create or update documents. Unchanged content is not re-embedded.
  router.post("/ingest", async (req, res) => {
    const { documents } = ingestRequestSchema.parse(req.body);
    const results = await ingestService.ingest(req.tenant, documents);
    res.json({ results });
  });

  router.get("/documents", async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    res.json(await repo.listDocuments(req.tenant.id, query));
  });

  // DELETE /v1/documents?externalId=artisan:123 — the id callers know.
  router.delete("/documents", async (req, res) => {
    const { externalId } = deleteQuerySchema.parse(req.query);
    const count = await repo.deleteDocuments(req.tenant.id, { externalId });
    if (count === 0) throw new AppError(404, "Document not found", "document_not_found");
    res.status(204).end();
  });

  router.delete("/documents/:id", async (req, res) => {
    const count = await repo.deleteDocuments(req.tenant.id, { id: req.params.id });
    if (count === 0) throw new AppError(404, "Document not found", "document_not_found");
    res.status(204).end();
  });

  return router;
}
