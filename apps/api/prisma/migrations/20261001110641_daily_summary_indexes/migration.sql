-- CreateIndex
CREATE INDEX "Job_organizationId_handedOverAt_idx" ON "Job"("organizationId", "handedOverAt");

-- CreateIndex
CREATE INDEX "JobStageHistory_organizationId_createdAt_idx" ON "JobStageHistory"("organizationId", "createdAt");
