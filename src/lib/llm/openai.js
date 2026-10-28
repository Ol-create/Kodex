import OpenAI from "openai";
import { AppError } from "../../utils/AppError.js";

const MAX_OUTPUT_TOKENS = 16_000;

// Only reasoning models accept `reasoning.effort`; others reject it with a 400.
const isReasoningModel = (model) => /^(gpt-5|gpt-6|o\d)/.test(model) && !model.includes("chat-latest");

// Same completion shape as the Anthropic client: { text, status, model,
// fellBack, usage }, where status is "complete" | "refused" | "truncated".
function toCompletion(response) {
  const parts = response.output.filter((item) => item.type === "message").flatMap((item) => item.content);
  const text = parts
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("")
    .trim();

  const reason = response.incomplete_details?.reason;
  const refused = parts.some((part) => part.type === "refusal") || reason === "content_filter";
  const status = refused ? "refused" : reason === "max_output_tokens" ? "truncated" : "complete";

  return {
    text,
    status,
    model: response.model,
    fellBack: false,
    usage: { inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null },
  };
}

function toAppError(err) {
  // APIUserAbortError extends APIError, so it must be checked first.
  if (err instanceof OpenAI.APIUserAbortError) return err;
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new AppError(503, "OpenAI credentials are invalid", "llm_not_configured");
  }
  // OpenAI reports an empty balance as a 429 too, but retrying won't help.
  // Mid-stream errors arrive as a plain APIError with no status, so match on type.
  if (err instanceof OpenAI.APIError && err.type === "insufficient_quota") {
    return new AppError(503, "OpenAI account has no credits; add billing at platform.openai.com", "llm_quota_exceeded");
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new AppError(503, "The language model is rate limited; retry shortly", "llm_rate_limited");
  }
  if (err instanceof OpenAI.APIError) {
    return new AppError(502, `Language model error: ${err.message}`, "llm_failed");
  }
  if (err instanceof OpenAI.OpenAIError) {
    // Raised before any request is sent, e.g. OPENAI_API_KEY is missing.
    return new AppError(503, `Language model is not configured: ${err.message}`, "llm_not_configured");
  }
  return err;
}

export function createOpenAiLlm({ apiKey, model, effort, client }) {
  let openai = client;
  const getClient = () => {
    try {
      // Without an explicit key the SDK reads OPENAI_API_KEY.
      openai ??= new OpenAI(apiKey ? { apiKey } : {});
      return openai;
    } catch (err) {
      throw toAppError(err);
    }
  };

  const params = ({ system, messages }) => ({
    model,
    instructions: system,
    input: messages,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    // Don't keep tenant documents on OpenAI's side for later retrieval.
    store: false,
    ...(isReasoningModel(model) && { reasoning: { effort } }),
  });

  return {
    provider: "openai",
    model,

    async generate(prompt) {
      try {
        return toCompletion(await getClient().responses.create(params(prompt)));
      } catch (err) {
        throw toAppError(err);
      }
    },

    // Calls onText for each text delta, then resolves with the full completion.
    async stream(prompt, { onText, signal } = {}) {
      try {
        const stream = getClient().responses.stream(params(prompt), { signal });
        if (onText) stream.on("response.output_text.delta", (event) => onText(event.delta));
        return toCompletion(await stream.finalResponse());
      } catch (err) {
        throw toAppError(err);
      }
    },
  };
}
