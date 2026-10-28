import request from "supertest";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/lib/apiKeys.js";
import { parseTenantConfig } from "../src/lib/tenantConfig.js";
import { createProfileService } from "../src/modules/profiles/profiles.service.js";

const tenant = { id: "t1", slug: "leddar", config: parseTenantConfig({}) };

const fakeEmbedder = () => ({
  model: "test-embed",
  embedDocuments: jest.fn(async (texts) => texts.map(() => [0.1, 0.2])),
  embedQuery: jest.fn(async () => [0.3, 0.4]),
});

const fakeRepo = (existing = new Map()) => ({
  findHashes: jest.fn(async () => existing),
  upsertProfiles: jest.fn(async () => {}),
  deleteMissing: jest.fn(async () => 2),
  deleteProfile: jest.fn(async () => 1),
  match: jest.fn(async () => [
    { externalId: "a1", similarity: "0.61234", attributes: { name: "Ade" } },
    { externalId: "a2", similarity: 0.4, attributes: {} },
  ]),
});

describe("profile service", () => {
  it("embeds only new or changed text, in one call", async () => {
    const embedder = fakeEmbedder();
    // Learn the hash of "same" by syncing it once.
    const first = fakeRepo();
    await createProfileService({ repo: first, embedder: fakeEmbedder() }).sync(tenant, "artisan", {
      profiles: [{ externalId: "a1", text: "same", attributes: {} }],
      replace: false,
    });
    const sameHash = first.upsertProfiles.mock.calls[0][2][0].contentHash;

    const repo = fakeRepo(new Map([["a1", sameHash], ["a2", "old-hash"]]));
    const result = await createProfileService({ repo, embedder }).sync(tenant, "artisan", {
      profiles: [
        { externalId: "a1", text: "same", attributes: { city: "Lagos" } },
        { externalId: "a2", text: "changed", attributes: {} },
        { externalId: "a3", text: "new", attributes: {} },
      ],
      replace: false,
    });

    expect(embedder.embedDocuments).toHaveBeenCalledTimes(1);
    expect(embedder.embedDocuments).toHaveBeenCalledWith(["changed", "new"]);
    expect(result).toEqual({ created: 1, updated: 1, unchanged: 1, deleted: 0 });

    const rows = repo.upsertProfiles.mock.calls[0][2];
    expect(rows.find((r) => r.externalId === "a1")).toMatchObject({ attributes: { city: "Lagos" } });
    expect(rows.find((r) => r.externalId === "a1").embedding).toBeUndefined();
    expect(rows.find((r) => r.externalId === "a3").embedding).toEqual([0.1, 0.2]);
    expect(repo.deleteMissing).not.toHaveBeenCalled();
  });

  it("deletes profiles missing from a full sync when replace is true", async () => {
    const repo = fakeRepo();
    const result = await createProfileService({ repo, embedder: fakeEmbedder() }).sync(tenant, "artisan", {
      profiles: [{ externalId: "a1", text: "x", attributes: {} }],
      replace: true,
    });
    expect(repo.deleteMissing).toHaveBeenCalledWith("t1", "artisan", ["a1"]);
    expect(result.deleted).toBe(2);
  });

  it("rejects duplicate externalIds", async () => {
    const service = createProfileService({ repo: fakeRepo(), embedder: fakeEmbedder() });
    await expect(
      service.sync(tenant, "artisan", {
        profiles: [
          { externalId: "a1", text: "x", attributes: {} },
          { externalId: "a1", text: "y", attributes: {} },
        ],
        replace: false,
      }),
    ).rejects.toMatchObject({ status: 400, code: "duplicate_external_id" });
  });

  it("matches with rounded numeric similarity, restricted to the given ids", async () => {
    const repo = fakeRepo();
    const service = createProfileService({ repo, embedder: fakeEmbedder() });

    const results = await service.match(tenant, { kind: "artisan", query: "women's bags", externalIds: ["a1", "a2"], topK: 5 });

    expect(repo.match).toHaveBeenCalledWith("t1", "artisan", [0.3, 0.4], { externalIds: ["a1", "a2"], limit: 5 });
    expect(results[0]).toEqual({ externalId: "a1", similarity: 0.612, attributes: { name: "Ade" } });
  });

  it("returns nothing without embedding when the id list is empty", async () => {
    const embedder = fakeEmbedder();
    const service = createProfileService({ repo: fakeRepo(), embedder });
    expect(await service.match(tenant, { kind: "artisan", query: "q", externalIds: [], topK: 5 })).toEqual([]);
    expect(embedder.embedQuery).not.toHaveBeenCalled();
  });
});

describe("profile routes", () => {
  const KEY = "kdx_test";
  const db = {
    apiKey: {
      findUnique: jest.fn(async ({ where }) =>
        where.keyHash === hashApiKey(KEY)
          ? {
              id: "k",
              prefix: "kdx_test",
              revokedAt: null,
              lastUsedAt: new Date(),
              tenant: { id: "t1", slug: "leddar", name: "Leddar", isActive: true, config: {} },
            }
          : null,
      ),
      update: jest.fn(),
    },
  };
  const appWith = (profileRepo = fakeRepo()) =>
    createApp({ db, embedder: fakeEmbedder(), llm: {}, retriever: {}, queryLog: {}, documentRepo: {}, profileRepo, logRequests: false });

  it("PUT /v1/profiles/:kind syncs profiles", async () => {
    const res = await request(appWith())
      .put("/v1/profiles/artisan")
      .set("X-API-Key", KEY)
      .send({ profiles: [{ externalId: "a1", text: "Bags and belts", attributes: { state: "Lagos" } }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 1, updated: 0, unchanged: 0, deleted: 0 });
  });

  it("rejects an invalid kind", async () => {
    const res = await request(appWith()).put("/v1/profiles/Artisan!").set("X-API-Key", KEY).send({ profiles: [] });
    expect(res.status).toBe(400);
  });

  it("POST /v1/match ranks profiles", async () => {
    const res = await request(appWith()).post("/v1/match").set("X-API-Key", KEY).send({ kind: "artisan", query: "women's bags" });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => r.externalId)).toEqual(["a1", "a2"]);
  });

  it("DELETE /v1/profiles/:kind/:externalId returns 404 for unknown profiles", async () => {
    const repo = { ...fakeRepo(), deleteProfile: jest.fn(async () => 0) };
    const res = await request(appWith(repo)).delete("/v1/profiles/artisan/nope").set("X-API-Key", KEY);
    expect(res.status).toBe(404);
  });

  it("requires an API key", async () => {
    const res = await request(appWith()).post("/v1/match").send({ kind: "artisan", query: "q" });
    expect(res.status).toBe(401);
  });
});
