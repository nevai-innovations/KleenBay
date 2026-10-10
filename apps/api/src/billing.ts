import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';
import type { Config } from './config.js';
import type { Subscription, SubscriptionPayment } from './generated/prisma/client.js';
import { requireOwner } from './auth.js';
import { audit } from './audit.js';
import { HttpError, notFound } from './errors.js';
import { ANNUAL_PLAN, paymentSchema, type PaymentProvider, type RazorpayOrder, type RazorpayPayment } from './razorpay.js';

const checkoutInput = z.object({ idempotencyKey: z.uuid() }).strict();
const transactionParams = z.object({ id: z.string().min(1).max(120) });
const verificationInput = z.object({ razorpay_order_id: z.string().regex(/^order_[A-Za-z0-9]+$/), razorpay_payment_id: z.string().regex(/^pay_[A-Za-z0-9]+$/), razorpay_signature: z.string().regex(/^[a-fA-F0-9]{64}$/) }).strict();

export function addCalendarYear(from: Date): Date {
  const end = new Date(from);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  if (end.getUTCMonth() !== from.getUTCMonth()) end.setUTCDate(0);
  return end;
}

function subscriptionState(subscription: Subscription | null, at = new Date()) {
  if (subscription?.currentPeriodEnd) return subscription.currentPeriodEnd > at ? 'ACTIVE' : 'EXPIRED';
  return subscription?.status ?? 'INACTIVE';
}

export async function requireActiveSubscription(db: Db, organizationId: string) {
  const subscription = await db.subscription.findUnique({ where: { organizationId } });
  if (subscriptionState(subscription) !== 'ACTIVE') throw new HttpError(402, 'SUBSCRIPTION_REQUIRED', 'An active subscription is required');
  return subscription!;
}

function paymentDto(payment: SubscriptionPayment) {
  return { id: payment.id, provider: payment.provider, merchantTransactionId: payment.merchantTransactionId, providerTransactionId: payment.providerTransactionId, razorpayOrderId: payment.razorpayOrderId, razorpayPaymentId: payment.razorpayPaymentId, amountPaise: payment.amountPaise, currency: payment.currency, status: payment.status, initiatedAt: payment.initiatedAt, completedAt: payment.completedAt, failedAt: payment.failedAt, failureReason: payment.failureReason };
}

function assertOrder(order: RazorpayOrder, local: SubscriptionPayment) {
  const notes = order.notes;
  if (order.id !== local.razorpayOrderId || order.amount !== ANNUAL_PLAN.pricePaise || order.currency !== 'INR' || order.receipt !== local.merchantTransactionId || local.amountPaise !== ANNUAL_PLAN.pricePaise || local.currency !== 'INR' || local.provider !== 'RAZORPAY' || (notes && !Array.isArray(notes) && notes.organizationId !== local.organizationId)) throw new HttpError(400, 'PAYMENT_MISMATCH', 'Payment does not match this subscription order');
}

async function settle(db: Db, local: SubscriptionPayment, result: RazorpayPayment, actorUserId?: string, ipAddress?: string) {
  if (result.order_id !== local.razorpayOrderId || result.amount !== ANNUAL_PLAN.pricePaise || result.currency !== 'INR' || local.amountPaise !== ANNUAL_PLAN.pricePaise) throw new HttpError(400, 'PAYMENT_MISMATCH', 'Payment does not match this subscription order');
  if (result.status !== 'captured' && result.status !== 'failed') return paymentDto(local);
  if (result.status === 'captured' && !result.captured) throw new HttpError(400, 'PAYMENT_NOT_CAPTURED', 'Payment has not been captured');
  return db.$transaction(async (tx) => {
    // Serialize every payment for this organization, including distinct early renewals.
    await tx.$queryRaw`SELECT "id" FROM "Subscription" WHERE "organizationId" = ${local.organizationId} FOR UPDATE`;
    const current = await tx.subscriptionPayment.findUniqueOrThrow({ where: { id: local.id, organizationId: local.organizationId } });
    if (current.status === 'SUCCESS') return paymentDto(current);
    const at = new Date();
    if (result.status === 'failed') {
      if (current.status === 'FAILED' || current.status === 'CANCELLED') return paymentDto(current);
      const failed = await tx.subscriptionPayment.update({ where: { id: current.id }, data: { status: 'FAILED', failedAt: at, providerStatus: 'failed', failureReason: 'Razorpay reported payment failure' } });
      const subscription = await tx.subscription.findUniqueOrThrow({ where: { organizationId: current.organizationId } });
      if (!subscription.currentPeriodEnd) await tx.subscription.update({ where: { id: subscription.id }, data: { status: 'PAYMENT_FAILED' } });
      await audit(tx, { organizationId: current.organizationId, actorUserId, action: 'SUBSCRIPTION_PAYMENT_FAILED', entityType: 'SubscriptionPayment', entityId: current.id, ipAddress });
      return paymentDto(failed);
    }
    const updated = await tx.subscriptionPayment.update({ where: { id: current.id }, data: { status: 'SUCCESS', completedAt: at, failedAt: null, failureReason: null, razorpayPaymentId: result.id, providerTransactionId: result.id, providerStatus: 'captured' } });
    const subscription = await tx.subscription.findUniqueOrThrow({ where: { organizationId: current.organizationId } });
    const renewing = Boolean(subscription.currentPeriodEnd && subscription.currentPeriodEnd > at);
    const periodStart = renewing ? subscription.currentPeriodStart! : at;
    const periodEnd = addCalendarYear(renewing ? subscription.currentPeriodEnd! : at);
    await tx.subscription.update({ where: { id: subscription.id }, data: { status: 'ACTIVE', currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, activatedAt: subscription.activatedAt ?? at, cancelledAt: null } });
    await audit(tx, { organizationId: current.organizationId, actorUserId, action: 'SUBSCRIPTION_PAYMENT_VERIFIED', entityType: 'SubscriptionPayment', entityId: current.id, after: { amountPaise: current.amountPaise, provider: 'RAZORPAY' }, ipAddress });
    await audit(tx, { organizationId: current.organizationId, actorUserId, action: renewing ? 'SUBSCRIPTION_RENEWED' : 'SUBSCRIPTION_ACTIVATED', entityType: 'Subscription', entityId: subscription.id, after: { currentPeriodStart: periodStart.toISOString(), currentPeriodEnd: periodEnd.toISOString() }, ipAddress });
    return paymentDto(updated);
  });
}

async function reconcile(db: Db, provider: PaymentProvider, local: SubscriptionPayment, actorUserId?: string, ipAddress?: string) {
  if (local.status === 'SUCCESS' || !local.razorpayOrderId || local.provider !== 'RAZORPAY') return paymentDto(local);
  assertOrder(await provider.fetchOrder(local.razorpayOrderId), local);
  const payments = await provider.fetchOrderPayments(local.razorpayOrderId);
  const result = payments.find((payment) => payment.status === 'captured') ?? payments.find((payment) => payment.status === 'failed');
  return result ? settle(db, local, result, actorUserId, ipAddress) : paymentDto(local);
}

export function registerBillingRoutes(app: FastifyInstance, db: Db, config: Config, provider: PaymentProvider | null) {
  function configured(): PaymentProvider {
    if (!provider) throw new HttpError(503, 'BILLING_UNAVAILABLE', 'Razorpay subscription checkout is not configured');
    return provider;
  }
  app.get('/api/billing', async (request) => {
    const owner = await requireOwner(db, request);
    const [subscription, payments] = await Promise.all([db.subscription.findUnique({ where: { organizationId: owner.organizationId } }), db.subscriptionPayment.findMany({ where: { organizationId: owner.organizationId }, orderBy: { initiatedAt: 'desc' }, take: 100 })]);
    const now = new Date();
    const status = subscriptionState(subscription, now);
    return { plan: ANNUAL_PLAN, checkoutAvailable: provider !== null, environment: config.RAZORPAY_ENV, subscription: { status, currentPeriodStart: subscription?.currentPeriodStart ?? null, currentPeriodEnd: subscription?.currentPeriodEnd ?? null, daysRemaining: subscription?.currentPeriodEnd && status === 'ACTIVE' ? Math.ceil((subscription.currentPeriodEnd.getTime() - now.getTime()) / 86400000) : 0 }, payments: payments.map(paymentDto) };
  });
  app.get('/api/billing/payments', async (request) => {
    const owner = await requireOwner(db, request);
    return (await db.subscriptionPayment.findMany({ where: { organizationId: owner.organizationId }, orderBy: { initiatedAt: 'desc' }, take: 100 })).map(paymentDto);
  });

  async function checkout(request: FastifyRequest) {
    const owner = await requireOwner(db, request);
    const gateway = configured();
    const input = checkoutInput.parse(request.body);
    const { payment, created } = await db.$transaction(async (tx) => {
      await tx.subscription.upsert({ where: { organizationId: owner.organizationId }, create: { organizationId: owner.organizationId }, update: {} });
      await tx.$queryRaw`SELECT "id" FROM "Subscription" WHERE "organizationId" = ${owner.organizationId} FOR UPDATE`;
      const existing = await tx.subscriptionPayment.findUnique({ where: { organizationId_checkoutKey: { organizationId: owner.organizationId, checkoutKey: input.idempotencyKey } } });
      if (existing) return { payment: existing, created: false };
      const subscription = await tx.subscription.findUniqueOrThrow({ where: { organizationId: owner.organizationId } });
      const pending = await tx.subscriptionPayment.create({ data: { organizationId: owner.organizationId, subscriptionId: subscription.id, checkoutKey: input.idempotencyKey, merchantTransactionId: `KB${randomBytes(12).toString('hex')}`, provider: 'RAZORPAY', amountPaise: ANNUAL_PLAN.pricePaise } });
      if (!subscription.currentPeriodEnd) await tx.subscription.update({ where: { id: subscription.id }, data: { status: 'PAYMENT_PENDING' } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'SUBSCRIPTION_CHECKOUT_INITIATED', entityType: 'SubscriptionPayment', entityId: pending.id, after: { amountPaise: pending.amountPaise, planCode: ANNUAL_PLAN.code }, ipAddress: request.ip });
      return { payment: pending, created: true };
    });
    let current = payment;
    if (created) {
      try {
        const order = await gateway.createOrder({ receipt: payment.merchantTransactionId, organizationId: owner.organizationId, paymentId: payment.id });
        assertOrder(order, { ...payment, razorpayOrderId: order.id });
        current = await db.$transaction(async (tx) => {
          const updated = await tx.subscriptionPayment.update({ where: { id: payment.id }, data: { razorpayOrderId: order.id } });
          await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'RAZORPAY_ORDER_CREATED', entityType: 'SubscriptionPayment', entityId: payment.id, after: { razorpayOrderId: order.id }, ipAddress: request.ip });
          return updated;
        });
      } catch {
        await db.$transaction(async (tx) => {
          await tx.subscriptionPayment.update({ where: { id: payment.id }, data: { status: 'FAILED', failedAt: new Date(), failureReason: 'Order creation could not be confirmed. Start a new checkout.' } });
          await tx.subscription.updateMany({ where: { id: payment.subscriptionId, currentPeriodEnd: null }, data: { status: 'PAYMENT_FAILED' } });
          await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'SUBSCRIPTION_PAYMENT_FAILED', entityType: 'SubscriptionPayment', entityId: payment.id, ipAddress: request.ip });
        });
        throw new HttpError(502, 'ORDER_CREATION_FAILED', 'Could not confirm a Razorpay order. Please start a new checkout.');
      }
    }
    if (current.status !== 'INITIATED' || !current.razorpayOrderId) throw new HttpError(409, 'CHECKOUT_ALREADY_STARTED', 'Checkout is processing or complete. Check payment history before trying again.');
    const organization = await db.organization.findUniqueOrThrow({ where: { id: owner.organizationId } });
    return { transactionId: current.id, keyId: gateway.keyId, orderId: current.razorpayOrderId, amountPaise: ANNUAL_PLAN.pricePaise, currency: ANNUAL_PLAN.currency, name: organization.name, prefill: { name: owner.name, ...(owner.email ? { email: owner.email } : {}) } };
  }
  app.post('/api/billing/checkout', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, checkout);
  app.post('/api/billing/renew', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, checkout);
  app.get('/api/billing/transactions/:id', async (request) => {
    const owner = await requireOwner(db, request);
    const { id } = transactionParams.parse(request.params);
    const payment = await db.subscriptionPayment.findFirst({ where: { id, organizationId: owner.organizationId } });
    if (!payment) notFound();
    return paymentDto(payment);
  });
  app.post('/api/billing/transactions/:id/reconcile', async (request) => {
    const owner = await requireOwner(db, request);
    const { id } = transactionParams.parse(request.params);
    const payment = await db.subscriptionPayment.findFirst({ where: { id, organizationId: owner.organizationId } });
    if (!payment) notFound();
    return reconcile(db, configured(), payment, owner.id, request.ip);
  });
  app.post('/api/billing/transactions/:id/cancel', async (request) => {
    const owner = await requireOwner(db, request);
    const { id } = transactionParams.parse(request.params);
    const { outcome } = z.object({ outcome: z.enum(['CANCELLED', 'FAILED']) }).strict().parse(request.body);
    const payment = await db.subscriptionPayment.findFirst({ where: { id, organizationId: owner.organizationId, provider: 'RAZORPAY' } });
    if (!payment) notFound();
    await reconcile(db, configured(), payment, owner.id, request.ip);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Subscription" WHERE "organizationId" = ${owner.organizationId} FOR UPDATE`;
      const current = await tx.subscriptionPayment.findUniqueOrThrow({ where: { id } });
      if (current.status !== 'INITIATED') return paymentDto(current);
      const cancelled = await tx.subscriptionPayment.update({ where: { id }, data: { status: outcome, failedAt: new Date(), failureReason: outcome === 'FAILED' ? 'Checkout reported a failed attempt' : 'Checkout dismissed' } });
      await tx.subscription.updateMany({ where: { id: payment.subscriptionId, currentPeriodEnd: null }, data: { status: outcome === 'FAILED' ? 'PAYMENT_FAILED' : 'INACTIVE' } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: outcome === 'FAILED' ? 'SUBSCRIPTION_PAYMENT_FAILED' : 'SUBSCRIPTION_PAYMENT_CANCELLED', entityType: 'SubscriptionPayment', entityId: id, ipAddress: request.ip });
      return paymentDto(cancelled);
    });
  });

  app.post('/api/billing/razorpay/verify', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const owner = await requireOwner(db, request);
    const input = verificationInput.parse(request.body);
    const gateway = configured();
    const local = await db.subscriptionPayment.findFirst({ where: { organizationId: owner.organizationId, razorpayOrderId: input.razorpay_order_id, provider: 'RAZORPAY' } });
    if (!local) notFound();
    if (!gateway.verifySignature(local.razorpayOrderId!, input.razorpay_payment_id, input.razorpay_signature)) {
      await audit(db, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'SUBSCRIPTION_VERIFICATION_REJECTED', entityType: 'SubscriptionPayment', entityId: local.id, ipAddress: request.ip });
      throw new HttpError(400, 'INVALID_PAYMENT_SIGNATURE', 'Payment signature verification failed');
    }
    assertOrder(await gateway.fetchOrder(local.razorpayOrderId!), local);
    const payment = await gateway.fetchPayment(input.razorpay_payment_id);
    if (payment.id !== input.razorpay_payment_id) throw new HttpError(400, 'PAYMENT_MISMATCH', 'Payment reference does not match');
    return settle(db, local, payment, owner.id, request.ip);
  });

  // Authenticate provider callbacks using the exact raw body, independently of owner sessions.
  app.register(async (webhooks) => {
    webhooks.removeContentTypeParser('application/json');
    webhooks.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 256 * 1024 }, (_request, body, done) => done(null, body));
    webhooks.post('/api/billing/razorpay/webhook', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) => {
      const gateway = configured();
      const raw = request.body as Buffer;
      const signature = request.headers['x-razorpay-signature'];
      if (!Buffer.isBuffer(raw) || typeof signature !== 'string' || !gateway.verifyWebhook(raw, signature)) throw new HttpError(400, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid webhook signature');
      let body: unknown;
      try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'INVALID_WEBHOOK', 'Invalid webhook'); }
      const event = z.object({ event: z.string(), payload: z.object({ payment: z.object({ entity: paymentSchema }).optional() }) }).parse(body);
      if (!['payment.captured', 'payment.failed', 'order.paid'].includes(event.event)) return { received: true };
      const payment = event.payload.payment?.entity;
      if (!payment) throw new HttpError(400, 'INVALID_WEBHOOK', 'Payment entity is required');
      const local = await db.subscriptionPayment.findUnique({ where: { razorpayOrderId: payment.order_id } });
      if (!local || local.provider !== 'RAZORPAY') notFound();
      if (payment.amount !== local.amountPaise || payment.currency !== local.currency) throw new HttpError(400, 'PAYMENT_MISMATCH', 'Webhook does not match this order');
      assertOrder(await gateway.fetchOrder(local.razorpayOrderId!), local);
      const confirmed = await gateway.fetchPayment(payment.id);
      if (confirmed.id !== payment.id) throw new HttpError(400, 'PAYMENT_MISMATCH', 'Payment reference does not match');
      await settle(db, local, confirmed);
      return { received: true };
    });
  });
}
