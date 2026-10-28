import { z } from "zod";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant. Answer only from the provided context. " +
  "If the context does not contain the answer, say you don't know. " +
  "Cite the sources you used as [1], [2], etc.";

const DEFAULT_FALLBACK_ANSWER =
  "I couldn't find that in our documentation. Please contact support for help.";

// Shape of Tenant.config. Every field has a default, so `{}` is a valid config.
export const tenantConfigSchema = z.object({
  systemPrompt: z.string().min(1).default(DEFAULT_SYSTEM_PROMPT),
  fallbackAnswer: z.string().min(1).default(DEFAULT_FALLBACK_ANSWER),
  // Allowed audience labels (e.g. brand, artisan, admin). Empty = no restriction.
  audiences: z.array(z.string().min(1)).default([]),
  retrieval: z
    .object({
      topK: z.number().int().min(1).max(50).default(5),
      // Minimum cosine similarity (0-1) for the best chunk; below it we answer
      // with fallbackAnswer instead of guessing.
      minScore: z.number().min(0).max(1).default(0.3),
    })
    .prefault({}),
  limits: z
    .object({
      // Requests per minute across all of the tenant's API keys, per Kodex
      // instance. Caps the bill if a key leaks or a client loops. 0 = no limit.
      requestsPerMinute: z.number().int().min(0).default(120),
    })
    .prefault({}),
});

export function parseTenantConfig(raw) {
  return tenantConfigSchema.parse(raw ?? {});
}
