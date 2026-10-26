import express from "express";
import helmet from "helmet";
import { apiKeyAuth } from "./middleware/apiKeyAuth.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { tenantRoutes } from "./modules/tenant/tenant.routes.js";

// Built as a factory so tests can pass a fake `db` instead of Prisma.
// No CORS: browsers never call this service directly. Client apps (e.g.
// leddar-server) proxy requests and authenticate with a tenant API key.
export function createApp({ db, logRequests = true }) {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "2mb" }));
  if (logRequests) app.use(requestLogger);

  app.use("/health", healthRoutes({ db }));

  // Everything under /v1 requires a tenant API key.
  app.use("/v1", apiKeyAuth({ db }));
  app.use("/v1/tenant", tenantRoutes());

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
