CREATE UNIQUE INDEX "SubscriptionPayment_providerTransactionId_key" ON "SubscriptionPayment"("providerTransactionId");

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_valid_period" CHECK ("currentPeriodStart" IS NULL OR "currentPeriodEnd" IS NULL OR "currentPeriodEnd" > "currentPeriodStart");
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_active_has_period" CHECK ("status" <> 'ACTIVE' OR ("currentPeriodStart" IS NOT NULL AND "currentPeriodEnd" IS NOT NULL));
