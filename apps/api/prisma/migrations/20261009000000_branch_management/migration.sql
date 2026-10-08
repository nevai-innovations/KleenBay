ALTER TABLE "Branch"
  ADD COLUMN "code" TEXT,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "addressLine1" TEXT,
  ADD COLUMN "addressLine2" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "state" TEXT,
  ADD COLUMN "postalCode" TEXT,
  ADD COLUMN "country" TEXT NOT NULL DEFAULT 'IN',
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN "openingTime" TEXT,
  ADD COLUMN "closingTime" TEXT;

UPDATE "Branch" AS branch
SET "addressLine1" = branch."address", "timezone" = organization."timezone"
FROM "Organization" AS organization
WHERE branch."organizationId" = organization."id";

UPDATE "User" AS employee
SET "branchId" = branch."id"
FROM "Branch" AS branch
WHERE employee."role" = 'EMPLOYEE'
  AND employee."branchId" IS NULL
  AND employee."organizationId" = branch."organizationId"
  AND (SELECT count(*) FROM "Branch" AS candidate WHERE candidate."organizationId" = employee."organizationId") = 1;

CREATE UNIQUE INDEX "Branch_organizationId_code_key" ON "Branch"("organizationId", "code");
