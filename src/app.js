import express from "express";
import helmet from "helmet";
import { apiKeyAuth } from "./middleware/apiKeyAuth.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { requestId, requestLogger } from "./middleware/requestLogger.js";
import { tenantRateLimit } from "./middleware/tenantRateLimit.js";
import { askRoutes } from "./modules/ask/ask.routes.js";
import { createAskService } from "./modules/ask/ask.service.js";
import { createQueryLogRepo } from "./modules/ask/queryLog.repo.js";
import { createRetriever } from "./modules/ask/retriever.js";
import { createDocumentRepo } from "./modules/documents/documents.repo.js";
import { documentRoutes } from "./modules/documents/documents.routes.js";
import { createIngestService } from "./modules/documents/ingest.service.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { createProfileRepo } from "./modules/profiles/profiles.repo.js";
import { profileRoutes } from "./modules/profiles/profiles.routes.js";
import { createProfileService } from "./modules/profiles/profiles.service.js";
import { tenantRoutes } from "./modules/tenant/tenant.routes.js";
import { usageRoutes } from "./modules/usage/usage.routes.js";

// Built as a factory so tests can pass fakes for the database, embedder, LLM
// and repositories.
// No CORS: browsers never call this service directly. Client apps (e.g.
// leddar-server) proxy requests and authenticate with a tenant API key.
export function createApp({
  db,
  embedder,
  llm,
  documentRepo = createDocumentRepo(db),
  retriever = createRetriever({ db, embedder }),
  queryLog = createQueryLogRepo(db),
  profileRepo = createProfileRepo(db),
  logRequests = true,
  trustProxy = 0,
}) {
  const app = express();
  const ingestService = createIngestService({ repo: documentRepo, embedder });
  const askService = createAskService({ retriever, llm, queryLog });
  const profileService = createProfileService({ repo: profileRepo, embedder });

  app.disable("x-powered-by");
  // Behind a load balancer/proxy (e.g. Elastic Beanstalk's nginx), trust its
  // X-Forwarded-* headers so req.ip is the real caller.
  if (trustProxy) app.set("trust proxy", trustProxy);
  app.use(requestId);
  app.use(helmet());
  app.use(express.json({ limit: "5mb" }));
  if (logRequests) app.use(requestLogger());

  app.use("/health", healthRoutes({ db }));

  // Everything under /v1 requires a tenant API key.
  app.use("/v1", apiKeyAuth({ db }));
  app.use("/v1", tenantRateLimit());
  app.use("/v1/tenant", tenantRoutes());
  app.use("/v1", documentRoutes({ ingestService, repo: documentRepo }));
  app.use("/v1", askRoutes({ askService }));
  app.use("/v1", profileRoutes({ profileService }));
  app.use("/v1", usageRoutes({ queryLog }));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
