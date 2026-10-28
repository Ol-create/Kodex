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
  LLM_PROVIDER: z.enum(["openai", "anthropic"]).default("openai"),
  // Defaults per provider: gpt-5.4-mini / claude-opus-5-5.
  LLM_MODEL: optionalString,
  // Reasoning depth vs latency/cost (ignored by non-reasoning OpenAI models).
  LLM_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  // Checked when answering, not at boot, so /health works without them.
  OPENAI_API_KEY: optionalString,
  // Optional: the Anthropic SDK also reads ANTHROPIC_AUTH_TOKEN or an
  // `ant auth login` profile when this is unset.
  ANTHROPIC_API_KEY: optionalString,

  // "json" (one object per line, for log collectors) or "text". Default: json in production.
  LOG_FORMAT: z.enum(["json", "text"]).optional(),
  // Proxy hops in front of the app (Elastic Beanstalk: nginx = 1). 0 = none.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // QueryLog rows (which hold users' questions) older than this are deleted
  // daily. 0 keeps them forever.
  QUERY_LOG_RETENTION_DAYS: z.coerce.number().int().min(0).default(90),
  // How long in-flight requests get to finish on shutdown before exiting.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
}).superRefine((env, ctx) => {
  // Locally a missing key only fails the request that needs it (so /health
  // works); a production server should refuse to start half-configured.
  if (env.NODE_ENV !== "production") return;
  const missing = (key) => ctx.addIssue({ code: "custom", path: [key], message: `${key} is required in production` });
  if (env.EMBEDDING_PROVIDER === "voyage" && !env.VOYAGE_API_KEY) missing("VOYAGE_API_KEY");
  if (env.LLM_PROVIDER === "openai" && !env.OPENAI_API_KEY) missing("OPENAI_API_KEY");
  if (env.LLM_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) missing("ANTHROPIC_API_KEY");
});

export const parseEnv = (raw) => envSchema.safeParse(raw);

const parsed = parseEnv(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
