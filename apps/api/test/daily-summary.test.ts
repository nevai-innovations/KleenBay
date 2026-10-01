import { randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { todayWindow } from '../src/daily-summary.js';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must target a _test database');
const db = createDb(testUrl);
const config = { ...getConfig(), NODE_ENV: 'test' as const, devOtp: true, DEV_OTP_ENABLED: 'true' as const, LOG_LEVEL: 'silent' };
const slug = `summary-${randomUUID()}`;
const now = new Date('2026-10-01T10:00:00.000Z');
const at = (hour: number, dayOffset = 0) => new Date(Date.parse('2026-10-01T00:00:00+05:30') + (hour + dayOffset * 24) * 60 * 60_000);
let app: Awaited<ReturnType<typeof buildApp>>;
let mainBranchId: string;
let otherBranchId: string;
let foreignBranchId: string;
let ownerCookie: string;
let employeeCookie: string;

function request(url: string, cookie?: string) {
  return app.inject({ method: 'GET', url, headers: { origin: config.APP_ORIGIN, 'x-organization-slug': slug, ...(cookie ? { cookie } : {}) } });
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  const org = await db.organization.create({ data: { slug, name: 'Summary Test', timezone: 'Asia/Kolkata' } });
  mainBranchId = (await db.branch.create({ data: { organizationId: org.id, name: 'Main' } })).id;
  otherBranchId = (await db.branch.create({ data: { organizationId: org.id, name: 'Second' } })).id;
  const owner = await db.user.create({ data: { organizationId: org.id, branchId: mainBranchId, role: 'OWNER', name: 'Owner', username: 'owner', passwordHash: await hash('test-password') } });
  const employee = await db.user.create({ data: { organizationId: org.id, branchId: mainBranchId, role: 'EMPLOYEE', name: 'Ravi', employee: { create: { mobile: '+919876543210' } } } });
  const service = await db.service.create({ data: { organizationId: org.id, name: 'Basic Wash', category: 'Wash', basePricePaise: 29900, estimatedMinutes: 45 } });

  async function customerVehicle(name: string, mobile: string, registrationNumber: string) {
    const customer = await db.customer.create({ data: { organizationId: org.id, name, mobile } });
    const vehicle = await db.vehicle.create({ data: { organizationId: org.id, customerId: customer.id, registrationNumber, make: 'Honda', model: 'City', type: 'SEDAN' } });
    return { customerId: customer.id, vehicleId: vehicle.id };
  }
  const newCustomer = await customerVehicle('New Customer', '+919845600101', 'KA01AB1001');
  const returningCustomer = await customerVehicle('Returning Customer', '+919845600102', 'KA01AB1002');
  const secondBranchCustomer = await customerVehicle('Second Branch Customer', '+919845600103', 'KA01AB1003');
  const base = { organizationId: org.id, serviceId: service.id, checkedInById: owner.id, taxPaise: 0 };
  await db.job.create({ data: { ...base, ...returningCustomer, branchId: mainBranchId, number: 1, idempotencyKey: randomUUID(), serviceName: 'Basic Wash', subtotalPaise: 29900, totalPaise: 29900, status: 'HANDED_OVER', checkedInAt: at(10, -1), expectedAt: at(11, -1), handedOverAt: at(11, -1), handedOverById: owner.id } });
  const active = await db.job.create({ data: { ...base, ...newCustomer, branchId: mainBranchId, number: 2, idempotencyKey: randomUUID(), serviceName: 'Basic Wash', subtotalPaise: 29900, totalPaise: 29900, status: 'WASHING', checkedInAt: at(9), expectedAt: at(13), stageAt: at(10) } });
  const delivered = await db.job.create({ data: { ...base, ...returningCustomer, branchId: mainBranchId, number: 3, idempotencyKey: randomUUID(), serviceName: 'Premium Wash', subtotalPaise: 59900, totalPaise: 59900, status: 'HANDED_OVER', checkedInAt: at(10), expectedAt: at(11), handedOverAt: at(12), handedOverById: owner.id } });
  const secondBranch = await db.job.create({ data: { ...base, ...secondBranchCustomer, branchId: otherBranchId, number: 4, idempotencyKey: randomUUID(), serviceName: 'Basic Wash', subtotalPaise: 49900, totalPaise: 49900, status: 'HANDED_OVER', checkedInAt: at(11), expectedAt: at(13), handedOverAt: at(12.5), handedOverById: owner.id } });
  await db.jobStageHistory.createMany({ data: [
    { organizationId: org.id, jobId: active.id, fromStage: 'RECEIVED', toStage: 'WASHING', actorUserId: employee.id, createdAt: at(10) },
    { organizationId: org.id, jobId: delivered.id, fromStage: 'WASHING', toStage: 'READY', actorUserId: employee.id, createdAt: at(11.5) },
    { organizationId: org.id, jobId: delivered.id, fromStage: 'READY', toStage: 'HANDED_OVER', actorUserId: employee.id, createdAt: at(12) },
    { organizationId: org.id, jobId: secondBranch.id, fromStage: 'WASHING', toStage: 'READY', actorUserId: owner.id, createdAt: at(12) },
  ] });
  const partial = await db.invoice.create({ data: { organizationId: org.id, jobId: delivered.id, invoiceNumber: 'SUM-001', subtotalPaise: 59900, taxPaise: 0, totalPaise: 59900, status: 'PARTIALLY_PAID', issuedAt: at(12) } });
  await db.payment.create({ data: { organizationId: org.id, invoiceId: partial.id, idempotencyKey: randomUUID(), amountPaise: 30000, method: 'UPI', collectedById: owner.id, createdAt: at(12) } });
  const full = await db.invoice.create({ data: { organizationId: org.id, jobId: secondBranch.id, invoiceNumber: 'SUM-002', subtotalPaise: 49900, taxPaise: 0, totalPaise: 49900, status: 'PAID', issuedAt: at(12.5) } });
  await db.payment.create({ data: { organizationId: org.id, invoiceId: full.id, idempotencyKey: randomUUID(), amountPaise: 49900, method: 'CASH', collectedById: owner.id, createdAt: at(12.5) } });

  const foreign = await db.organization.create({ data: { slug: `foreign-${randomUUID()}`, name: 'Another Business' } });
  const foreignBranch = await db.branch.create({ data: { organizationId: foreign.id, name: 'Main' } });
  foreignBranchId = foreignBranch.id;
  const foreignOwner = await db.user.create({ data: { organizationId: foreign.id, branchId: foreignBranch.id, role: 'OWNER', name: 'Other Owner', username: 'other', passwordHash: await hash('other-password') } });
  const foreignCustomer = await db.customer.create({ data: { organizationId: foreign.id, name: 'Other Customer', mobile: '+919845600104' } });
  const foreignVehicle = await db.vehicle.create({ data: { organizationId: foreign.id, customerId: foreignCustomer.id, registrationNumber: 'KA01AB1004', make: 'Tata', model: 'Nexon', type: 'SUV' } });
  const foreignService = await db.service.create({ data: { organizationId: foreign.id, name: 'Other Wash', category: 'Wash', basePricePaise: 100000, estimatedMinutes: 30 } });
  const foreignJob = await db.job.create({ data: { organizationId: foreign.id, branchId: foreignBranch.id, customerId: foreignCustomer.id, vehicleId: foreignVehicle.id, serviceId: foreignService.id, checkedInById: foreignOwner.id, number: 1, idempotencyKey: randomUUID(), serviceName: 'Other Wash', subtotalPaise: 100000, taxPaise: 0, totalPaise: 100000, status: 'HANDED_OVER', checkedInAt: at(9), expectedAt: at(10), handedOverAt: at(10), handedOverById: foreignOwner.id } });
  const foreignInvoice = await db.invoice.create({ data: { organizationId: foreign.id, jobId: foreignJob.id, invoiceNumber: 'OTHER-001', subtotalPaise: 100000, taxPaise: 0, totalPaise: 100000, status: 'PAID', issuedAt: at(10) } });
  await db.payment.create({ data: { organizationId: foreign.id, invoiceId: foreignInvoice.id, idempotencyKey: randomUUID(), amountPaise: 100000, method: 'CASH', collectedById: foreignOwner.id, createdAt: at(10) } });

  app = await buildApp(config, db);
  await app.ready();
  const ownerLogin = await app.inject({ method: 'POST', url: '/api/auth/owner/login', headers: { origin: config.APP_ORIGIN, 'x-organization-slug': slug }, payload: { login: 'owner', password: 'test-password' } });
  ownerCookie = `${ownerLogin.cookies[0]!.name}=${ownerLogin.cookies[0]!.value}`;
  await app.inject({ method: 'POST', url: '/api/auth/employee/request-otp', headers: { origin: config.APP_ORIGIN, 'x-organization-slug': slug }, payload: { mobile: '9876543210' } });
  const employeeLogin = await app.inject({ method: 'POST', url: '/api/auth/employee/verify-otp', headers: { origin: config.APP_ORIGIN, 'x-organization-slug': slug }, payload: { mobile: '9876543210', code: config.DEV_OTP_CODE } });
  employeeCookie = `${employeeLogin.cookies[0]!.name}=${employeeLogin.cookies[0]!.value}`;
});

afterAll(async () => { if (app) await app.close(); await db.$disconnect(); vi.useRealTimers(); });

describe('daily summary', () => {
  it('uses the business timezone for the day boundary', () => {
    const window = todayWindow(new Date('2026-09-30T19:00:00.000Z'), 'Asia/Kolkata');
    expect(window.date).toBe('2026-10-01');
    expect(window.start.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(window.end.toISOString()).toBe('2026-10-01T18:30:00.000Z');
  });

  it('reports actual check-ins, collections, outstanding, turnaround and activity without cross-tenant data', async () => {
    const response = await request('/api/summary/daily', ownerCookie);
    expect(response.statusCode).toBe(200);
    const summary = response.json();
    expect(summary.date).toBe('2026-10-01');
    expect(summary.receivedCount).toBe(3);
    expect(summary.handedOverCount).toBe(2);
    expect(summary.stillOnBoardCount).toBe(1);
    expect(summary.collectedPaise).toBe(79900);
    expect(summary.collectionByMethod).toEqual([{ method: 'CASH', amountPaise: 49900 }, { method: 'UPI', amountPaise: 30000 }]);
    expect(summary.unpaidPaise).toBe(29900);
    expect(summary.unpaidInvoiceCount).toBe(1);
    expect(summary.pipelinePaise).toBe(29900);
    expect(summary.avgTurnaroundMinutes).toBe(105);
    expect(summary.lateCount).toBe(2);
    expect(summary.services).toEqual([{ name: 'Basic Wash', count: 2, valuePaise: 79800 }, { name: 'Premium Wash', count: 1, valuePaise: 59900 }]);
    expect(summary.hours).toEqual([{ hour: 9, count: 1 }, { hour: 10, count: 1 }, { hour: 11, count: 1 }]);
    expect(summary.busiestHour).toBe(9);
    expect(summary.staff).toEqual([{ id: expect.any(String), name: 'Ravi', cars: 2, updates: 3, handovers: 1 }]);
    expect(summary.customers).toEqual({ newCount: 2, returningCount: 1 });
    expect(summary.attention.map((item: { kind: string }) => item.kind).sort()).toEqual(['LATE', 'UNPAID']);
  });

  it('applies the branch filter to financial and operational data', async () => {
    const response = await request(`/api/summary/daily?branchId=${mainBranchId}`, ownerCookie);
    expect(response.statusCode).toBe(200);
    const summary = response.json();
    expect(summary.receivedCount).toBe(2);
    expect(summary.handedOverCount).toBe(1);
    expect(summary.collectedPaise).toBe(30000);
    expect(summary.collectionByMethod).toEqual([{ method: 'UPI', amountPaise: 30000 }]);
    expect(summary.unpaidPaise).toBe(29900);
    expect(summary.avgTurnaroundMinutes).toBe(120);
    expect(summary.staff).toHaveLength(1);
    expect(summary.customers).toEqual({ newCount: 1, returningCount: 1 });
    expect((await request(`/api/summary/daily?branchId=${otherBranchId}`, ownerCookie)).json().collectedPaise).toBe(49900);
  });

  it('is owner-only and rejects another business branch', async () => {
    expect((await request('/api/summary/daily', employeeCookie)).statusCode).toBe(403);
    expect((await request('/api/summary/daily')).statusCode).toBe(401);
    expect((await request(`/api/summary/daily?branchId=${foreignBranchId}`, ownerCookie)).statusCode).toBe(404);
  });
});
