import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { createDb } from '../db.js';
import { getConfig } from '../config.js';
import { audit } from '../audit.js';

const config = getConfig();
if (!config.stagingMode || config.POD_NAMESPACE !== 'kleenbay-stage' || config.EXPECTED_DATABASE_NAME !== 'kleenbay_stage' || config.APP_ORIGIN !== 'https://stage.kleenbay.com' || !config.dummyOtp || !config.DUMMY_OTP) {
  throw new Error('Branch smoke is restricted to the KleenBay stage dummy-OTP deployment');
}
const db = createDb(config.DATABASE_URL);
const slug = `branch-stage-qa-${randomUUID().slice(0, 12)}`;
const branchDetails = (name: string) => ({ name, phone: '+919876543210', addressLine1: 'QA Market Road', city: 'Kollam', state: 'Kerala', postalCode: '691001', country: 'IN', timezone: 'Asia/Kolkata' });

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`Stage branch check failed: ${label}`);
}
async function request(path: string, method = 'GET', body?: unknown, cookie?: string) {
  const response = await fetch(`${config.APP_ORIGIN}/api${path}`, { method, headers: { origin: config.APP_ORIGIN, 'content-type': 'application/json', 'x-organization-slug': slug, ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json() as Record<string, unknown> | Record<string, unknown>[];
  return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
}
function jobInput(branchId: string, serviceId: string) {
  return { idempotencyKey: randomUUID(), ...(branchId ? { branchId } : {}), serviceId, mobile: '9845612399', customerName: 'QA Driver', registrationNumber: `KL02AB${randomInt(1000, 9999)}`, make: 'Tata', model: 'Nexon', vehicleType: 'SUV', expectedAt: new Date(Date.now() + 7200000).toISOString(), notify: false };
}

async function run() {
  const priorOrganizationIds = (await db.organization.findMany({ select: { id: true } })).map((row) => row.id);
  const priorJobIds = (await db.job.findMany({ select: { id: true } })).map((row) => row.id);
  const existingOwnerCount = await db.user.count({ where: { role: 'OWNER', active: true, passwordHash: { not: null } } });
  assert(existingOwnerCount > 0, 'existing active owners remain present');
  const password = randomBytes(32).toString('base64url');
  const org = await db.organization.create({ data: { slug, name: 'KleenBay Branch QA' } });
  const initial = await db.branch.create({ data: { organizationId: org.id, ...branchDetails('QA Main') } });
  const owner = await db.user.create({ data: { organizationId: org.id, role: 'OWNER', name: 'QA Owner', username: slug, passwordHash: await hash(password) } });
  await audit(db, { organizationId: org.id, actorUserId: owner.id, action: 'STAGE_QA_TENANT_CREATED', entityType: 'Organization', entityId: org.id });
  const login = await request('/auth/owner/login', 'POST', { login: slug, password });
  assert(login.status === 200 && login.cookie, 'owner password login');
  const cookie = login.cookie;
  const listing = await request('/branches', 'GET', undefined, cookie);
  assert(listing.status === 200 && Array.isArray(listing.data) && listing.data.length === 1, 'legacy branch visible');
  const second = await request('/branches', 'POST', branchDetails('QA Kottiyam'), cookie);
  assert(second.status === 201 && !Array.isArray(second.data) && typeof second.data.id === 'string', 'owner branch creation');
  const secondId = String((second.data as Record<string, unknown>).id);
  const edited = await request(`/branches/${secondId}`, 'PATCH', { openingTime: '09:00', closingTime: '18:00' }, cookie);
  assert(edited.status === 200, 'owner branch edit');
  const employeeMobile = String(9000000000 + randomInt(900000000));
  const employee = await request('/employees', 'POST', { name: 'QA Ravi', mobile: employeeMobile, branchId: initial.id }, cookie);
  assert(employee.status === 201 && !Array.isArray(employee.data) && typeof employee.data.id === 'string', 'owner creates employee');
  const employeeId = String((employee.data as Record<string, unknown>).id);
  const service = await request('/services', 'POST', { name: 'QA Premium Wash', category: 'Wash', basePricePaise: 59900, estimatedMinutes: 45 }, cookie);
  assert(service.status === 201 && !Array.isArray(service.data) && typeof service.data.id === 'string', 'service setup');
  const serviceId = String((service.data as Record<string, unknown>).id);
  assert((await request(`/services/${serviceId}/prices`, 'PUT', { branchId: secondId, vehicleType: 'SUV', pricePaise: 64900 }, cookie)).status === 200, 'branch price override');
  assert((await request('/jobs/check-in', 'POST', jobInput('', serviceId), cookie)).status === 400, 'multi-branch choice required');
  const first = await request('/jobs/check-in', 'POST', jobInput(initial.id, serviceId), cookie);
  const other = await request('/jobs/check-in', 'POST', jobInput(secondId, serviceId), cookie);
  assert(first.status === 201 && other.status === 201 && !Array.isArray(first.data) && !Array.isArray(other.data), 'two branch check-ins');
  const firstJob = first.data as Record<string, unknown>;
  const secondJob = other.data as Record<string, unknown>;
  assert(firstJob.servicePricePaise === 59900 && secondJob.servicePricePaise === 64900, 'snapshotted branch prices');
  const board = await request('/jobs', 'GET', undefined, cookie);
  const filtered = await request(`/jobs?branchId=${initial.id}`, 'GET', undefined, cookie);
  assert(Array.isArray(board.data) && Array.isArray(filtered.data) && board.data.length >= 2 && filtered.data.every((job) => (job as Record<string, unknown>).branchId === initial.id), 'board branch filter');
  const summary = await request(`/summary/daily?branchId=${initial.id}`, 'GET', undefined, cookie);
  assert(summary.status === 200 && !Array.isArray(summary.data) && summary.data.branchId === initial.id && Number(summary.data.receivedCount) >= 1, 'branch daily summary');
  const otp = await request('/auth/employee/request-otp', 'POST', { mobile: employeeMobile });
  assert(otp.status === 200, 'employee OTP request');
  const verified = await request('/auth/employee/verify-otp', 'POST', { mobile: employeeMobile, code: config.DUMMY_OTP });
  assert(verified.status === 200 && verified.cookie, 'employee OTP login');
  const employeeBoard = await request('/jobs', 'GET', undefined, verified.cookie);
  assert(Array.isArray(employeeBoard.data) && employeeBoard.data.some((job) => (job as Record<string, unknown>).id === firstJob.id) && employeeBoard.data.every((job) => (job as Record<string, unknown>).branchId === initial.id), 'employee branch visibility');
  assert((await request(`/jobs/${String(secondJob.id)}`, 'GET', undefined, verified.cookie)).status === 404, 'employee foreign-branch job denied');
  assert((await request('/payments', 'GET', undefined, verified.cookie)).status === 403, 'employee financial API denied');
  assert((await request('/branches', 'POST', branchDetails('Denied'), verified.cookie)).status === 403, 'employee branch mutation denied');
  assert((await request(`/employees/${employeeId}`, 'PATCH', { branchId: secondId }, cookie)).status === 200, 'employee branch reassignment');
  const movedBoard = await request('/jobs', 'GET', undefined, verified.cookie);
  assert(Array.isArray(movedBoard.data) && movedBoard.data.some((job) => (job as Record<string, unknown>).id === secondJob.id) && movedBoard.data.every((job) => (job as Record<string, unknown>).branchId === secondId), 'reassignment updates existing session');
  for (const job of [firstJob, secondJob]) {
    const draft = await request(`/jobs/${String(job.id)}/invoice`, 'POST', { items: [], discountKind: 'NONE', discountValue: 0 }, cookie);
    assert(draft.status === 201 && !Array.isArray(draft.data) && typeof draft.data.id === 'string', 'invoice draft');
    assert((await request(`/invoices/${String(draft.data.id)}/issue`, 'POST', {}, cookie)).status === 200, 'invoice issue');
    assert((await request(`/jobs/${String(job.id)}/payments`, 'POST', { idempotencyKey: randomUUID(), amountPaise: 10000, method: 'UPI' }, cookie)).status === 201, 'payment recorded');
  }
  const branchInvoices = await request(`/invoices?branchId=${secondId}`, 'GET', undefined, cookie);
  const branchPayments = await request(`/payments?branchId=${secondId}`, 'GET', undefined, cookie);
  assert(Array.isArray(branchInvoices.data) && branchInvoices.data.length === 1 && (branchInvoices.data[0] as { job: { branch: { id: string } } }).job.branch.id === secondId, 'invoice branch filter');
  assert(Array.isArray(branchPayments.data) && branchPayments.data.length === 1 && (branchPayments.data[0] as { invoice: { job: { branch: { id: string } } } }).invoice.job.branch.id === secondId, 'payment branch filter');
  for (const job of [firstJob, secondJob]) {
    assert((await request(`/jobs/${String(job.id)}/advance`, 'POST', { to: 'WASHING' }, cookie)).status === 200, 'washing stage');
    assert((await request(`/jobs/${String(job.id)}/advance`, 'POST', { to: 'READY' }, cookie)).status === 200, 'ready stage');
    assert((await request(`/jobs/${String(job.id)}/handover`, 'POST', { paymentAmountPaise: 0 }, cookie)).status === 200, 'handover');
  }
  assert((await request(`/branches/${secondId}/deactivate`, 'POST', {}, cookie)).status === 200, 'branch deactivation');
  assert((await request('/jobs/check-in', 'POST', jobInput(secondId, serviceId), cookie)).status === 400, 'inactive branch check-in rejected');
  const retained = await request(`/jobs?view=history&branchId=${secondId}`, 'GET', undefined, cookie);
  assert(Array.isArray(retained.data) && retained.data.some((job) => (job as Record<string, unknown>).id === secondJob.id), 'inactive branch jobs retained');
  assert(await db.auditLog.count({ where: { organizationId: org.id, action: 'EMPLOYEE_BRANCH_CHANGED' } }) === 1, 'branch assignment audit');
  assert(await db.organization.count({ where: { id: { in: priorOrganizationIds } } }) === priorOrganizationIds.length && await db.job.count({ where: { id: { in: priorJobIds } } }) === priorJobIds.length, 'preexisting organization and jobs retained');
  console.log(JSON.stringify({ status: 'PASS', checks: 31, qaOrganization: slug, preexistingOrganizations: priorOrganizationIds.length, preexistingJobs: priorJobIds.length, existingActiveOwners: existingOwnerCount }));
}

try { await run(); } finally { await db.$disconnect(); }
