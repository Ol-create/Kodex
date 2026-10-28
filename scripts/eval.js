// Measures retrieval (and optionally answer) quality against an eval set.
//
// Usage:
//   npm run eval -- [--set eval/leddar.jsonl] [--tenant leddar] [--answers]
//                   [--min-score 0.4] [--top-k 5]
//
// Each line of the set is a JSON case:
//   { id, audience: [...], question, expect: "answer" | "no_answer",
//     sources?: [externalId...], mustMention?: [regex...], mustNotMention?: [regex...] }
//
// Retrieval only (default) costs one embedding request for the whole set.
// --answers also calls the LLM once per case that passes the minScore gate.
// Results are written to eval/results/ (gitignored); eval runs don't touch QueryLog.
import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { env } from "../src/config/env.js";
import prisma from "../src/config/prisma.js";
import { createEmbedder } from "../src/lib/embeddings/index.js";
import { createLlm } from "../src/lib/llm/index.js";
import { parseTenantConfig } from "../src/lib/tenantConfig.js";
import { createAskService } from "../src/modules/ask/ask.service.js";
import { createRetriever } from "../src/modules/ask/retriever.js";
import { suggestMinScore } from "../src/lib/evalMetrics.js";

const { values } = parseArgs({
  options: {
    set: { type: "string", default: "eval/leddar.jsonl" },
    tenant: { type: "string", default: "leddar" },
    answers: { type: "boolean", default: false },
    "min-score": { type: "string" },
    "top-k": { type: "string" },
  },
});

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "-");
const matches = (text, pattern) => new RegExp(pattern, "i").test(text);

async function main() {
  const lines = (await fs.readFile(values.set, "utf8")).split(/\r?\n/).filter((l) => l.trim());
  const cases = lines.map((line, i) => {
    try {
      return { audience: [], sources: [], mustMention: [], mustNotMention: [], ...JSON.parse(line) };
    } catch (err) {
      throw new Error(`${values.set}:${i + 1}: ${err.message}`);
    }
  });

  const row = await prisma.tenant.findUnique({ where: { slug: values.tenant } });
  if (!row) throw new Error(`No tenant with slug "${values.tenant}"`);
  const config = parseTenantConfig(row.config);
  if (values["min-score"]) config.retrieval.minScore = Number(values["min-score"]);
  if (values["top-k"]) config.retrieval.topK = Number(values["top-k"]);
  const tenant = { id: row.id, slug: row.slug, config };
  const { topK, minScore } = config.retrieval;

  // One embedding request for every question (Voyage's free tier allows 3 per minute).
  const embedder = createEmbedder(env);
  const vectors = await embedder.embedQueries(cases.map((c) => c.question));
  const cache = new Map(cases.map((c, i) => [c.question, vectors[i]]));
  const cachedEmbedder = { ...embedder, embedQuery: async (text) => cache.get(text) ?? embedder.embedQuery(text) };

  const retriever = createRetriever({ db: prisma, embedder: cachedEmbedder });
  const llm = values.answers ? createLlm(env) : null;
  const ask = createAskService({ retriever, llm, queryLog: { record() {} } });

  console.log(`Eval ${values.set}: ${cases.length} cases, tenant ${tenant.slug}, topK ${topK}, minScore ${minScore}`);
  console.log(`Embeddings ${embedder.provider}/${embedder.model}${llm ? `, LLM ${llm.provider}/${llm.model}` : ""}\n`);

  const results = [];
  for (const c of cases) {
    const { sources, confidence } = await ask.retrieve(tenant, { question: c.question, audience: c.audience });
    const ids = sources.map((s) => s.externalId);
    const rank = c.sources.length ? ids.findIndex((id) => c.sources.includes(id)) + 1 : null;
    const result = { ...c, confidence, retrieved: ids, rank, passesGate: confidence >= minScore };

    if (llm) {
      const answer = await ask.ask(tenant, { question: c.question, audience: c.audience, history: [] });
      const failures = [];
      const declined = answer.status === "no_context" || answer.status === "no_answer";
      if (c.expect === "answer" && declined) failures.push(`expected an answer, got ${answer.status}`);
      if (c.expect === "no_answer" && !declined) failures.push(`expected no answer, got ${answer.status}`);
      if (c.expect === "answer" && answer.status === "answered") {
        for (const p of c.mustMention) if (!matches(answer.answer, p)) failures.push(`missing /${p}/`);
        if (!answer.sources.some((s) => s.cited)) failures.push("no citations");
      }
      for (const p of c.mustNotMention) if (matches(answer.answer, p)) failures.push(`mentions /${p}/`);
      Object.assign(result, { status: answer.status, answer: answer.answer, usage: answer.usage, failures, pass: !failures.length });
    }
    results.push(result);

    const hit = rank === null ? "     " : rank ? `hit@${rank}` : "MISS ";
    const verdict = llm ? (result.pass ? " PASS" : ` FAIL (${result.failures.join("; ")})`) : "";
    console.log(`${String(confidence.toFixed(3)).padStart(6)} ${hit} ${c.expect.padEnd(9)} ${c.id}${verdict}`);
  }

  // Retrieval
  const answerable = results.filter((r) => r.expect === "answer");
  const unanswerable = results.filter((r) => r.expect === "no_answer");
  const withSources = answerable.filter((r) => r.sources.length);
  const hits = withSources.filter((r) => r.rank > 0);
  const mrr = withSources.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / (withSources.length || 1);
  console.log(`\nRetrieval: hit@${topK} ${hits.length}/${withSources.length} (${pct(hits.length, withSources.length)}), MRR ${mrr.toFixed(3)}`);
  for (const r of withSources.filter((r) => !r.rank)) console.log(`  miss ${r.id}: got ${r.retrieved.slice(0, 3).join(", ")}`);

  // Confidence gate
  const range = (rs) => (rs.length ? `${Math.min(...rs.map((r) => r.confidence)).toFixed(3)}–${Math.max(...rs.map((r) => r.confidence)).toFixed(3)}` : "-");
  const kept = answerable.filter((r) => r.passesGate).length;
  const blocked = unanswerable.filter((r) => !r.passesGate).length;
  console.log(`\nConfidence: answerable ${range(answerable)}, unanswerable ${range(unanswerable)}`);
  console.log(`minScore ${minScore}: lets through ${kept}/${answerable.length} answerable, blocks ${blocked}/${unanswerable.length} unanswerable`);
  const best = suggestMinScore(results);
  console.log(`Suggested minScore ${best.threshold}: lets through ${best.kept}/${answerable.length}, blocks ${best.blocked}/${unanswerable.length}`);

  // Answers
  if (llm) {
    const passed = results.filter((r) => r.pass).length;
    const tokens = results.reduce((t, r) => ({ in: t.in + (r.usage?.inputTokens ?? 0), out: t.out + (r.usage?.outputTokens ?? 0) }), { in: 0, out: 0 });
    console.log(`\nAnswers: ${passed}/${results.length} passed (${pct(passed, results.length)}); tokens in ${tokens.in}, out ${tokens.out}`);
  }

  await fs.mkdir("eval/results", { recursive: true });
  const file = `eval/results/${tenant.slug}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await fs.writeFile(file, JSON.stringify({ set: values.set, topK, minScore, results }, null, 2));
  console.log(`\nSaved ${file}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
