import { createHash } from "node:crypto";
import { z } from "zod";
import { CHUNKER_VERSION, chunkText } from "../../lib/chunker.js";
import { AppError } from "../../utils/AppError.js";

export const ingestDocumentSchema = z.object({
  // Stable id from the caller: file path, URL, "artisan:<uuid>"...
  externalId: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500).optional(),
  content: z.string().trim().min(1, "content is empty").max(1_000_000),
  format: z.enum(["markdown", "text"]).default("markdown"),
  source: z.string().trim().min(1).max(100).default("api"),
  audience: z.array(z.string().trim().min(1)).default([]),
  entityType: z.string().trim().min(1).max(100).optional(),
  entityId: z.string().trim().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const ingestRequestSchema = z.object({
  documents: z.array(ingestDocumentSchema).min(1).max(100),
});

export function createIngestService({ repo, embedder, chunkOptions = {} }) {
  // Anything that changes the stored chunks or vectors must be in the hash;
  // otherwise an edit would be skipped as "unchanged".
  function contentHash(doc) {
    const fingerprint = JSON.stringify([
      CHUNKER_VERSION,
      chunkOptions,
      embedder.provider,
      embedder.model,
      embedder.dimensions,
      doc.format,
      doc.title ?? null,
      doc.content,
    ]);
    return createHash("sha256").update(fingerprint).digest("hex");
  }

  function assertAudiences(tenant, documents) {
    const allowed = tenant.config.audiences;
    if (allowed.length === 0) return;
    for (const doc of documents) {
      const unknown = doc.audience.filter((a) => !allowed.includes(a));
      if (unknown.length) {
        throw new AppError(
          400,
          `Document "${doc.externalId}" has unknown audience(s) ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}`,
          "invalid_audience",
        );
      }
    }
  }

  async function ingestOne(tenant, doc) {
    const hash = contentHash(doc);
    const fields = {
      externalId: doc.externalId,
      source: doc.source,
      title: doc.title ?? null,
      audience: doc.audience,
      entityType: doc.entityType ?? null,
      entityId: doc.entityId ?? null,
      metadata: doc.metadata,
    };

    const existing = await repo.findDocument(tenant.id, doc.externalId);
    if (existing?.contentHash === hash) {
      await repo.updateDocumentMetadata(tenant.id, existing.id, fields);
      return { externalId: doc.externalId, documentId: existing.id, status: "unchanged", chunks: existing._count.chunks };
    }

    const chunks = chunkText(doc.content, { ...chunkOptions, format: doc.format, title: doc.title });
    if (chunks.length === 0) {
      throw new AppError(400, `Document "${doc.externalId}" has no text to index`, "empty_document");
    }

    // Embed before opening the DB transaction: provider calls are slow.
    const embeddings = await embedder.embedDocuments(chunks.map((c) => c.content));
    const documentId = await repo.saveDocumentWithChunks(tenant.id, { ...fields, contentHash: hash }, chunks, embeddings);

    return {
      externalId: doc.externalId,
      documentId,
      status: existing ? "updated" : "created",
      chunks: chunks.length,
    };
  }

  return {
    // Validates every document up front, then ingests them one at a time
    // (embedding providers rate-limit, so parallelism buys little).
    async ingest(tenant, documents) {
      const parsed = documents.map((d) => ingestDocumentSchema.parse(d));
      assertAudiences(tenant, parsed);

      const results = [];
      for (const doc of parsed) {
        results.push(await ingestOne(tenant, doc));
      }
      return results;
    },
  };
}
