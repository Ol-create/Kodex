import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "../../utils/AppError.js";

const MAX_TOKENS = 16_000;

// With `fallbacks: "default"`, a request declined by Claude's safety
// classifiers is re-run server-side on the model Anthropic recommends for that
// refusal category, so a false positive on a help question doesn't become an
// outage. Remove both fields to opt out.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// A completion is { text, status, model, fellBack, usage }, where status is
// "complete" | "refused" | "truncated".
function toCompletion(message) {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  const status =
    message.stop_reason === "refusal" ? "refused" : message.stop_reason === "max_tokens" ? "truncated" : "complete";

  return {
    text,
    status,
    model: message.model,
    fellBack: (message.usage.iterations ?? []).some((entry) => entry.type === "fallback_message"),
    usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
  };
}

function toAppError(err) {
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AppError(503, "Anthropic credentials are invalid", "llm_not_configured");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AppError(503, "The language model is rate limited; retry shortly", "llm_rate_limited");
  }
  if (err instanceof Anthropic.APIError) {
    return new AppError(502, `Language model error: ${err.message}`, "llm_failed");
  }
  if (err instanceof Anthropic.AnthropicError) {
    // Raised before any request is sent, e.g. no credentials could be resolved.
    return new AppError(503, `Language model is not configured: ${err.message}`, "llm_not_configured");
  }
  return err;
}

export function createAnthropicLlm({ apiKey, model, effort, client }) {
  let anthropic = client;
  const getClient = () => {
    try {
      // Without an explicit key the SDK resolves ANTHROPIC_API_KEY,
      // ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
      anthropic ??= new Anthropic(apiKey ? { apiKey } : {});
      return anthropic;
    } catch (err) {
      throw toAppError(err);
    }
  };

  const params = ({ system, messages }) => ({
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages,
    output_config: { effort },
    betas: [FALLBACK_BETA],
    fallbacks: "default",
  });

  return {
    provider: "anthropic",
    model,

    async generate(prompt) {
      try {
        return toCompletion(await getClient().beta.messages.create(params(prompt)));
      } catch (err) {
        throw toAppError(err);
      }
    },

    // Calls onText for each text delta, then resolves with the full completion.
    async stream(prompt, { onText, signal } = {}) {
      try {
        const stream = getClient().beta.messages.stream(params(prompt), { signal });
        if (onText) stream.on("text", (delta) => onText(delta));
        return toCompletion(await stream.finalMessage());
      } catch (err) {
        throw toAppError(err);
      }
    },
  };
}
