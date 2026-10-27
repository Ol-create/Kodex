import express from "express";
import helmet from "helmet";
import { apiKeyAuth } from "./middleware/apiKeyAuth.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { createDocumentRepo } from "./modules/documents/documents.repo.js";
import { documentRoutes } from "./modules/documents/documents.routes.js";
import { createIngestService } from "./modules/documents/ingest.service.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { tenantRoutes } from "./modules/tenant/tenant.routes.js";

// Built as a factory so tests can pass fakes for `db`, `embedder` and the repo.
// No CORS: browsers never call this service directly. Client apps (e.g.
// leddar-server) proxy requests and authenticate with a tenant API key.
export function createApp({ db, embedder, documentRepo = createDocumentRepo(db), logRequests = true }) {
  const app = express();
  const ingestService = createIngestService({ repo: documentRepo, embedder });

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "5mb" }));
  if (logRequests) app.use(requestLogger);

  app.use("/health", healthRoutes({ db }));

  // Everything under /v1 requires a tenant API key.
  app.use("/v1", apiKeyAuth({ db }));
  app.use("/v1/tenant", tenantRoutes());
  app.use("/v1", documentRoutes({ ingestService, repo: documentRepo }));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
