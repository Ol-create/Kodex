import request from "supertest";
import { createApp } from "../src/app.js";
import { parseEnv } from "../src/config/env.js";
import { scheduleRetention } from "../src/jobs/retention.js";
import { hashApiKey } from "../src/lib/apiKeys.js";
import { createLogger } from "../src/lib/logger.js";
import { parseTenantConfig } from "../src/lib/tenantConfig.js";

const KEY = "kdx_test";

const dbWithTenant = (config = {}) => ({
  apiKey: {
    findUnique: jest.fn(async ({ where }) =>
      where.keyHash === hashApiKey(KEY)
        ? {
            id: "k",
            prefix: "kdx_test",
            revokedAt: null,
            lastUsedAt: new Date(),
            tenant: { id: "t1", slug: "leddar", name: "Leddar", isActive: true, config },
          }
        : null,
    ),
    update: jest.fn(),
  },
});

const appWith = ({ config, queryLog = {} } = {}) =>
  createApp({ db: dbWithTenant(config), embedder: {}, llm: {}, retriever: {}, queryLog, documentRepo: {}, logRequests: false });

describe("environment", () => {
  const base = { DATABASE_URL: "postgresql://x" };

  it("starts locally without provider keys", () => {
    expect(parseEnv(base).success).toBe(true);
  });

  it("refuses to start in production without the keys its providers need", () => {
    const result = parseEnv({ ...base, NODE_ENV: "production" });
    expect(result.success).toBe(false);
    expect(result.error.issues.map((i) => i.path[0])).toEqual(["VOYAGE_API_KEY", "OPENAI_API_KEY"]);
  });

  it("accepts a complete production config", () => {
    const result = parseEnv({ ...base, NODE_ENV: "production", VOYAGE_API_KEY: "pa-x", OPENAI_API_KEY: "sk-x" });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ QUERY_LOG_RETENTION_DAYS: 90, TRUST_PROXY: 0 });
  });

  it("only requires the Anthropic key when Anthropic is the LLM", () => {
    const result = parseEnv({ ...base, NODE_ENV: "production", VOYAGE_API_KEY: "pa-x", LLM_PROVIDER: "anthropic" });
    expect(result.error.issues.map((i) => i.path[0])).toEqual(["ANTHROPIC_API_KEY"]);
  });
});

describe("logger", () => {
  it("writes one JSON object per line, with errors serialised", () => {
    const lines = [];
    const log = createLogger({ format: "json", write: (line) => lines.push(line) });
    log.error("boom", { requestId: "r1", err: new Error("bad") });

    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ level: "error", msg: "boom", requestId: "r1", err: { name: "Error", message: "bad" } });
    expect(entry.time).toEqual(expect.any(String));
  });

  it("writes readable text locally", () => {
    const lines = [];
    createLogger({ format: "text", write: (line) => lines.push(line) }).info("hello", { tenant: "leddar", skipped: undefined });
    expect(lines).toEqual(["hello tenant=leddar"]);
  });
});

describe("request ids", () => {
  it("generates one and returns it as X-Request-Id", async () => {
    const res = await request(appWith()).get("/health");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps a caller's id, but not one that isn't id-shaped", async () => {
    const kept = await request(appWith()).get("/health").set("X-Request-Id", "leddar-abc.123");
    expect(kept.headers["x-request-id"]).toBe("leddar-abc.123");

    const replaced = await request(appWith()).get("/health").set("X-Request-Id", "not an id <script>");
    expect(replaced.headers["x-request-id"]).not.toBe("not an id <script>");
  });
});

describe("tenant rate limit", () => {
  it("allows up to the tenant's limit per minute, then returns 429", async () => {
    const app = appWith({ config: { limits: { requestsPerMinute: 2 } } });
    const call = () => request(app).get("/v1/tenant").set("X-API-Key", KEY);

    expect((await call()).status).toBe(200);
    const second = await call();
    expect(second.status).toBe(200);
    expect(second.headers["ratelimit-remaining"]).toBe("0");

    const third = await call();
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("rate_limited");
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("is off when requestsPerMinute is 0", async () => {
    const app = appWith({ config: { limits: { requestsPerMinute: 0 } } });
    for (let i = 0; i < 5; i++) expect((await request(app).get("/v1/tenant").set("X-API-Key", KEY)).status).toBe(200);
  });

  it("defaults to 120 per minute", () => {
    expect(parseTenantConfig({}).limits.requestsPerMinute).toBe(120);
  });
});

describe("GET /v1/usage", () => {
  it("summarises questions, tokens, latency and documentation gaps", async () => {
    const queryLog = {
      usage: jest.fn(async () => ({
        byStatus: [
          { status: "answered", _count: { _all: 6 } },
          { status: "no_answer", _count: { _all: 1 } },
          { status: "no_context", _count: { _all: 1 } },
        ],
        totals: { _sum: { inputTokens: 9000, outputTokens: 1200 } },
        latency: { avg: 3120.4, p95: 6900.2 },
        gaps: [{ question: "do you ship to the uk?", count: 2, lastAsked: "2026-10-28T10:00:00.000Z" }],
      })),
    };

    const res = await request(appWith({ queryLog })).get("/v1/usage?days=7").set("X-API-Key", KEY);

    expect(res.status).toBe(200);
    expect(queryLog.usage).toHaveBeenCalledWith("t1", expect.any(Date));
    expect(res.body).toMatchObject({
      questions: { total: 8, answered: 6, no_answer: 1, no_context: 1, refused: 0, error: 0 },
      answerRate: 0.75,
      tokens: { input: 9000, output: 1200 },
      latencyMs: { avg: 3120, p95: 6900 },
      gaps: [{ question: "do you ship to the uk?", count: 2 }],
    });
  });

  it("rejects an out-of-range window", async () => {
    const res = await request(appWith({ queryLog: { usage: jest.fn() } })).get("/v1/usage?days=1000").set("X-API-Key", KEY);
    expect(res.status).toBe(400);
  });
});

describe("query log retention", () => {
  const silent = { info() {}, warn() {}, error: jest.fn() };

  it("deletes rows older than the retention window right away", async () => {
    const queryLog = { deleteOlderThan: jest.fn(async () => 3) };
    const now = Date.parse("2026-10-28T00:00:00Z");
    const stop = scheduleRetention({ queryLog, days: 90, log: silent, now: () => now });
    await Promise.resolve();
    stop();

    expect(queryLog.deleteOlderThan).toHaveBeenCalledWith(new Date("2026-07-30T00:00:00Z"));
  });

  it("does nothing when retention is 0", () => {
    const queryLog = { deleteOlderThan: jest.fn() };
    scheduleRetention({ queryLog, days: 0, log: silent })();
    expect(queryLog.deleteOlderThan).not.toHaveBeenCalled();
  });

  it("logs failures instead of crashing", async () => {
    const queryLog = { deleteOlderThan: jest.fn(async () => { throw new Error("db down"); }) };
    const stop = scheduleRetention({ queryLog, days: 30, log: silent });
    await new Promise((r) => setImmediate(r));
    stop();
    expect(silent.error).toHaveBeenCalledWith("Query log retention failed", { err: "db down" });
  });
});
