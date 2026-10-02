-- Keep composite tenant FKs enforced at commit while allowing a guarded owner
-- transfer to update the user, sessions and audit actors atomically.
ALTER TABLE "Session" ALTER CONSTRAINT "Session_userId_organizationId_fkey" DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "AuditLog" ALTER CONSTRAINT "AuditLog_actorUserId_organizationId_fkey" DEFERRABLE INITIALLY IMMEDIATE;
