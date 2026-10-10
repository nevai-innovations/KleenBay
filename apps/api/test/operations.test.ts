import { randomInt, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { assertLocalTestDatabase } from '../src/database-target.js';
import { createPaidTestOrganization } from './paid-fixture.js';
import { dispatchMessage, Msg91WhatsAppProvider, type MessagingProvider } from '../src/messaging.js';
import type { StorageProvider } from '../src/storage.js';
import { createTrackingToken, readTrackingToken } from '../src/tracking.js';

const testUrl = assertLocalTestDatabase(process.env.TEST_DATABASE_URL);
const db = createDb(testUrl);
const config = { ...getConfig(), NODE_ENV: 'test' as const, devOtp: true, DEV_OTP_ENABLED: 'true' as const, DEV_OTP_FIXED_CODE: '123456', LOG_LEVEL: 'silent' };
const slug = `operations-${randomUUID()}`;
const employeeMobile = String(9000000000 + randomInt(900000000));
const employeeMobile2 = String(Number(employeeMobile) + 1);
const employeeE164 = `+91${employeeMobile}`;
const employeeE1642 = `+91${employeeMobile2}`;
const sent: string[] = [];
let failEvent: string | null = null;
const messaging: MessagingProvider = { name: 'MOCK', async send({ idempotencyKey }) {
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

const privateFields = new Set([
  'subtotalPaise', 'taxPaise', 'totalPaise', 'paidPaise', 'outstandingPaise', 'paymentStatus',
  'invoice', 'payments', 'amountPaise', 'paymentMethod', 'paymentReference', 'collectionByMethod',
  'basePricePaise', 'pricePaise', 'taxRateBps', 'discountPaise', 'allowOutstanding',
  'recipient', 'renderedText', 'provider', 'templateKey', 'providerMessageId', 'failureReason', 'nextRetryAt', 'deliveryAttempts',
  'trackingTokenHash', 'trackingTokenCiphertext', 'senderNumber', 'senderDisplayName',
]);

function expectOperationalOnly(value: unknown) {
  const found: string[] = [];
  function inspect(item: unknown) {
    if (Array.isArray(item)) { item.forEach(inspect); return; }
    if (item && typeof item === 'object') {
      for (const [key, nested] of Object.entries(item)) {
        if (privateFields.has(key)) found.push(key);
        inspect(nested);
      }
    }
  }
  inspect(value);
  expect(found).toEqual([]);
}

beforeAll(async () => {
  const org = await createPaidTestOrganization(db, { data: { slug, name: 'Operations Test' } });
  organizationId = org.id;
  branchId = (await db.branch.create({ data: { organizationId, name: 'Main' } })).id;
  serviceId = (await db.service.create({ data: { organizationId, name: 'Premium Wash', category: 'Wash', basePricePaise: 59900, estimatedMinutes: 45 } })).id;
  await db.user.create({ data: { organizationId, branchId, role: 'OWNER', name: 'Owner', username: 'owner', passwordHash: await hash('test-password') } });
  employeeId = (await db.user.create({ data: { organizationId, branchId, role: 'EMPLOYEE', name: 'Ravi', employee: { create: { mobile: employeeE164 } } } })).id;
  await db.user.create({ data: { organizationId, branchId, role: 'EMPLOYEE', name: 'Salim', employee: { create: { mobile: employeeE1642 } } } });
  app = await buildApp(config, db, undefined, messaging, storage);
  await app.ready();
  const owner = await request('POST', '/api/auth/owner/login', { login: 'owner', password: 'test-password' });
  ownerCookie = `${owner.cookies[0]!.name}=${owner.cookies[0]!.value}`;
  await request('POST', '/api/auth/employee/request-otp', { mobile: employeeMobile });
  const employee = await request('POST', '/api/auth/employee/verify-otp', { mobile: employeeMobile, code: config.DEV_OTP_FIXED_CODE });
  employeeCookie = `${employee.cookies[0]!.name}=${employee.cookies[0]!.value}`;
  await request('POST', '/api/auth/employee/request-otp', { mobile: employeeMobile2 });
  const otherEmployee = await request('POST', '/api/auth/employee/verify-otp', { mobile: employeeMobile2, code: config.DEV_OTP_FIXED_CODE });
  otherEmployeeCookie = `${otherEmployee.cookies[0]!.name}=${otherEmployee.cookies[0]!.value}`;
});

afterAll(async () => { if (app) await app.close(); await db.$disconnect(); });

describe('vehicle operations', () => {
  it('rejects an invalid registration at check-in without creating a job', async () => {
    const before = await db.job.count({ where: { organizationId } });
    const response = await request('POST', '/api/jobs/check-in', checkIn('invalid plate'), ownerCookie);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ path: 'registrationNumber', message: 'Enter a valid Indian registration number' }] });
    expect(await db.job.count({ where: { organizationId } })).toBe(before);
  });

  it('runs owner check-in through handover with once-only events, payment and history', async () => {
    const input = checkIn('KL29AB1234');
    const created = await request('POST', '/api/jobs/check-in', input, ownerCookie);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(created.json().status).toBe('RECEIVED');
    expect(created.json().totalPaise).toBe(59900);
    expect((await request('POST', '/api/jobs/check-in', input, ownerCookie)).json().id).toBe(id);
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId: id, event: 'VEHICLE_RECEIVED', status: 'SENT' } })).toBe(1));
    const received = await db.message.findUniqueOrThrow({ where: { jobId_event: { jobId: id, event: 'VEHICLE_RECEIVED' } } });
    expect(received).toMatchObject({ organizationId, branchId, recipient: '+919845612399', templateKey: 'VEHICLE_RECEIVED', provider: 'MOCK', attempts: 1 });
    expect(received.renderedText).toContain('Test Driver');
    const token = /\/track\/([A-Za-z0-9_-]{43})/.exec(received.renderedText)?.[1];
    expect(token).toBeTruthy();
    expect(received.renderedText).toContain(config.APP_ORIGIN);
    expect(token).not.toBe(id);
    expect((await db.job.findUniqueOrThrow({ where: { id } })).trackingTokenCiphertext).not.toContain(token);
    expect((await request('GET', `/api/public/track/${token}`)).json()).toMatchObject({ businessName: 'Operations Test', vehicleNumber: 'KL29AB1234', status: 'RECEIVED' });
    expect((await request('GET', '/api/public/track/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).statusCode).toBe(404);
    expect((await request('POST', `/api/jobs/${id}/advance`, { to: 'READY' }, ownerCookie)).statusCode).toBe(409);
    expect(await db.message.count({ where: { jobId: id } })).toBe(1);
    expect((await request('POST', `/api/jobs/${id}/advance`, { to: 'WASHING' }, ownerCookie)).statusCode).toBe(200);
    expect((await request('POST', `/api/jobs/${id}/advance`, { to: 'WASHING' }, ownerCookie)).statusCode).toBe(200);
    expect((await request('POST', `/api/jobs/${id}/advance`, { to: 'READY' }, ownerCookie)).statusCode).toBe(200);
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId: id, status: 'SENT' } })).toBe(3));
    expect((await db.message.findMany({ where: { jobId: id }, orderBy: { createdAt: 'asc' } })).map((message) => message.event)).toEqual(['VEHICLE_RECEIVED', 'WASH_STARTED', 'VEHICLE_READY']);
    expect((await db.message.findMany({ where: { jobId: id } })).every((message) => message.renderedText.includes(`/track/${token}`) || message.event === 'VEHICLE_HANDED_OVER')).toBe(true);
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
    expect(await db.messageAttempt.count({ where: { message: { jobId: id } } })).toBe(3);
    expect(sent.filter((key) => key.startsWith(`${id}:`))).toHaveLength(3);
    const paid = await request('POST', `/api/jobs/${id}/payments`, { idempotencyKey: randomUUID(), amountPaise: 20000, method: 'CASH' }, ownerCookie);
    expect(paid.json().paymentStatus).toBe('PAID');
    expect(paid.json().invoice.totalPaise).toBe(59900);
    expect(await db.auditLog.count({ where: { organizationId, entityType: 'Job', entityId: id } })).toBeGreaterThanOrEqual(4);
  });

  it('lets employee check in and progress but keeps business financial controls private', async () => {
    const created = await request('POST', '/api/jobs/check-in', checkIn('KL29AB1235'), employeeCookie);
    expect(created.statusCode).toBe(201);
    expectOperationalOnly(created.json());
    const id = created.json().id;
    expect(created.json().checkedInBy.name).toBe('Ravi');
    expect(created.json().assignments.map((assignment: { employee: { id: string } }) => assignment.employee.id)).toEqual([employeeId]);
    expect(await db.auditLog.count({ where: { organizationId, action: 'JOB_ASSIGNED', after: { path: ['jobId'], equals: id } } })).toBe(1);
    expect((await request('GET', '/api/operations/available-employees', undefined, employeeCookie)).statusCode).toBe(403);
    expect((await request('GET', '/api/jobs?view=active', undefined, otherEmployeeCookie)).json().some((job: { id: string }) => job.id === id)).toBe(true);
    const detail = await request('GET', `/api/jobs/${id}`, undefined, otherEmployeeCookie);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().customer.name).toBe('Test Driver');
    expect(detail.json().stages).toHaveLength(1);
    expectOperationalOnly(detail.json());
    const board = await request('GET', '/api/jobs?view=active', undefined, employeeCookie);
    expectOperationalOnly(board.json());
    const boardJob = board.json().find((job: { id: string }) => job.id === id);
    expect(boardJob).toBeTruthy();
    expect(Object.keys(boardJob).sort()).toEqual(['id', 'branchId', 'number', 'status', 'serviceName', 'checkedInAt', 'stageAt', 'expectedAt', 'handedOverAt', 'branch', 'customer', 'vehicle'].sort());
    expectOperationalOnly((await request('GET', '/api/board/metrics', undefined, employeeCookie)).json());
    expectOperationalOnly((await request('GET', '/api/operations/capabilities', undefined, employeeCookie)).json());
    expect((await request('GET', '/api/operations/settings', undefined, employeeCookie)).statusCode).toBe(403);
    expect((await request('POST', `/api/jobs/${id}/payments`, { idempotencyKey: randomUUID(), amountPaise: 100, method: 'CASH' }, employeeCookie)).statusCode).toBe(403);
    const started = await request('POST', `/api/jobs/${id}/advance`, { to: 'WASHING' }, otherEmployeeCookie);
    expect(started.statusCode).toBe(200);
    expectOperationalOnly(started.json());
    expectOperationalOnly((await request('POST', `/api/jobs/${id}/advance`, { to: 'WASHING' }, otherEmployeeCookie)).json());
    const ready = await request('POST', `/api/jobs/${id}/advance`, { to: 'READY' }, employeeCookie);
    expect(ready.statusCode).toBe(200);
    expectOperationalOnly(ready.json());
    expect((await request('POST', `/api/jobs/${id}/handover`, { paymentAmountPaise: 100, paymentMethod: 'CASH' }, employeeCookie)).statusCode).toBe(403);
    expect(await db.invoice.count({ where: { jobId: id } })).toBe(0);
    const handed = await request('POST', `/api/jobs/${id}/handover`, { paymentAmountPaise: 0 }, employeeCookie);
    expect(handed.statusCode).toBe(200);
    expectOperationalOnly(handed.json());
    expectOperationalOnly((await request('POST', `/api/jobs/${id}/handover`, { paymentAmountPaise: 0 }, employeeCookie)).json());
    const history = await request('GET', '/api/jobs?view=history&q=KL29AB1235', undefined, employeeCookie);
    expect(history.json()).toHaveLength(1);
    expectOperationalOnly(history.json());
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId: id, status: 'SENT' } })).toBe(3));
  });

  it('keeps paid invoice and payment details owner-only on job detail and history', async () => {
    const job = await db.job.findFirstOrThrow({ where: { organizationId, vehicle: { registrationNumber: 'KL29AB1234' } } });
    const ownerDetail = await request('GET', `/api/jobs/${job.id}`, undefined, ownerCookie);
    expect(ownerDetail.json().totalPaise).toBe(59900);
    expect(ownerDetail.json().outstandingPaise).toBe(0);
    expect(ownerDetail.json().invoice.totalPaise).toBe(59900);
    expect(ownerDetail.json().invoice.payments).toHaveLength(2);
    const employeeDetail = await request('GET', `/api/jobs/${job.id}`, undefined, employeeCookie);
    expect(employeeDetail.statusCode).toBe(200);
    expect(employeeDetail.json().vehicle.registrationNumber).toBe('KL29AB1234');
    expect(employeeDetail.json().serviceName).toBe('Premium Wash');
    expect(employeeDetail.json().stages).toHaveLength(4);
    expect(employeeDetail.json().messages[0]).toEqual(expect.objectContaining({ event: 'VEHICLE_RECEIVED', status: 'SENT' }));
    expect(Object.keys(employeeDetail.json()).sort()).toEqual(['id', 'number', 'status', 'serviceName', 'checkedInAt', 'stageAt', 'expectedAt', 'handedOverAt', 'notes', 'branch', 'customer', 'vehicle', 'checkedInBy', 'handedOverBy', 'stages', 'assignments', 'inspection', 'photos', 'messages', 'selectedAddOns'].sort());
    expect(Object.keys(employeeDetail.json().messages[0]).sort()).toEqual(['id', 'event', 'status', 'createdAt', 'sentAt', 'failedAt'].sort());
    expectOperationalOnly(employeeDetail.json());
    expectOperationalOnly((await request('GET', '/api/jobs?view=history&q=KL29AB1234', undefined, employeeCookie)).json());
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
    expect(message).toMatchObject({ attempts: 1, failureReason: 'Simulated provider failure' });
    expect(message.nextRetryAt).toBeTruthy();
    expect((await db.job.findUniqueOrThrow({ where: { id } })).status).toBe('READY');
    expect((await request('POST', `/api/jobs/${id}/messages/${message.id}/retry`, {}, employeeCookie)).statusCode).toBe(403);
    expect((await request('POST', `/api/jobs/${id}/messages/${message.id}/retry`, {}, ownerCookie)).statusCode).toBe(200);
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId: id, event: 'VEHICLE_READY', status: 'SENT' } })).toBe(1));
    expect(await db.message.count({ where: { jobId: id, event: 'VEHICLE_READY' } })).toBe(1);
    expect((await db.messageAttempt.findMany({ where: { messageId: message.id }, orderBy: { number: 'asc' } })).map((attempt) => attempt.status)).toEqual(['FAILED', 'SENT']);
    expect((await db.message.findUniqueOrThrow({ where: { id: message.id } })).attempts).toBe(2);
    expect((await request('POST', `/api/jobs/${id}/messages/${message.id}/retry`, {}, ownerCookie)).statusCode).toBe(409);
  });

  it('does not queue messages when customer updates are disabled', async () => {
    const created = await request('POST', '/api/jobs/check-in', { ...checkIn('KL29AB1240'), notify: false }, ownerCookie);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await request('POST', `/api/jobs/${id}/advance`, { to: 'WASHING' }, ownerCookie)).statusCode).toBe(200);
    expect((await request('POST', `/api/jobs/${id}/advance`, { to: 'READY' }, ownerCookie)).statusCode).toBe(200);
    expect(await db.message.count({ where: { jobId: id } })).toBe(0);
  });

  it('does not expose another business message or retry endpoint', async () => {
    const otherOrg = await createPaidTestOrganization(db, { data: { slug: `other-${randomUUID()}`, name: 'Other Business' } });
    await db.user.create({ data: { organizationId: otherOrg.id, role: 'OWNER', name: 'Other Owner', username: 'other', passwordHash: await hash('other-password') } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/owner/login', headers: { 'x-organization-slug': otherOrg.slug }, payload: { login: 'other', password: 'other-password' } });
    const cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`;
    const message = await db.message.findFirstOrThrow({ where: { organizationId } });
    expect((await request('GET', `/api/jobs/${message.jobId}`, undefined, cookie)).statusCode).toBe(404);
    expect((await request('POST', `/api/jobs/${message.jobId}/messages/${message.id}/retry`, {}, cookie)).statusCode).toBe(404);
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
    const employeeDetail = await request('GET', `/api/jobs/${job.id}`, undefined, employeeCookie);
    expect(employeeDetail.json().inspection.damages).toHaveLength(1);
    expect(employeeDetail.json().photos).toHaveLength(1);
    expectOperationalOnly(employeeDetail.json());
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

  it('scopes WhatsApp settings and sender snapshots to the owner organization', async () => {
    expect((await request('GET', '/api/whatsapp/settings', undefined, employeeCookie)).statusCode).toBe(403);
    expect((await request('PATCH', '/api/whatsapp/settings', { enabled: false }, employeeCookie)).statusCode).toBe(403);
    expect((await request('POST', '/api/whatsapp/test-connection', {}, employeeCookie)).statusCode).toBe(403);
    expect((await request('POST', '/api/whatsapp/test-failure', {}, employeeCookie)).statusCode).toBe(403);
    const updated = await request('PATCH', '/api/whatsapp/settings', { senderNumber: '0919876543210', senderDisplayName: 'Main Bay', templateReceived: 'received_test' }, ownerCookie);
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ provider: 'MOCK', senderNumber: '+919876543210', senderDisplayName: 'Main Bay', templateReceived: 'received_test' });
    expect(updated.body).not.toContain('credentialRef');
    const test = await request('POST', '/api/whatsapp/test-connection', {}, ownerCookie);
    expect(test.json()).toMatchObject({ delivered: false, status: 'MOCK_ACTIVE' });

    const otherOrg = await createPaidTestOrganization(db, { data: { slug: `message-tenant-${randomUUID()}`, name: 'Second Wash' } });
    await db.user.create({ data: { organizationId: otherOrg.id, role: 'OWNER', name: 'Second Owner', username: 'second', passwordHash: await hash('other-password') } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/owner/login', headers: { 'x-organization-slug': otherOrg.slug }, payload: { login: 'second', password: 'other-password' } });
    const otherCookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`;
    expect((await request('GET', '/api/whatsapp/settings', undefined, otherCookie)).json().senderNumber).toBeNull();
    expect((await request('PATCH', '/api/whatsapp/settings', { senderNumber: '9123456789', senderDisplayName: 'Second Bay' }, otherCookie)).statusCode).toBe(200);
    expect((await request('GET', '/api/whatsapp/settings', undefined, ownerCookie)).json().senderDisplayName).toBe('Main Bay');

    const created = await request('POST', '/api/jobs/check-in', checkIn('KL29AB1260'), ownerCookie);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId: id, status: 'SENT' } })).toBe(1));
    const message = await db.message.findFirstOrThrow({ where: { jobId: id } });
    expect(message).toMatchObject({ organizationId, senderNumber: '+919876543210', senderDisplayName: 'Main Bay', templateKey: 'received_test', provider: 'MOCK' });
    expect(message.renderedText).toContain('Operations Test');
    expect((await request('GET', `/api/jobs/${id}`, undefined, otherCookie)).statusCode).toBe(404);
    expect((await request('POST', `/api/jobs/${id}/messages/${message.id}/retry`, {}, otherCookie)).statusCode).toBe(404);
    const suppressed = await request('PATCH', '/api/whatsapp/settings', { enabled: false }, ownerCookie);
    expect(suppressed.statusCode).toBe(200);
    const disabledJob = await request('POST', '/api/jobs/check-in', checkIn('KL29AB1261'), ownerCookie);
    expect(disabledJob.statusCode).toBe(201);
    expect(await db.message.count({ where: { jobId: disabledJob.json().id } })).toBe(0);
    expect((await request('PATCH', '/api/whatsapp/settings', { enabled: true }, ownerCookie)).statusCode).toBe(200);
    expect(await db.auditLog.count({ where: { organizationId, action: 'WHATSAPP_SETTINGS_UPDATED' } })).toBeGreaterThan(0);
  });

  it('fails one tenant mock delivery without rolling back check-in, then retries', async () => {
    expect((await request('POST', '/api/whatsapp/test-failure', {}, ownerCookie)).json().status).toBe('armed');
    const created = await request('POST', '/api/jobs/check-in', checkIn('KL29AB1262'), ownerCookie);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId: id, status: 'FAILED' } })).toBe(1));
    expect((await db.job.findUniqueOrThrow({ where: { id } })).status).toBe('RECEIVED');
    const message = await db.message.findFirstOrThrow({ where: { jobId: id } });
    expect((await request('POST', `/api/jobs/${id}/messages/${message.id}/retry`, {}, ownerCookie)).statusCode).toBe(200);
    await vi.waitFor(async () => expect(await db.message.count({ where: { id: message.id, status: 'SENT', attempts: 2 } })).toBe(1));
    expect(await db.message.count({ where: { jobId: id, event: 'VEHICLE_RECEIVED' } })).toBe(1);
    expect(await db.auditLog.count({ where: { organizationId, action: 'WHATSAPP_MOCK_FAILURE_ARMED' } })).toBeGreaterThan(0);
  });

  it('resolves the queued provider from organization settings and fails closed for unconnected MSG91', async () => {
    await db.organizationWhatsAppConfig.update({ where: { organizationId }, data: { provider: 'MSG91', status: 'NOT_CONNECTED' } });
    try {
      const created = await request('POST', '/api/jobs/check-in', checkIn('KL29AB1263'), ownerCookie);
      expect(created.statusCode).toBe(201);
      const id = created.json().id;
      await vi.waitFor(async () => expect(await db.message.count({ where: { jobId: id, status: 'FAILED', provider: 'MSG91' } })).toBe(1));
      const message = await db.message.findFirstOrThrow({ where: { jobId: id } });
      expect(message.failureReason).toBe('Provider delivery failed');
      expect((await db.job.findUniqueOrThrow({ where: { id } })).status).toBe('RECEIVED');
      expect((await request('POST', '/api/whatsapp/test-connection', {}, ownerCookie)).statusCode).toBe(409);
      expect((await request('PATCH', '/api/whatsapp/settings', { enabled: false }, ownerCookie)).statusCode).toBe(409);
    } finally {
      await db.organizationWhatsAppConfig.update({ where: { organizationId }, data: { provider: 'MOCK', status: 'MOCK_ACTIVE' } });
    }
  });

  it('sends a previously failed tenant MSG91 message through its scoped sender and keeps attempt history', async () => {
    await db.organizationWhatsAppConfig.update({ where: { organizationId }, data: { provider: 'MSG91', status: 'CONNECTED', credentialRef: 'primary', msg91IntegratedNumberId: 'integrated-test', senderNumber: '+919999999999', templateStatuses: { received_test: 'APPROVED' } } });
    try {
      const created = await request('POST', '/api/jobs/check-in', checkIn('KL29AB1299'), ownerCookie);
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      await vi.waitFor(async () => expect(await db.message.count({ where: { jobId: id, status: 'FAILED' } })).toBe(1));
      const queued = await db.message.findFirstOrThrow({ where: { jobId: id } });
      expect(queued.templateVariables).toEqual(['Test Driver', 'KL29AB1299', 'Operations Test', expect.stringContaining('/track/')]);
      const requestProvider = vi.fn(async () => new Response(JSON.stringify({ message_id: 'msg91-test-id' }), { status: 200 }));
      await db.message.update({ where: { id: queued.id }, data: { status: 'PENDING' } });
      await dispatchMessage(db, new Msg91WhatsAppProvider({ [`${organizationId}:primary`]: 'test-auth-key' }, requestProvider as typeof fetch), queued.id);
      const sentMessage = await db.message.findUniqueOrThrow({ where: { id: queued.id }, include: { deliveryAttempts: true } });
      expect(sentMessage).toMatchObject({ status: 'SENT', providerMessageId: 'msg91-test-id', attempts: 2 });
      expect(sentMessage.deliveryAttempts.map((attempt) => attempt.status)).toEqual(['FAILED', 'SENT']);
      expect((await db.job.findUniqueOrThrow({ where: { id } })).status).toBe('RECEIVED');
      expect(requestProvider).toHaveBeenCalledTimes(1);
    } finally {
      await db.organizationWhatsAppConfig.update({ where: { organizationId }, data: { provider: 'MOCK', status: 'MOCK_ACTIVE', credentialRef: null, msg91IntegratedNumberId: null, senderNumber: null } });
    }
  });

  it('creates one private link at check-in even without messages and exposes only customer-safe status across every stage', async () => {
    await request('PATCH', '/api/operations/settings', { allowOutstanding: true, showCustomerTrackingLink: true }, ownerCookie);
    const created = await request('POST', '/api/jobs/check-in', { ...checkIn('KL29AB1270'), notify: false }, ownerCookie);
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const stored = await db.job.findUniqueOrThrow({ where: { id } });
    expect(stored.trackingTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.trackingTokenCiphertext).toBeTruthy();
    expect(created.body).not.toContain(stored.trackingTokenHash!);
    expect(created.body).not.toContain(stored.trackingTokenCiphertext!);
    const link = await request('POST', `/api/jobs/${id}/tracking-link`, {}, employeeCookie);
    expect(link.statusCode).toBe(200);
    const token = /\/track\/([A-Za-z0-9_-]{43})/.exec(link.json().url)?.[1];
    expect(token).toBeTruthy();
    expect(token).not.toBe(id);
    expect((await request('POST', `/api/jobs/${id}/tracking-link`, {}, ownerCookie)).json().url).toBe(link.json().url);
    const other = await request('POST', '/api/jobs/check-in', { ...checkIn('KL29AB1271'), notify: false }, ownerCookie);
    const otherLink = await request('POST', `/api/jobs/${other.json().id}/tracking-link`, {}, ownerCookie);
    expect(otherLink.json().url).not.toBe(link.json().url);
    expect((await request('GET', `/api/public/tracking/${token}`)).statusCode).toBe(200);
    const received = (await request('GET', `/api/public/tracking/${token}`)).json();
    expect(received).toMatchObject({ businessName: 'Operations Test', vehicleRegistration: 'KL29AB1270', vehicleMake: 'Hyundai', vehicleModel: 'Creta', serviceName: 'Premium Wash', status: 'RECEIVED', photos: [], washingStartedAt: null, readyAt: null, handedOverAt: null });
    expect(Object.keys(received).sort()).toEqual(['businessName', 'businessLogoUrl', 'vehicleRegistration', 'vehicleMake', 'vehicleModel', 'serviceName', 'status', 'expectedCompletionAt', 'receivedAt', 'washingStartedAt', 'readyAt', 'handedOverAt', 'photos'].sort());
    expect(JSON.stringify(received)).not.toMatch(/(?:customerId|organizationId|jobId|invoice|payment|totalPaise|notes|employee|mobile|audit|trackingTokenHash)/i);
    expect((await request('GET', `/api/public/tracking/${'A'.repeat(43)}`)).statusCode).toBe(404);
    expect((await request('GET', '/api/public/tracking/bad')).statusCode).toBe(404);
    expect((await request('POST', `/api/jobs/${id}/advance`, { to: 'WASHING' }, ownerCookie)).statusCode).toBe(200);
    expect((await request('GET', `/api/public/tracking/${token}`)).json()).toMatchObject({ status: 'WASHING', washingStartedAt: expect.any(String) });
    expect((await request('POST', `/api/jobs/${id}/advance`, { to: 'READY' }, ownerCookie)).statusCode).toBe(200);
    expect((await request('GET', `/api/public/tracking/${token}`)).json()).toMatchObject({ status: 'READY', readyAt: expect.any(String) });
    expect((await request('POST', `/api/jobs/${id}/handover`, { paymentAmountPaise: 0 }, ownerCookie)).statusCode).toBe(200);
    expect((await request('GET', `/api/public/tracking/${token}`)).json()).toMatchObject({ status: 'HANDED_OVER', handedOverAt: expect.any(String) });
    await db.job.update({ where: { id }, data: { handedOverAt: new Date(Date.now() - 31 * 86_400_000) } });
    const expired = await request('GET', `/api/public/tracking/${token}`);
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error.message).toBe('This tracking link has expired.');
    expect((await request('GET', `/api/public/tracking/${token}/photos/1`)).statusCode).toBe(410);
  });

  it('requires both owner approval and organization opt-in to share an AFTER photo', async () => {
    await request('PATCH', '/api/operations/settings', { showCustomerTrackingLink: true, showCompletedVehiclePhotos: false }, ownerCookie);
    const created = await request('POST', '/api/jobs/check-in', { ...checkIn('KL29AB1272'), notify: false }, ownerCookie);
    const id = created.json().id as string;
    const link = await request('POST', `/api/jobs/${id}/tracking-link`, {}, ownerCookie);
    const token = /\/track\/([A-Za-z0-9_-]{43})/.exec(link.json().url)?.[1];
    expect(token).toBeTruthy();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aakAAAAASUVORK5CYII=', 'base64');
    async function upload(kind: 'BEFORE' | 'AFTER') {
      const boundary = `test-${randomUUID()}`;
      return app.inject({ method: 'POST', url: `/api/jobs/${id}/photos?kind=${kind}`, headers: { origin: config.APP_ORIGIN, 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: ownerCookie }, payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="wash.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]) });
    }
    const before = await upload('BEFORE');
    const after = await upload('AFTER');
    expect(before.statusCode).toBe(201);
    expect(after.statusCode).toBe(201);
    const visibilityPath = `/api/jobs/${id}/photos/${after.json().id}/customer-visibility`;
    expect((await request('PATCH', visibilityPath, { customerVisible: true }, employeeCookie)).statusCode).toBe(403);
    expect((await request('PATCH', `/api/jobs/${id}/photos/${before.json().id}/customer-visibility`, { customerVisible: true }, ownerCookie)).statusCode).toBe(409);
    expect((await request('PATCH', visibilityPath, { customerVisible: true }, ownerCookie)).statusCode).toBe(200);
    expect((await request('GET', `/api/public/tracking/${token}`)).json().photos).toEqual([]);
    expect((await request('GET', `/api/public/tracking/${token}/photos/1`)).statusCode).toBe(404);
    expect((await request('PATCH', '/api/operations/settings', { showCompletedVehiclePhotos: true }, ownerCookie)).statusCode).toBe(200);
    const publicPhoto = (await request('GET', `/api/public/tracking/${token}`)).json().photos;
    expect(publicPhoto).toEqual([{ url: `/api/public/tracking/${token}/photos/1` }]);
    const photoResponse = await request('GET', publicPhoto[0].url);
    expect(photoResponse.statusCode).toBe(200);
    expect(photoResponse.headers['content-type']).toContain('image/png');
    expect((await request('GET', `/api/public/tracking/${token}/photos/2`)).statusCode).toBe(404);
    expect(await db.auditLog.count({ where: { organizationId, action: 'PHOTO_CUSTOMER_VISIBILITY_CHANGED', entityId: after.json().id } })).toBe(1);
    expect((await request('PATCH', visibilityPath, { customerVisible: false }, ownerCookie)).statusCode).toBe(200);
    expect((await request('GET', `/api/public/tracking/${token}`)).json().photos).toEqual([]);
    await request('PATCH', '/api/operations/settings', { showCompletedVehiclePhotos: false }, ownerCookie);
  });

  it('blocks tracking when disabled and isolates link controls by tenant', async () => {
    const created = await request('POST', '/api/jobs/check-in', checkIn('KL29AB1273'), ownerCookie);
    const id = created.json().id as string;
    const link = await request('POST', `/api/jobs/${id}/tracking-link`, {}, ownerCookie);
    const token = /\/track\/([A-Za-z0-9_-]{43})/.exec(link.json().url)?.[1];
    expect(token).toBeTruthy();
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId: id, status: 'SENT' } })).toBe(1));
    const received = await db.message.findFirstOrThrow({ where: { jobId: id } });
    expect(received.renderedText).toContain(`/track/${token}`);
    await request('POST', `/api/jobs/${id}/advance`, { to: 'WASHING' }, ownerCookie);
    await request('POST', `/api/jobs/${id}/advance`, { to: 'READY' }, ownerCookie);
    const messages = await db.message.findMany({ where: { jobId: id } });
    expect(messages).toHaveLength(3);
    expect(messages.every((message) => message.renderedText.includes(`/track/${token}`))).toBe(true);
    expect((await request('PATCH', '/api/operations/settings', { showCustomerTrackingLink: false }, employeeCookie)).statusCode).toBe(403);
    await request('PATCH', '/api/operations/settings', { showCustomerTrackingLink: false }, ownerCookie);
    expect((await request('GET', `/api/public/tracking/${token}`)).statusCode).toBe(404);
    expect((await request('POST', `/api/jobs/${id}/tracking-link`, {}, ownerCookie)).json()).toEqual({ enabled: false, url: null });
    const hiddenJob = await request('POST', '/api/jobs/check-in', checkIn('KL29AB1274'), ownerCookie);
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId: hiddenJob.json().id, status: 'SENT' } })).toBe(1));
    expect((await db.message.findFirstOrThrow({ where: { jobId: hiddenJob.json().id } })).renderedText).not.toContain('/track/');
    expect((await db.job.findUniqueOrThrow({ where: { id: hiddenJob.json().id } })).trackingTokenHash).toBeTruthy();
    await request('PATCH', '/api/operations/settings', { showCustomerTrackingLink: true }, ownerCookie);
    expect((await request('GET', `/api/public/tracking/${token}`)).statusCode).toBe(200);

    const otherOrg = await createPaidTestOrganization(db, { data: { slug: `tracking-${randomUUID()}`, name: 'Other Wash' } });
    const otherOwner = await db.user.create({ data: { organizationId: otherOrg.id, role: 'OWNER', name: 'Other', username: 'tracking-owner', passwordHash: await hash('other-password') } });
    const otherLogin = await app.inject({ method: 'POST', url: '/api/auth/owner/login', headers: { 'x-organization-slug': otherOrg.slug }, payload: { login: 'tracking-owner', password: 'other-password' } });
    const otherCookie = `${otherLogin.cookies[0]!.name}=${otherLogin.cookies[0]!.value}`;
    expect((await request('POST', `/api/jobs/${id}/tracking-link`, {}, otherCookie)).statusCode).toBe(404);
    expect((await request('PATCH', `/api/jobs/${id}/photos/no-photo/customer-visibility`, { customerVisible: true }, otherCookie)).statusCode).toBe(404);
    const otherBranch = await db.branch.create({ data: { organizationId: otherOrg.id, name: 'Other Bay' } });
    const otherCustomer = await db.customer.create({ data: { organizationId: otherOrg.id, name: 'Other Driver', mobile: '+919999888877' } });
    const otherVehicle = await db.vehicle.create({ data: { organizationId: otherOrg.id, customerId: otherCustomer.id, registrationNumber: 'KA01AB1234', make: 'Maruti', model: 'Swift', type: 'HATCHBACK' } });
    const otherService = await db.service.create({ data: { organizationId: otherOrg.id, name: 'Other Wash', category: 'Wash', basePricePaise: 10000, estimatedMinutes: 30 } });
    const otherTracking = createTrackingToken(config.trackingSecret);
    await db.job.create({ data: { organizationId: otherOrg.id, branchId: otherBranch.id, customerId: otherCustomer.id, vehicleId: otherVehicle.id, serviceId: otherService.id, checkedInById: otherOwner.id, number: 1, idempotencyKey: randomUUID(), serviceName: 'Other Wash', subtotalPaise: 10000, taxPaise: 0, totalPaise: 10000, expectedAt: new Date(Date.now() + 3_600_000), trackingTokenHash: otherTracking.hash, trackingTokenCiphertext: otherTracking.ciphertext } });
    const otherToken = readTrackingToken(config.trackingSecret, otherTracking.ciphertext);
    expect((await request('GET', `/api/public/tracking/${otherToken}`)).json()).toMatchObject({ businessName: 'Other Wash', vehicleRegistration: 'KA01AB1234' });
    expect((await request('GET', `/api/public/tracking/${token}`)).json()).toMatchObject({ businessName: 'Operations Test', vehicleRegistration: 'KL29AB1273' });
  });
});
