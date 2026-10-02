import { randomInt, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { assertLocalTestDatabase } from '../src/database-target.js';

const db = createDb(assertLocalTestDatabase(process.env.TEST_DATABASE_URL));
const password = 'A-long-stage-test-password!';
const prefix = randomUUID().slice(0, 8);
const mobileBase = 9000000000 + randomInt(100000000);
let app: Awaited<ReturnType<typeof buildApp>>;
let config: ReturnType<typeof getConfig>;
const verifyAccessToken = vi.fn(async () => { throw new Error('MSG91 must not be called in dummy mode'); });

const post = (url: string, payload: unknown, cookie?: string) => app.inject({
  method: 'POST', url, headers: { origin: config.APP_ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(payload),
});

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DATABASE_URL', 'postgresql://stage:placeholder@localhost:5432/kleenbay_stage');
  vi.stubEnv('EXPECTED_DATABASE_NAME', 'kleenbay_stage');
  vi.stubEnv('APP_ORIGIN', 'https://stage.kleenbay.com');
  vi.stubEnv('COOKIE_SECURE', 'true');
  vi.stubEnv('STAGING_MODE', 'true');
  vi.stubEnv('POD_NAMESPACE', 'kleenbay-stage');
  vi.stubEnv('DEV_OTP_ENABLED', 'false');
  vi.stubEnv('DEV_OTP_FIXED_CODE', undefined);
  vi.stubEnv('DEV_OTP_CODE', undefined);
  vi.stubEnv('OTP_PROVIDER', 'DUMMY_OTP');
  vi.stubEnv('DUMMY_OTP', '123456');
  vi.stubEnv('OTP_HASH_SECRET', 'stage-integration-hash-secret-not-for-use');
  vi.stubEnv('MSG91_AUTH_KEY', undefined);
  vi.stubEnv('MSG91_WIDGET_ID', undefined);
  vi.stubEnv('MSG91_WIDGET_TOKEN', undefined);
  config = { ...getConfig(), LOG_LEVEL: 'silent' };
  vi.unstubAllEnvs();
  app = await buildApp(config, db, { verifyAccessToken });
  await app.ready();
});

afterAll(async () => { if (app) await app.close(); await db.$disconnect(); });

describe('public stage dummy OTP', () => {
  it('uses one configured code for owner-created employees in separate businesses', async () => {
    const otpConfig = await app.inject('/api/auth/employee/otp-config');
    expect(otpConfig.json()).toEqual({ provider: 'dummy', otpLength: 6 });
    expect(otpConfig.body).not.toContain('123456');
    for (const index of [0, 1]) {
      const organization = await db.organization.create({ data: { slug: `stage-dummy-${prefix}-${index}`, name: `Stage Dummy ${index}` } });
      const branch = await db.branch.create({ data: { organizationId: organization.id, name: 'Main' } });
      const email = `stage-dummy-${prefix}-${index}@example.test`;
      await db.user.create({ data: { organizationId: organization.id, branchId: branch.id, role: 'OWNER', name: `Owner ${index}`, email, passwordHash: await hash(password) } });
      const mobile = String(mobileBase + index);
      expect((await post('/api/auth/employee/request-otp', { mobile })).statusCode).toBe(404);
      const ownerLogin = await post('/api/auth/owner/login', { login: email, password });
      expect(ownerLogin.statusCode).toBe(200);
      const ownerCookie = `${ownerLogin.cookies[0]!.name}=${ownerLogin.cookies[0]!.value}`;
      const created = await post('/api/employees', { name: `Worker ${index}`, mobile }, ownerCookie);
      expect(created.statusCode).toBe(201);
      const requested = await post('/api/auth/employee/request-otp', { mobile });
      expect(requested.statusCode).toBe(200);
      expect(requested.json()).toMatchObject({ provider: 'dummy', resendAfterSeconds: 60, expiresInSeconds: 300 });
      expect(requested.body).not.toContain('123456');
      expect((await post('/api/auth/employee/request-otp', { mobile })).statusCode).toBe(429);
      const challenge = await db.otpChallenge.findFirstOrThrow({ where: { userId: created.json().id }, orderBy: { createdAt: 'desc' } });
      expect(challenge.codeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(challenge.codeHash).not.toContain('123456');
      expect((await post('/api/auth/employee/verify-otp', { mobile, code: '000000' })).statusCode).toBe(401);
      await db.otpChallenge.update({ where: { id: challenge.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await post('/api/auth/employee/verify-otp', { mobile, code: '123456' })).statusCode).toBe(401);
      await db.otpChallenge.update({ where: { id: challenge.id }, data: { expiresAt: new Date(Date.now() + 60_000) } });
      const verified = await post('/api/auth/employee/verify-otp', { mobile, code: '123456' });
      expect(verified.statusCode).toBe(200);
      expect(verified.json().user).toMatchObject({ role: 'EMPLOYEE', organizationId: organization.id });
      expect(verified.cookies[0]?.httpOnly).toBe(true);
      const employeeCookie = `${verified.cookies[0]!.name}=${verified.cookies[0]!.value}`;
      expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: employeeCookie } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/employees', headers: { cookie: employeeCookie } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/summary/daily', headers: { cookie: employeeCookie } })).statusCode).toBe(403);
      expect((await post('/api/auth/employee/verify-otp', { mobile, code: '123456' })).statusCode).toBe(401);
      const deactivated = await app.inject({ method: 'PATCH', url: `/api/employees/${created.json().id}`, headers: { origin: config.APP_ORIGIN, cookie: ownerCookie }, payload: { active: false } });
      expect(deactivated.statusCode).toBe(200);
      expect((await post('/api/auth/employee/request-otp', { mobile })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: employeeCookie } })).statusCode).toBe(401);
      const audits = await db.auditLog.findMany({ where: { actorUserId: created.json().id, action: { in: ['OTP_REQUESTED', 'EMPLOYEE_LOGIN'] } } });
      expect(JSON.stringify(audits)).not.toContain('123456');
    }
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });
});
