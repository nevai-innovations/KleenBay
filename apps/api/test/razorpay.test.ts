import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RazorpayPaymentProvider, validHmac } from '../src/razorpay.js';

describe('Razorpay REST provider', () => {
  it('creates a server-controlled INR 720000-paise order with unique receipt and safe notes', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'order_test', amount: 720000, currency: 'INR', receipt: 'KB123', status: 'created' }));
    const provider = new RazorpayPaymentProvider('rzp_test_local', 'private-key', 'private-webhook-secret', fetcher);
    await provider.createOrder({ receipt: 'KB123', organizationId: 'org1', paymentId: 'local1' });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.razorpay.com/v1/orders');
    expect(JSON.parse(String(init.body))).toEqual({ amount: 720000, currency: 'INR', receipt: 'KB123', partial_payment: false, notes: { organizationId: 'org1', paymentReference: 'local1', planCode: 'KLEENBAY_ANNUAL' } });
    expect(String(init.body)).not.toContain('private-key');
  });
  it('uses SHA-256 HMAC and rejects malformed or changed signatures', () => {
    const provider = new RazorpayPaymentProvider('rzp_test_local', 'private-key');
    const sig = createHmac('sha256', 'private-key').update('order_1|pay_1').digest('hex');
    expect(provider.verifySignature('order_1', 'pay_1', sig)).toBe(true);
    expect(provider.verifySignature('order_2', 'pay_1', sig)).toBe(false);
    for (const invalid of ['', 'a', 'z'.repeat(64), '0'.repeat(64)]) expect(validHmac('order_1|pay_1', invalid, 'private-key')).toBe(false);
  });
  it('uses a separate secret and exact raw bytes for webhooks', () => {
    const provider = new RazorpayPaymentProvider('rzp_test_local', 'private-key', 'private-webhook-secret');
    const raw = Buffer.from('{ "event": "payment.captured" }');
    const sig = createHmac('sha256', 'private-webhook-secret').update(raw).digest('hex');
    expect(provider.verifyWebhook(raw, sig)).toBe(true);
    expect(provider.verifyWebhook(Buffer.from('{"event":"payment.captured"}'), sig)).toBe(false);
    expect(new RazorpayPaymentProvider('rzp_test_local', 'private-key').verifyWebhook(raw, sig)).toBe(false);
  });
  it('returns safe provider errors without response bodies or secrets', async () => {
    const provider = new RazorpayPaymentProvider('rzp_test_local', 'private-key', undefined, vi.fn(async () => new Response('secret provider details', { status: 401 })));
    await expect(provider.fetchOrder('order_1')).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE', statusCode: 502 });
  });
});
