import { createHash } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { ownerSetupSchema } from '@carwash/shared';
import type { FastifyInstance } from 'fastify';
import { audit } from './audit.js';
import type { Db } from './db.js';
import { HttpError } from './errors.js';

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export function registerOwnerAccountRoutes(app: FastifyInstance, db: Db) {
  app.post('/api/auth/owner/setup', { config: { rateLimit: { max: 12, timeWindow: '10 minutes' } } }, async (request) => {
    const input = ownerSetupSchema.parse(request.body);
    const digest = tokenHash(input.token);
    const passwordHash = await hash(input.password);
    await db.$transaction(async (tx) => {
      const setup = await tx.ownerSetup.findFirst({
        where: { tokenHash: digest, consumedAt: null, expiresAt: { gt: new Date() } },
        include: { user: true },
      });
      if (!setup || setup.user.role !== 'OWNER' || setup.user.active || setup.user.passwordHash || setup.user.organizationId !== setup.organizationId)
        throw new HttpError(400, 'INVALID_SETUP', 'Setup link is invalid or expired');
      const consumed = await tx.ownerSetup.updateMany({
        where: { id: setup.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) throw new HttpError(400, 'INVALID_SETUP', 'Setup link is invalid or expired');
      await tx.user.update({ where: { id: setup.userId }, data: { passwordHash, active: true } });
      await audit(tx, { organizationId: setup.organizationId, actorUserId: setup.userId,
        action: 'OWNER_PASSWORD_SET', entityType: 'User', entityId: setup.userId, ipAddress: request.ip });
    });
    return { status: 'ready' };
  });
}
