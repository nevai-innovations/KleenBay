import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { forbidden, HttpError } from './errors.js';
import { enforceEntitlement } from './entitlements.js';

export const cookieName = 'kleenbay_session';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export async function startSession(db: Db, reply: FastifyReply, config: Config, user: { id: string; organizationId: string }) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.SESSION_HOURS * 60 * 60 * 1000);
  await db.session.create({ data: { userId: user.id, organizationId: user.organizationId, tokenHash: digest(token), expiresAt } });
  reply.setCookie(cookieName, token, {
    path: '/', httpOnly: true, secure: config.secureCookie, sameSite: 'strict',
    maxAge: config.SESSION_HOURS * 60 * 60,
  });
}

export async function currentUser(db: Db, request: FastifyRequest, deferEntitlement = false) {
  const token = request.cookies[cookieName];
  if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
  const session = await db.session.findUnique({ where: { tokenHash: digest(token) }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.user.active || session.organizationId !== session.user.organizationId) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Session expired');
  }
  if (!deferEntitlement) await enforceEntitlement(db, session.user, request);
  return session.user;
}

export async function requireOwner(db: Db, request: FastifyRequest) {
  const user = await currentUser(db, request, true);
  if (user.role !== 'OWNER') forbidden();
  await enforceEntitlement(db, user, request);
  return user;
}

export async function revokeSession(db: Db, request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[cookieName];
  if (token) await db.session.updateMany({ where: { tokenHash: digest(token), revokedAt: null }, data: { revokedAt: new Date() } });
  reply.clearCookie(cookieName, { path: '/' });
}
