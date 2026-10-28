import { createEmbedder, withSafetyChecks } from "../src/lib/embeddings/index.js";
import { createOllamaEmbedder } from "../src/lib/embeddings/ollama.js";
import { createVoyageEmbedder } from "../src/lib/embeddings/voyage.js";
import { HttpError, postJson } from "../src/lib/http.js";

const vec = (n, value = 0.1) => Array(n).fill(value);

describe("Voyage embedder", () => {
  it("batches inputs, sends input_type and keeps order", async () => {
    const http = jest.fn(async (url, body) => ({
      // Return out of order to prove we sort by index.
      data: body.input.map((text, index) => ({ index, embedding: [text.length] })).reverse(),
    }));
    const embedder = createVoyageEmbedder({ apiKey: "k", dimensions: 1024, http });

    const texts = Array.from({ length: 130 }, (_, i) => "x".repeat(i + 1));
    const vectors = await embedder.embedDocuments(texts);

    expect(http).toHaveBeenCalledTimes(2); // 128 + 2
    expect(vectors.map((v) => v[0])).toEqual(texts.map((t) => t.length));

    const [url, body, options] = http.mock.calls[0];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(body).toMatchObject({ model: "voyage-3.5", input_type: "document", output_dimension: 1024 });
    expect(options.headers.Authorization).toBe("Bearer k");
  });

  it("uses input_type=query for queries", async () => {
    const http = jest.fn(async () => ({ data: [{ index: 0, embedding: [1] }] }));
    await createVoyageEmbedder({ apiKey: "k", dimensions: 1, http }).embedQuery("hi");
    expect(http.mock.calls[0][1].input_type).toBe("query");
  });

  it("embeds many queries in one request", async () => {
    const http = jest.fn(async (url, body) => ({ data: body.input.map((_, index) => ({ index, embedding: [index] })) }));
    const vectors = await createVoyageEmbedder({ apiKey: "k", dimensions: 1, http }).embedQueries(["a", "b", "c"]);
    expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0][1]).toMatchObject({ input: ["a", "b", "c"], input_type: "query" });
    expect(vectors).toEqual([[0], [1], [2]]);
  });

  it("fails clearly without an API key", async () => {
    const embedder = createVoyageEmbedder({ apiKey: undefined, dimensions: 1024, http: jest.fn() });
    await expect(embedder.embedDocuments(["a"])).rejects.toMatchObject({ status: 503, code: "embedding_not_configured" });
  });
});

describe("Ollama embedder", () => {
  it("calls /api/embed and prefixes mxbai queries", async () => {
    const http = jest.fn(async (url, body) => ({ embeddings: body.input.map(() => [1]) }));
    const embedder = createOllamaEmbedder({ baseUrl: "http://localhost:11434/", dimensions: 1, http });

    await embedder.embedDocuments(["doc"]);
    await embedder.embedQuery("question");

    expect(http.mock.calls[0][0]).toBe("http://localhost:11434/api/embed");
    expect(http.mock.calls[0][1]).toEqual({ model: "mxbai-embed-large", input: ["doc"] });
    expect(http.mock.calls[1][1].input[0]).toMatch(/^Represent this sentence.*question$/);

    await embedder.embedQueries(["q1", "q2"]);
    expect(http.mock.calls[2][1].input).toEqual(expect.arrayContaining([expect.stringMatching(/^Represent.*q2$/)]));
  });
});

describe("createEmbedder", () => {
  it("picks the provider from env", () => {
    expect(createEmbedder({ EMBEDDING_PROVIDER: "voyage", EMBEDDING_DIMENSIONS: 1024 }).provider).toBe("voyage");
    const ollama = createEmbedder({ EMBEDDING_PROVIDER: "ollama", EMBEDDING_DIMENSIONS: 1024, OLLAMA_BASE_URL: "http://x" });
    expect(ollama).toMatchObject({ provider: "ollama", model: "mxbai-embed-large" });
  });
});

describe("withSafetyChecks", () => {
  const base = (impl) => ({ provider: "fake", model: "m", dimensions: 3, embedDocuments: impl, embedQuery: async () => vec(3) });

  it("passes valid vectors through and skips empty input", async () => {
    const impl = jest.fn(async (texts) => texts.map(() => vec(3)));
    const embedder = withSafetyChecks(base(impl));
    await expect(embedder.embedDocuments(["a", "b"])).resolves.toHaveLength(2);
    await expect(embedder.embedDocuments([])).resolves.toEqual([]);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("rejects vectors with the wrong dimension", async () => {
    const embedder = withSafetyChecks(base(async () => [vec(2)]));
    await expect(embedder.embedDocuments(["a"])).rejects.toMatchObject({ code: "embedding_dimension_mismatch" });
  });

  it("rejects a wrong number of vectors", async () => {
    const embedder = withSafetyChecks(base(async () => [vec(3)]));
    await expect(embedder.embedDocuments(["a", "b"])).rejects.toMatchObject({ status: 502, code: "embedding_failed" });
  });

  it("turns provider HTTP errors into 502s", async () => {
    const embedder = withSafetyChecks(base(async () => { throw new HttpError(401, "bad key"); }));
    await expect(embedder.embedDocuments(["a"])).rejects.toMatchObject({ status: 502, code: "embedding_failed" });
  });
});

describe("postJson", () => {
  const response = (status, body = {}, headers = {}) => ({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
  });

  it("retries 429 and 5xx, honouring Retry-After", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(429, {}, { "retry-after": "2" }))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200, { ok: true }));
    const sleep = jest.fn().mockResolvedValue();

    await expect(postJson("http://x", {}, { fetchImpl, sleep })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls[0][0]).toBe(2000);
  });

  it("does not retry 4xx errors other than 429", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(400, { error: "bad" }));
    await expect(postJson("http://x", {}, { fetchImpl, sleep: jest.fn() })).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry limit", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(postJson("http://x", {}, { fetchImpl, sleep: jest.fn().mockResolvedValue(), retries: 2 })).rejects.toThrow(
      "ECONNRESET",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
