import { randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import type { MessagingProvider } from '../src/messaging.js';
import type { StorageProvider } from '../src/storage.js';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must target a _test database');
const db = createDb(testUrl);
const config = { ...getConfig(), NODE_ENV: 'test' as const, devOtp: true, DEV_OTP_ENABLED: 'true' as const, LOG_LEVEL: 'silent' };
const slug = `operations-${randomUUID()}`;
const sent: string[] = [];
let failEvent: string | null = null;
const messaging: MessagingProvider = { async send({ idempotencyKey }) {
  if (failEvent && idempotencyKey.endsWith(failEvent)) { failEvent = null; throw new Error('Simulated provider failure'); }
  sent.push(idempotencyKey);
  return { providerMessageId: `test:${idempotencyKey}` };
} };
const files = new Map<string, Buffer>();
const storage: StorageProvider = {
  async put({ data }) { const key = `test/${randomUUID()}.png`; files.set(key, data); return key; },
  async get(key) { const file = files.get(key); if (!file) throw new Error('Missing test file'); return file; },
  async remove(key) { files.delete(key); },
};
let app: Awaited<ReturnType<typeof buildApp>>;
let organizationId: string;
let branchId: string;
let serviceId: string;
let ownerCookie: string;
let employeeCookie: string;
let otherEmployeeCookie: string;
let employeeId: string;

function request(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, cookie?: string) {
  return app.inject({ method, url, headers: { origin: config.APP_ORIGIN, 'content-type': 'application/json', 'x-organization-slug': slug, ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
}

function checkIn(registrationNumber: string) {
  return { idempotencyKey: randomUUID(), mobile: '9845612399', customerName: 'Test Driver', registrationNumber, make: 'Hyundai', model: 'Creta', vehicleType: 'SUV', serviceId, branchId, expectedAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(), notify: true };
}

beforeAll(async () => {
  const org = await db.organization.create({ data: { slug, name: 'Operations Test' } });
  organizationId = org.id;
  branchId = (await db.branch.create({ data: { organizationId, name: 'Main' } })).id;
  serviceId = (await db.service.create({ data: { organizationId, name: 'Premium Wash', category: 'Wash', basePricePaise: 59900, estimatedMinutes: 45 } })).id;
  await db.user.create({ data: { organizationId, branchId, role: 'OWNER', name: 'Owner', username: 'owner', passwordHash: await hash('test-password') } });
  employeeId = (await db.user.create({ data: { organizationId, branchId, role: 'EMPLOYEE', name: 'Ravi', employee: { create: { mobile: '+919876543210' } } } })).id;
  await db.user.create({ data: { organizationId, branchId, role: 'EMPLOYEE', name: 'Salim', employee: { create: { mobile: '+919876543211' } } } });
  app = await buildApp(config, db, undefined, messaging, storage);
  await app.ready();
  const owner = await request('POST', '/api/auth/owner/login', { login: 'owner', password: 'test-password' });
  ownerCookie = `${owner.cookies[0]!.name}=${owner.cookies[0]!.value}`;
  await request('POST', '/api/auth/employee/request-otp', { mobile: '9876543210' });
  const employee = await request('POST', '/api/auth/employee/verify-otp', { mobile: '9876543210', code: config.DEV_OTP_CODE });
  employeeCookie = `${employee.cookies[0]!.name}=${employee.cookies[0]!.value}`;
  await request('POST', '/api/auth/employee/request-otp', { mobile: '9876543211' });
  const otherEmployee = await request('POST', '/api/auth/employee/verify-otp', { mobile: '9876543211', code: config.DEV_OTP_CODE });
  otherEmployeeCookie = `${otherEmployee.cookies[0]!.name}=${otherEmployee.cookies[0]!.value}`;
});

afterAll(async () => { if (app) await app.close(); await db.$disconnect(); });

describe('vehicle operations', () => {
  it('runs owner check-in through handover with once-only events, payment and history', async () => {
    const input = checkIn('KL29AB1234');
    const created = await request('POST', '/api/jobs/check-in', input, ownerCookie);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(created.json().status).toBe('RECEIVED');
    expect(created.json().totalPaise).toBe(59900);
    expect((await request('POST', '/api/jobs/check-in', input, ownerCookie)).json().id).toBe(id);
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId: id, event: 'VEHICLE_RECEIVED', status: 'SENT' } })).toBe(1));
    expect((await request('POST', `/api/jobs/${id}/advance`, { to: 'READY' }, ownerCookie)).statusCode).toBe(409);
    expect((await request('POST', `/api/jobs/${id}/advance`, { to: 'WASHING' }, ownerCookie)).statusCode).toBe(200);
    expect((await request('POST', `/api/jobs/${id}/advance`, { to: 'WASHING' }, ownerCookie)).statusCode).toBe(200);
    expect((await request('POST', `/api/jobs/${id}/advance`, { to: 'READY' }, ownerCookie)).statusCode).toBe(200);
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId: id, status: 'SENT' } })).toBe(3));
    expect((await request('GET', '/api/jobs?view=active', undefined, ownerCookie)).json().some((job: { id: string }) => job.id === id)).toBe(true);
    const handed = await request('POST', `/api/jobs/${id}/handover`, { paymentAmountPaise: 39900, paymentMethod: 'UPI' }, ownerCookie);
    expect(handed.statusCode).toBe(200);
    expect(handed.json().status).toBe('HANDED_OVER');
    expect(handed.json().outstandingPaise).toBe(20000);
    expect(handed.json().invoice.payments).toHaveLength(1);
    expect((await request('POST', `/api/jobs/${id}/handover`, { paymentAmountPaise: 39900, paymentMethod: 'UPI' }, ownerCookie)).json().invoice.payments).toHaveLength(1);
    expect((await request('GET', '/api/jobs?view=active', undefined, ownerCookie)).json().some((job: { id: string }) => job.id === id)).toBe(false);
    expect((await request('GET', '/api/jobs?view=history&q=KL29AB1234', undefined, ownerCookie)).json().some((job: { id: string }) => job.id === id)).toBe(true);
    expect(await db.jobStageHistory.count({ where: { jobId: id } })).toBe(4);
    expect(await db.message.count({ where: { jobId: id } })).toBe(3);
    expect(sent.filter((key) => key.startsWith(`${id}:`))).toHaveLength(3);
    const paid = await request('POST', `/api/jobs/${id}/payments`, { idempotencyKey: randomUUID(), amountPaise: 20000, method: 'CASH' }, ownerCookie);
    expect(paid.json().paymentStatus).toBe('PAID');
    expect(paid.json().invoice.totalPaise).toBe(59900);
    expect(await db.auditLog.count({ where: { organizationId, entityType: 'Job', entityId: id } })).toBeGreaterThanOrEqual(4);
  });

  it('lets employee check in and progress but keeps business financial controls private', async () => {
    const created = await request('POST', '/api/jobs/check-in', checkIn('KL29AB1235'), employeeCookie);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(created.json().checkedInBy.name).toBe('Ravi');
    expect(created.json().assignments.map((assignment: { employee: { id: string } }) => assignment.employee.id)).toEqual([employeeId]);
    expect(await db.auditLog.count({ where: { organizationId, action: 'JOB_ASSIGNED', after: { path: ['jobId'], equals: id } } })).toBe(1);
    expect((await request('GET', '/api/operations/available-employees', undefined, employeeCookie)).statusCode).toBe(403);
    expect((await request('GET', '/api/jobs?view=active', undefined, otherEmployeeCookie)).json().some((job: { id: string }) => job.id === id)).toBe(true);
    expect((await request('GET', `/api/jobs/${id}`, undefined, otherEmployeeCookie)).statusCode).toBe(200);
    expect((await request('GET', '/api/jobs?view=active', undefined, employeeCookie)).json().find((job: { id: string }) => job.id === id).totalPaise).toBeUndefined();
    expect((await request('GET', '/api/board/metrics', undefined, employeeCookie)).json().collectedPaise).toBeUndefined();
    expect((await request('GET', '/api/operations/settings', undefined, employeeCookie)).statusCode).toBe(403);
    expect((await request('POST', `/api/jobs/${id}/payments`, { idempotencyKey: randomUUID(), amountPaise: 100, method: 'CASH' }, employeeCookie)).statusCode).toBe(403);
    expect((await request('POST', `/api/jobs/${id}/advance`, { to: 'WASHING' }, otherEmployeeCookie)).statusCode).toBe(200);
    expect((await request('POST', `/api/jobs/${id}/advance`, { to: 'READY' }, employeeCookie)).statusCode).toBe(200);
    expect((await request('POST', `/api/jobs/${id}/handover`, { paymentAmountPaise: 0 }, employeeCookie)).statusCode).toBe(200);
    expect((await request('GET', '/api/jobs?view=history&q=KL29AB1235', undefined, employeeCookie)).json()).toHaveLength(1);
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId: id, status: 'SENT' } })).toBe(3));
  });

  it('keeps assignment choices owner-only, including direct API requests', async () => {
    const forged = await request('POST', '/api/jobs/check-in', { ...checkIn('KL29AB1238'), employeeIds: [employeeId] }, otherEmployeeCookie);
    expect(forged.statusCode).toBe(403);
    expect(await db.job.count({ where: { organizationId, vehicle: { registrationNumber: 'KL29AB1238' } } })).toBe(0);
    const ownerCheckIn = await request('POST', '/api/jobs/check-in', { ...checkIn('KL29AB1239'), employeeIds: [employeeId] }, ownerCookie);
    expect(ownerCheckIn.statusCode).toBe(201);
    expect(ownerCheckIn.json().assignments.map((assignment: { employee: { id: string } }) => assignment.employee.id)).toEqual([employeeId]);
  });

  it('records a failed message and retries it without duplicating the event', async () => {
    const created = await request('POST', '/api/jobs/check-in', checkIn('KL29AB1236'), ownerCookie);
    const id = created.json().id;
    failEvent = ':VEHICLE_READY';
    await request('POST', `/api/jobs/${id}/advance`, { to: 'WASHING' }, ownerCookie);
    await request('POST', `/api/jobs/${id}/advance`, { to: 'READY' }, ownerCookie);
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId: id, event: 'VEHICLE_READY', status: 'FAILED' } })).toBe(1));
    const message = await db.message.findUniqueOrThrow({ where: { jobId_event: { jobId: id, event: 'VEHICLE_READY' } } });
    expect((await request('POST', `/api/jobs/${id}/messages/${message.id}/retry`, {}, employeeCookie)).statusCode).toBe(403);
    expect((await request('POST', `/api/jobs/${id}/messages/${message.id}/retry`, {}, ownerCookie)).statusCode).toBe(200);
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId: id, event: 'VEHICLE_READY', status: 'SENT' } })).toBe(1));
    expect(await db.message.count({ where: { jobId: id, event: 'VEHICLE_READY' } })).toBe(1);
  });

  it('finalizes one condition record and validates tenant-scoped photos', async () => {
    const job = await db.job.findFirstOrThrow({ where: { organizationId, vehicle: { registrationNumber: 'KL29AB1236' } } });
    const input = { damages: [{ location: 'FRONT', type: 'SCRATCH', description: 'Existing front bumper mark' }] };
    const inspection = await request('POST', `/api/jobs/${job.id}/inspection`, input, employeeCookie);
    expect(inspection.statusCode).toBe(201);
    expect(inspection.json().damages).toHaveLength(1);
    expect((await request('POST', `/api/jobs/${job.id}/inspection`, input, ownerCookie)).statusCode).toBe(409);
    const boundary = `test-${randomUUID()}`;
    const upload = (image: Buffer, mimeType: string, cookie: string) => app.inject({ method: 'POST', url: `/api/jobs/${job.id}/photos?kind=DAMAGE&damageItemId=${inspection.json().damages[0].id}`, headers: { origin: config.APP_ORIGIN, 'content-type': `multipart/form-data; boundary=${boundary}`, cookie }, payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="damage.png"\r\nContent-Type: ${mimeType}\r\n\r\n`), image, Buffer.from(`\r\n--${boundary}--\r\n`)]) });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aakAAAAASUVORK5CYII=', 'base64');
    expect((await upload(Buffer.from('not an image'), 'image/png', employeeCookie)).statusCode).toBe(415);
    const photo = await upload(png, 'image/png', employeeCookie);
    expect(photo.statusCode).toBe(201);
    expect((await request('GET', `/api/photos/${photo.json().id}`, undefined, ownerCookie)).statusCode).toBe(200);
    expect((await request('GET', `/api/photos/${photo.json().id}`, undefined, employeeCookie)).statusCode).toBe(200);
    expect((await request('GET', `/api/jobs/${job.id}`, undefined, ownerCookie)).json().photos).toHaveLength(1);
    expect(await db.auditLog.count({ where: { organizationId, action: 'PHOTO_UPLOADED', entityId: photo.json().id } })).toBe(1);
  });

  it('enforces Handover settings and emits the optional final message once', async () => {
    expect((await request('PATCH', '/api/operations/settings', { employeeHandover: false, allowOutstanding: false, sendHandoverMessage: true }, employeeCookie)).statusCode).toBe(403);
    expect((await request('PATCH', '/api/operations/settings', { employeeHandover: false, allowOutstanding: false, sendHandoverMessage: true }, ownerCookie)).statusCode).toBe(200);
    const created = await request('POST', '/api/jobs/check-in', checkIn('KL29AB1237'), ownerCookie);
    const id = created.json().id;
    await request('POST', `/api/jobs/${id}/advance`, { to: 'WASHING' }, ownerCookie);
    await request('POST', `/api/jobs/${id}/advance`, { to: 'READY' }, ownerCookie);
    expect((await request('POST', `/api/jobs/${id}/handover`, { paymentAmountPaise: 59900, paymentMethod: 'UPI' }, employeeCookie)).statusCode).toBe(403);
    expect((await request('POST', `/api/jobs/${id}/handover`, { paymentAmountPaise: 0 }, ownerCookie)).statusCode).toBe(400);
    expect((await request('POST', `/api/jobs/${id}/handover`, { paymentAmountPaise: 59900, paymentMethod: 'UPI' }, ownerCookie)).statusCode).toBe(200);
    expect((await request('POST', `/api/jobs/${id}/handover`, { paymentAmountPaise: 59900, paymentMethod: 'UPI' }, ownerCookie)).statusCode).toBe(200);
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId: id, event: 'VEHICLE_HANDED_OVER', status: 'SENT' } })).toBe(1));
    expect(await db.message.count({ where: { jobId: id, event: 'VEHICLE_HANDED_OVER' } })).toBe(1);
    expect(await db.auditLog.count({ where: { organizationId, action: 'OPERATIONS_SETTINGS_UPDATED', entityId: organizationId } })).toBeGreaterThan(0);
  });
});
