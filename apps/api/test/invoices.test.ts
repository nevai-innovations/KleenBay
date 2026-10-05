import { randomInt, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { assertLocalTestDatabase } from '../src/database-target.js';
import { calculateInvoice } from '../src/invoice-calculation.js';

const db = createDb(assertLocalTestDatabase(process.env.TEST_DATABASE_URL));
const config = { ...getConfig(), NODE_ENV: 'test' as const, devOtp: true, DEV_OTP_ENABLED: 'true' as const, DEV_OTP_FIXED_CODE: '123456', LOG_LEVEL: 'silent' };
const slug = `invoice-${randomUUID()}`;
const employeeMobile = String(9000000000 + randomInt(900000000));
let app: Awaited<ReturnType<typeof buildApp>>;
let orgId: string;
let branchId: string;
let serviceId: string;
let ownerCookie: string;
let employeeCookie: string;
let otherCookie: string;
function req(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, cookie = ownerCookie) {
  return app.inject({ method, url, headers: { origin: config.APP_ORIGIN, 'content-type': 'application/json', 'x-organization-slug': slug, ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
}
async function createJob(plate: string) {
  const result = await req('POST', '/api/jobs/check-in', { idempotencyKey: randomUUID(), mobile: '9876543210', customerName: 'Invoice Customer', registrationNumber: plate, make: 'Tata', model: 'Nexon', vehicleType: 'SUV', serviceId, branchId, expectedAt: new Date(Date.now() + 3_600_000).toISOString(), notify: false });
  expect(result.statusCode).toBe(201);
  return result.json().id as string;
}
beforeAll(async () => {
  const org = await db.organization.create({ data: { slug, name: 'Invoice Test Wash' } });
  orgId = org.id;
  branchId = (await db.branch.create({ data: { organizationId: orgId, name: 'Main', address: 'Test Road', phone: '9000000000' } })).id;
  serviceId = (await db.service.create({ data: { organizationId: orgId, name: 'Premium Wash', category: 'Wash', basePricePaise: 50000, estimatedMinutes: 40 } })).id;
  await db.user.create({ data: { organizationId: orgId, role: 'OWNER', name: 'Owner', username: `invoice-${randomUUID()}`, email: `invoice-${randomUUID()}@example.test`, passwordHash: await hash('test-password') } });
  await db.user.create({ data: { organizationId: orgId, branchId, role: 'EMPLOYEE', name: 'Worker', employee: { create: { mobile: `+91${employeeMobile}` } } } });
  const other = await db.organization.create({ data: { slug: `invoice-other-${randomUUID()}`, name: 'Other Wash' } });
  await db.user.create({ data: { organizationId: other.id, role: 'OWNER', name: 'Other', email: `other-${randomUUID()}@example.test`, passwordHash: await hash('test-password') } });
  app = await buildApp(config, db);
  await app.ready();
  const owner = await db.user.findFirstOrThrow({ where: { organizationId: orgId, role: 'OWNER' } });
  const login = await req('POST', '/api/auth/owner/login', { login: owner.email, password: 'test-password' }, '');
  ownerCookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`;
  await req('POST', '/api/auth/employee/request-otp', { mobile: employeeMobile });
  const employee = await req('POST', '/api/auth/employee/verify-otp', { mobile: employeeMobile, code: '123456' });
  employeeCookie = `${employee.cookies[0]!.name}=${employee.cookies[0]!.value}`;
  const foreign = await db.user.findFirstOrThrow({ where: { organizationId: other.id } });
  const otherLogin = await req('POST', '/api/auth/owner/login', { login: foreign.email, password: 'test-password' }, '');
  otherCookie = `${otherLogin.cookies[0]!.name}=${otherLogin.cookies[0]!.value}`;
});
afterAll(async () => { if (app) await app.close(); await db.$disconnect(); });

describe('customer invoices', () => {
  it('calculates line totals, flat/percent discounts and tax without negative totals', () => {
    const lines = [{ kind: 'SERVICE' as const, description: 'Wash', quantity: 1, unitPricePaise: 50000, taxRateBps: 1800 }, { kind: 'ADD_ON' as const, description: 'Tyre polish', quantity: 2, unitPricePaise: 10000, taxRateBps: 1800 }];
    expect(calculateInvoice(lines, 'NONE', 0)).toMatchObject({ subtotalPaise: 70000, discountPaise: 0, taxPaise: 12600, totalPaise: 82600 });
    expect(calculateInvoice(lines, 'FLAT', 10000)).toMatchObject({ discountPaise: 10000, taxablePaise: 60000, taxPaise: 10800, totalPaise: 70800 });
    expect(calculateInvoice(lines, 'PERCENT', 1000)).toMatchObject({ discountPaise: 7000, taxablePaise: 63000, taxPaise: 11340, totalPaise: 74340 });
    expect(() => calculateInvoice(lines, 'FLAT', 70001)).toThrow();
    expect(() => calculateInvoice(lines, 'PERCENT', 10001)).toThrow();
    const tinyLines = Array.from({ length: 5 }, (_, index) => ({ kind: 'ADD_ON' as const, description: `Line ${index}`, quantity: 1, unitPricePaise: 1, taxRateBps: 1800 }));
    const tinyInvoice = calculateInvoice(tinyLines, 'FLAT', 3);
    expect(tinyInvoice.items.every((item) => item.totalPaise >= 0 && item.taxPaise >= 0)).toBe(true);
    expect(tinyInvoice.items.reduce((sum, item) => sum + item.totalPaise, 0)).toBe(tinyInvoice.totalPaise);
  });

  it('snapshots service, add-on, product, custom, discount and configured GST; then locks issued amounts', async () => {
    const settings = await req('PATCH', '/api/invoice-settings', { gstRateBps: 1800, gstin: 'TESTGSTIN', invoiceAddress: 'Test Road', allowCustomInvoiceItems: true });
    expect(settings.statusCode).toBe(200);
    const addOn = await req('POST', '/api/sale-items', { kind: 'ADD_ON', name: 'Tyre polish', pricePaise: 10000 });
    const product = await req('POST', '/api/sale-items', { kind: 'PRODUCT', name: 'Air freshener', pricePaise: 5000 });
    expect(addOn.statusCode).toBe(201);
    expect(product.statusCode).toBe(201);
    const jobId = await createJob('KL01AA1001');
    const draft = await req('POST', `/api/jobs/${jobId}/invoice`, { items: [{ kind: 'ADD_ON', saleItemId: addOn.json().id, quantity: 2 }, { kind: 'PRODUCT', saleItemId: product.json().id, quantity: 1 }, { kind: 'CUSTOM', description: 'Special treatment', quantity: 1, unitPricePaise: 2000 }], discountKind: 'FLAT', discountValue: 7000 });
    expect(draft.statusCode).toBe(201);
    const invoice = draft.json();
    expect(invoice.status).toBe('DRAFT');
    expect(invoice.items.map((item: { kind: string }) => item.kind)).toEqual(['SERVICE', 'ADD_ON', 'PRODUCT', 'CUSTOM']);
    expect(invoice).toMatchObject({ subtotalPaise: 77000, discountPaise: 7000, taxablePaise: 70000, taxPaise: 12600, totalPaise: 82600 });
    expect(invoice.invoiceNumber).toMatch(/^KB-\d{4}-\d{6}$/);
    const id = invoice.id as string;
    expect((await req('POST', `/api/invoices/${id}/issue`, {})).statusCode).toBe(200);
    await req('PATCH', `/api/sale-items/${addOn.json().id}`, { pricePaise: 20000 });
    await req('PATCH', `/api/services/${serviceId}`, { basePricePaise: 90000 });
    const persisted = (await req('GET', `/api/invoices/${id}`)).json();
    expect(persisted.totalPaise).toBe(82600);
    expect(persisted.items[1].unitPricePaise).toBe(10000);
    expect(persisted.items[0].unitPricePaise).toBe(50000);
    expect((await req('POST', `/api/jobs/${jobId}/invoice`, { items: [], discountKind: 'NONE', discountValue: 0 })).statusCode).toBe(409);
    await expect(db.invoice.update({ where: { id }, data: { totalPaise: 1 } })).rejects.toThrow();
    await expect(db.invoiceItem.update({ where: { id: persisted.items[0].id }, data: { unitPricePaise: 1 } })).rejects.toThrow();
    const p1 = await req('POST', `/api/jobs/${jobId}/payments`, { idempotencyKey: randomUUID(), amountPaise: 70000, method: 'UPI' });
    expect(p1.json().outstandingPaise).toBe(12600);
    expect(p1.json().invoice.status).toBe('PARTIALLY_PAID');
    expect((await req('POST', `/api/jobs/${jobId}/payments`, { idempotencyKey: randomUUID(), amountPaise: 12601, method: 'CASH' })).statusCode).toBe(400);
    const p2 = await req('POST', `/api/jobs/${jobId}/payments`, { idempotencyKey: randomUUID(), amountPaise: 12600, method: 'CASH' });
    expect(p2.json().invoice.status).toBe('PAID');
    expect(p2.json().outstandingPaise).toBe(0);
    await expect(db.invoice.update({ where: { id }, data: { status: 'DRAFT' } })).rejects.toThrow();
    const firstPayment = await db.payment.findFirstOrThrow({ where: { invoiceId: id } });
    await expect(db.payment.update({ where: { id: firstPayment.id }, data: { amountPaise: 1 } })).rejects.toThrow();
    expect((await req('POST', `/api/invoices/${id}/cancel`, { reason: 'Wrong vehicle' })).statusCode).toBe(409);
    expect(await db.auditLog.count({ where: { organizationId: orgId, entityType: 'Invoice', entityId: id } })).toBeGreaterThanOrEqual(3);
  });

  it('allows audited cancellation and replacement while keeping old invoice and number', async () => {
    const jobId = await createJob('KL01AA1002');
    const first = await req('POST', `/api/jobs/${jobId}/invoice`, { items: [] });
    const id = first.json().id as string;
    expect((await req('POST', `/api/invoices/${id}/issue`, {})).statusCode).toBe(200);
    expect((await req('POST', `/api/invoices/${id}/cancel`, { reason: 'Incorrect line item' })).statusCode).toBe(200);
    const replacement = await req('POST', `/api/jobs/${jobId}/invoice`, { items: [] });
    expect(replacement.statusCode).toBe(201);
    expect(replacement.json().invoiceNumber).not.toBe(first.json().invoiceNumber);
    expect(replacement.json().replacesInvoiceId).toBe(id);
    expect((await req('GET', `/api/invoices/${id}`)).json().status).toBe('CANCELLED');
    expect((await req('POST', `/api/invoices/${replacement.json().id}/issue`, {})).statusCode).toBe(200);
    const numbers = (await db.invoice.findMany({ where: { organizationId: orgId }, select: { invoiceNumber: true } })).map((item) => item.invoiceNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('denies employee financial endpoints and isolates every invoice by tenant', async () => {
    const invoice = await db.invoice.findFirstOrThrow({ where: { organizationId: orgId } });
    const job = await db.job.findUniqueOrThrow({ where: { id: invoice.jobId } });
    for (const url of ['/api/invoices', `/api/invoices/${invoice.id}`, '/api/invoice-settings']) expect((await req('GET', url, undefined, employeeCookie)).statusCode).toBe(403);
    for (const url of [`/api/jobs/${job.id}/invoice`, `/api/invoices/${invoice.id}/issue`, `/api/invoices/${invoice.id}/cancel`, '/api/sale-items']) expect((await req('POST', url, {}, employeeCookie)).statusCode).toBe(403);
    expect((await req('GET', '/api/sale-items', undefined, employeeCookie)).body).not.toContain('pricePaise');
    expect((await req('GET', `/api/invoices/${invoice.id}`, undefined, otherCookie)).statusCode).toBe(404);
    expect((await req('POST', `/api/invoices/${invoice.id}/cancel`, { reason: 'Other tenant request' }, otherCookie)).statusCode).toBe(404);
    expect((await req('POST', `/api/jobs/${job.id}/invoice`, { items: [] }, otherCookie)).statusCode).toBe(404);
    expect((await req('GET', '/api/invoices', undefined, otherCookie)).json()).toEqual([]);
    expect((await req('GET', `/api/jobs/${job.id}`, undefined, employeeCookie)).body).not.toMatch(/invoiceNumber|discountPaise|taxPaise|totalPaise|payments|outstandingPaise/);
  });

  it('issues a prepared invoice at handover and accounts for earlier partial payments', async () => {
    await req('PATCH', `/api/services/${serviceId}`, { basePricePaise: 50000 });
    const jobId = await createJob('KL01AA1003');
    const draft = await req('POST', `/api/jobs/${jobId}/invoice`, { items: [], discountKind: 'PERCENT', discountValue: 1000 });
    expect(draft.json().totalPaise).toBe(53100);
    expect((await req('POST', `/api/invoices/${draft.json().id}/issue`, {})).statusCode).toBe(200);
    const paid = await req('POST', `/api/jobs/${jobId}/payments`, { idempotencyKey: randomUUID(), amountPaise: 30000, method: 'UPI' });
    expect(paid.json().outstandingPaise).toBe(23100);
    await req('POST', `/api/jobs/${jobId}/advance`, { to: 'WASHING' });
    await req('POST', `/api/jobs/${jobId}/advance`, { to: 'READY' });
    const handover = await req('POST', `/api/jobs/${jobId}/handover`, { paymentAmountPaise: 10000, paymentMethod: 'CASH' });
    expect(handover.statusCode).toBe(200);
    expect(handover.json().invoice.invoiceNumber).toBe(draft.json().invoiceNumber);
    expect(handover.json().outstandingPaise).toBe(13100);
    expect(handover.json().invoice.payments).toHaveLength(2);
  });

  it('permits employee add-on selection only when explicitly enabled and never returns prices', async () => {
    const item = await db.saleItem.findFirstOrThrow({ where: { organizationId: orgId, kind: 'ADD_ON' } });
    const jobId = await createJob('KL01AA1004');
    expect((await req('POST', `/api/jobs/${jobId}/add-ons`, { saleItemId: item.id, quantity: 1 }, employeeCookie)).statusCode).toBe(403);
    expect((await req('PATCH', '/api/invoice-settings', { employeeAddons: true }, employeeCookie)).statusCode).toBe(403);
    await req('PATCH', '/api/invoice-settings', { employeeAddons: true });
    const added = await req('POST', `/api/jobs/${jobId}/add-ons`, { saleItemId: item.id, quantity: 2 }, employeeCookie);
    expect(added.statusCode).toBe(200);
    const detail = await req('GET', `/api/jobs/${jobId}`, undefined, employeeCookie);
    expect(detail.json().selectedAddOns).toEqual([{ description: item.name, quantity: 2 }]);
    expect(detail.body).not.toMatch(/pricePaise|totalPaise|invoiceNumber|discountPaise|taxPaise/);
    expect((await req('GET', `/api/jobs/${jobId}`, undefined, ownerCookie)).json().invoice.items).toHaveLength(2);
    await req('PATCH', '/api/invoice-settings', { employeeAddons: false });
    expect((await req('POST', `/api/jobs/${jobId}/add-ons`, { saleItemId: item.id, quantity: 1 }, employeeCookie)).statusCode).toBe(403);
  });
});
