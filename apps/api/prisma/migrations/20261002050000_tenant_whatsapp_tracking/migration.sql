CREATE TYPE "WhatsAppConnectionStatus" AS ENUM ('MOCK_ACTIVE', 'NOT_CONNECTED', 'PENDING_VERIFICATION', 'CONNECTED', 'ERROR');

CREATE TABLE "OrganizationWhatsAppConfig" (
  "organizationId" TEXT NOT NULL,
  "provider" "MessageProviderType" NOT NULL DEFAULT 'MOCK',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "senderNumber" TEXT,
  "senderDisplayName" TEXT,
  "msg91IntegratedNumberId" TEXT,
  "credentialRef" TEXT,
  "templateReceived" TEXT NOT NULL DEFAULT 'VEHICLE_RECEIVED',
  "templateWashing" TEXT NOT NULL DEFAULT 'WASH_STARTED',
  "templateReady" TEXT NOT NULL DEFAULT 'VEHICLE_READY',
  "templateHandedOver" TEXT DEFAULT 'VEHICLE_HANDED_OVER',
  "status" "WhatsAppConnectionStatus" NOT NULL DEFAULT 'MOCK_ACTIVE',
  "lastVerifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganizationWhatsAppConfig_pkey" PRIMARY KEY ("organizationId")
);

ALTER TABLE "OrganizationWhatsAppConfig" ADD CONSTRAINT "OrganizationWhatsAppConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
INSERT INTO "OrganizationWhatsAppConfig" ("organizationId") SELECT "id" FROM "Organization";

ALTER TABLE "Job" ADD COLUMN "trackingTokenHash" TEXT;
ALTER TABLE "Job" ADD COLUMN "trackingTokenCiphertext" TEXT;
CREATE UNIQUE INDEX "Job_trackingTokenHash_key" ON "Job"("trackingTokenHash");

ALTER TABLE "Message" ADD COLUMN "senderNumber" TEXT;
ALTER TABLE "Message" ADD COLUMN "senderDisplayName" TEXT;
ALTER TABLE "Message" ADD COLUMN "trackingTokenHash" TEXT;
