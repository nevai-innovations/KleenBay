import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { assertLocalTestDatabase } from '../src/database-target.js';
import { canCompleteExistingJob, deriveEntitlement, getOrganizationEntitlement, type EntitlementState } from '../src/entitlements.js';
import { createPaidTestOrganization } from './paid-fixture.js';
import { readTrackingToken } from '../src/tracking.js';

const db = createDb(assertLocalTestDatabase(process.env.TEST_DATABASE_URL));
const config = { ...getConfig(), NODE_ENV: 'test' as const, LOG_LEVEL: 'silent', SUBSCRIPTION_GRACE_DAYS: 7 };
let app: Awaited<ReturnType<typeof buildApp>>;
let orgId: string;
let branchId: string;
let serviceId: string;
let ownerCookie: string;
let employeeCookie: string;
let foreignCookie: string;
let foreignOrgId: string;
let email: string;
const password = randomBytes(24).toString('base64url');
const files = new Map<string, Buffer>();
const send = vi.fn(async () => ({ providerMessageId: randomUUID() }));
async function session(user: { id: string; organizationId: string }) {
  const token = randomBytes(32).toString('hex');
  await db.session.create({ data: { userId: user.id, organizationId: user.organizationId, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 3600000) } });
  return `kleenbay_session=${token}`;
}
const req = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object, cookie = ownerCookie) => app.inject({ method, url, headers: { origin: config.APP_ORIGIN, cookie }, ...(payload ? { payload } : {}) });
const input = () => ({ idempotencyKey: randomUUID(), branchId, mobile: '9876543290', customerName: 'Entitlement Driver', registrationNumber: `KA01AB${Math.floor(1000 + Math.random() * 8999)}`, make: 'Tata', model: 'Nexon', vehicleType: 'SUV', serviceId, expectedAt: new Date(Date.now() + 3600000).toISOString(), notify: true });
async function checkIn() { const response = await req('POST', '/api/jobs/check-in', input()); expect(response.statusCode, response.body).toBe(201); return response.json(); }
async function setState(state: EntitlementState) {
  if (state === 'NOT_SUBSCRIBED') { await db.subscription.delete({ where: { organizationId: orgId } }); return null; }
  const end = new Date(Date.now() + (state === 'ACTIVE' ? 86400000 : state === 'GRACE_PERIOD' ? -86400000 : -8 * 86400000));
  await db.subscription.update({ where: { organizationId: orgId }, data: { currentPeriodStart: new Date(end.getTime() - 365 * 86400000), currentPeriodEnd: end } });
  return end;
}

beforeEach(async () => {
  send.mockClear();
  const org = await createPaidTestOrganization(db, { data: { slug: `entitlement-${randomUUID()}`, name: 'Entitlement Synthetic', allowOutstanding: true, employeeHandover: true, sendHandoverMessage: true } });
  orgId = org.id;
  branchId = (await db.branch.create({ data: { organizationId: orgId, name: 'Main' } })).id;
  serviceId = (await db.service.create({ data: { organizationId: orgId, name: 'Wash', category: 'Wash', basePricePaise: 120000, estimatedMinutes: 45 } })).id;
  email = `entitlement-${randomUUID()}@example.test`;
  ownerCookie = await session(await db.user.create({ data: { organizationId: orgId, role: 'OWNER', name: 'Owner', email, passwordHash: await hash(password) } }));
  employeeCookie = await session(await db.user.create({ data: { organizationId: orgId, branchId, role: 'EMPLOYEE', name: 'Employee' } }));
  const other = await createPaidTestOrganization(db, { data: { slug: `entitlement-other-${randomUUID()}`, name: 'Other Synthetic' } });
  foreignOrgId = other.id;
  foreignCookie = await session(await db.user.create({ data: { organizationId: other.id, role: 'OWNER', name: 'Other' } }));
  app = await buildApp(config, db, undefined, { name: 'MOCK', send }, { async put({ data, organizationId, jobId }) { const key = `${organizationId}/${jobId}/${randomUUID()}.png`; files.set(key, data); return key; }, async get(key) { return files.get(key)!; }, async remove(key) { files.delete(key); } });
  await app.ready();
});
afterEach(async () => { await app.close(); });
afterAll(async () => { await db.$disconnect(); });

describe('subscription date boundaries', () => {
  const end = new Date('2028-02-28T23:59:59.999Z');
  const subscription = { activatedAt: new Date('2027-01-01'), currentPeriodStart: new Date('2027-01-01'), currentPeriodEnd: end };
  it('derives never-paid state even when a pending record has dates', () => { expect(deriveEntitlement({ ...subscription, activatedAt: null }, 7).state).toBe('NOT_SUBSCRIBED'); expect(deriveEntitlement(null, 7).state).toBe('NOT_SUBSCRIBED'); });
  it.each([
    ['2028-02-28T23:59:59.998Z', 'ACTIVE'],
    ['2028-02-28T23:59:59.999Z', 'GRACE_PERIOD'],
    ['2028-03-06T23:59:59.998Z', 'GRACE_PERIOD'],
    ['2028-03-06T23:59:59.999Z', 'EXPIRED'],
  ])('at %s resolves to %s across leap day', (at, state) => { expect(deriveEntitlement(subscription, 7, new Date(at)).state).toBe(state); });
  it('uses configured grace and strictly pre-expiry jobs, never delivered jobs', () => {
    const access = deriveEntitlement(subscription, 3, end);
    expect(access.graceEndsAt?.toISOString()).toBe('2028-03-02T23:59:59.999Z');
    expect(canCompleteExistingJob(access, { checkedInAt: new Date(end.getTime() - 1), status: 'RECEIVED' })).toBe(true);
    expect(canCompleteExistingJob(access, { checkedInAt: end, status: 'RECEIVED' })).toBe(false);
    expect(canCompleteExistingJob(access, { checkedInAt: new Date(end.getTime() - 1), status: 'HANDED_OVER' })).toBe(false);
    expect(deriveEntitlement(subscription, 0, end).state).toBe('EXPIRED');
  });
});

describe('authoritative organization enforcement', () => {
  it.each(['NOT_SUBSCRIBED', 'ACTIVE', 'GRACE_PERIOD', 'EXPIRED'] as const)('%s preserves owner authentication, billing and owner-only authorization', async (state) => {
    await setState(state);
    expect((await req('POST', '/api/auth/owner/login', { login: email, password })).statusCode).toBe(200);
    expect((await req('GET', '/api/billing')).statusCode).toBe(200);
    expect((await req('GET', '/api/billing')).json().subscription.state).toBe(state);
    expect((await req('POST', '/api/billing/checkout', { idempotencyKey: randomUUID() })).statusCode).toBe(503);
    expect((await req('GET', '/api/billing', undefined, employeeCookie)).statusCode).toBe(403);
    expect((await req('GET', '/api/customers')).statusCode).toBe(200);
    const employeeAccess = (await req('GET', '/api/entitlement', undefined, employeeCookie)).json();
    expect(Object.keys(employeeAccess).sort()).toEqual(['canCreateWork', 'canOperate']);
    const board = await req('GET', '/api/jobs', undefined, employeeCookie);
    expect(board.statusCode).toBe(state === 'ACTIVE' || state === 'GRACE_PERIOD' ? 200 : 402);
    const created = await req('POST', '/api/jobs/check-in', input());
    expect(created.statusCode).toBe(state === 'ACTIVE' ? 201 : 402);
    if (state !== 'ACTIVE') expect(created.json().error.code).toBe(state === 'GRACE_PERIOD' ? 'GRACE_NEW_WORK_BLOCKED' : state === 'EXPIRED' ? 'SUBSCRIPTION_EXPIRED' : 'SUBSCRIPTION_REQUIRED');
    expect((await req('POST', '/api/auth/logout', {})).statusCode).toBe(200);
  });
  it.each(['NOT_SUBSCRIBED', 'GRACE_PERIOD', 'EXPIRED'] as const)('%s blocks every setup expansion/configuration mutation before payload processing', async (state) => {
    await setState(state);
    for (const [method, path] of [
      ['POST', '/api/employees'], ['PATCH', '/api/employees/unknown'], ['POST', '/api/branches'], ['PATCH', `/api/branches/${branchId}`],
      ['POST', '/api/services'], ['PUT', `/api/services/${serviceId}/prices`], ['POST', '/api/sale-items'], ['PATCH', '/api/invoice-settings'],
      ['POST', '/api/customers'], ['POST', '/api/vehicles'], ['PATCH', '/api/operations/settings'], ['PATCH', '/api/whatsapp/settings'],
    ] as const) expect((await req(method, path, {})).statusCode, path).toBe(402);
    expect(await db.auditLog.count({ where: { organizationId: orgId, action: 'SUBSCRIPTION_MUTATION_BLOCKED' } })).toBe(12);
  });
  it('completes pre-expiry jobs through inspection, photos, invoice, partial/full payment, messages and handover during grace', async () => {
    const job = await checkIn();
    const end = (await setState('GRACE_PERIOD'))!;
    await db.job.update({ where: { id: job.id }, data: { checkedInAt: new Date(end.getTime() - 1000) } });
    const stored = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    const token = readTrackingToken(config.trackingSecret, stored.trackingTokenCiphertext!);
    expect((await req('POST', `/api/jobs/${job.id}/inspection`, { damages: [] }, employeeCookie)).statusCode).toBe(201);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZl8AAAAASUVORK5CYII=', 'base64');
    const body = Buffer.concat([Buffer.from('--photo\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n'), png, Buffer.from('\r\n--photo--\r\n')]);
    const photo = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/photos?kind=AFTER`, headers: { origin: config.APP_ORIGIN, cookie: employeeCookie, 'content-type': 'multipart/form-data; boundary=photo' }, payload: body });
    expect(photo.statusCode, photo.body).toBe(201);
    expect((await req('GET', `/api/photos/${photo.json().id}`, undefined, employeeCookie)).statusCode).toBe(200);
    expect((await req('POST', `/api/jobs/${job.id}/advance`, { to: 'WASHING' }, employeeCookie)).statusCode).toBe(200);
    expect((await req('GET', `/api/public/tracking/${token}`)).json().status).toBe('WASHING');
    expect((await req('POST', `/api/jobs/${job.id}/advance`, { to: 'READY' }, employeeCookie)).statusCode).toBe(200);
    const draft = await req('POST', `/api/jobs/${job.id}/invoice`, { items: [], discountKind: 'NONE', discountValue: 0 });
    expect(draft.statusCode, draft.body).toBe(201);
    expect((await req('POST', `/api/invoices/${draft.json().id}/issue`, {})).statusCode).toBe(200);
    expect((await req('POST', `/api/jobs/${job.id}/payments`, { idempotencyKey: randomUUID(), amountPaise: 70000, method: 'UPI' })).json().outstandingPaise).toBe(50000);
    expect((await req('POST', `/api/jobs/${job.id}/payments`, { idempotencyKey: randomUUID(), amountPaise: 50000, method: 'CASH' })).json().paymentStatus).toBe('PAID');
    const employeeJob = (await req('GET', `/api/jobs/${job.id}`, undefined, employeeCookie)).json();
    expect(employeeJob).not.toHaveProperty('invoice'); expect(employeeJob).not.toHaveProperty('outstandingPaise');
    expect((await req('POST', `/api/jobs/${job.id}/handover`, { paymentAmountPaise: 0 }, employeeCookie)).statusCode).toBe(200);
    expect((await req('GET', `/api/public/tracking/${token}`)).json().status).toBe('HANDED_OVER');
    await vi.waitFor(async () => { expect(await db.message.count({ where: { jobId: job.id, status: 'SENT' } })).toBe(4); });
    expect((await req('POST', `/api/jobs/${job.id}/advance`, { to: 'RECEIVED' })).statusCode).toBe(402);
  });
  it('excludes boundary/new/delivered jobs from employee grace access, including direct detail and photo retrieval', async () => {
    const old = await checkIn(); const boundary = await checkIn(); const newer = await checkIn();
    const end = (await setState('GRACE_PERIOD'))!;
    await db.job.update({ where: { id: old.id }, data: { checkedInAt: new Date(end.getTime() - 1) } });
    await db.job.update({ where: { id: boundary.id }, data: { checkedInAt: end } });
    const uploader = await db.user.findFirstOrThrow({ where: { organizationId: orgId, role: 'OWNER' } });
    const hiddenPhoto = await db.photo.create({ data: { organizationId: orgId, jobId: boundary.id, kind: 'BEFORE', storageKey: `synthetic/${boundary.id}/ineligible.png`, mimeType: 'image/png', byteSize: 1, uploadedById: uploader.id } });
    expect((await req('GET', `/api/photos/${hiddenPhoto.id}`, undefined, employeeCookie)).statusCode).toBe(402);
    const list = (await req('GET', '/api/jobs', undefined, employeeCookie)).json();
    expect(list.map((job: { id: string }) => job.id)).toEqual([old.id]);
    for (const id of [boundary.id, newer.id]) {
      expect((await req('GET', `/api/jobs/${id}`, undefined, employeeCookie)).statusCode).toBe(402);
      expect((await req('POST', `/api/jobs/${id}/advance`, { to: 'WASHING' })).statusCode).toBe(402);
    }
    expect((await req('GET', '/api/board/metrics', undefined, employeeCookie)).json().inBay).toBe(1);
    expect((await req('GET', '/api/jobs?view=history', undefined, employeeCookie)).json()).toEqual([]);
  });
  it('expired keeps owner historical reads and public tracking but blocks invoice/job/payment mutations', async () => {
    const job = await checkIn();
    const draft = await req('POST', `/api/jobs/${job.id}/invoice`, { items: [], discountKind: 'NONE', discountValue: 0 });
    const stored = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    const token = readTrackingToken(config.trackingSecret, stored.trackingTokenCiphertext!);
    await setState('EXPIRED');
    for (const path of ['/api/jobs?view=history', `/api/jobs/${job.id}`, '/api/invoices', `/api/invoices/${draft.json().id}`, '/api/payments', '/api/summary/daily']) expect((await req('GET', path)).statusCode, path).toBe(200);
    for (const path of [`/api/jobs/${job.id}/advance`, `/api/jobs/${job.id}/invoice`, `/api/jobs/${job.id}/payments`, `/api/jobs/${job.id}/handover`, `/api/invoices/${draft.json().id}/issue`]) expect((await req('POST', path, {})).statusCode, path).toBe(402);
    expect((await req('GET', `/api/public/tracking/${token}`)).statusCode).toBe(200);
    expect((await req('GET', '/api/operations/capabilities', undefined, employeeCookie)).json()).toEqual({ canHandover: false, canAddOns: false });
  });
  it('isolates entitlement by authenticated tenant and deduplicates observed-state audit events', async () => {
    const job = await checkIn(); await setState('GRACE_PERIOD');
    expect((await req('POST', `/api/jobs/${job.id}/advance`, { to: 'WASHING' }, foreignCookie)).statusCode).toBe(404);
    expect((await req('GET', '/api/entitlement?organizationId=' + foreignOrgId)).json().state).toBe('GRACE_PERIOD');
    expect((await req('GET', '/api/entitlement', undefined, foreignCookie)).json().state).toBe('ACTIVE');
    await Promise.all(Array.from({ length: 6 }, () => getOrganizationEntitlement(db, orgId, 7)));
    expect(await db.auditLog.count({ where: { organizationId: orgId, action: 'SUBSCRIPTION_ENTERED_GRACE_PERIOD' } })).toBe(1);
  });
});
