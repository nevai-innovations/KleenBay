CREATE TYPE "SubscriptionStatus" AS ENUM ('INACTIVE', 'PAYMENT_PENDING', 'ACTIVE', 'EXPIRED', 'PAYMENT_FAILED');
CREATE TYPE "SubscriptionPaymentStatus" AS ENUM ('INITIATED', 'SUCCESS', 'FAILED', 'CANCELLED');

CREATE TABLE "Subscription" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "planCode" TEXT NOT NULL DEFAULT 'KLEENBAY_ANNUAL',
  "status" "SubscriptionStatus" NOT NULL DEFAULT 'INACTIVE',
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SubscriptionPayment" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'PAYU',
  "merchantTransactionId" TEXT NOT NULL,
  "providerTransactionId" TEXT,
  "amountPaise" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "status" "SubscriptionPaymentStatus" NOT NULL DEFAULT 'INITIATED',
  "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "providerStatus" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SubscriptionPayment_amountPaise_positive" CHECK ("amountPaise" > 0)
);

CREATE UNIQUE INDEX "Subscription_organizationId_key" ON "Subscription"("organizationId");
CREATE UNIQUE INDEX "Subscription_id_organizationId_key" ON "Subscription"("id", "organizationId");
CREATE INDEX "Subscription_organizationId_status_idx" ON "Subscription"("organizationId", "status");
CREATE UNIQUE INDEX "SubscriptionPayment_merchantTransactionId_key" ON "SubscriptionPayment"("merchantTransactionId");
CREATE UNIQUE INDEX "SubscriptionPayment_id_organizationId_key" ON "SubscriptionPayment"("id", "organizationId");
CREATE INDEX "SubscriptionPayment_organizationId_initiatedAt_idx" ON "SubscriptionPayment"("organizationId", "initiatedAt");
CREATE INDEX "SubscriptionPayment_organizationId_status_idx" ON "SubscriptionPayment"("organizationId", "status");
CREATE INDEX "SubscriptionPayment_subscriptionId_organizationId_idx" ON "SubscriptionPayment"("subscriptionId", "organizationId");

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_subscriptionId_organizationId_fkey" FOREIGN KEY ("subscriptionId", "organizationId") REFERENCES "Subscription"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
