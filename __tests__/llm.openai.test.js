import OpenAI from "openai";
import { createLlm } from "../src/lib/llm/index.js";
import { createOpenAiLlm } from "../src/lib/llm/openai.js";

const response = (overrides = {}) => ({
  model: "gpt-5.4-mini-2026-03-17",
  status: "completed",
  incomplete_details: null,
  output: [
    { type: "reasoning", summary: [] },
    {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "Paid in 3 days " },
        { type: "output_text", text: "[1]." },
      ],
    },
  ],
  usage: { input_tokens: 900, output_tokens: 40 },
  ...overrides,
});

const prompt = { system: "sys", messages: [{ role: "user", content: "q" }] };

function fakeClient({ create, final } = {}) {
  const handlers = {};
  const stream = {
    on: jest.fn((event, fn) => {
      handlers[event] = fn;
      return stream;
    }),
    finalResponse: jest.fn(async () => {
      handlers["response.output_text.delta"]?.({ delta: "Paid " });
      handlers["response.output_text.delta"]?.({ delta: "in 3 days" });
      return final ?? response();
    }),
  };
  return {
    responses: {
      create: create ?? jest.fn(async () => response()),
      stream: jest.fn(() => stream),
    },
  };
}

describe("createOpenAiLlm", () => {
  it("sends instructions, input, effort and store=false", async () => {
    const client = fakeClient();
    await createOpenAiLlm({ model: "gpt-5.4-mini", effort: "medium", client }).generate(prompt);

    expect(client.responses.create).toHaveBeenCalledWith({
      model: "gpt-5.4-mini",
      instructions: "sys",
      input: prompt.messages,
      max_output_tokens: 16000,
      store: false,
      reasoning: { effort: "medium" },
    });
  });

  it("omits reasoning effort for non-reasoning models", async () => {
    const client = fakeClient();
    await createOpenAiLlm({ model: "gpt-4.1-mini", effort: "medium", client }).generate(prompt);
    expect(client.responses.create.mock.calls[0][0]).not.toHaveProperty("reasoning");
  });

  it("joins output text and reports usage", async () => {
    const result = await createOpenAiLlm({ model: "m", effort: "low", client: fakeClient() }).generate(prompt);
    expect(result).toEqual({
      text: "Paid in 3 days [1].",
      status: "complete",
      model: "gpt-5.4-mini-2026-03-17",
      fellBack: false,
      usage: { inputTokens: 900, outputTokens: 40 },
    });
  });

  it("flags refusals, content filtering and truncation", async () => {
    const run = (res) =>
      createOpenAiLlm({ model: "m", effort: "low", client: fakeClient({ create: jest.fn(async () => res) }) }).generate(prompt);

    const refusal = response({ output: [{ type: "message", content: [{ type: "refusal", refusal: "Can't help" }] }] });
    expect((await run(refusal)).status).toBe("refused");
    expect((await run(response({ status: "incomplete", incomplete_details: { reason: "content_filter" } }))).status).toBe("refused");
    expect((await run(response({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }))).status).toBe(
      "truncated",
    );
  });

  it("streams text deltas and passes the abort signal", async () => {
    const client = fakeClient();
    const deltas = [];
    const signal = new AbortController().signal;

    const result = await createOpenAiLlm({ model: "m", effort: "low", client }).stream(prompt, { onText: (t) => deltas.push(t), signal });

    expect(deltas).toEqual(["Paid ", "in 3 days"]);
    expect(client.responses.stream.mock.calls[0][1]).toEqual({ signal });
    expect(result.text).toBe("Paid in 3 days [1].");
  });

  it("maps SDK errors to API errors", async () => {
    const failWith = (err) => fakeClient({ create: jest.fn(async () => { throw err; }) });
    const run = (err) => createOpenAiLlm({ model: "m", effort: "low", client: failWith(err) }).generate(prompt);
    const headers = new Headers();

    await expect(run(new OpenAI.AuthenticationError(401, {}, "bad key", headers))).rejects.toMatchObject({
      status: 503,
      code: "llm_not_configured",
    });
    await expect(run(new OpenAI.RateLimitError(429, {}, "slow down", headers))).rejects.toMatchObject({
      status: 503,
      code: "llm_rate_limited",
    });
    await expect(
      run(new OpenAI.RateLimitError(429, { type: "insufficient_quota", code: "credit_balance_exhausted" }, "no credits", headers)),
    ).rejects.toMatchObject({ status: 503, code: "llm_quota_exceeded" });
    // The shape a streaming request throws: no HTTP status.
    await expect(run(new OpenAI.APIError(undefined, { type: "insufficient_quota" }, "no credits", undefined))).rejects.toMatchObject({
      code: "llm_quota_exceeded",
    });
    await expect(run(new OpenAI.InternalServerError(500, {}, "boom", headers))).rejects.toMatchObject({
      status: 502,
      code: "llm_failed",
    });
    const aborted = new OpenAI.APIUserAbortError();
    await expect(run(aborted)).rejects.toBe(aborted);
  });

  it("reports a missing API key as llm_not_configured", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(createOpenAiLlm({ model: "m", effort: "low" }).generate(prompt)).rejects.toMatchObject({
        status: 503,
        code: "llm_not_configured",
      });
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe("createLlm", () => {
  it("picks the provider and its default model", () => {
    expect(createLlm({ LLM_PROVIDER: "openai", LLM_EFFORT: "low" })).toMatchObject({ provider: "openai", model: "gpt-5.4-mini" });
    expect(createLlm({ LLM_PROVIDER: "anthropic", LLM_EFFORT: "low" })).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
    expect(createLlm({ LLM_PROVIDER: "openai", LLM_MODEL: "gpt-5.5", LLM_EFFORT: "low" }).model).toBe("gpt-5.5");
  });
});
