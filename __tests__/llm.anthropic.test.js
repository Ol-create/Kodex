import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicLlm as createLlm } from "../src/lib/llm/anthropic.js";

const message = (overrides = {}) => ({
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  content: [
    { type: "thinking", thinking: "" },
    { type: "text", text: "Paid in 3 days " },
    { type: "text", text: "[1]." },
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
    finalMessage: jest.fn(async () => {
      handlers.text?.("Paid ");
      handlers.text?.("in 3 days");
      return final ?? message();
    }),
  };
  return {
    beta: {
      messages: {
        create: create ?? jest.fn(async () => message()),
        stream: jest.fn(() => stream),
      },
    },
  };
}

describe("createAnthropicLlm", () => {
  it("sends model, effort and the default refusal fallback", async () => {
    const client = fakeClient();
    await createLlm({ model: "claude-opus-5-5", effort: "medium", client }).generate(prompt);

    expect(client.beta.messages.create).toHaveBeenCalledWith({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      system: "sys",
      messages: prompt.messages,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  });

  it("joins text blocks and reports usage", async () => {
    const result = await createLlm({ model: "m", effort: "low", client: fakeClient() }).generate(prompt);
    expect(result).toEqual({
      text: "Paid in 3 days [1].",
      status: "complete",
      model: "claude-opus-5-5",
      fellBack: false,
      usage: { inputTokens: 900, outputTokens: 40 },
    });
  });

  it("flags refusals, truncation and fallbacks", async () => {
    const refused = fakeClient({ create: jest.fn(async () => message({ stop_reason: "refusal", content: [] })) });
    expect((await createLlm({ model: "m", effort: "low", client: refused }).generate(prompt)).status).toBe("refused");

    const truncated = fakeClient({ create: jest.fn(async () => message({ stop_reason: "max_tokens" })) });
    expect((await createLlm({ model: "m", effort: "low", client: truncated }).generate(prompt)).status).toBe("truncated");

    const fellBack = fakeClient({
      create: jest.fn(async () =>
        message({ model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: "fallback_message" }] } }),
      ),
    });
    const result = await createLlm({ model: "m", effort: "low", client: fellBack }).generate(prompt);
    expect(result).toMatchObject({ fellBack: true, model: "claude-opus-5" });
  });

  it("streams text deltas and passes the abort signal", async () => {
    const client = fakeClient();
    const deltas = [];
    const signal = new AbortController().signal;

    const result = await createLlm({ model: "m", effort: "low", client }).stream(prompt, { onText: (t) => deltas.push(t), signal });

    expect(deltas).toEqual(["Paid ", "in 3 days"]);
    expect(client.beta.messages.stream.mock.calls[0][1]).toEqual({ signal });
    expect(result.text).toBe("Paid in 3 days [1].");
  });

  it("maps SDK errors to API errors", async () => {
    const failWith = (err) => fakeClient({ create: jest.fn(async () => { throw err; }) });
    const run = (err) => createLlm({ model: "m", effort: "low", client: failWith(err) }).generate(prompt);
    const headers = new Headers();

    await expect(run(new Anthropic.AuthenticationError(401, {}, "bad key", headers))).rejects.toMatchObject({
      status: 503,
      code: "llm_not_configured",
    });
    await expect(run(new Anthropic.RateLimitError(429, {}, "slow down", headers))).rejects.toMatchObject({
      status: 503,
      code: "llm_rate_limited",
    });
    await expect(run(new Anthropic.InternalServerError(500, {}, "boom", headers))).rejects.toMatchObject({
      status: 502,
      code: "llm_failed",
    });
    await expect(run(new Anthropic.AnthropicError("Could not resolve authentication method"))).rejects.toMatchObject({
      status: 503,
      code: "llm_not_configured",
    });
  });
});
