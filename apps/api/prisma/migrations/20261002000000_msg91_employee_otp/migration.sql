ALTER TABLE "OtpChallenge" ADD COLUMN "requestSourceHash" TEXT;
ALTER TABLE "OtpChallenge" ADD COLUMN "providerTokenHash" TEXT;
ALTER TABLE "OtpChallenge" ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 5;

CREATE UNIQUE INDEX "OtpChallenge_providerTokenHash_key" ON "OtpChallenge"("providerTokenHash");
CREATE INDEX "OtpChallenge_requestSourceHash_createdAt_idx" ON "OtpChallenge"("requestSourceHash", "createdAt");
