// Bulk-ingest local files (.md, .markdown, .txt, .pdf) for a tenant.
//
// Usage:
//   npm run ingest -- <file-or-dir> [--tenant leddar] [--source docs]
//                     [--audience brand,artisan] [--prune]
//
// externalId is "<source>:<path relative to the target>", so re-running the
// same command updates documents in place. Markdown frontmatter `audience:`
// and `title:` override the flags per file. --prune deletes documents of the
// same source that no longer exist on disk; use a distinct --source per corpus.
import path from "node:path";
import { parseArgs } from "node:util";
import { env } from "../src/config/env.js";
import prisma from "../src/config/prisma.js";
import { createEmbedder } from "../src/lib/embeddings/index.js";
import { findFiles, loadFile } from "../src/lib/loaders.js";
import { parseTenantConfig } from "../src/lib/tenantConfig.js";
import { createDocumentRepo } from "../src/modules/documents/documents.repo.js";
import { createIngestService } from "../src/modules/documents/ingest.service.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tenant: { type: "string", default: "leddar" },
    source: { type: "string", default: "docs" },
    audience: { type: "string", default: "" },
    prune: { type: "boolean", default: false },
  },
});

const target = positionals[0];
if (!target) {
  console.error("Usage: npm run ingest -- <file-or-dir> [--tenant leddar] [--source docs] [--audience brand,artisan] [--prune]");
  process.exit(1);
}

const toList = (value) => (Array.isArray(value) ? value : String(value).split(",")).map((s) => s.trim()).filter(Boolean);

async function main() {
  const tenantRow = await prisma.tenant.findUnique({ where: { slug: values.tenant } });
  if (!tenantRow) throw new Error(`No tenant with slug "${values.tenant}"`);
  const tenant = { id: tenantRow.id, slug: tenantRow.slug, config: parseTenantConfig(tenantRow.config) };

  const embedder = createEmbedder(env);
  const repo = createDocumentRepo(prisma);
  const ingestService = createIngestService({ repo, embedder });

  const root = path.resolve(target);
  const files = await findFiles(root);
  const base = files.length === 1 && files[0] === root ? path.dirname(root) : root;
  console.log(`Ingesting ${files.length} file(s) into ${tenant.slug} with ${embedder.provider}/${embedder.model}\n`);

  const seen = [];
  let failed = 0;
  for (const file of files) {
    const relative = path.relative(base, file).split(path.sep).join("/");
    const externalId = `${values.source}:${relative}`;
    seen.push(externalId);
    try {
      const loaded = await loadFile(file);
      const [result] = await ingestService.ingest(tenant, [
        {
          externalId,
          title: loaded.title,
          content: loaded.content,
          format: loaded.format,
          source: values.source,
          audience: toList(loaded.frontmatter.audience ?? values.audience),
          metadata: { path: relative, ...(loaded.frontmatter.tags && { tags: toList(loaded.frontmatter.tags) }) },
        },
      ]);
      console.log(`  ${result.status.padEnd(9)} ${relative} (${result.chunks} chunks)`);
    } catch (err) {
      failed++;
      console.error(`  failed    ${relative}: ${err.message}`);
    }
  }

  if (values.prune) {
    const removed = await repo.deleteMissing(tenant.id, values.source, seen);
    console.log(`\nPruned ${removed} document(s) no longer on disk.`);
  }

  console.log(`\nDone: ${files.length - failed} ingested, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
