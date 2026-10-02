import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';

export const ANNUAL_PLAN = { code: 'KLEENBAY_ANNUAL', name: 'KleenBay Annual', pricePaise: 720000, currency: 'INR', billingInterval: 'YEAR' } as const;
const PRODUCT_INFO = 'KleenBay Annual';
const money = /^\d+(?:\.\d{1,2})?$/;

export function rupeesToPaise(value: string): number | null {
  if (!money.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : null;
}

export type PayUCheckout = { action: string; fields: Record<string, string> };
export type PayUResult = { status: 'success' | 'failed' | 'pending'; amountPaise: number; providerTransactionId?: string; providerStatus: string };
export type PayUCallback = Record<string, string>;

export interface PaymentProvider {
  createCheckout(input: { transactionId: string; organizationId: string; name: string; email: string; mobile: string; returnUrl: string }): PayUCheckout;
  verifyCallback(callback: PayUCallback, expected: { transactionId: string; organizationId: string; amountPaise: number }): boolean;
  verifyTransaction(transactionId: string): Promise<PayUResult | null>;
}

function sha512(value: string) { return createHash('sha512').update(value).digest('hex'); }
function hashMatches(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{128}$/i.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'));
}

export class PayUPaymentProvider implements PaymentProvider {
  constructor(private readonly key: string, private readonly salt: string, private readonly baseUrl: string) {}

  createCheckout(input: { transactionId: string; organizationId: string; name: string; email: string; mobile: string; returnUrl: string }): PayUCheckout {
    const fields = {
      key: this.key, txnid: input.transactionId, amount: (ANNUAL_PLAN.pricePaise / 100).toFixed(2), productinfo: PRODUCT_INFO,
      firstname: input.name, email: input.email, phone: input.mobile.replace(/^\+91/, ''),
      surl: input.returnUrl, furl: input.returnUrl, udf1: input.organizationId,
    };
    const hash = sha512([fields.key, fields.txnid, fields.amount, fields.productinfo, fields.firstname, fields.email, fields.udf1, '', '', '', '', ...Array(5).fill(''), this.salt].join('|'));
    return { action: `${this.baseUrl}/_payment`, fields: { ...fields, hash } };
  }

  verifyCallback(callback: PayUCallback, expected: { transactionId: string; organizationId: string; amountPaise: number }): boolean {
    if (callback.key !== this.key || callback.txnid !== expected.transactionId || callback.udf1 !== expected.organizationId ||
      rupeesToPaise(callback.amount ?? '') !== expected.amountPaise || callback.productinfo !== PRODUCT_INFO) return false;
    const extra = callback.additionalCharges ?? callback.additional_charges;
    const parts = [this.salt, callback.status ?? '', ...Array(5).fill(''), callback.udf5 ?? '', callback.udf4 ?? '', callback.udf3 ?? '', callback.udf2 ?? '', callback.udf1 ?? '', callback.email ?? '', callback.firstname ?? '', callback.productinfo, callback.amount, callback.txnid, callback.key];
    if (extra) parts.unshift(extra);
    return hashMatches(callback.hash ?? '', sha512(parts.join('|')));
  }

  async verifyTransaction(transactionId: string): Promise<PayUResult | null> {
    const command = 'verify_payment';
    const body = new URLSearchParams({ key: this.key, command, var1: transactionId, hash: sha512(`${this.key}|${command}|${transactionId}|${this.salt}`) });
    const verifyUrl = this.baseUrl === 'https://secure.payu.in' ? 'https://info.payu.in/merchant/postservice.php?form=2' : `${this.baseUrl}/merchant/postservice?form=2`;
    const response = await fetch(verifyUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('PayU verification unavailable');
    const parsed = z.object({ transaction_details: z.record(z.string(), z.object({ txnid: z.string().optional(), status: z.string(), unmappedstatus: z.string().optional(), transaction_amount: z.string().optional(), amt: z.string().optional(), mihpayid: z.union([z.string(), z.number()]).optional() }).passthrough()).optional() }).passthrough().parse(await response.json());
    const transaction = parsed.transaction_details?.[transactionId];
    if (!transaction || transaction.txnid !== transactionId) return null;
    const amountPaise = rupeesToPaise(transaction.transaction_amount ?? transaction.amt ?? '');
    if (amountPaise === null) return null;
    const status = transaction.status.toLowerCase();
    if (status === 'success' && !transaction.mihpayid) return null;
    return {
      status: status === 'success' && (!transaction.unmappedstatus || transaction.unmappedstatus.toLowerCase() === 'captured') ? 'success' : status === 'failure' || status === 'failed' ? 'failed' : 'pending',
      amountPaise, providerTransactionId: transaction.mihpayid === undefined ? undefined : String(transaction.mihpayid), providerStatus: status,
    };
  }
}

export function createPaymentProvider(config: Config): PaymentProvider | null {
  if (!config.payuConfigured) return null;
  return new PayUPaymentProvider(config.PAYU_MERCHANT_KEY!, config.PAYU_MERCHANT_SALT!, config.PAYU_BASE_URL!.replace(/\/$/, ''));
}
