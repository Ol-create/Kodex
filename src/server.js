import { env } from "./config/env.js";
import prisma from "./config/prisma.js";
import { createApp } from "./app.js";
import { createEmbedder } from "./lib/embeddings/index.js";
import { createLlm } from "./lib/llm/index.js";
import { logger } from "./lib/logger.js";
import { createQueryLogRepo } from "./modules/ask/queryLog.repo.js";
import { scheduleRetention } from "./jobs/retention.js";

const embedder = createEmbedder(env);
const llm = createLlm(env);
const app = createApp({ db: prisma, embedder, llm, trustProxy: env.TRUST_PROXY });

const server = app.listen(env.PORT, () => {
  logger.info(`Kodex listening on port ${env.PORT}`, {
    env: env.NODE_ENV,
    embeddings: `${embedder.provider}/${embedder.model}`,
    dimensions: embedder.dimensions,
    llm: `${llm.provider}/${llm.model}`,
    effort: env.LLM_EFFORT,
  });
});

const stopRetention = scheduleRetention({ queryLog: createQueryLogRepo(prisma), days: env.QUERY_LOG_RETENTION_DAYS });

// Stop taking new requests, let in-flight ones (including streams) finish,
// then exit. If they don't finish in time, exit anyway so a deploy never hangs.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);
  stopRetention();

  const force = setTimeout(() => {
    logger.warn("Shutdown timed out, exiting with requests still open");
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  force.unref();

  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Log, don't swallow: an unexpected rejection is a bug worth seeing.
process.on("unhandledRejection", (err) => logger.error("Unhandled promise rejection", { err }));
