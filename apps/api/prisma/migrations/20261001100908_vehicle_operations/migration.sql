-- CreateEnum
CREATE TYPE "JobStage" AS ENUM ('RECEIVED', 'WASHING', 'READY', 'HANDED_OVER');

-- CreateEnum
CREATE TYPE "MessageEvent" AS ENUM ('VEHICLE_RECEIVED', 'WASH_STARTED', 'VEHICLE_READY', 'VEHICLE_HANDED_OVER');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('ISSUED', 'PARTIALLY_PAID', 'PAID');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "allowOutstanding" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "employeeHandover" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "invoicePrefix" TEXT NOT NULL DEFAULT 'KB',
ADD COLUMN     "nextInvoiceNumber" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "nextJobNumber" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "sendHandoverMessage" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "subtotalPaise" INTEGER NOT NULL,
    "taxPaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "status" "JobStage" NOT NULL DEFAULT 'RECEIVED',
    "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedInById" TEXT NOT NULL,
    "stageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "notify" BOOLEAN NOT NULL DEFAULT true,
    "handedOverAt" TIMESTAMP(3),
    "handedOverById" TEXT,
    "handoverNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobStageHistory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "fromStage" "JobStage",
    "toStage" "JobStage" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobStageHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobAssignment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "role" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "JobAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "event" "MessageEvent" NOT NULL,
    "recipient" TEXT NOT NULL,
    "renderedText" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "subtotalPaise" INTEGER NOT NULL,
    "taxPaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "collectedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_organizationId_branchId_status_idx" ON "Job"("organizationId", "branchId", "status");

-- CreateIndex
CREATE INDEX "Job_organizationId_checkedInAt_idx" ON "Job"("organizationId", "checkedInAt");

-- CreateIndex
CREATE INDEX "Job_organizationId_vehicleId_checkedInAt_idx" ON "Job"("organizationId", "vehicleId", "checkedInAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_id_organizationId_key" ON "Job"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_organizationId_number_key" ON "Job"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Job_organizationId_idempotencyKey_key" ON "Job"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "JobStageHistory_organizationId_jobId_createdAt_idx" ON "JobStageHistory"("organizationId", "jobId", "createdAt");

-- CreateIndex
CREATE INDEX "JobAssignment_organizationId_jobId_removedAt_idx" ON "JobAssignment"("organizationId", "jobId", "removedAt");

-- CreateIndex
CREATE INDEX "JobAssignment_organizationId_employeeId_assignedAt_idx" ON "JobAssignment"("organizationId", "employeeId", "assignedAt");

-- CreateIndex
CREATE INDEX "Message_organizationId_status_createdAt_idx" ON "Message"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_jobId_event_key" ON "Message"("jobId", "event");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_jobId_key" ON "Invoice"("jobId");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_issuedAt_idx" ON "Invoice"("organizationId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_id_organizationId_key" ON "Invoice"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_jobId_organizationId_key" ON "Invoice"("jobId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_organizationId_invoiceNumber_key" ON "Invoice"("organizationId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "Payment_organizationId_invoiceId_createdAt_idx" ON "Payment"("organizationId", "invoiceId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_organizationId_createdAt_idx" ON "Payment"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_branchId_organizationId_fkey" FOREIGN KEY ("branchId", "organizationId") REFERENCES "Branch"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_customerId_organizationId_fkey" FOREIGN KEY ("customerId", "organizationId") REFERENCES "Customer"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_serviceId_organizationId_fkey" FOREIGN KEY ("serviceId", "organizationId") REFERENCES "Service"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_checkedInById_organizationId_fkey" FOREIGN KEY ("checkedInById", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_handedOverById_organizationId_fkey" FOREIGN KEY ("handedOverById", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStageHistory" ADD CONSTRAINT "JobStageHistory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStageHistory" ADD CONSTRAINT "JobStageHistory_jobId_organizationId_fkey" FOREIGN KEY ("jobId", "organizationId") REFERENCES "Job"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStageHistory" ADD CONSTRAINT "JobStageHistory_actorUserId_organizationId_fkey" FOREIGN KEY ("actorUserId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAssignment" ADD CONSTRAINT "JobAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAssignment" ADD CONSTRAINT "JobAssignment_jobId_organizationId_fkey" FOREIGN KEY ("jobId", "organizationId") REFERENCES "Job"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAssignment" ADD CONSTRAINT "JobAssignment_employeeId_organizationId_fkey" FOREIGN KEY ("employeeId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAssignment" ADD CONSTRAINT "JobAssignment_assignedById_organizationId_fkey" FOREIGN KEY ("assignedById", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_jobId_organizationId_fkey" FOREIGN KEY ("jobId", "organizationId") REFERENCES "Job"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_jobId_organizationId_fkey" FOREIGN KEY ("jobId", "organizationId") REFERENCES "Job"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_organizationId_fkey" FOREIGN KEY ("invoiceId", "organizationId") REFERENCES "Invoice"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_collectedById_organizationId_fkey" FOREIGN KEY ("collectedById", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
