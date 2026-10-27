// Splits documents into retrieval-sized chunks.
//
// Markdown is split on headings first, so a chunk never mixes two sections,
// then packed paragraph by paragraph up to `maxTokens`. Each chunk starts with
// its heading path ("Payments > Balance payment") so the embedding knows what
// the text is about even when the paragraph alone is ambiguous.

// Bump when chunking output changes, so existing documents get re-embedded.
export const CHUNKER_VERSION = 1;

const CHARS_PER_TOKEN = 4; // rough average for English prose

export const estimateTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const PARAGRAPH_GAP = "\n\n";

export function chunkText(text, { maxTokens = 500, overlapTokens = 60, format = "markdown", title } = {}) {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const sections =
    format === "markdown" ? splitMarkdownSections(normalized) : [{ path: [], body: normalized }];

  const chunks = [];
  for (const section of sections) {
    // The title is usually also the document's H1; don't repeat it.
    const path = section.path[0] === title ? section.path : [title, ...section.path];
    const headerPath = path.filter(Boolean).join(" > ");
    const header = headerPath ? headerPath + PARAGRAPH_GAP : "";
    // Leave room for the header in every chunk of this section.
    const bodyBudget = Math.max(50, maxTokens - estimateTokens(header));

    const pieces = splitBlocks(section.body).flatMap((block) =>
      estimateTokens(block) > bodyBudget ? splitOversized(block, bodyBudget) : [block],
    );

    for (const body of pack(pieces, bodyBudget, overlapTokens)) {
      chunks.push({ content: header + body, section: section.path.join(" > ") || null });
    }
  }

  return chunks.map((chunk, index) => ({ index, ...chunk, tokenCount: estimateTokens(chunk.content) }));
}

// Returns [{ path: ["Payments", "Balance"], body }] in document order.
// Headings inside fenced code blocks are ignored.
export function splitMarkdownSections(text) {
  const sections = [];
  let path = [];
  let lines = [];
  let inFence = false;

  const flush = () => {
    const body = lines.join("\n").trim();
    if (body) sections.push({ path: [...path], body });
    lines = [];
  };

  for (const line of text.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    const match = !inFence && line.match(HEADING);
    if (match) {
      flush();
      const level = match[1].length;
      path = [...path.slice(0, level - 1), match[2]];
      // Skipped levels (# then ###) leave holes; drop them.
      path = path.filter(Boolean);
      continue;
    }
    lines.push(line);
  }
  flush();
  return sections;
}

// Splits on blank lines, keeping fenced code blocks whole.
export function splitBlocks(body) {
  const blocks = [];
  let current = [];
  let inFence = false;

  for (const line of body.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === "") {
      if (current.length) blocks.push(current.join("\n").trim());
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join("\n").trim());
  return blocks.filter(Boolean);
}

// Breaks a block that is too big on its own: by sentence, then by line,
// then (last resort) by character count at a word boundary.
function splitOversized(block, maxTokens) {
  const separators = [/(?<=[.!?])\s+/, /\n/];

  const split = (text, level) => {
    if (estimateTokens(text) <= maxTokens) return [text];
    if (level >= separators.length) return hardSplit(text, maxTokens);
    const parts = text.split(separators[level]).filter((p) => p.trim());
    if (parts.length === 1) return split(text, level + 1);
    return pack(parts.flatMap((p) => split(p, level + 1)), maxTokens, 0, " ");
  };

  return split(block, 0);
}

function hardSplit(text, maxTokens) {
  const size = maxTokens * CHARS_PER_TOKEN;
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf(" ", size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

// Greedily joins pieces into chunks of at most maxTokens. Each new chunk
// starts with up to overlapTokens of the previous chunk's tail, so a fact
// split across a boundary is still retrievable from either side.
function pack(pieces, maxTokens, overlapTokens, joiner = PARAGRAPH_GAP) {
  const chunks = [];
  let current = [];
  const size = (parts) => estimateTokens(parts.join(joiner));

  for (const piece of pieces) {
    if (current.length && size([...current, piece]) > maxTokens) {
      chunks.push(current.join(joiner));
      const overlap = tailOverlap(current, overlapTokens);
      current = overlap && size([overlap, piece]) <= maxTokens ? [overlap] : [];
    }
    current.push(piece);
  }
  if (current.length) chunks.push(current.join(joiner));
  return chunks;
}

function tailOverlap(parts, overlapTokens) {
  if (overlapTokens <= 0) return null;
  const last = parts.at(-1);
  if (estimateTokens(last) <= overlapTokens) return last;

  const tail = last.slice(-overlapTokens * CHARS_PER_TOKEN);
  const firstSpace = tail.indexOf(" ");
  const trimmed = firstSpace === -1 ? tail : tail.slice(firstSpace + 1);
  return trimmed ? "…" + trimmed : null;
}
