import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { verify } from '@node-rs/argon2';
import { z, ZodError } from 'zod';
import { employeeSchema, employeeUpdateSchema, ownerLoginSchema } from '@carwash/shared';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { audit } from './audit.js';
import { currentUser, requireOwner, revokeSession, startSession } from './auth.js';
import { HttpError, notFound } from './errors.js';
import { createOtpProvider, type OtpProvider } from './otp.js';
import { registerEmployeeOtpRoutes } from './employee-otp.js';
import { registerCatalogRoutes } from './catalog.js';
import { createMessagingProvider, MockMessagingProvider, type MessagingProvider } from './messaging.js';
import { registerOperationsRoutes } from './operations.js';
import { registerMediaRoutes } from './media.js';
import { registerPublicTrackingRoutes } from './public-tracking.js';
import { registerDailySummaryRoutes } from './daily-summary.js';
import { registerOwnerAccountRoutes } from './owner-accounts.js';
import { registerWhatsAppSettingsRoutes } from './whatsapp-settings.js';
import { createStorageProvider, LocalStorageProvider, type StorageProvider } from './storage.js';
import { createPaymentProvider, type PaymentProvider } from './payu.js';
import { registerBillingRoutes } from './billing.js';
import { registerInvoiceRoutes } from './invoices.js';
import { registerBranchRoutes } from './branches.js';

class RouteOnlyLogController extends LogController {
  constructor() { super({ disableRequestLogging: true }); }
}

export async function buildApp(config: Config, db: Db, otp: OtpProvider = createOtpProvider(config), messaging: MessagingProvider = createMessagingProvider(config), storage: StorageProvider = createStorageProvider(config), paymentProvider: PaymentProvider | null = createPaymentProvider(config)) {
  if (config.NODE_ENV === 'production' && !config.stagingMode && messaging instanceof MockMessagingProvider) throw new Error('Configure a production messaging provider before startup');
  if (config.NODE_ENV === 'production' && !config.stagingMode && storage instanceof LocalStorageProvider) throw new Error('Configure a production storage provider before startup');
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, logController: new RouteOnlyLogController(), trustProxy: config.TRUST_PROXY_HOPS > 0 ? (_address, hop) => hop < config.TRUST_PROXY_HOPS : false });
  await app.register(cookie);
  await app.register(cors, { origin: config.APP_ORIGIN, credentials: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { files: 1, fileSize: 8 * 1024 * 1024 } });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body.toString()))));

  app.addHook('onResponse', async (request, reply) => {
    request.log.info({ requestId: request.id, method: request.method, route: request.routeOptions.url ?? 'unmatched', statusCode: reply.statusCode }, 'Request completed');
  });

  app.addHook('onRequest', async (request) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && (request.cookies.kleenbay_session || request.url.startsWith('/api/auth/employee/') || request.url === '/api/auth/owner/setup')) {
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
    const login = input.login.toLowerCase();
    const orgSlug = request.headers['x-organization-slug'];
    const where = { role: 'OWNER' as const, active: true, ...(login.includes('@') ? { email: login } : { username: login }) };
    const matches = await db.user.findMany({ where, include: { organization: true }, take: 2 });
    const user = matches.length === 1 ? matches[0] : !login.includes('@') && typeof orgSlug === 'string'
      ? await db.user.findFirst({ where: { ...where, organization: { slug: orgSlug } }, include: { organization: true } })
      : undefined;
    const valid = user?.passwordHash && await verify(user.passwordHash, input.password);
    if (!valid || !user) {
      if (user) await audit(db, { organizationId: user.organizationId, action: 'LOGIN_FAILED', entityType: 'User', entityId: user.id, ipAddress: request.ip });
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username/email or password');
    }
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'OWNER_LOGIN', entityType: 'User', entityId: user.id, ipAddress: request.ip });
    });
    await startSession(db, reply, config, user);
    return { user: { id: user.id, role: user.role, name: user.name, organizationId: user.organizationId, branchId: user.branchId }, organization: { id: user.organization.id, name: user.organization.name } };
  });

  registerEmployeeOtpRoutes(app, config, db, otp);
  registerOwnerAccountRoutes(app, db);

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
    if (!branchId) throw new HttpError(400, 'BRANCH_REQUIRED', 'Choose an active branch');
    if (!activeBranches.some((candidate) => candidate.id === branchId)) notFound();
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
      if (existing.branchId !== result.branchId) await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'EMPLOYEE_BRANCH_CHANGED', entityType: 'User', entityId: id, before: { branchId: existing.branchId }, after: { branchId: result.branchId }, ipAddress: request.ip });
      return result;
    });
    return { id: updated.id, name: updated.name, mobile: input.mobile ?? existing.employee?.mobile, active: updated.active, branchId: updated.branchId };
  });

  registerBranchRoutes(app, db);

  registerCatalogRoutes(app, db);
  registerOperationsRoutes(app, db, messaging, config);
  registerWhatsAppSettingsRoutes(app, db, config);
  registerMediaRoutes(app, db, storage);
  registerPublicTrackingRoutes(app, db, storage, config);
  registerDailySummaryRoutes(app, db);
  registerBillingRoutes(app, db, config, paymentProvider);
  registerInvoiceRoutes(app, db);

  return app;
}
