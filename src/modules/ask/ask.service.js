import { z } from "zod";
import { AppError } from "../../utils/AppError.js";
import { buildPrompt, extractCitations, NO_ANSWER } from "./prompt.js";

const SNIPPET_LENGTH = 280;

// `audience` may be one label ("brand") or several (["admin", "brand"]).
const audienceField = z
  .union([z.string().trim().min(1), z.array(z.string().trim().min(1)).max(10)])
  .optional()
  .transform((value) => (value === undefined ? [] : [...new Set([value].flat())]));

export const searchSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  audience: audienceField,
  topK: z.number().int().min(1).max(20).optional(),
});

export const askSchema = searchSchema.extend({
  userId: z.string().trim().min(1).max(200).optional(),
  // Earlier turns of the conversation, oldest first. Retrieval uses only the
  // latest question; history helps the model resolve "it", "that order", etc.
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(8000) }))
    .max(20)
    .default([]),
  stream: z.boolean().default(false),
});

const round = (n) => Math.round(n * 1000) / 1000;

const isNoAnswer = (text) => text.trimStart().startsWith(NO_ANSWER);

// Holds streamed text back while it could still be the NO_ANSWER marker, so
// clients never see the marker; once the text diverges it passes straight through.
function withoutMarker(onText) {
  let held = "";
  let passing = false;
  return {
    push(delta) {
      if (passing) return onText(delta);
      held += delta;
      const start = held.trimStart();
      if (NO_ANSWER.startsWith(start) || start.startsWith(NO_ANSWER)) return;
      passing = true;
      onText(held);
    },
    // Releases a short reply that never diverged from a prefix of the marker.
    flush() {
      if (!passing && held && !isNoAnswer(held)) onText(held);
    },
  };
}

export function createAskService({ retriever, llm, queryLog }) {
  function assertAudiences(tenant, audiences) {
    const allowed = tenant.config.audiences;
    const unknown = allowed.length ? audiences.filter((a) => !allowed.includes(a)) : [];
    if (unknown.length) {
      throw new AppError(400, `Unknown audience(s) ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}`, "invalid_audience");
    }
  }

  // Numbered sources ([1], [2], ...) in ranking order, plus overall confidence.
  async function retrieve(tenant, { question, audience, topK }) {
    assertAudiences(tenant, audience);
    const chunks = await retriever.search(tenant, {
      query: question,
      audiences: audience,
      topK: topK ?? tenant.config.retrieval.topK,
    });

    const sources = chunks.map((chunk, i) => ({
      id: i + 1,
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      externalId: chunk.externalId,
      title: chunk.title,
      section: chunk.section,
      source: chunk.source,
      content: chunk.content,
      similarity: round(chunk.similarity),
      matchedBy: chunk.matchedBy,
    }));
    const confidence = sources.length ? Math.max(...sources.map((s) => s.similarity)) : 0;
    return { sources, confidence };
  }

  // Follow-ups like "do I pay extra for those?" match nothing on their own.
  // When the question alone falls below minScore, search again with the
  // previous user question prepended and keep whichever result is stronger.
  // Costs a second embedding only for weak questions asked mid-conversation.
  async function retrieveForConversation(tenant, input) {
    const first = await retrieve(tenant, input);
    const previous = input.history?.findLast((m) => m.role === "user")?.content;
    if (!previous || first.confidence >= tenant.config.retrieval.minScore) return first;

    const second = await retrieve(tenant, { ...input, question: `${previous}\n${input.question}` });
    return second.confidence > first.confidence ? second : first;
  }

  const publicSource = ({ content, ...source }, cited) => ({ ...source, snippet: content.slice(0, SNIPPET_LENGTH), cited });

  return {
    retrieve,

    // Answers a question from the tenant's documents. When onText is given the
    // answer is streamed; onSources fires once retrieval is done, before generation.
    async ask(tenant, input, { onSources, onText, signal } = {}) {
      const started = Date.now();
      const log = {
        tenantId: tenant.id,
        userId: input.userId ?? null,
        question: input.question,
        audiences: input.audience,
        chunkIds: [],
        citedChunkIds: [],
      };

      try {
        const { sources, confidence } = await retrieveForConversation(tenant, input);
        log.chunkIds = sources.map((s) => s.chunkId);
        log.confidence = confidence;
        onSources?.(sources.map((s) => publicSource(s, false)), confidence);

        // Nothing relevant enough: answer with the fallback instead of letting
        // the model improvise. This also saves an LLM call.
        if (sources.length === 0 || confidence < tenant.config.retrieval.minScore) {
          const result = {
            status: "no_context",
            answer: tenant.config.fallbackAnswer,
            confidence,
            sources: sources.map((s) => publicSource(s, false)),
            model: null,
            usage: null,
          };
          queryLog.record({ ...log, status: result.status, answer: result.answer, latencyMs: Date.now() - started });
          return result;
        }

        const prompt = buildPrompt({
          systemPrompt: tenant.config.systemPrompt,
          question: input.question,
          sources,
          history: input.history,
        });
        let completion;
        if (onText) {
          const filter = withoutMarker(onText);
          completion = await llm.stream(prompt, { onText: filter.push, signal });
          filter.flush();
        } else {
          completion = await llm.generate(prompt);
        }

        // "refused": the model declined; "no_answer": the sources didn't cover
        // the question. Both get the fallback, and neither cites anything.
        const status =
          completion.status === "refused" ? "refused" : isNoAnswer(completion.text) ? "no_answer" : "answered";
        const answered = status === "answered";
        const cited = answered ? extractCitations(completion.text, sources.length) : [];
        const result = {
          status,
          answer: answered ? completion.text : tenant.config.fallbackAnswer,
          confidence,
          sources: sources.map((s) => publicSource(s, cited.includes(s.id))),
          model: completion.model,
          usage: completion.usage,
        };

        queryLog.record({
          ...log,
          status: result.status,
          answer: result.answer,
          citedChunkIds: sources.filter((s) => cited.includes(s.id)).map((s) => s.chunkId),
          model: completion.model,
          inputTokens: completion.usage.inputTokens,
          outputTokens: completion.usage.outputTokens,
          latencyMs: Date.now() - started,
        });
        return result;
      } catch (err) {
        queryLog.record({ ...log, status: "error", latencyMs: Date.now() - started });
        throw err;
      }
    },
  };
}
