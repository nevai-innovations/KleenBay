CREATE TABLE "OwnerSetup" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OwnerSetup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OwnerSetup_userId_key" ON "OwnerSetup"("userId");
CREATE UNIQUE INDEX "OwnerSetup_userId_organizationId_key" ON "OwnerSetup"("userId", "organizationId");
CREATE UNIQUE INDEX "OwnerSetup_tokenHash_key" ON "OwnerSetup"("tokenHash");
CREATE INDEX "OwnerSetup_organizationId_expiresAt_idx" ON "OwnerSetup"("organizationId", "expiresAt");
ALTER TABLE "OwnerSetup" ADD CONSTRAINT "OwnerSetup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OwnerSetup" ADD CONSTRAINT "OwnerSetup_userId_organizationId_fkey" FOREIGN KEY ("userId","organizationId") REFERENCES "User"("id","organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
