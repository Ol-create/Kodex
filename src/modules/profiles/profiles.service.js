import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../utils/AppError.js";

const round = (n) => Math.round(n * 1000) / 1000;

export const kindSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,39}$/, "kind must be lowercase letters, digits, - or _ (e.g. \"artisan\")");

export const syncSchema = z.object({
  profiles: z
    .array(
      z.object({
        externalId: z.string().trim().min(1).max(200),
        text: z.string().trim().min(1).max(20_000),
        attributes: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .max(1000),
  // true: this is the full list, so profiles of this kind not in it are deleted.
  replace: z.boolean().default(false),
});

export const matchSchema = z.object({
  kind: kindSchema,
  query: z.string().trim().min(1).max(5000),
  // Only rank these profiles (e.g. the artisans who are eligible right now).
  externalIds: z.array(z.string().min(1)).max(5000).optional(),
  topK: z.number().int().min(1).max(100).default(10),
});

export function createProfileService({ repo, embedder }) {
  // The model is part of the hash so switching models re-embeds everything.
  const hashOf = (text) => createHash("sha256").update(`${embedder.model}\n${text}`).digest("hex");

  return {
    async sync(tenant, kind, { profiles, replace }) {
      const ids = profiles.map((p) => p.externalId);
      if (new Set(ids).size !== ids.length) {
        const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
        throw new AppError(400, `Duplicate externalId(s): ${dupes.slice(0, 5).join(", ")}`, "duplicate_external_id");
      }

      const existing = await repo.findHashes(tenant.id, kind, ids);
      const rows = profiles.map((p) => ({ ...p, contentHash: hashOf(p.text) }));
      const changed = rows.filter((r) => existing.get(r.externalId) !== r.contentHash);

      // One embedding call for everything that changed.
      const vectors = await embedder.embedDocuments(changed.map((r) => r.text));
      changed.forEach((r, i) => (r.embedding = vectors[i]));

      if (rows.length) await repo.upsertProfiles(tenant.id, kind, rows);
      const deleted = replace ? await repo.deleteMissing(tenant.id, kind, ids) : 0;

      return {
        created: changed.filter((r) => !existing.has(r.externalId)).length,
        updated: changed.filter((r) => existing.has(r.externalId)).length,
        unchanged: rows.length - changed.length,
        deleted,
      };
    },

    async match(tenant, { kind, query, externalIds, topK }) {
      if (externalIds?.length === 0) return [];
      const vector = await embedder.embedQuery(query);
      const rows = await repo.match(tenant.id, kind, vector, { externalIds, limit: topK });
      return rows.map((r) => ({ externalId: r.externalId, similarity: round(Number(r.similarity)), attributes: r.attributes }));
    },

    deleteProfile: (tenant, kind, externalId) => repo.deleteProfile(tenant.id, kind, externalId),
  };
}
