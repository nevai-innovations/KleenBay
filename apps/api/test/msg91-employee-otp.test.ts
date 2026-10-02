import { randomInt, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { assertLocalTestDatabase } from '../src/database-target.js';
import { createOtpProvider } from '../src/otp.js';

const config = {
  ...getConfig(), NODE_ENV: 'test' as const, LOG_LEVEL: 'silent', devOtp: false, DEV_OTP_ENABLED: 'false' as const,
  OTP_PROVIDER: 'msg91' as const, otpMode: 'msg91' as const, MSG91_AUTH_KEY: 'test-key-not-real', MSG91_WIDGET_ID: 'test-widget', MSG91_WIDGET_TOKEN: 'test-public-token',
};
const db = createDb(assertLocalTestDatabase(process.env.TEST_DATABASE_URL));
const slug = `otp-${randomUUID()}`;
const employeeMobile = String(9000000000 + randomInt(900000000));
const employeeE164 = `+91${employeeMobile}`;
const providerMobile = `91${employeeMobile}`;
const spacedMobile = `+91 ${employeeMobile.slice(0, 5)} ${employeeMobile.slice(5)}`;
const prefixedMobile = `91 ${employeeMobile.slice(0, 5)} ${employeeMobile.slice(5)}`;
const trunkMobile = `0${employeeMobile}`;
const mismatchE164 = `+91${Number(employeeMobile) + 1}`;
const password = 'A-long-local-test-password!';
const accessToken = 'a'.repeat(64);
const verifyAccessToken = vi.fn(async (_token: string) => employeeE164);
let app: Awaited<ReturnType<typeof buildApp>>;
let orgId: string;
let ownerCookie: string;
let employeeId: string;

const post = (url: string, payload: unknown, cookie?: string) => app.inject({ method: 'POST', url, headers: { origin: config.APP_ORIGIN, 'content-type': 'application/json', 'x-organization-slug': slug, ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(payload) });

beforeAll(async () => {
  const org = await db.organization.create({ data: { name: 'OTP Test Wash', slug } });
  orgId = org.id;
  const branch = await db.branch.create({ data: { organizationId: org.id, name: 'Main' } });
  await db.user.create({ data: { organizationId: org.id, branchId: branch.id, role: 'OWNER', name: 'Owner', username: 'otp-owner', passwordHash: await hash(password) } });
  app = await buildApp(config, db, { verifyAccessToken });
  await app.ready();
  const owner = await post('/api/auth/owner/login', { login: 'otp-owner', password });
  expect(owner.statusCode).toBe(200);
  ownerCookie = `${owner.cookies[0]!.name}=${owner.cookies[0]!.value}`;
});

afterAll(async () => { if (app) await app.close(); await db.$disconnect(); });

describe('MSG91 employee OTP contract', () => {
  it('exposes only browser-public widget configuration', async () => {
    const result = await app.inject('/api/auth/employee/otp-config');
    expect(result.json()).toEqual({ provider: 'msg91', otpLength: 6, widgetId: 'test-widget', widgetToken: 'test-public-token' });
    expect(result.body).not.toContain(config.MSG91_AUTH_KEY);
    expect(result.body).not.toContain(config.OTP_HASH_SECRET);
  });

  it('requires owner creation and canonicalizes the account mobile', async () => {
    expect((await post('/api/auth/employee/request-otp', { mobile: spacedMobile })).statusCode).toBe(404);
    const created = await post('/api/employees', { name: 'Anu', mobile: trunkMobile }, ownerCookie);
    expect(created.statusCode).toBe(201);
    expect(created.json().mobile).toBe(employeeE164);
    expect((await post('/api/employees', { name: 'Anu', mobile: prefixedMobile }, ownerCookie)).statusCode).toBe(409);
    employeeId = created.json().id;
    const request = await post('/api/auth/employee/request-otp', { mobile: spacedMobile });
    expect(request.statusCode, request.body).toBe(200);
    expect(request.json()).toMatchObject({ provider: 'msg91', resendAfterSeconds: 60, expiresInSeconds: 300 });
    expect((await post('/api/auth/employee/request-otp', { mobile: employeeMobile })).statusCode).toBe(429);
    const challenge = await db.otpChallenge.findFirstOrThrow({ where: { organizationId: orgId, userId: employeeId }, orderBy: { createdAt: 'desc' } });
    expect(challenge.codeHash).not.toContain(accessToken);
    expect(challenge.requestSourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects wrong method, phone mismatch, and token replay; creates only an employee session', async () => {
    expect((await post('/api/auth/employee/verify-otp', { mobile: employeeMobile, code: '123456' })).statusCode).toBe(400);
    verifyAccessToken.mockResolvedValueOnce(mismatchE164);
    expect((await post('/api/auth/employee/verify-otp', { mobile: employeeMobile, accessToken })).statusCode).toBe(401);
    const verified = await post('/api/auth/employee/verify-otp', { mobile: employeeMobile, accessToken });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().user.role).toBe('EMPLOYEE');
    const cookie = `${verified.cookies[0]!.name}=${verified.cookies[0]!.value}`;
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json().user.role).toBe('EMPLOYEE');
    expect((await app.inject({ method: 'GET', url: '/api/summary/daily', headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/employees', headers: { cookie } })).statusCode).toBe(403);
    expect((await post('/api/auth/employee/verify-otp', { mobile: employeeMobile, accessToken })).statusCode).toBe(401);
    await db.otpChallenge.updateMany({ where: { userId: employeeId }, data: { createdAt: new Date(Date.now() - 61_000) } });
    expect((await post('/api/auth/employee/request-otp', { mobile: employeeMobile })).statusCode).toBe(200);
    expect((await post('/api/auth/employee/verify-otp', { mobile: employeeMobile, accessToken })).statusCode).toBe(401);
    const auditRecords = await db.auditLog.findMany({ where: { organizationId: orgId, action: { in: ['OTP_REQUESTED', 'EMPLOYEE_LOGIN'] } } });
    expect(JSON.stringify(auditRecords)).not.toContain(accessToken);
    expect(JSON.stringify(auditRecords)).not.toContain('123456');
  });

  it('rejects expired challenges and inactive employees', async () => {
    await db.otpChallenge.updateMany({ where: { userId: employeeId, consumedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await post('/api/auth/employee/verify-otp', { mobile: employeeMobile, accessToken: 'b'.repeat(64) })).statusCode).toBe(401);
    const changed = await app.inject({ method: 'PATCH', url: `/api/employees/${employeeId}`, headers: { origin: config.APP_ORIGIN, cookie: ownerCookie }, payload: { active: false } });
    expect(changed.statusCode).toBe(200);
    expect((await post('/api/auth/employee/request-otp', { mobile: employeeMobile })).statusCode).toBe(404);
    expect((await post('/api/auth/employee/verify-otp', { mobile: employeeMobile, accessToken: 'c'.repeat(64) })).statusCode).toBe(401);
  });
});

describe('MSG91 server token verifier', () => {
  it('calls verifyAccessToken with server AuthKey and fails closed on provider failure', async () => {
    const fetchImpl = vi.fn(async (_url: string, _options: RequestInit) => Response.json({ type: 'success', data: { identifier: providerMobile } }));
    const provider = createOtpProvider(config, fetchImpl as typeof fetch);
    expect(await provider.verifyAccessToken('x'.repeat(64))).toBe(providerMobile);
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://control.msg91.com/api/v5/widget/verifyAccessToken');
    expect(options.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(options.body).toBe(JSON.stringify({ authkey: config.MSG91_AUTH_KEY, 'access-token': 'x'.repeat(64) }));
    const failed = createOtpProvider(config, async () => Response.json({ type: 'error', message: 'invalid', data: { identifier: providerMobile } }));
    await expect(failed.verifyAccessToken('x'.repeat(64))).rejects.toMatchObject({ statusCode: 401 });
    const expiredToken = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.${'x'.repeat(32)}`;
    await expect(provider.verifyAccessToken(expiredToken)).rejects.toMatchObject({ statusCode: 401 });
    const unavailable = createOtpProvider(config, async () => { throw new Error('provider network failure'); });
    await expect(unavailable.verifyAccessToken('x'.repeat(64))).rejects.toMatchObject({ statusCode: 503 });
  });
});
