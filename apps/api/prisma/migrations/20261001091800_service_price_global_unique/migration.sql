CREATE UNIQUE INDEX "ServicePrice_serviceId_vehicleType_global_key"
ON "ServicePrice" ("serviceId", "vehicleType")
WHERE "branchId" IS NULL;
