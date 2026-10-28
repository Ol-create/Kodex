import { AppError } from "../utils/AppError.js";

const WINDOW_MS = 60_000;

// Fixed one-minute window per tenant, using tenant.config.limits.requestsPerMinute.
// In memory, so each instance counts on its own: with N instances a tenant can
// make up to N × the limit. Mount after apiKeyAuth.
export function tenantRateLimit({ now = Date.now } = {}) {
  const windows = new Map();

  return (req, res, next) => {
    const limit = req.tenant.config.limits.requestsPerMinute;
    if (!limit) return next();

    const t = now();
    let w = windows.get(req.tenant.id);
    if (!w || t - w.start >= WINDOW_MS) {
      w = { start: t, count: 0 };
      windows.set(req.tenant.id, w);
    }
    w.count += 1;

    res.set("RateLimit-Limit", String(limit));
    res.set("RateLimit-Remaining", String(Math.max(0, limit - w.count)));
    if (w.count > limit) {
      res.set("Retry-After", String(Math.ceil((w.start + WINDOW_MS - t) / 1000)));
      throw new AppError(429, `Rate limit of ${limit} requests per minute exceeded`, "rate_limited");
    }
    next();
  };
}
