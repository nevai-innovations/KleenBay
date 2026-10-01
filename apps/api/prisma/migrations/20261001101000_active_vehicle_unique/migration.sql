-- A vehicle may have many historical visits, but only one open job per business.
CREATE UNIQUE INDEX "Job_one_active_vehicle_per_org"
ON "Job" ("organizationId", "vehicleId")
WHERE "status" <> 'HANDED_OVER';
