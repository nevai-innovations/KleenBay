ALTER TABLE "Payment" ADD COLUMN "idempotencyKey" TEXT;
UPDATE "Payment" SET "idempotencyKey" = "id" WHERE "idempotencyKey" IS NULL;
ALTER TABLE "Payment" ALTER COLUMN "idempotencyKey" SET NOT NULL;
CREATE UNIQUE INDEX "Payment_organizationId_idempotencyKey_key" ON "Payment"("organizationId", "idempotencyKey");
