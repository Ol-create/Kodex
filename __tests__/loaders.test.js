import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findFiles, loadFile, parseFrontmatter } from "../src/lib/loaders.js";

describe("parseFrontmatter", () => {
  it("parses scalars and lists", () => {
    const { data, body } = parseFrontmatter('---\ntitle: "Payouts"\naudience: [artisan, admin]\n---\n# Body');
    expect(data).toEqual({ title: "Payouts", audience: ["artisan", "admin"] });
    expect(body).toBe("# Body");
  });

  it("returns the text untouched without frontmatter", () => {
    expect(parseFrontmatter("# Hello")).toEqual({ data: {}, body: "# Hello" });
  });

  it("handles CRLF line endings", () => {
    const { data, body } = parseFrontmatter("---\r\naudience: [brand]\r\n---\r\nText");
    expect(data.audience).toEqual(["brand"]);
    expect(body).toBe("Text");
  });
});

describe("loadFile / findFiles", () => {
  let dir;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodex-loaders-"));
    await fs.mkdir(path.join(dir, "nested"));
    await fs.mkdir(path.join(dir, ".hidden"));
    await fs.writeFile(path.join(dir, "faq.md"), "---\naudience: [brand]\n---\n# Brand FAQ\n\nHello");
    await fs.writeFile(path.join(dir, "nested", "notes.txt"), "  plain text  ");
    await fs.writeFile(path.join(dir, "nested", "untitled.md"), "No heading here");
    await fs.writeFile(path.join(dir, "image.png"), "binary");
    await fs.writeFile(path.join(dir, ".hidden", "secret.md"), "skip me");
  });

  afterAll(() => fs.rm(dir, { recursive: true, force: true }));

  it("finds supported files recursively, skipping hidden folders", async () => {
    const files = (await findFiles(dir)).map((f) => path.relative(dir, f).split(path.sep).join("/"));
    expect(files).toEqual(["faq.md", "nested/notes.txt", "nested/untitled.md"]);
  });

  it("loads markdown with frontmatter and an H1 title", async () => {
    const doc = await loadFile(path.join(dir, "faq.md"));
    expect(doc).toEqual({
      title: "Brand FAQ",
      content: "# Brand FAQ\n\nHello",
      format: "markdown",
      frontmatter: { audience: ["brand"] },
    });
  });

  it("falls back to the file name as title", async () => {
    expect((await loadFile(path.join(dir, "nested", "untitled.md"))).title).toBe("untitled");
    const txt = await loadFile(path.join(dir, "nested", "notes.txt"));
    expect(txt).toMatchObject({ title: "notes", content: "plain text", format: "text" });
  });

  it("rejects unsupported files", async () => {
    await expect(loadFile(path.join(dir, "image.png"))).rejects.toThrow("Unsupported file type");
  });
});
