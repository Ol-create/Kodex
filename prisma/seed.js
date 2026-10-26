// Creates (or updates) the Leddar tenant and issues its first API key.
// Safe to re-run: a new key is only issued when the tenant has no active key.
import prisma from "../src/config/prisma.js";
import { createApiKey } from "../src/lib/apiKeys.js";
import { parseTenantConfig } from "../src/lib/tenantConfig.js";

const leddarConfig = parseTenantConfig({
  audiences: ["brand", "artisan", "admin"],
  systemPrompt:
    "You are Leddar's help assistant. Leddar connects fashion brands with skilled " +
    "leather artisans in Nigeria for sample and production orders. Answer only from " +
    "the provided context, be concise and friendly, and cite sources as [1], [2]. " +
    "If the context does not answer the question, say you don't know and suggest " +
    "contacting Leddar support. Never invent prices, timelines or policies.",
  fallbackAnswer:
    "I couldn't find that in Leddar's help docs. Please contact Leddar support and the team will help you.",
});

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "leddar" },
    create: { slug: "leddar", name: "Leddar", config: leddarConfig },
    update: { name: "Leddar", config: leddarConfig },
  });
  console.log(`Tenant ready: ${tenant.slug} (${tenant.id})`);

  const activeKeys = await prisma.apiKey.count({
    where: { tenantId: tenant.id, revokedAt: null },
  });

  if (activeKeys > 0) {
    console.log(`Tenant already has ${activeKeys} active API key(s); not issuing a new one.`);
    console.log(`Create another with: npm run apikey:create -- leddar "<name>"`);
    return;
  }

  const { key } = await createApiKey(prisma, { tenantId: tenant.id, name: "leddar-server (dev)" });
  console.log("\nAPI key (shown once, store it in leddar/server .env as KODEX_API_KEY):");
  console.log(`  ${key}\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
