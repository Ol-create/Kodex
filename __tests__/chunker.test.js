import { chunkText, estimateTokens, splitBlocks, splitMarkdownSections } from "../src/lib/chunker.js";

const paragraph = (words, word = "word") => Array.from({ length: words }, (_, i) => `${word}${i}`).join(" ") + ".";

describe("splitMarkdownSections", () => {
  it("tracks the heading path", () => {
    const sections = splitMarkdownSections(
      ["Intro text", "# Payments", "About payments", "## Balance", "Pay the balance", "# KYC", "Verify"].join("\n"),
    );

    expect(sections).toEqual([
      { path: [], body: "Intro text" },
      { path: ["Payments"], body: "About payments" },
      { path: ["Payments", "Balance"], body: "Pay the balance" },
      { path: ["KYC"], body: "Verify" },
    ]);
  });

  it("ignores headings inside code fences", () => {
    const sections = splitMarkdownSections(["# Setup", "```bash", "# not a heading", "```"].join("\n"));
    expect(sections).toHaveLength(1);
    expect(sections[0].body).toContain("# not a heading");
  });

  it("skips headings with no body", () => {
    const sections = splitMarkdownSections("# Title\n## Sub\nBody");
    expect(sections).toEqual([{ path: ["Title", "Sub"], body: "Body" }]);
  });
});

describe("splitBlocks", () => {
  it("splits on blank lines but keeps code blocks whole", () => {
    const blocks = splitBlocks(["one", "", "```", "a", "", "b", "```", "", "two"].join("\n"));
    expect(blocks).toEqual(["one", "```\na\n\nb\n```", "two"]);
  });
});

describe("chunkText", () => {
  it("returns nothing for blank input", () => {
    expect(chunkText("  \n ")).toEqual([]);
  });

  it("prefixes each chunk with title and section path, without repeating an H1 title", () => {
    const chunks = chunkText("# Guide\n## Payouts\nPaid weekly.", { title: "Guide" });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("Guide > Payouts\n\nPaid weekly.");
    expect(chunks[0].section).toBe("Guide > Payouts");
  });

  it("never mixes sections in one chunk", () => {
    const chunks = chunkText("# A\nalpha\n# B\nbeta");
    expect(chunks.map((c) => c.content)).toEqual(["A\n\nalpha", "B\n\nbeta"]);
  });

  it("keeps every chunk within maxTokens and numbers them in order", () => {
    const text = Array.from({ length: 30 }, () => paragraph(40)).join("\n\n");
    const chunks = chunkText(text, { maxTokens: 200, overlapTokens: 30, format: "text" });

    expect(chunks.length).toBeGreaterThan(5);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.tokenCount).toBeLessThanOrEqual(200);
      expect(c.tokenCount).toBe(estimateTokens(c.content));
    });
  });

  it("overlaps consecutive chunks", () => {
    const paragraphs = ["first", "second", "third", "fourth"].map((w) => paragraph(60, w));
    const chunks = chunkText(paragraphs.join("\n\n"), { maxTokens: 250, overlapTokens: 40, format: "text" });

    expect(chunks.length).toBeGreaterThan(1);
    // The start of chunk 2 repeats the tail of chunk 1.
    const tailOfFirst = chunks[0].content.slice(-30);
    expect(chunks[1].content).toContain(tailOfFirst);
  });

  it("splits a single oversized paragraph", () => {
    const sentences = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} talks about leather goods.`).join(" ");
    const chunks = chunkText(sentences, { maxTokens: 100, overlapTokens: 0, format: "text" });

    expect(chunks.length).toBeGreaterThan(3);
    chunks.forEach((c) => expect(c.tokenCount).toBeLessThanOrEqual(100));
    expect(chunks.map((c) => c.content).join(" ")).toContain("Sentence number 49");
  });

  it("hard-splits text with no sentence or line breaks", () => {
    const chunks = chunkText("x".repeat(2000), { maxTokens: 100, overlapTokens: 0, format: "text" });
    chunks.forEach((c) => expect(c.tokenCount).toBeLessThanOrEqual(100));
    expect(chunks.map((c) => c.content).join("")).toHaveLength(2000);
  });
});
