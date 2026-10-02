// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BillingView } from './BillingView';

const base = {
  plan: { code: 'KLEENBAY_ANNUAL', name: 'KleenBay Annual', pricePaise: 720000, currency: 'INR', billingInterval: 'YEAR' },
  checkoutAvailable: true,
  subscription: { status: 'INACTIVE', currentPeriodStart: null, currentPeriodEnd: null, daysRemaining: 0 },
  payments: [] as object[],
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('owner billing view', () => {
  it('shows loading, authoritative inactive state and an honest empty history', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(base)));
    render(<BillingView />);
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(await screen.findByRole('heading', { name: 'KleenBay Annual' })).toBeTruthy();
    expect(screen.getByText('Not subscribed')).toBeTruthy();
    expect(screen.getByText('No subscription payments yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Subscribe for/ })).toBeTruthy();
  });

  it('shows real active dates and history from the billing API', async () => {
    const state = { ...base, subscription: { status: 'ACTIVE', currentPeriodStart: '2026-10-02T00:00:00.000Z', currentPeriodEnd: '2027-10-02T00:00:00.000Z', daysRemaining: 365 }, payments: [{ id: 'payment-1', merchantTransactionId: 'KB123', providerTransactionId: 'payu-1', amountPaise: 720000, status: 'SUCCESS', initiatedAt: '2026-10-02T00:00:00.000Z', completedAt: '2026-10-02T00:00:00.000Z' }] };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(state)));
    render(<BillingView />);
    expect(await screen.findByText('365')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Renew subscription' })).toBeTruthy();
    expect(screen.getByText('Transaction: KB123')).toBeTruthy();
    expect(screen.getByText('Success')).toBeTruthy();
  });

  it.each([['EXPIRED', 'Expired'], ['PAYMENT_FAILED', 'Payment unsuccessful'], ['PAYMENT_PENDING', 'Payment pending']])('shows %s as %s', async (status, label) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...base, subscription: { ...base.subscription, status } })));
    render(<BillingView />);
    expect(await screen.findByText(label)).toBeTruthy();
  });

  it('shows an API error and retry control without invented data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Billing unavailable' } }, { status: 503 })));
    render(<BillingView />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Billing unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText('Action Required')).toBeNull();
  });
});
