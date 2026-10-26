// Usage: npm run apikey:create -- <tenant-slug> "<key name>"
import prisma from "../src/config/prisma.js";
import { createApiKey } from "../src/lib/apiKeys.js";

const [slug, name] = process.argv.slice(2);

if (!slug || !name) {
  console.error('Usage: npm run apikey:create -- <tenant-slug> "<key name>"');
  process.exit(1);
}

try {
  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    console.error(`No tenant with slug "${slug}". Run \`npm run db:seed\` first?`);
    process.exitCode = 1;
  } else {
    const { key, record } = await createApiKey(prisma, { tenantId: tenant.id, name });
    console.log(`Created key "${record.name}" (${record.prefix}…) for ${tenant.slug}.`);
    console.log("Shown once, store it now:");
    console.log(`  ${key}`);
  }
} finally {
  await prisma.$disconnect();
}
