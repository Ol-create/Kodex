import fs from "node:fs/promises";
import path from "node:path";

export const SUPPORTED_EXTENSIONS = [".md", ".markdown", ".txt", ".pdf"];

// Reads a file into { title, content, format, frontmatter }.
// Markdown files may start with simple frontmatter:
//   ---
//   title: Payouts
//   audience: [artisan]
//   ---
export async function loadFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const fallbackTitle = path.basename(filePath, ext);

  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(await fs.readFile(filePath)), { verbosity: 0 });
    const { text } = await extractText(pdf, { mergePages: true });
    return { title: fallbackTitle, content: text.trim(), format: "text", frontmatter: {} };
  }

  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported file type: ${ext}`);
  }

  const raw = await fs.readFile(filePath, "utf8");
  if (ext === ".txt") {
    return { title: fallbackTitle, content: raw.trim(), format: "text", frontmatter: {} };
  }

  const { data, body } = parseFrontmatter(raw);
  return {
    title: data.title ?? firstHeading(body) ?? fallbackTitle,
    content: body.trim(),
    format: "markdown",
    frontmatter: data,
  };
}

// Minimal YAML-ish frontmatter: `key: value` and `key: [a, b]` lines only.
export function parseFrontmatter(text) {
  const match = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: text };

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!kv) continue;
    const [, key, value] = kv;
    const list = value.match(/^\[(.*)\]$/);
    data[key] = list
      ? list[1].split(",").map(unquote).filter(Boolean)
      : unquote(value);
  }
  return { data, body: text.slice(match[0].length) };
}

const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, "$2");

function firstHeading(markdown) {
  return markdown.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1] ?? null;
}

// Recursively lists supported files under a path (or the path itself).
export async function findFiles(target) {
  const stat = await fs.stat(target);
  if (stat.isFile()) return [target];

  const files = [];
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...(await findFiles(full)));
    else if (SUPPORTED_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) files.push(full);
  }
  return files.sort();
}
