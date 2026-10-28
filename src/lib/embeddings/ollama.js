import { postJson } from "../http.js";
import { batches } from "./batches.js";

const MAX_BATCH_SIZE = 32;

// mxbai-embed-large is trained with this prefix on queries (not documents).
const QUERY_PREFIXES = {
  "mxbai-embed-large": "Represent this sentence for searching relevant passages: ",
};

// https://github.com/ollama/ollama/blob/main/docs/api.md#generate-embeddings
export function createOllamaEmbedder({ baseUrl, model = "mxbai-embed-large", dimensions, http = postJson }) {
  const url = `${baseUrl.replace(/\/$/, "")}/api/embed`;
  const queryPrefix = QUERY_PREFIXES[model.split(":")[0]] ?? "";

  async function embed(texts) {
    const vectors = [];
    for (const batch of batches(texts, MAX_BATCH_SIZE)) {
      const res = await http(url, { model, input: batch }, { retries: 2 });
      vectors.push(...res.embeddings);
    }
    return vectors;
  }

  return {
    provider: "ollama",
    model,
    dimensions,
    embedDocuments: (texts) => embed(texts),
    embedQuery: async (text) => (await embed([queryPrefix + text]))[0],
    embedQueries: (texts) => embed(texts.map((text) => queryPrefix + text)),
  };
}
