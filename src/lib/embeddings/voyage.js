import { postJson } from "../http.js";
import { AppError } from "../../utils/AppError.js";
import { batches } from "./batches.js";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const MAX_BATCH_SIZE = 128; // Voyage allows 1000; smaller batches retry cheaper

// https://docs.voyageai.com/reference/embeddings-api
export function createVoyageEmbedder({ apiKey, model = "voyage-3.5", dimensions, http = postJson }) {
  async function embed(texts, inputType) {
    if (!apiKey) {
      throw new AppError(503, "VOYAGE_API_KEY is not set", "embedding_not_configured");
    }

    const vectors = [];
    for (const batch of batches(texts, MAX_BATCH_SIZE)) {
      const res = await http(
        VOYAGE_URL,
        // input_type lets Voyage optimise documents and queries differently.
        { input: batch, model, input_type: inputType, output_dimension: dimensions },
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      const ordered = [...res.data].sort((a, b) => a.index - b.index);
      vectors.push(...ordered.map((d) => d.embedding));
    }
    return vectors;
  }

  return {
    provider: "voyage",
    model,
    dimensions,
    embedDocuments: (texts) => embed(texts, "document"),
    embedQuery: async (text) => (await embed([text], "query"))[0],
    embedQueries: (texts) => embed(texts, "query"),
  };
}
