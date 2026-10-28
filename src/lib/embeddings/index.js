import { AppError } from "../../utils/AppError.js";
import { HttpError } from "../http.js";
import { createOllamaEmbedder } from "./ollama.js";
import { createVoyageEmbedder } from "./voyage.js";

// An embedder exposes:
//   provider, model, dimensions
//   embedDocuments(texts: string[]) -> number[][]
//   embedQuery(text: string)        -> number[]
//   embedQueries(texts: string[])   -> number[][]  (many queries in one request)
export function createEmbedder(env) {
  const options = { model: env.EMBEDDING_MODEL, dimensions: env.EMBEDDING_DIMENSIONS };

  const embedder =
    env.EMBEDDING_PROVIDER === "ollama"
      ? createOllamaEmbedder({ ...options, baseUrl: env.OLLAMA_BASE_URL })
      : createVoyageEmbedder({ ...options, apiKey: env.VOYAGE_API_KEY });

  return withSafetyChecks(embedder);
}

// Every vector must match the database column, and provider failures should
// reach API callers as a clean 502 rather than a stack trace.
export function withSafetyChecks(embedder) {
  const check = (vectors, expectedCount) => {
    if (vectors.length !== expectedCount) {
      throw new AppError(502, `Embedding provider returned ${vectors.length} vectors for ${expectedCount} inputs`, "embedding_failed");
    }
    for (const v of vectors) {
      if (v.length !== embedder.dimensions) {
        throw new AppError(
          500,
          `${embedder.provider}/${embedder.model} returned ${v.length} dimensions but EMBEDDING_DIMENSIONS is ${embedder.dimensions}`,
          "embedding_dimension_mismatch",
        );
      }
    }
    return vectors;
  };

  const guard = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError) {
        throw new AppError(502, `Embedding provider error: ${err.message}`, "embedding_failed");
      }
      throw err;
    }
  };

  return {
    ...embedder,
    embedDocuments: (texts) =>
      texts.length === 0 ? Promise.resolve([]) : guard(async () => check(await embedder.embedDocuments(texts), texts.length)),
    embedQuery: (text) => guard(async () => check([await embedder.embedQuery(text)], 1)[0]),
    embedQueries: (texts) =>
      texts.length === 0 ? Promise.resolve([]) : guard(async () => check(await embedder.embedQueries(texts), texts.length)),
  };
}
