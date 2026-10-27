import "dotenv/config";
import { z } from "zod";

// `KEY=` in .env yields "", which should mean "not set".
const optionalString = z
  .string()
  .optional()
  .transform((v) => v?.trim() || undefined);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Must match the vector(N) column in prisma/schema.prisma.
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),
  EMBEDDING_PROVIDER: z.enum(["voyage", "ollama"]).default("voyage"),
  // Defaults per provider: voyage-3.5 / mxbai-embed-large.
  EMBEDDING_MODEL: optionalString,
  // Checked when embedding, not at boot, so /health works without it.
  VOYAGE_API_KEY: optionalString,
  OLLAMA_BASE_URL: z.url().default("http://localhost:11434"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
