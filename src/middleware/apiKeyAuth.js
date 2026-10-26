import { extractApiKey, hashApiKey } from "../lib/apiKeys.js";
import { tenantConfigSchema } from "../lib/tenantConfig.js";
import { AppError } from "../utils/AppError.js";

// Avoid a write on every request; lastUsedAt only needs minute precision.
const LAST_USED_THROTTLE_MS = 60_000;

// Resolves the calling tenant from its API key and attaches it as req.tenant.
// Everything mounted after this middleware must scope its queries to req.tenant.id.
export function apiKeyAuth({ db }) {
  return async (req, res, next) => {
    const key = extractApiKey(req);
    if (!key) {
      throw new AppError(401, "API key required", "missing_api_key");
    }

    const record = await db.apiKey.findUnique({
      where: { keyHash: hashApiKey(key) },
      include: { tenant: true },
    });

    if (!record || record.revokedAt) {
      throw new AppError(401, "Invalid API key", "invalid_api_key");
    }
    if (!record.tenant.isActive) {
      throw new AppError(403, "Tenant is inactive", "tenant_inactive");
    }

    const config = tenantConfigSchema.safeParse(record.tenant.config ?? {});
    if (!config.success) {
      console.error(`Tenant ${record.tenant.slug} has invalid config`, config.error.issues);
      throw new AppError(500, "Tenant is misconfigured", "tenant_misconfigured");
    }

    req.tenant = {
      id: record.tenant.id,
      slug: record.tenant.slug,
      name: record.tenant.name,
      config: config.data,
    };
    req.apiKey = { id: record.id, prefix: record.prefix };

    const lastUsed = record.lastUsedAt?.getTime() ?? 0;
    if (Date.now() - lastUsed > LAST_USED_THROTTLE_MS) {
      db.apiKey
        .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
        .catch((err) => console.error("Failed to update apiKey.lastUsedAt", err.message));
    }

    next();
  };
}
