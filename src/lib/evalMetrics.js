const STEP = 0.005;
const roundToStep = (n) => Math.round(n / STEP) * STEP;

// The minScore that lets the most answerable cases through while blocking the
// most unanswerable ones. Several thresholds usually tie; this takes the middle
// of the lowest tying range, so a small score shift doesn't flip results.
export function suggestMinScore(cases) {
  const score = (threshold) => ({
    kept: cases.filter((c) => c.expect === "answer" && c.confidence >= threshold).length,
    blocked: cases.filter((c) => c.expect === "no_answer" && c.confidence < threshold).length,
  });

  const thresholds = [];
  for (let i = 0.2 / STEP; i <= 0.7 / STEP + 1e-9; i++) thresholds.push(roundToStep(i * STEP));
  const scored = thresholds.map((threshold) => ({ threshold, ...score(threshold) }));
  const top = Math.max(...scored.map((s) => s.kept + s.blocked));

  const first = scored.findIndex((s) => s.kept + s.blocked === top);
  let last = first;
  while (last + 1 < scored.length && scored[last + 1].kept + scored[last + 1].blocked === top) last++;

  const threshold = Math.round(roundToStep((scored[first].threshold + scored[last].threshold) / 2) * 1000) / 1000;
  return { threshold, ...score(threshold) };
}
