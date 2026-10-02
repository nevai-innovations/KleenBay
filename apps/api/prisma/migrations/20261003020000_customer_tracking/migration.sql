ALTER TABLE "Organization"
  ADD COLUMN "showCustomerTrackingLink" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "showCompletedVehiclePhotos" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Photo"
  ADD COLUMN "customerVisible" BOOLEAN NOT NULL DEFAULT false;
