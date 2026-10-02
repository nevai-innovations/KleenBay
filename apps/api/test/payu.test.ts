import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANNUAL_PLAN, PayUPaymentProvider, rupeesToPaise } from '../src/payu.js';

const hash = (value: string) => createHash('sha512').update(value).digest('hex');
const provider = new PayUPaymentProvider('merchant-key', 'merchant-salt', 'https://test.payu.in');
afterEach(() => vi.unstubAllGlobals());

describe('PayU hosted checkout provider', () => {
  it('uses the server plan amount and signs the hosted checkout without returning the salt', () => {
    const checkout = provider.createCheckout({ transactionId: 'KB123', organizationId: 'org-1', name: 'Owner', email: 'owner@example.test', mobile: '+919876543210', returnUrl: 'https://stage.kleenbay.com/api/billing/payu/return' });
    expect(checkout.action).toBe('https://test.payu.in/_payment');
    expect(checkout.fields.amount).toBe('7200.00');
    expect(checkout.fields.udf1).toBe('org-1');
    expect(checkout.fields.hash).toBe(hash(['merchant-key', 'KB123', '7200.00', 'KleenBay Annual', 'Owner', 'owner@example.test', 'org-1', '', '', '', '', ...Array(5).fill(''), 'merchant-salt'].join('|')));
    expect(JSON.stringify(checkout)).not.toContain('merchant-salt');
    expect(ANNUAL_PLAN.pricePaise).toBe(720000);
  });

  it('rejects callback tampering and wrong organization or amount', () => {
    const callback = { key: 'merchant-key', txnid: 'KB123', amount: '7200.00', productinfo: 'KleenBay Annual', firstname: 'Owner', email: 'owner@example.test', udf1: 'org-1', status: 'success', hash: '' };
    callback.hash = hash(['merchant-salt', 'success', ...Array(5).fill(''), '', '', '', '', 'org-1', callback.email, callback.firstname, callback.productinfo, callback.amount, callback.txnid, callback.key].join('|'));
    expect(provider.verifyCallback(callback, { transactionId: 'KB123', organizationId: 'org-1', amountPaise: 720000 })).toBe(true);
    expect(provider.verifyCallback({ ...callback, amount: '1.00' }, { transactionId: 'KB123', organizationId: 'org-1', amountPaise: 720000 })).toBe(false);
    expect(provider.verifyCallback(callback, { transactionId: 'KB123', organizationId: 'org-2', amountPaise: 720000 })).toBe(false);
    expect(provider.verifyCallback({ ...callback, hash: '0'.repeat(128) }, { transactionId: 'KB123', organizationId: 'org-1', amountPaise: 720000 })).toBe(false);
    expect(rupeesToPaise('7200.00')).toBe(720000);
    expect(rupeesToPaise('7200.001')).toBeNull();
  });

  it('uses server-side verify_payment and does not accept an uncaptured success', async () => {
    const fetchMock = vi.fn(async (_url: string) => Response.json({ transaction_details: { KB123: { txnid: 'KB123', status: 'success', unmappedstatus: 'captured', transaction_amount: '7200.00', mihpayid: 'payu-1' } } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await provider.verifyTransaction('KB123')).toEqual({ status: 'success', amountPaise: 720000, providerTransactionId: 'payu-1', providerStatus: 'success' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://test.payu.in/merchant/postservice?form=2');
    fetchMock.mockResolvedValueOnce(Response.json({ transaction_details: { KB123: { txnid: 'KB123', status: 'success', unmappedstatus: 'pending', transaction_amount: '7200.00', mihpayid: 'payu-1' } } }));
    expect((await provider.verifyTransaction('KB123'))?.status).toBe('pending');
  });
});
