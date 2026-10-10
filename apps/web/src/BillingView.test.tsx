// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BillingView } from './BillingView';
import { openRazorpay, type CheckoutOptions } from './razorpay-checkout';

vi.mock('./razorpay-checkout', () => ({ openRazorpay: vi.fn(async () => {}) }));
const base = { plan: { code: 'KLEENBAY_ANNUAL', name: 'KleenBay Annual', pricePaise: 720000, currency: 'INR', billingInterval: 'YEAR' }, checkoutAvailable: true, subscription: { status: 'INACTIVE', currentPeriodStart: null as string | null, currentPeriodEnd: null as string | null, daysRemaining: 0 }, payments: [] as object[] };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('owner Razorpay billing view', () => {
  it('shows loading, inactive state, server price, and empty history', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(base)));
    render(<BillingView />); expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(await screen.findByRole('heading', { name: 'KleenBay Annual' })).toBeTruthy();
    expect(screen.getByText('Not subscribed')).toBeTruthy(); expect(screen.getByText('No subscription payments yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Subscribe for ₹7,200/ })).toBeTruthy();
    expect(screen.getByText('WhatsApp Business API/provider charges are billed separately.')).toBeTruthy();
  });
  it('shows active dates and real Razorpay payment history', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...base, subscription: { status: 'ACTIVE', currentPeriodStart: '2026-10-10T00:00:00Z', currentPeriodEnd: '2027-10-10T00:00:00Z', daysRemaining: 365 }, payments: [{ id: 'p1', provider: 'RAZORPAY', razorpayPaymentId: 'pay_test', amountPaise: 720000, status: 'SUCCESS', initiatedAt: '2026-10-10T00:00:00Z', completedAt: '2026-10-10T00:00:00Z' }] })));
    render(<BillingView />); expect(await screen.findByText('365')).toBeTruthy(); expect(screen.getByRole('button', { name: 'Renew subscription' })).toBeTruthy(); expect(screen.getByText('Payment ID: pay_test')).toBeTruthy(); expect(screen.getByText('Success')).toBeTruthy(); expect(screen.getByText(/Razorpay/)).toBeTruthy();
  });
  it.each([['EXPIRED', 'Expired', /Renew for/], ['PAYMENT_FAILED', 'Payment unsuccessful', /Try again/], ['PAYMENT_PENDING', 'Payment pending', /Subscribe for/]])('shows %s with the appropriate action', async (status, label, action) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...base, subscription: { ...base.subscription, status } })));
    render(<BillingView />); expect(await screen.findByText(label)).toBeTruthy(); expect(screen.getByRole('button', { name: action })).toBeTruthy();
  });
  it('shows an API error without inventing billing data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Billing unavailable' } }, { status: 503 })));
    render(<BillingView />); expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Billing unavailable'); expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
  it('opens the backend-created Razorpay order and verifies success server-side', async () => {
    const requests: { path: string; body: unknown }[] = [];
    let active = false;
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path.endsWith('/billing/checkout')) return Response.json({ transactionId: 'local1', keyId: 'rzp_test_public', orderId: 'order_1', amountPaise: 720000, currency: 'INR', name: 'Test Wash', prefill: { email: 'owner@example.test' } });
      if (path.endsWith('/razorpay/verify')) { active = true; return Response.json({ status: 'SUCCESS' }); }
      return Response.json({ ...base, subscription: { ...base.subscription, status: active ? 'ACTIVE' : 'INACTIVE' } });
    }));
    render(<BillingView />); await screen.findByRole('heading', { name: 'KleenBay Annual' }); await userEvent.click(screen.getByRole('button', { name: /Subscribe for/ }));
    const [options] = vi.mocked(openRazorpay).mock.calls[0]!;
    expect(options).toMatchObject({ key: 'rzp_test_public', order_id: 'order_1', amount: 720000, currency: 'INR' });
    expect(requests.find((r) => r.path.endsWith('/billing/checkout'))?.body).toEqual({ idempotencyKey: expect.any(String) });
    const response = { razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'signature-from-checkout' }; options.handler(response);
    await screen.findByText('Active'); expect(requests.find((r) => r.path.endsWith('/razorpay/verify'))?.body).toEqual(response);
    expect(screen.getByRole('link', { name: 'Terms' }).getAttribute('href')).toBe('/terms'); expect(screen.getByRole('link', { name: 'Refunds' }).getAttribute('href')).toBe('/refund-policy');
  });
  it('records dismissal without pretending payment succeeded', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/checkout') ? Response.json({ transactionId: 'local1', keyId: 'rzp_test_public', orderId: 'order_1', amountPaise: 720000, currency: 'INR', name: 'Test', prefill: {} }) : Response.json(base)));
    render(<BillingView />); await screen.findByRole('heading', { name: 'KleenBay Annual' }); await userEvent.click(screen.getByRole('button', { name: /Subscribe for/ }));
    const [options] = vi.mocked(openRazorpay).mock.calls[0]!; options.modal.ondismiss();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/billing/transactions/local1/cancel', expect.objectContaining({ body: JSON.stringify({ outcome: 'CANCELLED' }) })));
    expect(screen.queryByText('Active')).toBeNull();
  });
  it('reports Checkout loading failure with a retryable action', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/checkout') ? Response.json({ transactionId: 'local1' }) : Response.json(base)));
    vi.mocked(openRazorpay).mockRejectedValueOnce(new Error('Checkout blocked'));
    render(<BillingView />); await screen.findByRole('heading', { name: 'KleenBay Annual' }); await userEvent.click(screen.getByRole('button', { name: /Subscribe for/ }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Checkout blocked');
  });
  it('does not activate when backend verification rejects a checkout callback', async () => {
    let options: CheckoutOptions | undefined;
    vi.mocked(openRazorpay).mockImplementationOnce(async (value) => { options = value; });
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/checkout') ? Response.json({ transactionId: 'local1', prefill: {} }) : path.endsWith('/verify') ? Response.json({ error: { message: 'Payment signature verification failed' } }, { status: 400 }) : Response.json(base)));
    render(<BillingView />); await screen.findByRole('heading', { name: 'KleenBay Annual' }); await userEvent.click(screen.getByRole('button', { name: /Subscribe for/ }));
    options!.handler({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'invalid' });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Payment signature verification failed'); expect(screen.queryByText('Active')).toBeNull();
  });
});
