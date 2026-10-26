import request from "supertest";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/lib/apiKeys.js";

const VALID_KEY = "kdx_valid_key";

const tenant = {
  id: "tenant-1",
  slug: "leddar",
  name: "Leddar",
  isActive: true,
  config: { audiences: ["brand", "artisan"] },
};

const keyRecord = (overrides = {}) => ({
  id: "key-1",
  prefix: "kdx_valid_ke",
  revokedAt: null,
  lastUsedAt: null,
  tenant,
  ...overrides,
});

function makeDb({ record = keyRecord(), queryRaw } = {}) {
  return {
    apiKey: {
      findUnique: jest.fn(async ({ where }) => (where.keyHash === hashApiKey(VALID_KEY) ? record : null)),
      update: jest.fn().mockResolvedValue({}),
    },
    $queryRaw: queryRaw ?? jest.fn().mockResolvedValue([{ extversion: "0.6.0" }]),
  };
}

const appWith = (db) => createApp({ db, logRequests: false });

describe("health", () => {
  it("GET /health is public", async () => {
    const res = await request(appWith(makeDb())).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /health/ready reports the pgvector version", async () => {
    const res = await request(appWith(makeDb())).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ database: "ok", pgvector: "0.6.0" });
  });

  it("GET /health/ready returns 503 when pgvector is missing", async () => {
    const db = makeDb({ queryRaw: jest.fn().mockResolvedValue([]) });
    const res = await request(appWith(db)).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.pgvector).toBe("missing");
  });

  it("GET /health/ready returns 503 when the database is down", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const db = makeDb({ queryRaw: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")) });
    const res = await request(appWith(db)).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.database).toBe("unreachable");
  });
});

describe("API key authentication", () => {
  it("rejects requests without a key", async () => {
    const res = await request(appWith(makeDb())).get("/v1/tenant");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("missing_api_key");
  });

  it("rejects unknown keys", async () => {
    const res = await request(appWith(makeDb())).get("/v1/tenant").set("Authorization", "Bearer kdx_wrong");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_api_key");
  });

  it("rejects revoked keys", async () => {
    const db = makeDb({ record: keyRecord({ revokedAt: new Date() }) });
    const res = await request(appWith(db)).get("/v1/tenant").set("X-API-Key", VALID_KEY);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_api_key");
  });

  it("rejects keys of inactive tenants", async () => {
    const db = makeDb({ record: keyRecord({ tenant: { ...tenant, isActive: false } }) });
    const res = await request(appWith(db)).get("/v1/tenant").set("X-API-Key", VALID_KEY);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("tenant_inactive");
  });

  it("returns 500 without leaking details when tenant config is invalid", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const db = makeDb({ record: keyRecord({ tenant: { ...tenant, config: { retrieval: { topK: -1 } } } }) });
    const res = await request(appWith(db)).get("/v1/tenant").set("X-API-Key", VALID_KEY);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("tenant_misconfigured");
  });

  it("resolves the tenant (with config defaults) for a valid key", async () => {
    const db = makeDb();
    const res = await request(appWith(db)).get("/v1/tenant").set("Authorization", `Bearer ${VALID_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "tenant-1", slug: "leddar" });
    expect(res.body.config.audiences).toEqual(["brand", "artisan"]);
    expect(res.body.config.retrieval.topK).toBe(5);
  });

  it("looks keys up by hash, never by raw value", async () => {
    const db = makeDb();
    await request(appWith(db)).get("/v1/tenant").set("X-API-Key", VALID_KEY);

    const { where } = db.apiKey.findUnique.mock.calls[0][0];
    expect(where).toEqual({ keyHash: hashApiKey(VALID_KEY) });
  });

  it("updates lastUsedAt at most once a minute", async () => {
    const fresh = makeDb({ record: keyRecord({ lastUsedAt: new Date() }) });
    await request(appWith(fresh)).get("/v1/tenant").set("X-API-Key", VALID_KEY);
    expect(fresh.apiKey.update).not.toHaveBeenCalled();

    const stale = makeDb({ record: keyRecord({ lastUsedAt: new Date(Date.now() - 120_000) }) });
    await request(appWith(stale)).get("/v1/tenant").set("X-API-Key", VALID_KEY);
    expect(stale.apiKey.update).toHaveBeenCalledWith({
      where: { id: "key-1" },
      data: { lastUsedAt: expect.any(Date) },
    });
  });
});

describe("errors", () => {
  it("returns JSON 404 for unknown routes", async () => {
    const res = await request(appWith(makeDb())).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("returns 400 for malformed JSON bodies", async () => {
    const res = await request(appWith(makeDb()))
      .post("/v1/tenant")
      .set("X-API-Key", VALID_KEY)
      .set("Content-Type", "application/json")
      .send("{bad json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_json");
  });
});
