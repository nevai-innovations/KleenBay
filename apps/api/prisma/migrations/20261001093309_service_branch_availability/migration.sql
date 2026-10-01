-- CreateTable
CREATE TABLE "ServiceBranch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceBranch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceBranch_organizationId_branchId_active_idx" ON "ServiceBranch"("organizationId", "branchId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceBranch_serviceId_branchId_key" ON "ServiceBranch"("serviceId", "branchId");

-- AddForeignKey
ALTER TABLE "ServiceBranch" ADD CONSTRAINT "ServiceBranch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceBranch" ADD CONSTRAINT "ServiceBranch_serviceId_organizationId_fkey" FOREIGN KEY ("serviceId", "organizationId") REFERENCES "Service"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceBranch" ADD CONSTRAINT "ServiceBranch_branchId_organizationId_fkey" FOREIGN KEY ("branchId", "organizationId") REFERENCES "Branch"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
