-- CreateEnum
CREATE TYPE "PhotoKind" AS ENUM ('BEFORE', 'DURING', 'AFTER', 'DAMAGE');

-- CreateEnum
CREATE TYPE "InspectionLocation" AS ENUM ('FRONT', 'REAR', 'LEFT', 'RIGHT', 'INTERIOR', 'WINDSHIELD', 'WHEELS', 'OTHER');

-- CreateEnum
CREATE TYPE "DamageType" AS ENUM ('SCRATCH', 'DENT', 'CRACK', 'PAINT_DAMAGE', 'BROKEN_ITEM', 'INTERIOR_DAMAGE', 'OTHER');

-- CreateTable
CREATE TABLE "VehicleInspection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "recordedById" TEXT NOT NULL,
    "finalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionDamageItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "location" "InspectionLocation" NOT NULL,
    "type" "DamageType" NOT NULL,
    "description" TEXT,

    CONSTRAINT "InspectionDamageItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Photo" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "damageItemId" TEXT,
    "kind" "PhotoKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "description" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VehicleInspection_jobId_key" ON "VehicleInspection"("jobId");

-- CreateIndex
CREATE INDEX "VehicleInspection_organizationId_createdAt_idx" ON "VehicleInspection"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleInspection_id_organizationId_key" ON "VehicleInspection"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleInspection_jobId_organizationId_key" ON "VehicleInspection"("jobId", "organizationId");

-- CreateIndex
CREATE INDEX "InspectionDamageItem_organizationId_inspectionId_idx" ON "InspectionDamageItem"("organizationId", "inspectionId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionDamageItem_id_organizationId_key" ON "InspectionDamageItem"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Photo_storageKey_key" ON "Photo"("storageKey");

-- CreateIndex
CREATE INDEX "Photo_organizationId_jobId_createdAt_idx" ON "Photo"("organizationId", "jobId", "createdAt");

-- AddForeignKey
ALTER TABLE "VehicleInspection" ADD CONSTRAINT "VehicleInspection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleInspection" ADD CONSTRAINT "VehicleInspection_jobId_organizationId_fkey" FOREIGN KEY ("jobId", "organizationId") REFERENCES "Job"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleInspection" ADD CONSTRAINT "VehicleInspection_recordedById_organizationId_fkey" FOREIGN KEY ("recordedById", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionDamageItem" ADD CONSTRAINT "InspectionDamageItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionDamageItem" ADD CONSTRAINT "InspectionDamageItem_inspectionId_organizationId_fkey" FOREIGN KEY ("inspectionId", "organizationId") REFERENCES "VehicleInspection"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_jobId_organizationId_fkey" FOREIGN KEY ("jobId", "organizationId") REFERENCES "Job"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_damageItemId_organizationId_fkey" FOREIGN KEY ("damageItemId", "organizationId") REFERENCES "InspectionDamageItem"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_uploadedById_organizationId_fkey" FOREIGN KEY ("uploadedById", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
