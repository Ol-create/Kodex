import { suggestMinScore } from "../src/lib/evalMetrics.js";

describe("suggestMinScore", () => {
  it("picks the middle of the range that best separates answerable from unanswerable", () => {
    const cases = [
      { expect: "answer", confidence: 0.6 },
      { expect: "answer", confidence: 0.45 },
      { expect: "no_answer", confidence: 0.38 },
      { expect: "no_answer", confidence: 0.3 },
    ];
    // Every threshold from 0.385 to 0.45 separates them; the middle rounds to 0.42.
    expect(suggestMinScore(cases)).toEqual({ threshold: 0.42, kept: 2, blocked: 2 });
  });

  it("prefers keeping answers when the groups overlap", () => {
    const cases = [
      { expect: "answer", confidence: 0.4 },
      { expect: "answer", confidence: 0.5 },
      { expect: "no_answer", confidence: 0.45 },
    ];
    expect(suggestMinScore(cases)).toMatchObject({ kept: 2, blocked: 0 });
  });
});
