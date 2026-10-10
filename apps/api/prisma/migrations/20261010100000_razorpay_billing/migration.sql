-- Preserve existing provider/history; change only the default for future payments.
ALTER TABLE "SubscriptionPayment" ALTER COLUMN "provider" SET DEFAULT 'RAZORPAY';
ALTER TABLE "SubscriptionPayment"
  ADD COLUMN "razorpayOrderId" TEXT,
  ADD COLUMN "razorpayPaymentId" TEXT,
  ADD COLUMN "checkoutKey" TEXT,
  ADD COLUMN "failedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "SubscriptionPayment_razorpayOrderId_key" ON "SubscriptionPayment"("razorpayOrderId");
CREATE UNIQUE INDEX "SubscriptionPayment_razorpayPaymentId_key" ON "SubscriptionPayment"("razorpayPaymentId");
CREATE UNIQUE INDEX "SubscriptionPayment_organizationId_checkoutKey_key" ON "SubscriptionPayment"("organizationId", "checkoutKey");
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_razorpay_amount_check"
  CHECK ("provider" <> 'RAZORPAY' OR ("amountPaise" = 720000 AND "currency" = 'INR'));
