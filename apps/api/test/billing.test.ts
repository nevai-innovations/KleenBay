import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { assertLocalTestDatabase } from '../src/database-target.js';
import { addCalendarYear, requireActiveSubscription } from '../src/billing.js';
import { ANNUAL_PLAN, validHmac, type PaymentProvider, type RazorpayOrder, type RazorpayPayment } from '../src/razorpay.js';

const db = createDb(assertLocalTestDatabase(process.env.TEST_DATABASE_URL));
const config = { ...getConfig(), NODE_ENV: 'test' as const, LOG_LEVEL: 'silent', razorpayConfigured: false };
const secret = 'local-test-key-secret';
const webhookSecret = 'local-test-webhook-secret';
const signature = (order: string, payment: string) => createHmac('sha256', secret).update(`${order}|${payment}`).digest('hex');
const orders = new Map<string, RazorpayOrder>();
const payments = new Map<string, RazorpayPayment>();
const gateway: PaymentProvider = {
  keyId: 'rzp_test_unitTest',
  createOrder: vi.fn(async ({ receipt, organizationId }) => {
    const order = { id: `order_${randomBytes(8).toString('hex')}`, amount: 720000, currency: 'INR', receipt, status: 'created', notes: { organizationId } };
    orders.set(order.id, order); return order;
  }),
  fetchOrder: async (id) => { const order = orders.get(id); if (!order) throw new Error('Unknown order'); return order; },
  fetchPayment: async (id) => { const payment = payments.get(id); if (!payment) throw new Error('Unknown payment'); return payment; },
  fetchOrderPayments: async (id) => [...payments.values()].filter((p) => p.order_id === id),
  verifySignature: (order, payment, sig) => validHmac(`${order}|${payment}`, sig, secret),
  verifyWebhook: (raw, sig) => validHmac(raw, sig, webhookSecret),
};
let app: Awaited<ReturnType<typeof buildApp>>;
let orgId: string;
let ownerCookie: string;
let employeeCookie: string;
let foreignCookie: string;

async function makeSession(user: { id: string; organizationId: string }) {
  const token = randomBytes(32).toString('hex');
  await db.session.create({ data: { organizationId: user.organizationId, userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 3600000) } });
  return `kleenbay_session=${token}`;
}
function request(method: 'GET' | 'POST', url: string, cookie = ownerCookie, payload?: object) { return app.inject({ method, url, headers: { origin: config.APP_ORIGIN, ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload }) }); }
async function checkout(cookie = ownerCookie, key = randomUUID()) {
  const response = await request('POST', '/api/billing/checkout', cookie, { idempotencyKey: key });
  expect(response.statusCode).toBe(200);
  return response.json() as { transactionId: string; orderId: string; amountPaise: number; keyId: string };
}
function providerPayment(orderId: string, status = 'captured', overrides: Partial<RazorpayPayment> = {}) {
  const payment: RazorpayPayment = { id: `pay_${randomBytes(8).toString('hex')}`, order_id: orderId, amount: 720000, currency: 'INR', status, captured: status === 'captured', created_at: Math.floor(Date.now() / 1000), ...overrides };
  payments.set(payment.id, payment); return payment;
}
function verify(payment: RazorpayPayment, cookie = ownerCookie, sig = signature(payment.order_id, payment.id)) { return request('POST', '/api/billing/razorpay/verify', cookie, { razorpay_order_id: payment.order_id, razorpay_payment_id: payment.id, razorpay_signature: sig }); }
function webhook(payment: RazorpayPayment, event = 'payment.captured', valid = true, whitespace = false) {
  const raw = JSON.stringify({ event, payload: { payment: { entity: payment } } }, null, whitespace ? 2 : undefined);
  const sig = createHmac('sha256', webhookSecret).update(raw).digest('hex');
  return app.inject({ method: 'POST', url: '/api/billing/razorpay/webhook', headers: { 'content-type': 'application/json', 'x-razorpay-signature': valid ? sig : '0'.repeat(64), 'x-razorpay-event-id': 'duplicate-event' }, payload: raw });
}
async function billing() { return (await request('GET', '/api/billing')).json(); }

beforeEach(async () => {
  vi.mocked(gateway.createOrder).mockClear();
  const org = await db.organization.create({ data: { slug: `razor-${randomUUID()}`, name: 'Billing Test' } }); orgId = org.id;
  const owner = await db.user.create({ data: { organizationId: orgId, role: 'OWNER', name: 'Owner' } });
  const employee = await db.user.create({ data: { organizationId: orgId, role: 'EMPLOYEE', name: 'Employee' } });
  const foreign = await db.organization.create({ data: { slug: `razor-other-${randomUUID()}`, name: 'Other Business' } });
  const otherOwner = await db.user.create({ data: { organizationId: foreign.id, role: 'OWNER', name: 'Other Owner' } });
  ownerCookie = await makeSession(owner); employeeCookie = await makeSession(employee); foreignCookie = await makeSession(otherOwner);
  app = await buildApp(config, db, undefined, undefined, undefined, gateway); await app.ready();
});
afterEach(async () => { await app?.close(); });
afterAll(async () => { await db.$disconnect(); });

describe('Razorpay organization billing', () => {
  it('returns authoritative inactive state and empty history', async () => {
    const result = await billing(); expect(result.plan).toEqual(ANNUAL_PLAN); expect(result.subscription.status).toBe('INACTIVE'); expect(result.payments).toEqual([]);
    await expect(requireActiveSubscription(db, orgId)).rejects.toMatchObject({ statusCode: 402 });
    expect((await request('GET', '/api/jobs')).statusCode).toBe(200);
  });
  it('rejects unauthenticated and employee access to all owner billing routes', async () => {
    expect((await request('GET', '/api/billing', '')).statusCode).toBe(401);
    for (const [method, path] of [['GET', '/api/billing'], ['GET', '/api/billing/payments'], ['POST', '/api/billing/checkout'], ['POST', '/api/billing/renew'], ['POST', '/api/billing/razorpay/verify'], ['GET', '/api/billing/transactions/x'], ['POST', '/api/billing/transactions/x/reconcile'], ['POST', '/api/billing/transactions/x/cancel']] as const) expect((await request(method, path, employeeCookie, method === 'POST' ? {} : undefined)).statusCode).toBe(403);
  });
  it('creates a unique server-priced order and returns only checkout data', async () => {
    const result = await checkout(); expect(result.amountPaise).toBe(720000); expect(result.keyId).toBe(gateway.keyId);
    const row = await db.subscriptionPayment.findUniqueOrThrow({ where: { id: result.transactionId } }); expect(row.provider).toBe('RAZORPAY'); expect(row.razorpayOrderId).toBe(result.orderId);
    expect(orders.get(result.orderId)?.receipt.length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect((await checkout()).orderId).not.toBe(result.orderId);
  });
  it.each(['amount', 'amountPaise', 'organizationId', 'planCode', 'subscriptionPeriod'])('rejects client override of %s', async (field) => {
    expect((await request('POST', '/api/billing/checkout', ownerCookie, { idempotencyKey: randomUUID(), [field]: 'override' })).statusCode).toBe(400);
    expect(await db.subscriptionPayment.count({ where: { organizationId: orgId } })).toBe(0);
  });
  it('reuses one checkout idempotency key without creating another provider order', async () => {
    const key = randomUUID(); const first = await checkout(ownerCookie, key); const second = await checkout(ownerCookie, key); expect(second).toEqual(first); expect(gateway.createOrder).toHaveBeenCalledTimes(1);
  });
  it('isolates payment history, transaction reads, reconciliation, cancellation, and verify', async () => {
    const result = await checkout(); const payment = providerPayment(result.orderId);
    expect((await verify(payment, foreignCookie)).statusCode).toBe(404);
    for (const [method, suffix] of [['GET', ''], ['POST', '/reconcile'], ['POST', '/cancel']] as const) expect((await request(method, `/api/billing/transactions/${result.transactionId}${suffix}`, foreignCookie, method === 'POST' ? { outcome: 'CANCELLED' } : undefined)).statusCode).toBe(404);
    expect((await request('GET', '/api/billing', foreignCookie)).json().payments).toEqual([]);
    expect((await request('GET', '/api/billing/payments', foreignCookie)).json()).toEqual([]);
  });
  it('rejects invalid checkout signature without activation and audits no signature', async () => {
    const result = await checkout(); const payment = providerPayment(result.orderId);
    expect((await verify(payment, ownerCookie, '0'.repeat(64))).statusCode).toBe(400); expect((await billing()).subscription.status).toBe('PAYMENT_PENDING');
    const audit = await db.auditLog.findMany({ where: { organizationId: orgId } }); expect(JSON.stringify(audit)).not.toContain(secret); expect(JSON.stringify(audit)).not.toContain('0'.repeat(64));
  });
  it('rejects an unknown order', async () => { expect((await verify(providerPayment('order_unknown'))).statusCode).toBe(404); });
  it.each([{ amount: 1 }, { currency: 'USD' }, { order_id: 'order_foreign' }])('rejects provider payment mismatch %j', async (overrides) => {
    const result = await checkout(); const payment = providerPayment(result.orderId, 'captured', overrides);
    const response = await request('POST', '/api/billing/razorpay/verify', ownerCookie, { razorpay_order_id: result.orderId, razorpay_payment_id: payment.id, razorpay_signature: signature(result.orderId, payment.id) });
    expect(response.statusCode).toBe(400); expect((await billing()).subscription.status).not.toBe('ACTIVE');
  });
  it('does not activate on authorized but uncaptured payment', async () => { const result = await checkout(); expect((await verify(providerPayment(result.orderId, 'authorized'))).json().status).toBe('INITIATED'); expect((await billing()).subscription.status).toBe('PAYMENT_PENDING'); });
  it('activates once despite concurrent verify, webhook, and webhook retry', async () => {
    const result = await checkout(); const payment = providerPayment(result.orderId);
    const responses = await Promise.all([verify(payment), verify(payment), webhook(payment), webhook(payment, 'order.paid')]); expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    const first = await billing(); expect(first.subscription.status).toBe('ACTIVE'); expect(first.payments[0].status).toBe('SUCCESS');
    const end = first.subscription.currentPeriodEnd; await verify(payment); await webhook(payment); expect((await billing()).subscription.currentPeriodEnd).toBe(end);
    expect(await db.auditLog.count({ where: { organizationId: orgId, action: 'SUBSCRIPTION_ACTIVATED' } })).toBe(1);
    expect(await db.auditLog.count({ where: { organizationId: orgId, action: 'SUBSCRIPTION_PAYMENT_VERIFIED' } })).toBe(1);
    expect(await requireActiveSubscription(db, orgId)).toMatchObject({ status: 'ACTIVE' });
  });
  it('extends early renewals from the existing period end', async () => {
    const result = await checkout(); await verify(providerPayment(result.orderId)); const first = (await billing()).subscription;
    const renewed = await checkout(); await verify(providerPayment(renewed.orderId)); const second = (await billing()).subscription;
    expect(second.currentPeriodStart).toBe(first.currentPeriodStart); expect(second.currentPeriodEnd).toBe(addCalendarYear(new Date(first.currentPeriodEnd)).toISOString());
  });
  it.each(['GRACE_PERIOD', 'EXPIRED'] as const)('renews %s once and immediately restores owner and employee operations', async (state) => {
    const first = await checkout(); await verify(providerPayment(first.orderId));
    const end = new Date(Date.now() - (state === 'GRACE_PERIOD' ? 1 : 8) * 86400000);
    const start = new Date(end.getTime() - 365 * 86400000);
    await db.subscription.update({ where: { organizationId: orgId }, data: { currentPeriodStart: start, currentPeriodEnd: end } });
    const branch = await db.branch.create({ data: { organizationId: orgId, name: 'Main' } });
    const service = await db.service.create({ data: { organizationId: orgId, name: 'Wash', category: 'Wash', basePricePaise: 10000, estimatedMinutes: 30 } });
    await db.user.updateMany({ where: { organizationId: orgId, role: 'EMPLOYEE' }, data: { branchId: branch.id } });
    const job = { idempotencyKey: randomUUID(), branchId: branch.id, mobile: '9876543280', customerName: 'Renewal Test', registrationNumber: 'KA01AB1234', make: 'Tata', model: 'Nexon', vehicleType: 'SUV', serviceId: service.id, expectedAt: new Date(Date.now() + 3600000).toISOString(), notify: false };
    expect((await request('POST', '/api/jobs/check-in', ownerCookie, job)).statusCode).toBe(402);
    expect((await request('GET', '/api/entitlement')).json().state).toBe(state);
    const renewal = await checkout(); const payment = providerPayment(renewal.orderId);
    expect((await verify(payment)).statusCode).toBe(200);
    const restored = (await billing()).subscription;
    expect(restored.state).toBe('ACTIVE');
    if (state === 'GRACE_PERIOD') { expect(restored.currentPeriodEnd).toBe(addCalendarYear(end).toISOString()); expect(restored.currentPeriodStart).toBe(start.toISOString()); }
    else expect(new Date(restored.currentPeriodStart).getTime()).toBeGreaterThan(Date.now() - 60000);
    expect((await request('POST', '/api/jobs/check-in', ownerCookie, job)).statusCode).toBe(201);
    expect((await request('GET', '/api/jobs', employeeCookie)).statusCode).toBe(200);
    await Promise.all([verify(payment), webhook(payment), webhook(payment)]);
    expect((await billing()).subscription.currentPeriodEnd).toBe(restored.currentPeriodEnd);
    const audits = await db.auditLog.findMany({ where: { organizationId: orgId, action: 'SUBSCRIPTION_ACCESS_RESTORED' } });
    expect(audits.filter((entry) => (entry.before as { state: string }).state === state)).toHaveLength(1);
  });
  it('serializes two distinct concurrent paid renewals without losing a year', async () => {
    const a = await checkout(); const b = await checkout(); const pa = providerPayment(a.orderId); const pb = providerPayment(b.orderId);
    const responses = await Promise.all([verify(pa), verify(pb)]); expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    const state = (await billing()).subscription; expect(new Date(state.currentPeriodEnd).getUTCFullYear()).toBe(new Date(state.currentPeriodStart).getUTCFullYear() + 2);
  });
  it('restarts expired renewal from verified successful payment time', async () => {
    const result = await checkout(); await db.subscription.update({ where: { organizationId: orgId }, data: { status: 'ACTIVE', currentPeriodStart: new Date('2020-01-01'), currentPeriodEnd: new Date('2021-01-01') } });
    expect((await billing()).subscription.status).toBe('EXPIRED'); await verify(providerPayment(result.orderId)); const state = (await billing()).subscription;
    expect(new Date(state.currentPeriodStart).getTime()).toBeGreaterThan(Date.now() - 60000); expect(state.currentPeriodEnd).toBe(addCalendarYear(new Date(state.currentPeriodStart)).toISOString());
  });
  it('keeps an active subscription after failed/cancelled renewal and late failure webhook', async () => {
    const first = await checkout(); const paid = providerPayment(first.orderId); await verify(paid); const end = (await billing()).subscription.currentPeriodEnd;
    const failed = await checkout(); await webhook(providerPayment(failed.orderId, 'failed'), 'payment.failed');
    const cancelled = await checkout(); expect((await request('POST', `/api/billing/transactions/${cancelled.transactionId}/cancel`, ownerCookie, { outcome: 'CANCELLED' })).json().status).toBe('CANCELLED');
    await webhook({ ...paid, status: 'failed', captured: false }, 'payment.failed'); expect((await billing()).subscription.currentPeriodEnd).toBe(end); expect((await billing()).subscription.status).toBe('ACTIVE');
  });
  it('reconciles captured funds even after checkout dismissal', async () => {
    const result = await checkout(); await request('POST', `/api/billing/transactions/${result.transactionId}/cancel`, ownerCookie, { outcome: 'CANCELLED' });
    const paid = providerPayment(result.orderId); expect((await webhook(paid)).statusCode).toBe(200); expect((await billing()).subscription.status).toBe('ACTIVE');
  });
  it('handles payment failure without activation', async () => {
    const result = await checkout(); expect((await webhook(providerPayment(result.orderId, 'failed'), 'payment.failed')).statusCode).toBe(200); expect((await billing()).subscription.status).toBe('PAYMENT_FAILED');
  });
  it('reconciles pending payments server-side', async () => {
    const result = await checkout(); providerPayment(result.orderId); expect((await request('POST', `/api/billing/transactions/${result.transactionId}/reconcile`, ownerCookie, {})).json().status).toBe('SUCCESS');
  });
  it('validates raw webhook signatures, including whitespace', async () => {
    const result = await checkout(); const paid = providerPayment(result.orderId); expect((await webhook(paid, 'payment.captured', false)).statusCode).toBe(400); expect((await webhook(paid, 'payment.captured', true, true)).statusCode).toBe(200);
  });
  it('rejects unknown webhook orders and mismatched webhook amounts', async () => {
    expect((await webhook(providerPayment('order_unknown'))).statusCode).toBe(404);
    const result = await checkout(); expect((await webhook(providerPayment(result.orderId, 'captured', { amount: 1 }))).statusCode).toBe(400);
  });
  it('rejects cross-organization provider metadata', async () => {
    const result = await checkout(); orders.get(result.orderId)!.notes = { organizationId: 'foreign' }; expect((await verify(providerPayment(result.orderId))).statusCode).toBe(400);
  });
  it('clamps leap day when adding a calendar year', () => { expect(addCalendarYear(new Date('2028-02-29T12:34:56.789Z')).toISOString()).toBe('2029-02-28T12:34:56.789Z'); });
});
