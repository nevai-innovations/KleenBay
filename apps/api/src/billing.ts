import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { normalizeIndianMobile } from '@carwash/shared';
import type { Db } from './db.js';
import type { Config } from './config.js';
import { requireOwner } from './auth.js';
import { audit } from './audit.js';
import { HttpError, notFound } from './errors.js';
import { ANNUAL_PLAN, type PaymentProvider, type PayUCallback } from './payu.js';

const checkoutInput = z.object({ payerMobile: z.string().transform((value) => normalizeIndianMobile(value)) }).strict();
const transactionParams = z.object({ id: z.string().min(1) });

function addYear(from: Date): Date {
  const end = new Date(from);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  if (end.getUTCMonth() !== from.getUTCMonth()) end.setUTCDate(0);
  return end;
}

function paymentDto(payment: { id: string; merchantTransactionId: string; providerTransactionId: string | null; amountPaise: number; currency: string; status: string; initiatedAt: Date; completedAt: Date | null }) {
  return { id: payment.id, merchantTransactionId: payment.merchantTransactionId, providerTransactionId: payment.providerTransactionId, amountPaise: payment.amountPaise, currency: payment.currency, status: payment.status, initiatedAt: payment.initiatedAt, completedAt: payment.completedAt };
}

async function reconcile(db: Db, provider: PaymentProvider, payment: { id: string; organizationId: string; subscriptionId: string; merchantTransactionId: string; amountPaise: number; status: string }, actorUserId?: string, ipAddress?: string) {
  if (payment.status !== 'INITIATED') return;
  const result = await provider.verifyTransaction(payment.merchantTransactionId);
  if (!result || result.status === 'pending' || (result.status === 'success' && !result.providerTransactionId) || result.amountPaise !== payment.amountPaise || payment.amountPaise !== ANNUAL_PLAN.pricePaise) return;
  const at = new Date();
  await db.$transaction(async (tx) => {
    const updated = await tx.subscriptionPayment.updateMany({ where: { id: payment.id, organizationId: payment.organizationId, status: 'INITIATED' }, data: { status: result.status === 'success' ? 'SUCCESS' : 'FAILED', completedAt: at, providerTransactionId: result.providerTransactionId, providerStatus: result.providerStatus, failureReason: result.status === 'failed' ? 'Provider reported payment failure' : null } });
    if (updated.count !== 1) return;
    await audit(tx, { organizationId: payment.organizationId, actorUserId, action: result.status === 'success' ? 'SUBSCRIPTION_PAYMENT_SUCCEEDED' : 'SUBSCRIPTION_PAYMENT_FAILED', entityType: 'SubscriptionPayment', entityId: payment.id, after: { status: result.status, amountPaise: payment.amountPaise }, ipAddress });
    const subscription = await tx.subscription.findUniqueOrThrow({ where: { id: payment.subscriptionId, organizationId: payment.organizationId } });
    if (result.status === 'success') {
      const renewing = Boolean(subscription.currentPeriodEnd && subscription.currentPeriodEnd > at);
      const periodStart = renewing ? subscription.currentPeriodStart! : at;
      const periodEnd = addYear(renewing ? subscription.currentPeriodEnd! : at);
      await tx.subscription.update({ where: { id: subscription.id }, data: { status: 'ACTIVE', currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, activatedAt: subscription.activatedAt ?? at } });
      await audit(tx, { organizationId: payment.organizationId, actorUserId, action: renewing ? 'SUBSCRIPTION_RENEWED' : 'SUBSCRIPTION_ACTIVATED', entityType: 'Subscription', entityId: subscription.id, after: { currentPeriodStart: periodStart.toISOString(), currentPeriodEnd: periodEnd.toISOString() }, ipAddress });
    } else if (!subscription.currentPeriodEnd || subscription.currentPeriodEnd <= at) {
      await tx.subscription.update({ where: { id: subscription.id }, data: { status: 'PAYMENT_FAILED' } });
    }
  });
}

export function registerBillingRoutes(app: FastifyInstance, db: Db, config: Config, provider: PaymentProvider | null) {
  app.get('/api/billing', async (request) => {
    const owner = await requireOwner(db, request);
    const [subscription, payments] = await Promise.all([
      db.subscription.findUnique({ where: { organizationId: owner.organizationId } }),
      db.subscriptionPayment.findMany({ where: { organizationId: owner.organizationId }, orderBy: { initiatedAt: 'desc' }, take: 100 }),
    ]);
    const now = new Date();
    const status = subscription?.status === 'ACTIVE' && subscription.currentPeriodEnd && subscription.currentPeriodEnd <= now ? 'EXPIRED' : subscription?.status ?? 'INACTIVE';
    return { plan: ANNUAL_PLAN, checkoutAvailable: provider !== null, subscription: { status, currentPeriodStart: subscription?.currentPeriodStart ?? null, currentPeriodEnd: subscription?.currentPeriodEnd ?? null, daysRemaining: subscription?.currentPeriodEnd && status === 'ACTIVE' ? Math.ceil((subscription.currentPeriodEnd.getTime() - now.getTime()) / 86_400_000) : 0 }, payments: payments.map(paymentDto) };
  });

  app.get('/api/billing/payments', async (request) => {
    const owner = await requireOwner(db, request);
    const payments = await db.subscriptionPayment.findMany({ where: { organizationId: owner.organizationId }, orderBy: { initiatedAt: 'desc' }, take: 100 });
    return payments.map(paymentDto);
  });

  async function checkout(request: FastifyRequest) {
    const owner = await requireOwner(db, request);
    if (!provider) throw new HttpError(503, 'BILLING_UNAVAILABLE', 'Subscription checkout is not configured');
    if (!owner.email) throw new HttpError(400, 'OWNER_EMAIL_REQUIRED', 'Add an owner email before checkout');
    const { payerMobile } = checkoutInput.parse(request.body);
    const transactionId = `KB${randomBytes(10).toString('hex').toUpperCase()}`;
    const payment = await db.$transaction(async (tx) => {
      const subscription = await tx.subscription.upsert({ where: { organizationId: owner.organizationId }, create: { organizationId: owner.organizationId, status: 'PAYMENT_PENDING' }, update: {} });
      const pending = await tx.subscriptionPayment.create({ data: { organizationId: owner.organizationId, subscriptionId: subscription.id, merchantTransactionId: transactionId, amountPaise: ANNUAL_PLAN.pricePaise } });
      if (!subscription.currentPeriodEnd || subscription.currentPeriodEnd <= new Date()) await tx.subscription.update({ where: { id: subscription.id }, data: { status: 'PAYMENT_PENDING' } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'SUBSCRIPTION_CHECKOUT_INITIATED', entityType: 'SubscriptionPayment', entityId: pending.id, after: { amountPaise: pending.amountPaise, planCode: ANNUAL_PLAN.code }, ipAddress: request.ip });
      return pending;
    });
    const checkout = provider.createCheckout({ transactionId, organizationId: owner.organizationId, name: owner.name, email: owner.email, mobile: payerMobile, returnUrl: `${config.APP_ORIGIN}/api/billing/payu/return` });
    return { transactionId: payment.merchantTransactionId, action: checkout.action, fields: checkout.fields };
  }
  app.post('/api/billing/checkout', checkout);
  app.post('/api/billing/renew', checkout);

  app.get('/api/billing/transactions/:id', async (request) => {
    const owner = await requireOwner(db, request);
    const { id } = transactionParams.parse(request.params);
    const payment = await db.subscriptionPayment.findFirst({ where: { organizationId: owner.organizationId, id } });
    if (!payment) notFound();
    return paymentDto(payment);
  });

  app.post('/api/billing/transactions/:id/reconcile', async (request) => {
    const owner = await requireOwner(db, request);
    const { id } = transactionParams.parse(request.params);
    const payment = await db.subscriptionPayment.findFirst({ where: { organizationId: owner.organizationId, id } });
    if (!payment) notFound();
    if (!provider) throw new HttpError(503, 'BILLING_UNAVAILABLE', 'Subscription checkout is not configured');
    await reconcile(db, provider, payment, owner.id, request.ip);
    const current = await db.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } });
    return paymentDto(current);
  });

  app.post('/api/billing/payu/return', async (request, reply) => {
    if (!provider) throw new HttpError(503, 'BILLING_UNAVAILABLE', 'Subscription checkout is not configured');
    const callback = z.record(z.string(), z.string()).parse(request.body) as PayUCallback;
    const payment = callback.txnid ? await db.subscriptionPayment.findUnique({ where: { merchantTransactionId: callback.txnid } }) : null;
    if (!payment || !provider.verifyCallback(callback, { transactionId: payment.merchantTransactionId, organizationId: payment.organizationId, amountPaise: payment.amountPaise })) {
      throw new HttpError(400, 'INVALID_PAYU_RESPONSE', 'Invalid payment response');
    }
    await reconcile(db, provider, payment, undefined, request.ip);
    return reply.code(303).header('location', '/billing').send();
  });
}
