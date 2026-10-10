import { randomInt, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { assertLocalTestDatabase } from '../src/database-target.js';
import { createPaidTestOrganization } from './paid-fixture.js';

const config = { ...getConfig(), NODE_ENV: 'test' as const, devOtp: true, DEV_OTP_ENABLED: 'true' as const, DEV_OTP_FIXED_CODE: '123456', LOG_LEVEL: 'silent' };
const testUrl = assertLocalTestDatabase(process.env.TEST_DATABASE_URL);
const db = createDb(testUrl);
const slug = `test-${randomUUID()}`;
const employeeMobile = String(9000000000 + randomInt(900000000));
const employeeE164 = `+91${employeeMobile}`;
const password = 'A-long-local-test-password!';
let app: Awaited<ReturnType<typeof buildApp>>;
let ownerId: string;
let organizationId: string;
let branchId: string;
let ownerCookie: string;
let employeeCookie: string;
const origin = config.APP_ORIGIN;

const post = (url: string, payload: unknown, cookie?: string, org = slug) => app.inject({ method: 'POST', url, headers: { origin, 'content-type': 'application/json', 'x-organization-slug': org, ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(payload) });

beforeAll(async () => {
  const organization = await createPaidTestOrganization(db, { data: { name: 'Test Car Wash', slug } });
  organizationId = organization.id;
  const branch = await db.branch.create({ data: { organizationId: organization.id, name: 'Main' } });
  branchId = branch.id;
  const owner = await db.user.create({ data: { organizationId: organization.id, branchId, role: 'OWNER', name: 'Owner', username: 'owner', email: `owner-${slug}@example.test`, passwordHash: await hash(password) } });
  ownerId = owner.id;
  app = await buildApp(config, db);
  await app.ready();
});

afterAll(async () => { if (app) await app.close(); await db.$disconnect(); });

describe('M1 authentication and tenant boundaries', () => {
  it('authenticates owner with password, creates session and audit record', async () => {
    const wrong = await post('/api/auth/owner/login', { login: 'owner', password: 'wrong' });
    expect(wrong.statusCode).toBe(401);
    const result = await post('/api/auth/owner/login', { login: 'owner', password });
    expect(result.statusCode).toBe(200);
    expect(result.json().user.role).toBe('OWNER');
    ownerCookie = result.cookies[0]!.name + '=' + result.cookies[0]!.value;
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: ownerCookie } });
    expect(me.json().user.id).toBe(ownerId);
    expect(await db.auditLog.count({ where: { actorUserId: ownerId, action: 'OWNER_LOGIN' } })).toBe(1);
  });

  it('rejects unknown employees and owner creates an employee without self-registration', async () => {
    const unknown = await post('/api/auth/employee/request-otp', { mobile: employeeMobile });
    expect(unknown.statusCode).toBe(404);
    const created = await post('/api/employees', { name: 'Ravi', mobile: employeeMobile, branchId }, ownerCookie);
    expect(created.statusCode).toBe(201);
    expect(created.json().mobile).toBe(employeeE164);
    expect(await db.auditLog.count({ where: { action: 'EMPLOYEE_CREATED', entityId: created.json().id } })).toBe(1);
    const duplicate = await post('/api/employees', { name: 'Ravi 2', mobile: employeeMobile, branchId }, ownerCookie);
    expect(duplicate.statusCode).toBe(409);
  });

  it('enforces OTP expiry, attempts, cooldown and creates employee session', async () => {
    const sent = await post('/api/auth/employee/request-otp', { mobile: employeeMobile });
    expect(sent.statusCode, sent.body).toBe(200);
    expect((await post('/api/auth/employee/request-otp', { mobile: employeeMobile })).statusCode).toBe(429);
    expect((await post('/api/auth/employee/verify-otp', { mobile: employeeMobile, code: '000000' })).statusCode).toBe(401);
    const employee = await db.employeeProfile.findUniqueOrThrow({ where: { organizationId_mobile: { organizationId: (await db.organization.findUniqueOrThrow({ where: { slug } })).id, mobile: employeeE164 } } });
    await db.otpChallenge.updateMany({ where: { userId: employee.userId, consumedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await post('/api/auth/employee/verify-otp', { mobile: employeeMobile, code: config.DEV_OTP_FIXED_CODE })).statusCode).toBe(401);
    await db.otpChallenge.updateMany({ where: { userId: employee.userId, consumedAt: null }, data: { expiresAt: new Date(Date.now() + 60_000) } });
    const verified = await post('/api/auth/employee/verify-otp', { mobile: employeeMobile, code: config.DEV_OTP_FIXED_CODE });
    expect(verified.statusCode).toBe(200);
    employeeCookie = verified.cookies[0]!.name + '=' + verified.cookies[0]!.value;
    expect(verified.json().user.role).toBe('EMPLOYEE');
    expect((await post('/api/auth/employee/verify-otp', { mobile: employeeMobile, code: config.DEV_OTP_FIXED_CODE })).statusCode).toBe(401);
  });

  it('blocks employee management and cross-tenant branch assignment', async () => {
    const forbidden = await app.inject({ method: 'GET', url: '/api/employees', headers: { cookie: employeeCookie } });
    expect(forbidden.statusCode).toBe(403);
    const other = await createPaidTestOrganization(db, { data: { slug: `other-${randomUUID()}`, name: 'Other Wash' } });
    const foreign = await db.branch.create({ data: { organizationId: other.id, name: 'Other Branch' } });
    const result = await post('/api/employees', { name: 'Bad Branch', mobile: '9876543213', branchId: foreign.id }, ownerCookie);
    expect(result.statusCode).toBe(404);
  });

  it('deactivates employee, revokes sessions and blocks login', async () => {
    const employee = await db.employeeProfile.findFirstOrThrow({ where: { organizationId, mobile: employeeE164 } });
    const changed = await app.inject({ method: 'PATCH', url: `/api/employees/${employee.userId}`, headers: { cookie: ownerCookie, origin }, payload: { active: false } });
    expect(changed.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: employeeCookie } })).statusCode).toBe(401);
    expect((await post('/api/auth/employee/request-otp', { mobile: employeeMobile })).statusCode).toBe(404);
    expect(await db.auditLog.count({ where: { action: 'EMPLOYEE_UPDATED', entityId: employee.userId } })).toBe(1);
  });

  it('returns a structured 429 when OTP requests are rate limited', async () => {
    let limited;
    for (let attempt = 0; attempt < 14; attempt++) {
      const response = await post('/api/auth/employee/request-otp', { mobile: '9876543215' });
      if (response.statusCode === 429) { limited = response; break; }
    }
    expect(limited?.statusCode).toBe(429);
    expect(limited?.json().error.code).toBe('RATE_LIMITED');
  });
});
