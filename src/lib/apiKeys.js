import crypto from "node:crypto";

const KEY_PREFIX = "kdx_";
const DISPLAY_PREFIX_LENGTH = 12;

// Keys are 192 bits of randomness, so a fast SHA-256 hash is enough;
// a slow password hash (bcrypt) would only add latency to every request.
export function hashApiKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function generateApiKey() {
  const key = KEY_PREFIX + crypto.randomBytes(24).toString("base64url");
  return {
    key,
    prefix: key.slice(0, DISPLAY_PREFIX_LENGTH),
    keyHash: hashApiKey(key),
  };
}

// Accepts `Authorization: Bearer <key>` or `X-API-Key: <key>`.
export function extractApiKey(req) {
  const auth = req.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }
  return req.get("x-api-key")?.trim() || null;
}

// Creates a key for a tenant. The raw key is returned once and never stored.
export async function createApiKey(db, { tenantId, name }) {
  const { key, prefix, keyHash } = generateApiKey();
  const record = await db.apiKey.create({
    data: { tenantId, name, prefix, keyHash },
  });
  return { key, record };
}
