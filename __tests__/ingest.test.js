import request from "supertest";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/lib/apiKeys.js";
import { createIngestService } from "../src/modules/documents/ingest.service.js";

const tenant = { id: "t1", slug: "leddar", config: { audiences: ["brand", "artisan", "admin"] } };

const fakeEmbedder = () => ({
  provider: "fake",
  model: "fake-1",
  dimensions: 3,
  embedDocuments: jest.fn(async (texts) => texts.map(() => [0.1, 0.2, 0.3])),
  embedQuery: jest.fn(async () => [0.1, 0.2, 0.3]),
});

// In-memory stand-in for documents.repo.js.
function fakeRepo() {
  const docs = new Map();
  return {
    docs,
    findDocument: jest.fn(async (tenantId, externalId) => {
      const doc = docs.get(`${tenantId}:${externalId}`);
      return doc && { id: doc.id, contentHash: doc.contentHash, _count: { chunks: doc.chunks.length } };
    }),
    updateDocumentMetadata: jest.fn(async (tenantId, id, data) => {
      for (const doc of docs.values()) if (doc.id === id) Object.assign(doc, data);
    }),
    saveDocumentWithChunks: jest.fn(async (tenantId, data, chunks, embeddings) => {
      const key = `${tenantId}:${data.externalId}`;
      const id = docs.get(key)?.id ?? `doc-${docs.size + 1}`;
      docs.set(key, { id, ...data, chunks, embeddings });
      return id;
    }),
    listDocuments: jest.fn(async () => ({ documents: [], nextCursor: null })),
    deleteDocuments: jest.fn(async () => 0),
  };
}

const doc = (overrides = {}) => ({
  externalId: "docs:faq.md",
  title: "FAQ",
  content: "# FAQ\n\n## Payouts\n\nArtisans are paid after delivery.",
  audience: ["artisan"],
  ...overrides,
});

describe("ingest service", () => {
  it("chunks, embeds and stores a new document", async () => {
    const repo = fakeRepo();
    const embedder = fakeEmbedder();
    const service = createIngestService({ repo, embedder });

    const [result] = await service.ingest(tenant, [doc()]);

    expect(result).toMatchObject({ externalId: "docs:faq.md", documentId: "doc-1", status: "created", chunks: 1 });
    const [tenantId, data, chunks, embeddings] = repo.saveDocumentWithChunks.mock.calls[0];
    expect(tenantId).toBe("t1");
    expect(data).toMatchObject({ source: "api", audience: ["artisan"], contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(chunks[0].content).toBe("FAQ > Payouts\n\nArtisans are paid after delivery.");
    expect(embeddings).toHaveLength(1);
  });

  it("skips re-embedding unchanged content but still updates metadata", async () => {
    const repo = fakeRepo();
    const embedder = fakeEmbedder();
    const service = createIngestService({ repo, embedder });

    await service.ingest(tenant, [doc()]);
    const [again] = await service.ingest(tenant, [doc({ audience: ["artisan", "admin"] })]);

    expect(again.status).toBe("unchanged");
    expect(embedder.embedDocuments).toHaveBeenCalledTimes(1);
    expect(repo.updateDocumentMetadata).toHaveBeenCalledWith("t1", "doc-1", expect.objectContaining({ audience: ["artisan", "admin"] }));
  });

  it("re-embeds when content changes", async () => {
    const repo = fakeRepo();
    const embedder = fakeEmbedder();
    const service = createIngestService({ repo, embedder });

    await service.ingest(tenant, [doc()]);
    const [updated] = await service.ingest(tenant, [doc({ content: "Payouts happen weekly." })]);

    expect(updated).toMatchObject({ status: "updated", documentId: "doc-1" });
    expect(embedder.embedDocuments).toHaveBeenCalledTimes(2);
  });

  it("re-embeds when the embedding model changes", async () => {
    const repo = fakeRepo();
    await createIngestService({ repo, embedder: fakeEmbedder() }).ingest(tenant, [doc()]);

    const newModel = { ...fakeEmbedder(), model: "fake-2" };
    const [result] = await createIngestService({ repo, embedder: newModel }).ingest(tenant, [doc()]);
    expect(result.status).toBe("updated");
  });

  it("rejects audiences the tenant doesn't define, before embedding anything", async () => {
    const embedder = fakeEmbedder();
    const service = createIngestService({ repo: fakeRepo(), embedder });

    await expect(service.ingest(tenant, [doc(), doc({ externalId: "b", audience: ["customer"] })])).rejects.toMatchObject({
      status: 400,
      code: "invalid_audience",
    });
    expect(embedder.embedDocuments).not.toHaveBeenCalled();
  });

  it("allows any audience when the tenant defines none", async () => {
    const service = createIngestService({ repo: fakeRepo(), embedder: fakeEmbedder() });
    const open = { ...tenant, config: { audiences: [] } };
    await expect(service.ingest(open, [doc({ audience: ["anyone"] })])).resolves.toHaveLength(1);
  });
});

describe("document routes", () => {
  const KEY = "kdx_test";
  const db = {
    apiKey: {
      findUnique: jest.fn(async ({ where }) =>
        where.keyHash === hashApiKey(KEY)
          ? { id: "k", prefix: "kdx_test", revokedAt: null, lastUsedAt: new Date(), tenant: { ...tenant, name: "Leddar", isActive: true } }
          : null,
      ),
      update: jest.fn(),
    },
  };
  const appWith = (repo, embedder = fakeEmbedder()) =>
    createApp({ db, embedder, documentRepo: repo, logRequests: false });

  it("POST /v1/ingest ingests documents", async () => {
    const repo = fakeRepo();
    const res = await request(appWith(repo)).post("/v1/ingest").set("X-API-Key", KEY).send({ documents: [doc()] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ status: "created", chunks: 1 });
  });

  it("POST /v1/ingest validates the body", async () => {
    const res = await request(appWith(fakeRepo()))
      .post("/v1/ingest")
      .set("X-API-Key", KEY)
      .send({ documents: [{ externalId: "", content: "" }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("POST /v1/ingest requires an API key", async () => {
    const res = await request(appWith(fakeRepo())).post("/v1/ingest").send({ documents: [doc()] });
    expect(res.status).toBe(401);
  });

  it("GET /v1/documents is scoped to the caller's tenant", async () => {
    const repo = fakeRepo();
    await request(appWith(repo)).get("/v1/documents?limit=5&source=docs").set("X-API-Key", KEY);
    expect(repo.listDocuments).toHaveBeenCalledWith("t1", { limit: 5, source: "docs" });
  });

  it("DELETE /v1/documents?externalId= deletes within the tenant or 404s", async () => {
    const repo = fakeRepo();
    repo.deleteDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const app = appWith(repo);

    const ok = await request(app).delete("/v1/documents?externalId=docs:faq.md").set("X-API-Key", KEY);
    const missing = await request(app).delete("/v1/documents?externalId=nope").set("X-API-Key", KEY);

    expect(ok.status).toBe(204);
    expect(missing.status).toBe(404);
    expect(repo.deleteDocuments).toHaveBeenCalledWith("t1", { externalId: "docs:faq.md" });
  });

  it("DELETE /v1/documents without externalId is a 400", async () => {
    const res = await request(appWith(fakeRepo())).delete("/v1/documents").set("X-API-Key", KEY);
    expect(res.status).toBe(400);
  });

  it("DELETE /v1/documents/:id deletes within the tenant", async () => {
    const repo = fakeRepo();
    repo.deleteDocuments.mockResolvedValueOnce(1);
    const res = await request(appWith(repo)).delete("/v1/documents/doc-1").set("X-API-Key", KEY);
    expect(res.status).toBe(204);
    expect(repo.deleteDocuments).toHaveBeenCalledWith("t1", { id: "doc-1" });
  });
});
