CREATE TYPE "MessageProviderType" AS ENUM ('MOCK', 'MSG91');

ALTER TABLE "Message"
  ADD COLUMN "branchId" TEXT,
  ADD COLUMN "customerId" TEXT,
  ADD COLUMN "templateKey" TEXT,
  ADD COLUMN "provider" "MessageProviderType",
  ADD COLUMN "nextRetryAt" TIMESTAMP(3);

UPDATE "Message" AS message
SET "branchId" = job."branchId",
    "customerId" = job."customerId",
    "templateKey" = message."event"::text,
    "provider" = 'MOCK'
FROM "Job" AS job
WHERE message."jobId" = job."id" AND message."organizationId" = job."organizationId";

ALTER TABLE "Message"
  ALTER COLUMN "branchId" SET NOT NULL,
  ALTER COLUMN "customerId" SET NOT NULL,
  ALTER COLUMN "templateKey" SET NOT NULL,
  ALTER COLUMN "provider" SET NOT NULL;

CREATE UNIQUE INDEX "Message_id_organizationId_key" ON "Message"("id", "organizationId");
CREATE INDEX "Message_organizationId_branchId_createdAt_idx" ON "Message"("organizationId", "branchId", "createdAt");
ALTER TABLE "Message" ADD CONSTRAINT "Message_branchId_organizationId_fkey" FOREIGN KEY ("branchId", "organizationId") REFERENCES "Branch"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_customerId_organizationId_fkey" FOREIGN KEY ("customerId", "organizationId") REFERENCES "Customer"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "MessageAttempt" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "status" "MessageStatus" NOT NULL,
  "failureReason" TEXT,
  "providerMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessageAttempt_messageId_number_key" ON "MessageAttempt"("messageId", "number");
CREATE INDEX "MessageAttempt_organizationId_messageId_createdAt_idx" ON "MessageAttempt"("organizationId", "messageId", "createdAt");
ALTER TABLE "MessageAttempt" ADD CONSTRAINT "MessageAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessageAttempt" ADD CONSTRAINT "MessageAttempt_messageId_organizationId_fkey" FOREIGN KEY ("messageId", "organizationId") REFERENCES "Message"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
