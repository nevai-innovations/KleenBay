import type { Db } from './db.js';

type AuditInput = {
  organizationId: string;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: object | null;
  after?: object | null;
  ipAddress?: string | null;
};

export async function audit(db: Pick<Db, 'auditLog'>, event: AuditInput) {
  return db.auditLog.create({
    data: {
      organizationId: event.organizationId,
      actorUserId: event.actorUserId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      before: event.before ?? undefined,
      after: event.after ?? undefined,
      ipAddress: event.ipAddress ?? undefined,
    },
  });
}
