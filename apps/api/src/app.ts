import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { hash, verify } from '@node-rs/argon2';
import { randomInt } from 'node:crypto';
import { z, ZodError } from 'zod';
import { employeeSchema, employeeUpdateSchema, ownerLoginSchema, otpRequestSchema, otpVerifySchema } from '@carwash/shared';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { audit } from './audit.js';
import { currentUser, requireOwner, revokeSession, startSession } from './auth.js';
import { HttpError, notFound } from './errors.js';
import { createOtpProvider, type OtpProvider } from './otp.js';
import { registerCatalogRoutes } from './catalog.js';
import { LocalMessagingProvider, type MessagingProvider } from './messaging.js';
import { registerOperationsRoutes } from './operations.js';
import { registerMediaRoutes } from './media.js';
import { registerDailySummaryRoutes } from './daily-summary.js';
import { LocalStorageProvider, type StorageProvider } from './storage.js';

export async function buildApp(config: Config, db: Db, otp: OtpProvider = createOtpProvider(config), messaging: MessagingProvider = new LocalMessagingProvider(), storage: StorageProvider = new LocalStorageProvider()) {
  if (config.NODE_ENV === 'production' && messaging instanceof LocalMessagingProvider) throw new Error('Configure a production messaging provider before startup');
  if (config.NODE_ENV === 'production' && storage instanceof LocalStorageProvider) throw new Error('Configure a production storage provider before startup');
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, trustProxy: config.TRUST_PROXY_HOPS > 0 });
  await app.register(cookie);
  await app.register(cors, { origin: config.APP_ORIGIN, credentials: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { files: 1, fileSize: 8 * 1024 * 1024 } });

  app.addHook('onRequest', async (request) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && request.cookies.kleenbay_session) {
      if (request.headers.origin !== config.APP_ORIGIN) throw new HttpError(403, 'BAD_ORIGIN', 'Invalid request origin');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid input', issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) }, requestId: request.id });
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message }, requestId: request.id });
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return reply.code(409).send({ error: { code: 'CONFLICT', message: 'That value is already in use' }, requestId: request.id });
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' }, requestId: request.id });
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 413) return reply.code(413).send({ error: { code: 'FILE_TOO_LARGE', message: 'Photo exceeds the 8 MB limit' }, requestId: request.id });
    request.log.error({ errorType: error instanceof Error ? error.name : 'UnknownError', requestId: request.id }, 'Request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }, requestId: request.id });
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    try { await db.$queryRaw`SELECT 1`; return { status: 'ready' }; }
    catch { return reply.code(503).send({ status: 'unavailable' }); }
  });

  app.post('/api/auth/owner/login', { config: { rateLimit: { max: 8, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const input = ownerLoginSchema.parse(request.body);
    const orgSlug = z.string().min(2).max(100).parse(request.headers['x-organization-slug']);
    const organization = await db.organization.findUnique({ where: { slug: orgSlug } });
    const user = organization && await db.user.findFirst({ where: { organizationId: organization.id, role: 'OWNER', active: true, OR: [{ username: input.login.toLowerCase() }, { email: input.login.toLowerCase() }] } });
    const valid = user?.passwordHash && await verify(user.passwordHash, input.password);
    if (!valid || !user) {
      if (organization) await audit(db, { organizationId: organization.id, action: 'LOGIN_FAILED', entityType: 'User', entityId: user?.id ?? 'unknown', ipAddress: request.ip });
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username/email or password');
    }
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'OWNER_LOGIN', entityType: 'User', entityId: user.id, ipAddress: request.ip });
    });
    await startSession(db, reply, config, user);
    return { user: { id: user.id, role: user.role, name: user.name, organizationId: user.organizationId, branchId: user.branchId }, organization: { id: organization.id, name: organization.name } };
  });

  app.post('/api/auth/employee/request-otp', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request) => {
    const input = otpRequestSchema.parse(request.body);
    const orgSlug = z.string().min(2).max(100).parse(request.headers['x-organization-slug']);
    const org = await db.organization.findUnique({ where: { slug: orgSlug } });
    const employee = org && await db.employeeProfile.findUnique({ where: { organizationId_mobile: { organizationId: org.id, mobile: input.mobile } }, include: { user: true } });
    if (!org || !employee?.user.active) throw new HttpError(404, 'EMPLOYEE_NOT_FOUND', 'No active employee account for this mobile number');
    const recent = await db.otpChallenge.findFirst({ where: { userId: employee.userId, createdAt: { gt: new Date(Date.now() - 60_000) } } });
    if (recent) throw new HttpError(429, 'OTP_RATE_LIMIT', 'Wait a minute before requesting another code');
    const code = config.devOtp ? config.DEV_OTP_CODE : String(randomInt(100000, 1000000));
    await otp.send(input.mobile, code);
    await db.$transaction(async (tx) => {
      await tx.otpChallenge.updateMany({ where: { userId: employee.userId, consumedAt: null }, data: { consumedAt: new Date() } });
      await tx.otpChallenge.create({ data: { organizationId: employee.organizationId, userId: employee.userId, codeHash: await hash(code), expiresAt: new Date(Date.now() + 5 * 60_000) } });
      await audit(tx, { organizationId: employee.organizationId, actorUserId: employee.userId, action: 'OTP_REQUESTED', entityType: 'User', entityId: employee.userId, ipAddress: request.ip });
    });
    return { status: 'sent' };
  });

  app.post('/api/auth/employee/verify-otp', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const input = otpVerifySchema.parse(request.body);
    const orgSlug = z.string().min(2).max(100).parse(request.headers['x-organization-slug']);
    const org = await db.organization.findUnique({ where: { slug: orgSlug } });
    const employee = org && await db.employeeProfile.findUnique({ where: { organizationId_mobile: { organizationId: org.id, mobile: input.mobile } }, include: { user: true } });
    if (!org || !employee?.user.active) throw new HttpError(401, 'INVALID_OTP', 'Invalid or expired code');
    const challenge = await db.otpChallenge.findFirst({ where: { userId: employee.userId, consumedAt: null }, orderBy: { createdAt: 'desc' } });
    if (!challenge || challenge.expiresAt <= new Date() || challenge.attempts >= 5) throw new HttpError(401, 'INVALID_OTP', 'Invalid or expired code');
    const valid = await verify(challenge.codeHash, input.code);
    if (!valid) {
      await db.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
      throw new HttpError(401, 'INVALID_OTP', 'Invalid or expired code');
    }
    await db.$transaction(async (tx) => {
      await tx.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
      await tx.user.update({ where: { id: employee.userId }, data: { lastLoginAt: new Date() } });
      await audit(tx, { organizationId: employee.organizationId, actorUserId: employee.userId, action: 'EMPLOYEE_LOGIN', entityType: 'User', entityId: employee.userId, ipAddress: request.ip });
    });
    await startSession(db, reply, config, employee.user);
    return { user: { id: employee.user.id, role: 'EMPLOYEE', name: employee.user.name, organizationId: employee.organizationId, branchId: employee.user.branchId }, organization: { id: org.id, name: org.name } };
  });

  app.get('/api/auth/me', async (request) => {
    const user = await currentUser(db, request);
    const org = await db.organization.findUniqueOrThrow({ where: { id: user.organizationId } });
    return { user: { id: user.id, role: user.role, name: user.name, organizationId: user.organizationId, branchId: user.branchId }, organization: { id: org.id, name: org.name } };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const user = await currentUser(db, request);
    await revokeSession(db, request, reply);
    await audit(db, { organizationId: user.organizationId, actorUserId: user.id, action: 'LOGOUT', entityType: 'User', entityId: user.id, ipAddress: request.ip });
    return { status: 'ok' };
  });

  app.get('/api/employees', async (request) => {
    const owner = await requireOwner(db, request);
    const users = await db.user.findMany({ where: { organizationId: owner.organizationId, role: 'EMPLOYEE' }, include: { employee: true, branch: true }, orderBy: { name: 'asc' } });
    return users.map((u) => ({ id: u.id, name: u.name, mobile: u.employee?.mobile, active: u.active, branchId: u.branchId, branchName: u.branch?.name, lastLoginAt: u.lastLoginAt }));
  });

  app.post('/api/employees', async (request, reply) => {
    const owner = await requireOwner(db, request);
    const input = employeeSchema.parse(request.body);
    const activeBranches = await db.branch.findMany({ where: { organizationId: owner.organizationId, active: true }, select: { id: true } });
    const branchId = input.branchId ?? (activeBranches.length === 1 ? activeBranches[0]?.id : undefined);
    if (branchId) {
      const branch = activeBranches.find((candidate) => candidate.id === branchId);
      if (!branch) notFound();
    }
    const employee = await db.$transaction(async (tx) => {
      const created = await tx.user.create({ data: { organizationId: owner.organizationId, branchId, role: 'EMPLOYEE', name: input.name, active: input.active, employee: { create: { mobile: input.mobile } } } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'EMPLOYEE_CREATED', entityType: 'User', entityId: created.id, after: { name: created.name, mobile: input.mobile, active: input.active }, ipAddress: request.ip });
      return created;
    });
    return reply.code(201).send({ id: employee.id, name: employee.name, mobile: input.mobile, active: employee.active, branchId: employee.branchId });
  });

  app.patch('/api/employees/:id', async (request) => {
    const owner = await requireOwner(db, request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = employeeUpdateSchema.parse(request.body);
    const existing = await db.user.findFirst({ where: { id, organizationId: owner.organizationId, role: 'EMPLOYEE' }, include: { employee: true } });
    if (!existing) notFound();
    if (input.branchId) {
      const branch = await db.branch.findFirst({ where: { id: input.branchId, organizationId: owner.organizationId, active: true } });
      if (!branch) notFound();
    }
    const updated = await db.$transaction(async (tx) => {
      const result = await tx.user.update({ where: { id }, data: { name: input.name, active: input.active, branchId: input.branchId, employee: input.mobile ? { update: { mobile: input.mobile } } : undefined } });
      if (input.active === false) await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'EMPLOYEE_UPDATED', entityType: 'User', entityId: id, before: { name: existing.name, mobile: existing.employee?.mobile, active: existing.active, branchId: existing.branchId }, after: { name: result.name, mobile: input.mobile ?? existing.employee?.mobile, active: result.active, branchId: result.branchId }, ipAddress: request.ip });
      return result;
    });
    return { id: updated.id, name: updated.name, mobile: input.mobile ?? existing.employee?.mobile, active: updated.active, branchId: updated.branchId };
  });

  app.get('/api/branches', async (request) => {
    const user = await currentUser(db, request);
    return db.branch.findMany({ where: { organizationId: user.organizationId, active: true }, select: { id: true, name: true, address: true, phone: true }, orderBy: { name: 'asc' } });
  });

  registerCatalogRoutes(app, db);
  registerOperationsRoutes(app, db, messaging);
  registerMediaRoutes(app, db, storage);
  registerDailySummaryRoutes(app, db);

  return app;
}
