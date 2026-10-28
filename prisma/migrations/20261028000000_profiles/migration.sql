-- CreateTable
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "contentHash" TEXT NOT NULL,
    "embedding" vector(1024),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Profile_tenantId_kind_idx" ON "Profile"("tenantId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Profile_tenantId_kind_externalId_key" ON "Profile"("tenantId", "kind", "externalId");

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- No HNSW index on purpose: a tenant has at most thousands of profiles, and
-- matches are usually restricted to a list of ids, which an approximate index
-- would apply after the scan and could drop. An exact scan is fast and complete.
