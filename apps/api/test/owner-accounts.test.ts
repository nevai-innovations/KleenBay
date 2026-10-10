import { createPaidTestOrganization } from './paid-fixture.js';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { assertLocalTestDatabase } from '../src/database-target.js';

const config = { ...getConfig(), NODE_ENV: 'test' as const, devOtp: true, DEV_OTP_ENABLED: 'true' as const, DEV_OTP_FIXED_CODE: '123456', LOG_LEVEL: 'silent' };
const db = createDb(assertLocalTestDatabase(process.env.TEST_DATABASE_URL));
const suffix = randomUUID().slice(0, 8);
const password = randomBytes(24).toString('base64url');
const names = ['Arun', 'Anandalekshmi', 'Aswin', 'Praveena P'];
const phoneBase = 9000000000 + randomInt(100000000);
type Tenant = { name: string; orgId: string; branchId: string; ownerId: string; cookie: string; employeeId: string; employeeMobile: string; serviceId: string; jobId: string; customerId: string; vehicleId: string; plate: string; customerMobile: string };
const tenants: Tenant[] = [];
let app: Awaited<ReturnType<typeof buildApp>>;

const request = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie?: string, body?: unknown) => app.inject({ method, url, headers: { origin: config.APP_ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });

beforeAll(async () => {
  app = await buildApp(config, db);
  await app.ready();
  for (const [index, name] of names.entries()) {
    const org = await createPaidTestOrganization(db, { data: { slug: `tenant-${suffix}-${index}`, name: `${name} Test Wash` } });
    const branch = await db.branch.create({ data: { organizationId: org.id, name: 'Main' } });
    const email = `${name.toLowerCase().replaceAll(' ', '')}-${suffix}@example.test`;
    const owner = await db.user.create({ data: { organizationId: org.id, branchId: branch.id, role: 'OWNER', name, email, passwordHash: await hash(password) } });
    const login = await request('POST', '/api/auth/owner/login', undefined, { login: email, password });
    expect(login.statusCode).toBe(200);
    const cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`;
    const employeeMobile = String(phoneBase + index);
    const employee = await request('POST', '/api/employees', cookie, { name: `${name} Worker`, mobile: employeeMobile });
    expect(employee.statusCode).toBe(201);
    const service = await request('POST', '/api/services', cookie, { name: `${name} Wash`, category: 'Wash', basePricePaise: 49900 + index, estimatedMinutes: 45 });
    expect(service.statusCode).toBe(201);
    const plate = `KL29AB12${10 + index}`;
    const customerMobile = String(phoneBase + 100 + index);
    const job = await request('POST', '/api/jobs/check-in', cookie, { idempotencyKey: randomUUID(), branchId: branch.id, mobile: customerMobile, customerName: `${name} Customer`, registrationNumber: plate, make: 'Hyundai', model: 'Creta', vehicleType: 'SUV', serviceId: service.json().id, expectedAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(), notify: true });
    expect(job.statusCode).toBe(201);
    tenants.push({ name, orgId: org.id, branchId: branch.id, ownerId: owner.id, cookie, employeeId: employee.json().id, employeeMobile, serviceId: service.json().id, jobId: job.json().id, customerId: job.json().customerId, vehicleId: job.json().vehicleId, plate, customerMobile });
  }
});

afterAll(async () => { if (app) await app.close(); await db.$disconnect(); });

describe('one owner per isolated business', () => {
  it('enforces one owner per business and globally unique employee mobiles', async () => {
    const arun = tenants[0]!;
    const anand = tenants[1]!;
    expect((await request('POST', '/api/employees', anand.cookie, { name: 'Duplicate', mobile: arun.employeeMobile })).statusCode).toBe(409);
    await expect(db.user.create({ data: { organizationId: arun.orgId, role: 'OWNER', name: 'Second Owner', email: `second-${suffix}@example.test`, passwordHash: await hash(password) } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('keeps every owner in their own dashboard and removes owner management', async () => {
    for (const tenant of tenants) {
      expect((await request('GET', '/api/auth/me', tenant.cookie)).json().user.organizationId).toBe(tenant.orgId);
      expect((await request('GET', '/api/summary/daily', tenant.cookie)).json().receivedCount).toBe(1);
      expect((await request('GET', '/api/jobs?view=active', tenant.cookie)).json().map((job: { id: string }) => job.id)).toEqual([tenant.jobId]);
      expect((await request('GET', '/api/employees', tenant.cookie)).json().map((employee: { id: string }) => employee.id)).toEqual([tenant.employeeId]);
      expect((await request('GET', '/api/services', tenant.cookie)).json().map((service: { id: string }) => service.id)).toEqual([tenant.serviceId]);
      expect((await request('GET', '/api/owners', tenant.cookie)).statusCode).toBe(404);
      expect((await request('POST', '/api/owners', tenant.cookie, { name: 'Another', email: 'another@example.test' })).statusCode).toBe(404);
    }
  });

  it('rejects foreign entity IDs and search results across the four-owner chain', async () => {
    for (const [index, tenant] of tenants.entries()) {
      const foreign = tenants[(index + 1) % tenants.length]!;
      expect((await request('GET', `/api/jobs/${foreign.jobId}`, tenant.cookie)).statusCode).toBe(404);
      expect((await request('GET', `/api/customers/${foreign.customerId}`, tenant.cookie)).statusCode).toBe(404);
      expect((await request('GET', `/api/vehicles/${foreign.vehicleId}`, tenant.cookie)).statusCode).toBe(404);
      expect((await request('PATCH', `/api/employees/${foreign.employeeId}`, tenant.cookie, { active: false })).statusCode).toBe(404);
      expect((await request('POST', '/api/employees', tenant.cookie, { name: 'Foreign', mobile: String(phoneBase + 200 + index), branchId: foreign.branchId })).statusCode).toBe(404);
      expect((await request('POST', '/api/vehicles', tenant.cookie, { customerId: foreign.customerId, registrationNumber: `KL29AB13${10 + index}`, make: 'Tata', model: 'Nexon', type: 'SUV' })).statusCode).toBe(404);
      expect((await request('POST', '/api/jobs/check-in', tenant.cookie, { idempotencyKey: randomUUID(), branchId: tenant.branchId, mobile: String(phoneBase + 300 + index), customerName: 'Foreign', registrationNumber: `KL29AB14${10 + index}`, make: 'Tata', model: 'Nexon', vehicleType: 'SUV', serviceId: foreign.serviceId, expectedAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString() })).statusCode).toBe(404);
      expect((await request('GET', `/api/jobs?view=active&q=${foreign.plate}`, tenant.cookie)).json()).toEqual([]);
      expect((await request('GET', `/api/customers?q=${foreign.customerMobile}`, tenant.cookie)).json()).toEqual([]);
      expect((await request('GET', `/api/vehicles?q=${foreign.plate}`, tenant.cookie)).json()).toEqual([]);
      expect((await request('GET', `/api/search?q=${foreign.plate}`, tenant.cookie)).json().vehicles).toEqual([]);
    }
  });

  it('keeps invoice, collections and operational status tenant-scoped', async () => {
    const arun = tenants[0]!;
    expect((await request('POST', `/api/jobs/${arun.jobId}/advance`, arun.cookie, { to: 'WASHING' })).statusCode).toBe(200);
    expect((await request('POST', `/api/jobs/${arun.jobId}/advance`, arun.cookie, { to: 'READY' })).statusCode).toBe(200);
    expect((await request('POST', `/api/jobs/${arun.jobId}/handover`, arun.cookie, { paymentAmountPaise: 10000, paymentMethod: 'UPI' })).statusCode).toBe(200);
    expect((await request('GET', `/api/jobs/${arun.jobId}`, arun.cookie)).json().invoice.payments).toHaveLength(1);
    for (const tenant of tenants.slice(1)) {
      expect((await request('GET', `/api/jobs/${arun.jobId}`, tenant.cookie)).statusCode).toBe(404);
      expect((await request('POST', `/api/jobs/${arun.jobId}/payments`, tenant.cookie, { idempotencyKey: randomUUID(), amountPaise: 100, method: 'CASH' })).statusCode).toBe(404);
      expect((await request('GET', '/api/board/metrics', tenant.cookie)).json().collectedPaise).toBe(0);
      expect((await request('GET', '/api/summary/daily', tenant.cookie)).json().collectedPaise).toBe(0);
    }
  });

  it('maps an employee by their owner-created mobile without a business hint', async () => {
    const arun = tenants[0]!;
    expect((await request('POST', '/api/auth/employee/request-otp', undefined, { mobile: arun.employeeMobile })).statusCode).toBe(200);
    const login = await request('POST', '/api/auth/employee/verify-otp', undefined, { mobile: arun.employeeMobile, code: '123456' });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.organizationId).toBe(arun.orgId);
    const cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`;
    expect((await request('GET', `/api/jobs/${tenants[1]!.jobId}`, cookie)).statusCode).toBe(404);
    expect((await request('GET', '/api/summary/daily', cookie)).statusCode).toBe(403);
    expect((await request('GET', `/api/jobs/${arun.jobId}`, cookie)).json().invoice).toBeUndefined();
  });

  it('accepts only valid single-use password setup tokens without an organization hint', async () => {
    const org = await createPaidTestOrganization(db, { data: { slug: `pending-${suffix}`, name: 'Pending Test Wash' } });
    const owner = await db.user.create({ data: { organizationId: org.id, role: 'OWNER', name: 'Pending', email: `pending-${suffix}@example.test`, active: false } });
    const token = randomBytes(32).toString('base64url');
    const setup = await db.ownerSetup.create({ data: { organizationId: org.id, userId: owner.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 60_000) } });
    const newPassword = randomBytes(24).toString('base64url');
    expect((await request('POST', '/api/auth/owner/setup', undefined, { token: 'x'.repeat(43), password: newPassword })).statusCode).toBe(400);
    expect((await request('POST', '/api/auth/owner/setup', undefined, { token, password: newPassword })).statusCode).toBe(200);
    expect((await request('POST', '/api/auth/owner/setup', undefined, { token, password: newPassword })).statusCode).toBe(400);
    expect((await request('POST', '/api/auth/owner/login', undefined, { login: owner.email, password: newPassword })).statusCode).toBe(200);
    expect((await db.ownerSetup.findUniqueOrThrow({ where: { id: setup.id } })).consumedAt).toBeTruthy();
  });
});
