import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { assertLocalTestDatabase } from '../src/database-target.js';
import { ANNUAL_PLAN, type PaymentProvider, type PayUCallback, type PayUResult } from '../src/payu.js';

const db = createDb(assertLocalTestDatabase(process.env.TEST_DATABASE_URL));
const config = { ...getConfig(), NODE_ENV: 'test' as const, LOG_LEVEL: 'silent', payuConfigured: false };
const results = new Map<string, PayUResult>();
let validCallback = true;
const provider: PaymentProvider = {
  createCheckout: ({ transactionId, organizationId }) => ({ action: 'https://test.payu.in/_payment', fields: { txnid: transactionId, udf1: organizationId, amount: '7200.00' } }),
  verifyCallback: (callback: PayUCallback, expected) => validCallback && callback.txnid === expected.transactionId && callback.udf1 === expected.organizationId && expected.amountPaise === ANNUAL_PLAN.pricePaise,
  verifyTransaction: async (transactionId) => results.get(transactionId) ?? null,
};
let app: Awaited<ReturnType<typeof buildApp>>;
let organizationId: string;
let ownerCookie: string;
let employeeCookie: string;
let foreignCookie: string;

async function makeSession(user: { id: string; organizationId: string }) {
  const token = randomBytes(32).toString('base64url');
  await db.session.create({ data: { userId: user.id, organizationId: user.organizationId, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 3600_000) } });
  return `kleenbay_session=${token}`;
}
function request(method: 'GET' | 'POST', url: string, cookie?: string, payload?: object) {
  return app.inject({ method, url, headers: { origin: config.APP_ORIGIN, ...(cookie ? { cookie } : {}) }, ...(payload ? { payload } : {}) });
}
async function startCheckout(cookie = ownerCookie, payload: object = { payerMobile: '9876543210' }) {
  return request('POST', '/api/billing/checkout', cookie, payload);
}

beforeAll(async () => {
  const org = await db.organization.create({ data: { slug: `billing-${randomUUID()}`, name: 'Billing Test' } });
  organizationId = org.id;
  const owner = await db.user.create({ data: { organizationId, role: 'OWNER', name: 'Owner', email: `owner-${randomUUID()}@example.test` } });
  const employee = await db.user.create({ data: { organizationId, role: 'EMPLOYEE', name: 'Employee', employee: { create: { mobile: `+91${String(Math.floor(9000000000 + Math.random() * 999999999))}` } } } });
  const foreign = await db.organization.create({ data: { slug: `billing-foreign-${randomUUID()}`, name: 'Other Business' } });
  const foreignOwner = await db.user.create({ data: { organizationId: foreign.id, role: 'OWNER', name: 'Other Owner', email: `foreign-${randomUUID()}@example.test` } });
  ownerCookie = await makeSession(owner);
  employeeCookie = await makeSession(employee);
  foreignCookie = await makeSession(foreignOwner);
  app = await buildApp(config, db, undefined, undefined, undefined, provider);
  await app.ready();
});
afterAll(async () => { if (app) await app.close(); await db.$disconnect(); });

describe('owner-only billing', () => {
  it('returns authoritative empty state for owner and rejects employees on every billing API', async () => {
    const response = await request('GET', '/api/billing', ownerCookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().plan).toEqual(ANNUAL_PLAN);
    expect(response.json().subscription.status).toBe('INACTIVE');
    expect(response.json().payments).toEqual([]);
    for (const [method, url] of [
      ['GET', '/api/billing'], ['GET', '/api/billing/payments'], ['POST', '/api/billing/checkout'],
      ['POST', '/api/billing/renew'], ['GET', '/api/billing/transactions/unknown'], ['POST', '/api/billing/transactions/unknown/reconcile'],
    ] as const) expect((await request(method, url, employeeCookie, method === 'POST' ? { payerMobile: '9876543210' } : undefined)).statusCode).toBe(403);
    expect((await request('GET', '/api/billing')).statusCode).toBe(401);
  });

  it('charges the server plan and cannot be pointed at another organization', async () => {
    expect((await startCheckout(ownerCookie, { payerMobile: '9876543210', amount: 1, organizationId: 'foreign' })).statusCode).toBe(400);
    expect((await startCheckout(ownerCookie, { payerMobile: 'invalid' })).statusCode).toBe(400);
    const response = await startCheckout();
    expect(response.statusCode).toBe(200);
    expect(response.json().fields.amount).toBe('7200.00');
    expect(response.json().fields.udf1).toBe(organizationId);
    const payment = await db.subscriptionPayment.findUniqueOrThrow({ where: { merchantTransactionId: response.json().transactionId } });
    expect(payment.amountPaise).toBe(720000);
    expect(payment.organizationId).toBe(organizationId);
    expect((await request('GET', `/api/billing/transactions/${payment.id}`, foreignCookie)).statusCode).toBe(404);
    expect((await request('POST', `/api/billing/transactions/${payment.id}/reconcile`, foreignCookie, {})).statusCode).toBe(404);
    expect((await request('GET', '/api/billing', foreignCookie)).json().payments).toEqual([]);
  });

  it('rejects invalid callback and mismatched verified amount', async () => {
    const checkout = await startCheckout();
    const transactionId = checkout.json().transactionId as string;
    const callback = { txnid: transactionId, udf1: organizationId };
    validCallback = false;
    expect((await request('POST', '/api/billing/payu/return', undefined, callback)).statusCode).toBe(400);
    validCallback = true;
    results.set(transactionId, { status: 'success', amountPaise: 100, providerStatus: 'success' });
    expect((await app.inject({ method: 'POST', url: '/api/billing/payu/return', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(callback).toString() })).statusCode).toBe(303);
    expect((await db.subscriptionPayment.findUniqueOrThrow({ where: { merchantTransactionId: transactionId } })).status).toBe('INITIATED');
  });

  it('activates once, extends early renewals once, and preserves active access after a failed renewal', async () => {
    const first = await startCheckout();
    const firstId = first.json().transactionId as string;
    results.set(firstId, { status: 'success', amountPaise: 720000, providerStatus: 'success', providerTransactionId: `payu-first-${firstId}` });
    const callback = { txnid: firstId, udf1: organizationId };
    const simultaneous = await Promise.all([
      request('POST', '/api/billing/payu/return', undefined, callback),
      request('POST', '/api/billing/payu/return', undefined, callback),
    ]);
    expect(simultaneous.map((response) => response.statusCode)).toEqual([303, 303]);
    const active = (await request('GET', '/api/billing', ownerCookie)).json();
    expect(active.subscription.status).toBe('ACTIVE');
    expect(active.payments.find((item: { merchantTransactionId: string }) => item.merchantTransactionId === firstId).status).toBe('SUCCESS');
    const firstEnd = new Date(active.subscription.currentPeriodEnd);
    expect(firstEnd.getUTCFullYear()).toBe(new Date().getUTCFullYear() + 1);
    await request('POST', '/api/billing/payu/return', undefined, callback);
    expect(new Date((await request('GET', '/api/billing', ownerCookie)).json().subscription.currentPeriodEnd).getTime()).toBe(firstEnd.getTime());

    const failed = await startCheckout();
    const failedId = failed.json().transactionId as string;
    results.set(failedId, { status: 'failed', amountPaise: 720000, providerStatus: 'failure' });
    await request('POST', '/api/billing/payu/return', undefined, { txnid: failedId, udf1: organizationId });
    expect((await request('GET', '/api/billing', ownerCookie)).json().subscription.status).toBe('ACTIVE');
    expect(new Date((await request('GET', '/api/billing', ownerCookie)).json().subscription.currentPeriodEnd).getTime()).toBe(firstEnd.getTime());

    const renewed = await startCheckout();
    const renewedId = renewed.json().transactionId as string;
    results.set(renewedId, { status: 'success', amountPaise: 720000, providerStatus: 'success', providerTransactionId: `payu-renewed-${renewedId}` });
    const renewCallback = { txnid: renewedId, udf1: organizationId };
    await request('POST', '/api/billing/payu/return', undefined, renewCallback);
    const secondEnd = new Date((await request('GET', '/api/billing', ownerCookie)).json().subscription.currentPeriodEnd);
    expect(secondEnd.getUTCFullYear()).toBe(firstEnd.getUTCFullYear() + 1);
    await request('POST', '/api/billing/payu/return', undefined, renewCallback);
    expect(new Date((await request('GET', '/api/billing', ownerCookie)).json().subscription.currentPeriodEnd).getTime()).toBe(secondEnd.getTime());
    expect((await db.auditLog.count({ where: { organizationId, action: 'SUBSCRIPTION_RENEWED' } }))).toBe(1);

    await db.subscription.update({ where: { organizationId }, data: { currentPeriodStart: new Date(Date.now() - 730 * 86_400_000), currentPeriodEnd: new Date(Date.now() - 86_400_000) } });
    expect((await request('GET', '/api/billing', ownerCookie)).json().subscription.status).toBe('EXPIRED');
    const expiredFailure = await startCheckout();
    const expiredFailureId = expiredFailure.json().transactionId as string;
    results.set(expiredFailureId, { status: 'failed', amountPaise: 720000, providerStatus: 'failure' });
    await request('POST', '/api/billing/payu/return', undefined, { txnid: expiredFailureId, udf1: organizationId });
    expect((await request('GET', '/api/billing', ownerCookie)).json().subscription.status).toBe('PAYMENT_FAILED');
    const expiredRenewal = await startCheckout();
    const expiredRenewalId = expiredRenewal.json().transactionId as string;
    results.set(expiredRenewalId, { status: 'success', amountPaise: 720000, providerStatus: 'success', providerTransactionId: `payu-expired-${expiredRenewalId}` });
    await request('POST', '/api/billing/payu/return', undefined, { txnid: expiredRenewalId, udf1: organizationId });
    const reset = (await request('GET', '/api/billing', ownerCookie)).json().subscription;
    expect(reset.status).toBe('ACTIVE');
    expect(new Date(reset.currentPeriodStart).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(new Date(reset.currentPeriodEnd).getUTCFullYear()).toBe(new Date().getUTCFullYear() + 1);
  });
});
