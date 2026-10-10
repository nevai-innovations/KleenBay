import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { HttpError } from './errors.js';

export const ANNUAL_PLAN = { code: 'KLEENBAY_ANNUAL', name: 'KleenBay Annual', price: 7200, pricePaise: 720000, currency: 'INR', billingInterval: 'YEAR' } as const;
export const orderSchema = z.object({ id: z.string().regex(/^order_[A-Za-z0-9]+$/), amount: z.number().int(), currency: z.string(), receipt: z.string(), status: z.string(), notes: z.union([z.record(z.string(), z.string()), z.array(z.unknown())]).optional() });
export const paymentSchema = z.object({ id: z.string().regex(/^pay_[A-Za-z0-9]+$/), order_id: z.string(), amount: z.number().int(), currency: z.string(), status: z.string(), captured: z.boolean(), created_at: z.number().int().positive() });
export type RazorpayOrder = z.infer<typeof orderSchema>;
export type RazorpayPayment = z.infer<typeof paymentSchema>;
export interface PaymentProvider {
  readonly keyId: string;
  createOrder(input: { receipt: string; organizationId: string; paymentId: string }): Promise<RazorpayOrder>;
  fetchOrder(id: string): Promise<RazorpayOrder>;
  fetchPayment(id: string): Promise<RazorpayPayment>;
  fetchOrderPayments(id: string): Promise<RazorpayPayment[]>;
  verifySignature(orderId: string, paymentId: string, signature: string): boolean;
  verifyWebhook(body: Buffer, signature: string): boolean;
}

export function validHmac(body: string | Buffer, signature: string, secret: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(Buffer.from(signature, 'hex'), expected);
}

export class RazorpayPaymentProvider implements PaymentProvider {
  constructor(readonly keyId: string, private readonly keySecret: string, private readonly webhookSecret?: string, private readonly fetcher: typeof fetch = fetch) {}

  private async request(path: string, body?: object): Promise<unknown> {
    try {
      const response = await this.fetcher(`https://api.razorpay.com/v1${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Provider unavailable');
      return await response.json();
    } catch { throw new HttpError(502, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Razorpay is unavailable. Please try again shortly.'); }
  }

  async createOrder(input: { receipt: string; organizationId: string; paymentId: string }) {
    return orderSchema.parse(await this.request('/orders', { amount: ANNUAL_PLAN.pricePaise, currency: ANNUAL_PLAN.currency, receipt: input.receipt, partial_payment: false, notes: { organizationId: input.organizationId, paymentReference: input.paymentId, planCode: ANNUAL_PLAN.code } }));
  }
  async fetchOrder(id: string) { return orderSchema.parse(await this.request(`/orders/${encodeURIComponent(id)}`)); }
  async fetchPayment(id: string) { return paymentSchema.parse(await this.request(`/payments/${encodeURIComponent(id)}`)); }
  async fetchOrderPayments(id: string) { return z.object({ items: z.array(paymentSchema) }).parse(await this.request(`/orders/${encodeURIComponent(id)}/payments`)).items; }
  verifySignature(orderId: string, paymentId: string, signature: string) { return validHmac(`${orderId}|${paymentId}`, signature, this.keySecret); }
  verifyWebhook(body: Buffer, signature: string) { return Boolean(this.webhookSecret && validHmac(body, signature, this.webhookSecret)); }
}

export function createPaymentProvider(config: Config): PaymentProvider | null {
  return config.razorpayConfigured ? new RazorpayPaymentProvider(config.RAZORPAY_KEY_ID!, config.RAZORPAY_KEY_SECRET!, config.RAZORPAY_WEBHOOK_SECRET) : null;
}
