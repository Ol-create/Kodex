import { createAnthropicLlm } from "./anthropic.js";
import { createOpenAiLlm } from "./openai.js";

export const DEFAULT_LLM_MODELS = {
  openai: "gpt-5.4-mini",
  anthropic: "claude-opus-5-5",
};

// An LLM exposes:
//   provider, model
//   generate(prompt)                     -> completion
//   stream(prompt, { onText, signal })   -> completion
// where prompt is { system, messages } and a completion is
// { text, status, model, fellBack, usage }.
export function createLlm(env) {
  const provider = env.LLM_PROVIDER;
  const options = { model: env.LLM_MODEL ?? DEFAULT_LLM_MODELS[provider], effort: env.LLM_EFFORT };

  return provider === "anthropic"
    ? createAnthropicLlm({ ...options, apiKey: env.ANTHROPIC_API_KEY })
    : createOpenAiLlm({ ...options, apiKey: env.OPENAI_API_KEY });
}
