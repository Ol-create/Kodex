import { env } from "./config/env.js";
import prisma from "./config/prisma.js";
import { createApp } from "./app.js";
import { createEmbedder } from "./lib/embeddings/index.js";

const embedder = createEmbedder(env);
const app = createApp({ db: prisma, embedder });

const server = app.listen(env.PORT, () => {
  console.log(`Kodex listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  console.log(`Embeddings: ${embedder.provider}/${embedder.model} (${embedder.dimensions} dims)`);
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
