import request from "supertest";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/lib/apiKeys.js";
import { parseTenantConfig } from "../src/lib/tenantConfig.js";
import { createAskService } from "../src/modules/ask/ask.service.js";

const tenant = {
  id: "t1",
  slug: "leddar",
  config: parseTenantConfig({ audiences: ["brand", "artisan", "admin"], fallbackAnswer: "Please contact support." }),
};

const chunk = (id, similarity, overrides = {}) => ({
  chunkId: `c${id}`,
  documentId: `d${id}`,
  externalId: `docs:${id}.md`,
  title: `Doc ${id}`,
  section: `Section ${id}`,
  source: "docs",
  content: `Content of chunk ${id}`,
  similarity,
  score: 0.03,
  matchedBy: ["semantic"],
  ...overrides,
});

const fakeRetriever = (chunks = [chunk(1, 0.72), chunk(2, 0.55)]) => ({ search: jest.fn(async () => chunks) });

const completion = (overrides = {}) => ({
  text: "Artisans are paid within 3 days [2].",
  status: "complete",
  model: "claude-opus-5-5",
  fellBack: false,
  usage: { inputTokens: 1200, outputTokens: 30 },
  ...overrides,
});

const fakeLlm = (result = completion()) => ({
  generate: jest.fn(async () => result),
  stream: jest.fn(async (prompt, { onText }) => {
    for (const piece of ["Artisans are paid ", "within 3 days [2]."]) onText(piece);
    return result;
  }),
});

const fakeQueryLog = () => ({ record: jest.fn() });

describe("ask service", () => {
  it("retrieves, generates, marks cited sources and logs", async () => {
    const retriever = fakeRetriever();
    const llm = fakeLlm();
    const queryLog = fakeQueryLog();
    const service = createAskService({ retriever, llm, queryLog });

    const result = await service.ask(tenant, { question: "When are artisans paid?", audience: ["artisan"], history: [], userId: "u1" });

    expect(retriever.search).toHaveBeenCalledWith(tenant, { query: "When are artisans paid?", audiences: ["artisan"], topK: 5 });
    expect(result).toMatchObject({ status: "answered", answer: "Artisans are paid within 3 days [2].", confidence: 0.72 });
    expect(result.sources.map((s) => [s.id, s.cited])).toEqual([[1, false], [2, true]]);
    expect(result.sources[0]).not.toHaveProperty("content");
    expect(result.sources[0].snippet).toBe("Content of chunk 1");

    const [prompt] = llm.generate.mock.calls[0];
    expect(prompt.messages.at(-1).content).toContain('<source id="2" title="Doc 2" section="Section 2">');

    expect(queryLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        userId: "u1",
        status: "answered",
        chunkIds: ["c1", "c2"],
        citedChunkIds: ["c2"],
        inputTokens: 1200,
        latencyMs: expect.any(Number),
      }),
    );
  });

  it("uses a per-request topK when given", async () => {
    const retriever = fakeRetriever();
    await createAskService({ retriever, llm: fakeLlm(), queryLog: fakeQueryLog() }).ask(tenant, {
      question: "q",
      audience: [],
      history: [],
      topK: 2,
    });
    expect(retriever.search.mock.calls[0][1].topK).toBe(2);
  });

  it("returns the fallback without calling the LLM when nothing is relevant", async () => {
    const llm = fakeLlm();
    const queryLog = fakeQueryLog();
    const service = createAskService({ retriever: fakeRetriever([chunk(1, 0.12)]), llm, queryLog });

    const result = await service.ask(tenant, { question: "What's the weather?", audience: [], history: [] });

    expect(result).toMatchObject({ status: "no_context", answer: "Please contact support.", model: null });
    expect(llm.generate).not.toHaveBeenCalled();
    expect(queryLog.record).toHaveBeenCalledWith(expect.objectContaining({ status: "no_context", confidence: 0.12 }));
  });

  it("searches again with the previous question when a follow-up matches weakly", async () => {
    const retriever = { search: jest.fn().mockResolvedValueOnce([chunk(9, 0.2)]).mockResolvedValueOnce([chunk(1, 0.62)]) };
    const llm = fakeLlm();
    const service = createAskService({ retriever, llm, queryLog: fakeQueryLog() });
    const history = [
      { role: "user", content: "How many sample corrections can I request?" },
      { role: "assistant", content: "Up to 2." },
    ];

    const result = await service.ask(tenant, { question: "Do I pay extra for those?", audience: ["brand"], history });

    expect(retriever.search.mock.calls.map(([, { query }]) => query)).toEqual([
      "Do I pay extra for those?",
      "How many sample corrections can I request?\nDo I pay extra for those?",
    ]);
    expect(result).toMatchObject({ status: "answered", confidence: 0.62 });
    // The model still sees the user's actual question, with history for context.
    expect(llm.generate.mock.calls[0][0].messages.at(-1).content).toContain("Do I pay extra for those?");
  });

  it("does not search twice when the question matches well or there is no history", async () => {
    for (const [chunks, history] of [
      [[chunk(1, 0.7)], [{ role: "user", content: "earlier" }, { role: "assistant", content: "ok" }]],
      [[chunk(1, 0.2)], []],
    ]) {
      const retriever = fakeRetriever(chunks);
      const service = createAskService({ retriever, llm: fakeLlm(), queryLog: fakeQueryLog() });
      await service.ask(tenant, { question: "q", audience: [], history });
      expect(retriever.search).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the first result when the expanded search is no better", async () => {
    const retriever = { search: jest.fn().mockResolvedValueOnce([chunk(1, 0.2)]).mockResolvedValueOnce([chunk(2, 0.15)]) };
    const llm = fakeLlm();
    const service = createAskService({ retriever, llm, queryLog: fakeQueryLog() });

    const result = await service.ask(tenant, {
      question: "and the weather?",
      audience: [],
      history: [{ role: "user", content: "How do I pay?" }, { role: "assistant", content: "Via Paystack." }],
    });

    expect(result).toMatchObject({ status: "no_context", confidence: 0.2 });
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it("returns the fallback when retrieval finds nothing", async () => {
    const service = createAskService({ retriever: fakeRetriever([]), llm: fakeLlm(), queryLog: fakeQueryLog() });
    const result = await service.ask(tenant, { question: "q", audience: [], history: [] });
    expect(result).toMatchObject({ status: "no_context", confidence: 0, sources: [] });
  });

  it("replaces a refused answer with the fallback", async () => {
    const service = createAskService({
      retriever: fakeRetriever(),
      llm: fakeLlm(completion({ status: "refused", text: "partial" })),
      queryLog: fakeQueryLog(),
    });
    const result = await service.ask(tenant, { question: "q", audience: [], history: [] });
    expect(result).toMatchObject({ status: "refused", answer: "Please contact support." });
    expect(result.sources.every((s) => !s.cited)).toBe(true);
  });

  it("turns a NO_ANSWER reply into the fallback with no citations", async () => {
    const queryLog = fakeQueryLog();
    const service = createAskService({
      retriever: fakeRetriever(),
      llm: fakeLlm(completion({ text: "NO_ANSWER" })),
      queryLog,
    });
    const result = await service.ask(tenant, { question: "q", audience: [], history: [] });

    expect(result).toMatchObject({ status: "no_answer", answer: "Please contact support." });
    expect(result.sources.every((s) => !s.cited)).toBe(true);
    expect(queryLog.record).toHaveBeenCalledWith(expect.objectContaining({ status: "no_answer", citedChunkIds: [] }));
  });

  it("never streams the NO_ANSWER marker, even split across deltas", async () => {
    const llm = {
      stream: jest.fn(async (prompt, { onText }) => {
        for (const piece of ["NO_", "ANS", "WER"]) onText(piece);
        return completion({ text: "NO_ANSWER" });
      }),
    };
    const deltas = [];
    const result = await createAskService({ retriever: fakeRetriever(), llm, queryLog: fakeQueryLog() }).ask(
      tenant,
      { question: "q", audience: [], history: [] },
      { onText: (t) => deltas.push(t) },
    );

    expect(deltas).toEqual([]);
    expect(result.status).toBe("no_answer");
  });

  it("streams normal answers, including ones that start like the marker", async () => {
    const stream = (pieces) => ({
      stream: jest.fn(async (prompt, { onText }) => {
        pieces.forEach(onText);
        return completion({ text: pieces.join("") });
      }),
    });
    const run = async (pieces) => {
      const deltas = [];
      const service = createAskService({ retriever: fakeRetriever(), llm: stream(pieces), queryLog: fakeQueryLog() });
      const result = await service.ask(tenant, { question: "q", audience: [], history: [] }, { onText: (t) => deltas.push(t) });
      return { deltas, result };
    };

    const normal = await run(["Artisans are paid ", "within 3 days [2]."]);
    expect(normal.deltas).toEqual(["Artisans are paid ", "within 3 days [2]."]);

    const lookalike = await run(["N", "O", " fee applies [1]."]);
    expect(lookalike.deltas.join("")).toBe("NO fee applies [1].");
    expect(lookalike.result.status).toBe("answered");

    const short = await run(["N"]);
    expect(short.deltas).toEqual(["N"]);
  });

  it("rejects unknown audiences before retrieving", async () => {
    const retriever = fakeRetriever();
    const service = createAskService({ retriever, llm: fakeLlm(), queryLog: fakeQueryLog() });

    await expect(service.ask(tenant, { question: "q", audience: ["hacker"], history: [] })).rejects.toMatchObject({
      status: 400,
      code: "invalid_audience",
    });
    expect(retriever.search).not.toHaveBeenCalled();
  });

  it("logs failures and rethrows", async () => {
    const queryLog = fakeQueryLog();
    const llm = { generate: jest.fn(async () => { throw new Error("boom"); }) };
    const service = createAskService({ retriever: fakeRetriever(), llm, queryLog });

    await expect(service.ask(tenant, { question: "q", audience: [], history: [] })).rejects.toThrow("boom");
    expect(queryLog.record).toHaveBeenCalledWith(expect.objectContaining({ status: "error", chunkIds: ["c1", "c2"] }));
  });
});

describe("ask routes", () => {
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
              tenant: { id: "t1", slug: "leddar", name: "Leddar", isActive: true, config: tenant.config },
            }
          : null,
      ),
      update: jest.fn(),
    },
  };
  const appWith = ({ retriever = fakeRetriever(), llm = fakeLlm(), queryLog = fakeQueryLog() } = {}) =>
    createApp({ db, embedder: {}, llm, retriever, queryLog, documentRepo: {}, logRequests: false });

  it("POST /v1/search returns ranked sources with content and no LLM call", async () => {
    const llm = fakeLlm();
    const res = await request(appWith({ llm })).post("/v1/search").set("X-API-Key", KEY).send({ question: "payouts", audience: "artisan" });

    expect(res.status).toBe(200);
    expect(res.body.confidence).toBe(0.72);
    expect(res.body.results[0]).toMatchObject({ id: 1, chunkId: "c1", content: "Content of chunk 1" });
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it("POST /v1/ask accepts a single audience string", async () => {
    const retriever = fakeRetriever();
    const res = await request(appWith({ retriever })).post("/v1/ask").set("X-API-Key", KEY).send({ question: "q", audience: "brand" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("answered");
    expect(retriever.search.mock.calls[0][1].audiences).toEqual(["brand"]);
  });

  it("POST /v1/ask validates input", async () => {
    const res = await request(appWith()).post("/v1/ask").set("X-API-Key", KEY).send({ question: "", topK: 99 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("POST /v1/ask with stream=true sends sources, deltas and done as SSE", async () => {
    const res = await request(appWith())
      .post("/v1/ask")
      .set("X-API-Key", KEY)
      .send({ question: "When are artisans paid?", stream: true })
      .buffer(true)
      .parse((response, callback) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => callback(null, body));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = res.body
      .trim()
      .split("\n\n")
      .map((block) => {
        const [eventLine, dataLine] = block.split("\n");
        return { event: eventLine.replace("event: ", ""), data: JSON.parse(dataLine.replace("data: ", "")) };
      });

    expect(events.map((e) => e.event)).toEqual(["sources", "delta", "delta", "done"]);
    expect(events[0].data.sources).toHaveLength(2);
    expect(events[1].data.text + events[2].data.text).toBe("Artisans are paid within 3 days [2].");
    expect(events[3].data).toMatchObject({ status: "answered", confidence: 0.72 });
  });

  it("streaming errors before the stream opens are normal JSON errors", async () => {
    const res = await request(appWith()).post("/v1/ask").set("X-API-Key", KEY).send({ question: "q", audience: "nobody", stream: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_audience");
  });

  it("streaming errors after the stream opens become an SSE error event", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const llm = { stream: jest.fn(async () => { throw new Error("socket hang up"); }) };
    const res = await request(appWith({ llm }))
      .post("/v1/ask")
      .set("X-API-Key", KEY)
      .send({ question: "q", stream: true })
      .buffer(true)
      .parse((response, callback) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => callback(null, body));
      });

    expect(res.body).toContain("event: sources");
    expect(res.body).toContain('event: error\ndata: {"code":"internal_error","message":"Something went wrong"}');
  });
});
