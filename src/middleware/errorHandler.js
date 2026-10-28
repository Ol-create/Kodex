import { ZodError, z } from "zod";
import { logger } from "../lib/logger.js";
import { AppError } from "../utils/AppError.js";

export function notFound(req, res) {
  res.status(404).json({ error: { code: "not_found", message: `Route ${req.method} ${req.path} not found` } });
}

// Express 5 forwards rejected promises here, so handlers can simply throw.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: { code: "validation_error", message: "Invalid request", details: z.flattenError(err).fieldErrors },
    });
  }

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "invalid_json", message: "Request body is not valid JSON" } });
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: { code: "payload_too_large", message: "Request body is too large" } });
  }

  logger.error("Unhandled error", { requestId: req.id, method: req.method, path: req.path, err });
  // The request id lets support find this error in the logs.
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong", requestId: req.id } });
}
