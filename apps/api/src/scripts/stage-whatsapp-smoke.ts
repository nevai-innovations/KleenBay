import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { createDb } from '../db.js';
import { getConfig } from '../config.js';
import { audit } from '../audit.js';

const config = getConfig();
if (!config.stagingMode || config.POD_NAMESPACE !== 'kleenbay-stage' || config.EXPECTED_DATABASE_NAME !== 'kleenbay_stage' || config.APP_ORIGIN !== 'https://stage.kleenbay.com' || config.MESSAGING_PROVIDER !== 'mock' || !config.dummyOtp) {
  throw new Error('This smoke check is restricted to the KleenBay mock-messaging stage');
}

const db = createDb(config.DATABASE_URL);
type Tenant = { organizationId: string; slug: string; branchId: string; cookie: string; sender: string };

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`Stage WhatsApp check failed: ${label}`);
}

async function request(path: string, method = 'GET', body?: unknown, cookie?: string, slug?: string) {
  const response = await fetch(`${config.APP_ORIGIN}/api${path}`, {
    method,
    headers: { origin: config.APP_ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(slug ? { 'x-organization-slug': slug } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json() as Record<string, unknown>;
  return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
}

async function tenant(name: string, sender: string): Promise<Tenant> {
  const slug = `wa-stage-qa-${randomUUID().slice(0, 12)}`;
  const username = slug;
  const password = randomBytes(32).toString('base64url');
  const org = await db.organization.create({ data: { name, slug } });
  const branch = await db.branch.create({ data: { organizationId: org.id, name: 'QA Bay' } });
  const owner = await db.user.create({ data: { organizationId: org.id, role: 'OWNER', name: 'QA Owner', username, passwordHash: await hash(password) } });
  await audit(db, { organizationId: org.id, actorUserId: owner.id, action: 'STAGE_QA_TENANT_CREATED', entityType: 'Organization', entityId: org.id });
  const login = await request('/auth/owner/login', 'POST', { login: username, password }, undefined, slug);
  assert(login.status === 200 && login.cookie, 'owner login');
  const settings = await request('/whatsapp/settings', 'PATCH', { senderNumber: sender, senderDisplayName: name, enabled: true }, login.cookie, slug);
  assert(settings.status === 200 && settings.data.senderNumber === sender, 'tenant WhatsApp settings');
  const service = await request('/services', 'POST', { name: 'QA Wash', category: 'Wash', basePricePaise: 49900, estimatedMinutes: 45 }, login.cookie, slug);
  assert(service.status === 201, 'owner service setup');
  return { organizationId: org.id, slug, branchId: branch.id, cookie: login.cookie, sender };
}

async function waitForMessage(jobId: string, event: 'VEHICLE_RECEIVED' | 'WASH_STARTED' | 'VEHICLE_READY', status: 'SENT' | 'FAILED') {
  for (let index = 0; index < 40; index++) {
    const message = await db.message.findUnique({ where: { jobId_event: { jobId, event } } });
    if (message?.status === status) return message;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Stage WhatsApp check timed out: ${event} ${status}`);
}

async function checkIn(owner: Tenant, plate: string, mobile: string, serviceId: string) {
  const input = { idempotencyKey: randomUUID(), mobile, customerName: 'QA Driver', registrationNumber: plate, make: 'Tata', model: 'Nexon', vehicleType: 'SUV', serviceId, branchId: owner.branchId, expectedAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(), notify: true };
  const created = await request('/jobs/check-in', 'POST', input, owner.cookie, owner.slug);
  assert(created.status === 201 && typeof created.data.id === 'string', 'check-in');
  const duplicate = await request('/jobs/check-in', 'POST', input, owner.cookie, owner.slug);
  assert(duplicate.status === 200 && duplicate.data.id === created.data.id, 'idempotent check-in');
  return String(created.data.id);
}

async function run() {
  const ownerA = await tenant('KleenBay QA North', '+919876543210');
  const ownerB = await tenant('KleenBay QA South', '+919123456789');
  const settingA = await request(`/whatsapp/settings?organizationId=${ownerB.organizationId}`, 'GET', undefined, ownerA.cookie, ownerB.slug);
  assert(settingA.status === 200 && settingA.data.senderNumber === ownerA.sender && !('credentialRef' in settingA.data), 'owner A configuration isolation');
  const settingB = await request('/whatsapp/settings', 'GET', undefined, ownerB.cookie, ownerA.slug);
  assert(settingB.status === 200 && settingB.data.senderNumber === ownerB.sender, 'owner B configuration isolation');
  const connection = await request('/whatsapp/test-connection', 'POST', {}, ownerA.cookie, ownerA.slug);
  assert(connection.status === 200 && connection.data.delivered === false, 'mock-only connection test');

  const employeeMobile = String(9000000000 + randomInt(100000000, 900000000));
  const employee = await request('/employees', 'POST', { name: 'QA Employee', mobile: `091${employeeMobile}` }, ownerA.cookie, ownerA.slug);
  assert(employee.status === 201, 'owner-created employee');
  assert((await request('/auth/employee/request-otp', 'POST', { mobile: employeeMobile })).status === 200, 'employee OTP request');
  const employeeLogin = await request('/auth/employee/verify-otp', 'POST', { mobile: employeeMobile, code: config.DUMMY_OTP });
  assert(employeeLogin.status === 200 && employeeLogin.cookie, 'employee OTP login');
  assert((await request('/whatsapp/settings', 'GET', undefined, employeeLogin.cookie)).status === 403, 'employee settings denial');
  assert((await request('/summary/daily', 'GET', undefined, employeeLogin.cookie)).status === 403, 'employee financial denial');

  const serviceA = (await db.service.findFirstOrThrow({ where: { organizationId: ownerA.organizationId } })).id;
  const serviceB = (await db.service.findFirstOrThrow({ where: { organizationId: ownerB.organizationId } })).id;
  const suffix = randomInt(1000, 9999);
  const jobA = await checkIn(ownerA, `KL07QA${suffix}`, '9000000101', serviceA);
  const received = await waitForMessage(jobA, 'VEHICLE_RECEIVED', 'SENT');
  assert(received.organizationId === ownerA.organizationId && received.senderNumber === ownerA.sender && received.provider === 'MOCK' && received.renderedText.includes('KleenBay QA North') && received.renderedText.includes(`KL07QA${suffix}`), 'received message tenant content');
  const token = /\/track\/([A-Za-z0-9_-]{43})/.exec(received.renderedText)?.[1];
  assert(token && token !== jobA, 'unpredictable tracking token');
  const publicReceived = await request(`/public/tracking/${token}`);
  assert(publicReceived.status === 200 && publicReceived.data.status === 'RECEIVED' && publicReceived.data.vehicleRegistration === `KL07QA${suffix}`, 'unauthenticated received tracking');
  assert(Object.keys(publicReceived.data).sort().join(',') === ['businessName', 'businessLogoUrl', 'vehicleRegistration', 'vehicleMake', 'vehicleModel', 'serviceName', 'status', 'expectedCompletionAt', 'receivedAt', 'washingStartedAt', 'readyAt', 'handedOverAt', 'photos'].sort().join(','), 'public tracking allowlist');
  assert((await request(`/public/tracking/${'A'.repeat(43)}`)).status === 404, 'invalid tracking token');
  const started = await request(`/jobs/${jobA}/advance`, 'POST', { to: 'WASHING' }, ownerA.cookie, ownerA.slug);
  assert(started.status === 200, 'washing transition');
  const washing = await waitForMessage(jobA, 'WASH_STARTED', 'SENT');
  assert(washing.renderedText.includes(`/track/${token}`), 'stable washing tracking link');
  assert((await request(`/public/tracking/${token}`)).data.status === 'WASHING', 'unauthenticated washing tracking');
  assert((await request(`/jobs/${jobA}/advance`, 'POST', { to: 'WASHING' }, ownerA.cookie, ownerA.slug)).status === 200, 'duplicate stage request');
  const ready = await request(`/jobs/${jobA}/advance`, 'POST', { to: 'READY' }, ownerA.cookie, ownerA.slug);
  assert(ready.status === 200, 'ready transition');
  const readyMessage = await waitForMessage(jobA, 'VEHICLE_READY', 'SENT');
  assert(readyMessage.renderedText.includes(`/track/${token}`) && (await db.message.count({ where: { jobId: jobA } })) === 3, 'ready once and stable link');
  assert((await request(`/public/tracking/${token}`)).data.status === 'READY', 'ready tracking status');
  const handed = await request(`/jobs/${jobA}/handover`, 'POST', { paymentAmountPaise: 0 }, ownerA.cookie, ownerA.slug);
  assert(handed.status === 200, 'handover');
  const publicHanded = await request(`/public/tracking/${token}`);
  assert(publicHanded.status === 200 && publicHanded.data.status === 'HANDED_OVER' && publicHanded.data.handedOverAt, 'unauthenticated completed tracking');
  assert((await request(`/jobs/${jobA}/tracking-link`, 'POST', {}, ownerA.cookie, ownerA.slug)).data.url === `${config.APP_ORIGIN}/track/${token}`, 'single stable tracking link');
  console.log('PASS RECEIVED, WASHING, READY, HANDED_OVER, idempotency and public tracking');

  const jobB = await checkIn(ownerB, `KL07QB${suffix}`, '9000000102', serviceB);
  const bMessage = await waitForMessage(jobB, 'VEHICLE_RECEIVED', 'SENT');
  assert(bMessage.senderNumber === ownerB.sender && bMessage.renderedText.includes('KleenBay QA South'), 'organization B sender');
  assert((await request(`/jobs/${jobB}`, 'GET', undefined, ownerA.cookie, ownerA.slug)).status === 404, 'owner A cannot read B job');
  assert((await request(`/jobs/${jobB}/messages/${bMessage.id}/retry`, 'POST', {}, ownerA.cookie, ownerA.slug)).status === 404, 'owner A cannot retry B message');
  const employeeDetail = await request(`/jobs/${jobA}`, 'GET', undefined, employeeLogin.cookie);
  assert(employeeDetail.status === 200 && !('invoice' in employeeDetail.data) && !('totalPaise' in employeeDetail.data) && !('trackingTokenHash' in employeeDetail.data), 'employee operational-only detail');
  console.log('PASS tenant isolation and employee authorization');

  assert((await request('/whatsapp/test-failure', 'POST', {}, ownerA.cookie, ownerA.slug)).status === 200, 'arm mock failure');
  const failedJob = await checkIn(ownerA, `KL07QC${suffix}`, '9000000103', serviceA);
  const failed = await waitForMessage(failedJob, 'VEHICLE_RECEIVED', 'FAILED');
  assert((await db.job.findUniqueOrThrow({ where: { id: failedJob } })).status === 'RECEIVED', 'failed message does not roll back job');
  assert((await request(`/jobs/${failedJob}/messages/${failed.id}/retry`, 'POST', {}, employeeLogin.cookie)).status === 403, 'employee retry denial');
  assert((await request(`/jobs/${failedJob}/messages/${failed.id}/retry`, 'POST', {}, ownerA.cookie, ownerA.slug)).status === 200, 'owner retry');
  const recovered = await waitForMessage(failedJob, 'VEHICLE_RECEIVED', 'SENT');
  assert(recovered.attempts === 2 && (await db.message.count({ where: { jobId: failedJob, event: 'VEHICLE_RECEIVED' } })) === 1, 'retry attempt and uniqueness');
  console.log('PASS mock failure and owner retry');
}

try { await run(); }
finally { await db.$disconnect(); }
