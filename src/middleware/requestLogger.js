import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger.js";

// Accept a caller's request id (e.g. leddar-server's) so one id follows a
// request across services; otherwise make one. Must look like an id, not prose.
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,100}$/;

// Gives every request an id (req.id, X-Request-Id response header) and logs
// one line per request: method, path, status, duration and tenant.
export function requestId(req, res, next) {
  const incoming = req.get("X-Request-Id");
  req.id = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.set("X-Request-Id", req.id);
  next();
}

export function requestLogger(log = logger) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      log.info(`${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode} ${ms.toFixed(1)}ms`, {
        requestId: req.id,
        tenant: req.tenant?.slug,
        status: res.statusCode,
        durationMs: Math.round(ms),
      });
    });
    next();
  };
}
