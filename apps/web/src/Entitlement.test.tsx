// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { EntitlementBoundary, ownerWarning, type Access } from './Entitlement';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const active: Access = { state: 'ACTIVE', daysRemaining: 365, canCreateWork: true, canOperate: true };
describe('subscription experience', () => {
  it.each([30, 7, 1])('warns owners at %s days remaining', (daysRemaining) => { expect(ownerWarning({ ...active, daysRemaining })).toContain(daysRemaining === 1 ? 'tomorrow' : `${daysRemaining} days`); });
  it('does not warn far from expiry', () => { expect(ownerWarning(active)).toBeNull(); });
  it.each(['NOT_SUBSCRIBED', 'GRACE_PERIOD', 'EXPIRED'] as const)('keeps owner history and renewal accessible in %s', async (state) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...active, state, canCreateWork: false, canOperate: state === 'GRACE_PERIOD', graceDaysRemaining: 5 })));
    render(<EntitlementBoundary role="OWNER" onLogout={() => {}}>Historical business records</EntitlementBoundary>);
    expect(await screen.findByText('Historical business records')).toBeTruthy();
    expect(screen.getByRole('link', { name: state === 'NOT_SUBSCRIBED' ? 'Subscribe' : 'Renew now' }).getAttribute('href')).toBe('/billing');
    if (state === 'GRACE_PERIOD') expect(screen.getByRole('status').textContent).toContain('5 days of grace remaining');
  });
  it('keeps employee operational UI during grace without billing information', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ canCreateWork: false, canOperate: true })));
    render(<EntitlementBoundary role="EMPLOYEE" onLogout={() => {}}>Existing vehicles</EntitlementBoundary>);
    expect(await screen.findByText('Existing vehicles')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull(); expect(document.body.textContent).not.toMatch(/7,200|Razorpay|Renew|Billing/);
  });
  it('blocks inactive employee operations and restores them after renewal event', async () => {
    let canOperate = false;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ canCreateWork: canOperate, canOperate })));
    render(<EntitlementBoundary role="EMPLOYEE" onLogout={() => {}}>Operational board</EntitlementBoundary>);
    expect(await screen.findByText('Your business subscription is inactive. Please contact the owner.')).toBeTruthy();
    expect(screen.queryByText('Operational board')).toBeNull(); expect(screen.queryByRole('link')).toBeNull();
    canOperate = true; window.dispatchEvent(new Event('kleenbay:subscription-updated'));
    await waitFor(() => expect(screen.getByText('Operational board')).toBeTruthy());
  });
  it('fails closed when access cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    render(<EntitlementBoundary role="EMPLOYEE" onLogout={() => {}}>Operational board</EntitlementBoundary>);
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy(); expect(screen.queryByText('Operational board')).toBeNull();
  });
});
