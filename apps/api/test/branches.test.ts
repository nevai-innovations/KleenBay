import { randomInt, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { assertLocalTestDatabase } from '../src/database-target.js';
import { MockMessagingProvider } from '../src/messaging.js';
import type { StorageProvider } from '../src/storage.js';

const db = createDb(assertLocalTestDatabase(process.env.TEST_DATABASE_URL));
const config = { ...getConfig(), NODE_ENV: 'test' as const, devOtp: true, DEV_OTP_ENABLED: 'true' as const, DEV_OTP_FIXED_CODE: '123456', LOG_LEVEL: 'silent' };
const slug = `branch-${randomUUID()}`;
const foreignSlug = `branch-foreign-${randomUUID()}`;
const mobile = String(9000000000 + randomInt(900000000));
const storage: StorageProvider = { async put() { return 'test'; }, async get() { return Buffer.alloc(0); }, async remove() {} };
const branchInput = (name: string) => ({ name, code: name.toLowerCase().replaceAll(' ', '-'), phone: '+91 98470 10000', addressLine1: 'Market Road', city: 'Kollam', state: 'Kerala', postalCode: '691001', country: 'IN', timezone: 'Asia/Kolkata', openingTime: '08:00', closingTime: '19:00' });
let app: Awaited<ReturnType<typeof buildApp>>;
let organizationId: string;
let mainId: string;
let secondId: string;
let foreignId: string;
let serviceId: string;
let employeeId: string;
let ownerCookie: string;
let employeeCookie: string;
let foreignOwnerCookie: string;
let mainJobId: string;
let secondJobId: string;

function request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, body?: unknown, cookie?: string, orgSlug = slug) {
  return app.inject({ method, url, headers: { origin: config.APP_ORIGIN, 'content-type': 'application/json', 'x-organization-slug': orgSlug, ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
}
function checkIn(branchId?: string) {
  return { idempotencyKey: randomUUID(), mobile: '9845612399', customerName: 'Branch Driver', registrationNumber: `KL02AB${randomInt(1000, 9999)}`, make: 'Tata', model: 'Nexon', vehicleType: 'SUV', serviceId, ...(branchId ? { branchId } : {}), expectedAt: new Date(Date.now() + 3600000).toISOString(), notify: false };
}

beforeAll(async () => {
  const org = await db.organization.create({ data: { slug, name: 'Branch Test' } });
  organizationId = org.id;
  const foreign = await db.organization.create({ data: { slug: foreignSlug, name: 'Other Business' } });
  mainId = (await db.branch.create({ data: { organizationId, name: 'Main' } })).id;
  foreignId = (await db.branch.create({ data: { organizationId: foreign.id, name: 'Foreign' } })).id;
  serviceId = (await db.service.create({ data: { organizationId, name: 'Premium Wash', category: 'Wash', basePricePaise: 59900, estimatedMinutes: 45 } })).id;
  await db.user.create({ data: { organizationId, role: 'OWNER', name: 'Owner', username: 'owner', passwordHash: await hash('branch-test-password') } });
  await db.user.create({ data: { organizationId: foreign.id, role: 'OWNER', name: 'Foreign Owner', username: 'owner', passwordHash: await hash('branch-test-password') } });
  employeeId = (await db.user.create({ data: { organizationId, branchId: mainId, role: 'EMPLOYEE', name: 'Ravi', employee: { create: { mobile: `+91${mobile}` } } } })).id;
  app = await buildApp(config, db, undefined, new MockMessagingProvider(), storage);
  await app.ready();
  const owner = await request('POST', '/api/auth/owner/login', { login: 'owner', password: 'branch-test-password' });
  ownerCookie = `${owner.cookies[0]!.name}=${owner.cookies[0]!.value}`;
  const foreignOwner = await request('POST', '/api/auth/owner/login', { login: 'owner', password: 'branch-test-password' }, undefined, foreignSlug);
  foreignOwnerCookie = `${foreignOwner.cookies[0]!.name}=${foreignOwner.cookies[0]!.value}`;
  await request('POST', '/api/auth/employee/request-otp', { mobile });
  const employee = await request('POST', '/api/auth/employee/verify-otp', { mobile, code: '123456' });
  employeeCookie = `${employee.cookies[0]!.name}=${employee.cookies[0]!.value}`;
});
afterAll(async () => { if (app) await app.close(); await db.$disconnect(); });

describe('owner branch management and scope', () => {
  it('creates and edits only the owner organization branch, with audit', async () => {
    const created = await request('POST', '/api/branches', branchInput('Kottiyam'), ownerCookie);
    expect(created.statusCode).toBe(201);
    secondId = created.json().id;
    expect(created.json()).toMatchObject({ organizationId, name: 'Kottiyam', active: true, city: 'Kollam' });
    const listing = await request('GET', '/api/branches', undefined, ownerCookie);
    expect(listing.json().map((branch: { id: string }) => branch.id).sort()).toEqual([mainId, secondId].sort());
    const edited = await request('PATCH', `/api/branches/${secondId}`, { phone: '+91 98470 20000', openingTime: '09:00' }, ownerCookie);
    expect(edited.statusCode).toBe(200);
    expect(edited.json().phone).toBe('+91 98470 20000');
    expect((await request('GET', `/api/branches/${secondId}`, undefined, ownerCookie)).statusCode).toBe(200);
    expect(await db.auditLog.count({ where: { organizationId, entityType: 'Branch', entityId: secondId, action: { in: ['BRANCH_CREATED', 'BRANCH_UPDATED'] } } })).toBe(2);
  });

  it('denies employee management and hides other branches', async () => {
    expect((await request('GET', '/api/branches', undefined, employeeCookie)).json().map((branch: { id: string }) => branch.id)).toEqual([mainId]);
    for (const [method, url, body] of [['GET', `/api/branches/${mainId}`, undefined], ['POST', '/api/branches', branchInput('Forbidden')], ['PATCH', `/api/branches/${mainId}`, { name: 'Forbidden' }], ['POST', `/api/branches/${mainId}/deactivate`, {}]] as const) {
      expect((await request(method, url, body, employeeCookie)).statusCode).toBe(403);
    }
    expect((await request('GET', `/api/jobs?branchId=${secondId}`, undefined, employeeCookie)).statusCode).toBe(403);
    expect((await request('GET', `/api/board/metrics?branchId=${secondId}`, undefined, employeeCookie)).statusCode).toBe(403);
  });

  it('rejects foreign branch IDs on reads, changes, employee assignment, and check-in', async () => {
    expect((await request('GET', `/api/branches/${foreignId}`, undefined, ownerCookie)).statusCode).toBe(404);
    expect((await request('PATCH', `/api/branches/${foreignId}`, { name: 'Stolen' }, ownerCookie)).statusCode).toBe(404);
    expect((await request('POST', `/api/branches/${foreignId}/deactivate`, {}, ownerCookie)).statusCode).toBe(404);
    expect((await request('PATCH', `/api/employees/${employeeId}`, { branchId: foreignId }, ownerCookie)).statusCode).toBe(404);
    expect((await request('POST', '/api/jobs/check-in', checkIn(foreignId), ownerCookie)).statusCode).toBe(400);
    expect((await request('PUT', `/api/services/${serviceId}/prices`, { branchId: foreignId, vehicleType: 'SUV', pricePaise: 69900 }, ownerCookie)).statusCode).toBe(404);
    expect((await request('PUT', `/api/services/${serviceId}/branches/${foreignId}`, { active: false }, ownerCookie)).statusCode).toBe(404);
    expect((await request('GET', `/api/summary/daily?branchId=${foreignId}`, undefined, ownerCookie)).statusCode).toBe(404);
    expect((await request('GET', `/api/invoices?branchId=${foreignId}`, undefined, ownerCookie)).statusCode).toBe(404);
    expect((await request('GET', `/api/payments?branchId=${foreignId}`, undefined, ownerCookie)).statusCode).toBe(404);
    expect((await request('GET', '/api/branches', undefined, foreignOwnerCookie, foreignSlug)).json().map((branch: { id: string }) => branch.id)).toEqual([foreignId]);
  });

  it('requires branch choice for multiple branches, applies overrides, and scopes board and summary', async () => {
    expect((await request('POST', '/api/jobs/check-in', checkIn(), ownerCookie)).statusCode).toBe(400);
    expect((await request('PUT', `/api/services/${serviceId}/prices`, { branchId: secondId, vehicleType: 'SUV', pricePaise: 64900 }, ownerCookie)).statusCode).toBe(200);
    const first = await request('POST', '/api/jobs/check-in', checkIn(mainId), ownerCookie);
    const second = await request('POST', '/api/jobs/check-in', checkIn(secondId), ownerCookie);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    mainJobId = first.json().id;
    secondJobId = second.json().id;
    expect(first.json().servicePricePaise).toBe(59900);
    expect(second.json().servicePricePaise).toBe(64900);
    const all = (await request('GET', '/api/jobs', undefined, ownerCookie)).json();
    const filtered = (await request('GET', `/api/jobs?branchId=${mainId}`, undefined, ownerCookie)).json();
    expect(all.length).toBeGreaterThan(filtered.length);
    expect(filtered.every((job: { branchId: string }) => job.branchId === mainId)).toBe(true);
    expect((await request('GET', `/api/summary/daily?branchId=${mainId}`, undefined, ownerCookie)).json().branchId).toBe(mainId);
    expect((await request('GET', `/api/jobs/${second.json().id}`, undefined, employeeCookie)).statusCode).toBe(404);
    const employeeJobs = (await request('GET', '/api/jobs', undefined, employeeCookie)).json();
    expect(employeeJobs.some((job: { id: string }) => job.id === first.json().id)).toBe(true);
    expect(employeeJobs.every((job: { branchId: string }) => job.branchId === mainId)).toBe(true);
  });

  it('scopes invoices, payments, and handed-over history to the job branch', async () => {
    for (const jobId of [mainJobId, secondJobId]) {
      const draft = await request('POST', `/api/jobs/${jobId}/invoice`, { items: [], discountKind: 'NONE', discountValue: 0 }, ownerCookie);
      expect(draft.statusCode).toBe(201);
      expect((await request('POST', `/api/invoices/${draft.json().id}/issue`, {}, ownerCookie)).statusCode).toBe(200);
      expect((await request('POST', `/api/jobs/${jobId}/payments`, { idempotencyKey: randomUUID(), amountPaise: 10000, method: 'UPI' }, ownerCookie)).statusCode).toBe(201);
    }
    const mainInvoices = (await request('GET', `/api/invoices?branchId=${mainId}`, undefined, ownerCookie)).json();
    const secondInvoices = (await request('GET', `/api/invoices?branchId=${secondId}`, undefined, ownerCookie)).json();
    expect(mainInvoices.some((row: { job: { branch: { id: string } } }) => row.job.branch.id === secondId)).toBe(false);
    expect(secondInvoices.some((row: { job: { branch: { id: string } } }) => row.job.branch.id === mainId)).toBe(false);
    expect(mainInvoices.length).toBeGreaterThan(0);
    expect(secondInvoices.length).toBeGreaterThan(0);
    const mainPayments = (await request('GET', `/api/payments?branchId=${mainId}`, undefined, ownerCookie)).json();
    const secondPayments = (await request('GET', `/api/payments?branchId=${secondId}`, undefined, ownerCookie)).json();
    expect(mainPayments.length).toBeGreaterThan(0);
    expect(secondPayments.length).toBeGreaterThan(0);
    expect(mainPayments.every((row: { invoice: { job: { branch: { id: string } } } }) => row.invoice.job.branch.id === mainId)).toBe(true);
    expect(secondPayments.every((row: { invoice: { job: { branch: { id: string } } } }) => row.invoice.job.branch.id === secondId)).toBe(true);
    expect((await request('GET', '/api/payments', undefined, employeeCookie)).statusCode).toBe(403);
    for (const jobId of [mainJobId, secondJobId]) {
      expect((await request('POST', `/api/jobs/${jobId}/advance`, { to: 'WASHING' }, ownerCookie)).statusCode).toBe(200);
      expect((await request('POST', `/api/jobs/${jobId}/advance`, { to: 'READY' }, ownerCookie)).statusCode).toBe(200);
      expect((await request('POST', `/api/jobs/${jobId}/handover`, { paymentAmountPaise: 0 }, ownerCookie)).statusCode).toBe(200);
    }
    const history = (await request('GET', `/api/jobs?view=history&branchId=${secondId}`, undefined, ownerCookie)).json();
    expect(history.some((job: { id: string }) => job.id === secondJobId)).toBe(true);
    expect(history.some((job: { id: string }) => job.id === mainJobId)).toBe(false);
  });

  it('fails closed for a legacy employee without branch assignment', async () => {
    await db.user.update({ where: { id: employeeId }, data: { branchId: null } });
    try {
      expect((await request('GET', '/api/branches', undefined, employeeCookie)).json()).toEqual([]);
      expect((await request('GET', '/api/jobs?view=history', undefined, employeeCookie)).json()).toEqual([]);
      expect((await request('GET', `/api/jobs/${mainJobId}`, undefined, employeeCookie)).statusCode).toBe(404);
      expect((await request('GET', '/api/services', undefined, employeeCookie)).json()).toEqual([]);
      expect((await request('POST', '/api/jobs/check-in', checkIn(mainId), employeeCookie)).statusCode).toBe(403);
    } finally {
      await db.user.update({ where: { id: employeeId }, data: { branchId: mainId } });
    }
  });

  it('reassigns employee, audits it, and retains historical jobs after deactivation', async () => {
    const update = await request('PATCH', `/api/employees/${employeeId}`, { branchId: secondId }, ownerCookie);
    expect(update.statusCode).toBe(200);
    expect(await db.auditLog.count({ where: { organizationId, entityId: employeeId, action: 'EMPLOYEE_BRANCH_CHANGED' } })).toBe(1);
    expect((await request('GET', '/api/branches', undefined, employeeCookie)).json().map((branch: { id: string }) => branch.id)).toEqual([secondId]);
    expect((await request('GET', `/api/jobs?branchId=${mainId}`, undefined, employeeCookie)).statusCode).toBe(403);
    expect((await request('POST', `/api/branches/${secondId}/deactivate`, {}, ownerCookie)).statusCode).toBe(200);
    expect((await request('POST', '/api/jobs/check-in', checkIn(secondId), ownerCookie)).statusCode).toBe(400);
    expect((await request('GET', `/api/jobs?view=history&branchId=${secondId}`, undefined, ownerCookie)).json().length).toBeGreaterThan(0);
    expect((await request('POST', `/api/branches/${mainId}/deactivate`, {}, ownerCookie)).statusCode).toBe(400);
    expect((await request('POST', `/api/branches/${secondId}/activate`, {}, ownerCookie)).statusCode).toBe(200);
  });
});
