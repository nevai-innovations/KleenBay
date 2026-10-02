CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "EmployeeProfile_mobile_key" ON "EmployeeProfile"("mobile");
CREATE UNIQUE INDEX "User_one_owner_per_organization_key" ON "User"("organizationId") WHERE "role" = 'OWNER';
