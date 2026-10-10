// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { InvoicesView } from './InvoicesView';

const owner = { user: { id: 'owner-1', role: 'OWNER', name: 'Owner', organizationId: 'org-1', branchId: null }, organization: { id: 'org-1', name: 'KleenBay' } };
const employee = { user: { id: 'employee-1', role: 'EMPLOYEE', name: 'Worker', organizationId: 'org-1', branchId: null }, organization: { id: 'org-1', name: 'KleenBay' } };
const invoice = {
  id: 'invoice-1', jobId: 'job-1', invoiceNumber: 'KB-2026-000001', status: 'PARTIALLY_PAID', createdAt: '2026-10-01T10:00:00Z', issuedAt: '2026-10-01T10:05:00Z',
  subtotalPaise: 120000, discountKind: 'NONE', discountValue: 0, discountPaise: 0, taxablePaise: 120000, taxPaise: 0, totalPaise: 120000, paidPaise: 100000, outstandingPaise: 20000,
  items: [{ id: 'line-1', kind: 'SERVICE', description: 'Premium Wash', quantity: 1, unitPricePaise: 120000, subtotalPaise: 120000, taxRateBps: 0, taxPaise: 0, totalPaise: 120000 }],
  payments: [{ id: 'payment-1', amountPaise: 70000, method: 'UPI', createdAt: '2026-10-01T10:06:00Z', collectedBy: { name: 'Owner' } }, { id: 'payment-2', amountPaise: 30000, method: 'CASH', createdAt: '2026-10-01T10:07:00Z', collectedBy: { name: 'Owner' } }],
  job: { number: 17, serviceName: 'Premium Wash', customer: { name: 'Asha', mobile: '+919876543210' }, vehicle: { registrationNumber: 'KL01AB1234', make: 'Tata', model: 'Nexon' }, branch: { name: 'Main', address: 'Test Road', phone: '9000000000' } },
  organization: { name: 'KleenBay', gstin: null, invoiceAddress: null, invoicePhone: null, currency: 'INR' },
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('owner customer invoices', () => {
  it('uses the same branch filter for invoice and payment lists', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      requests.push(path);
      if (path === '/api/branches') return Response.json([{ id: 'main', name: 'Main', active: true }, { id: 'second', name: 'Kottiyam', active: true }]);
      if (path === '/api/sale-items') return Response.json([]);
      if (path === '/api/invoice-settings') return Response.json({ gstRateBps: null, gstin: null, invoiceAddress: null, invoicePhone: null, allowCustomInvoiceItems: false, employeeAddons: false });
      if (path.startsWith('/api/invoices?')) return Response.json([]);
      if (path.startsWith('/api/payments?')) return Response.json([]);
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();
    render(<InvoicesView />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Invoice branch' }), 'second');
    await waitFor(() => expect(requests.some((path) => path.includes('/api/invoices?branchId=second'))).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Payments' }));
    await waitFor(() => expect(requests.some((path) => path.includes('/api/payments?branchId=second'))).toBe(true));
  });
  it('shows invoice navigation, search, payment history and print document to owner', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      requests.push(path);
      if (path.endsWith('/entitlement')) return Response.json({ state: 'ACTIVE', daysRemaining: 365, canCreateWork: true, canOperate: true });
      if (path.endsWith('/auth/me')) return Response.json(owner);
      if (path.endsWith('/employees') || path.endsWith('/branches') || path.endsWith('/sale-items')) return Response.json([]);
      if (path.endsWith('/invoice-settings')) return Response.json({ gstRateBps: null, gstin: null, invoiceAddress: null, invoicePhone: null, allowCustomInvoiceItems: false, employeeAddons: false });
      if (path.startsWith('/api/invoices?')) return Response.json([invoice]);
      if (path === '/api/invoices/invoice-1') return Response.json(invoice);
      if (path.startsWith('/api/jobs?')) return Response.json([]);
      if (path.startsWith('/api/board/metrics')) return Response.json({ inBay: 0, ready: 0, late: 0 });
      if (path.endsWith('/services') || path.endsWith('/operations/available-employees')) return Response.json([]);
      if (path.endsWith('/operations/capabilities')) return Response.json({ allowOutstanding: true, canHandover: true });
      throw new Error(`Unexpected API request: ${path}`);
    }));
    const user = userEvent.setup();
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Owner navigation' });
    await user.click(within(nav).getByRole('button', { name: 'Invoices' }));
    expect(await screen.findByRole('button', { name: /KB-2026-000001/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /KB-2026-000001/ }));
    expect(await screen.findByRole('heading', { name: 'Invoice', level: 1 })).toBeTruthy();
    expect(screen.getByText('KL01AB1234')).toBeTruthy();
    expect(screen.getByText(/UPI/, { selector: '.invoice-payment-list p' })).toBeTruthy();
    expect(screen.getByText(/CASH/, { selector: '.invoice-payment-list p' })).toBeTruthy();
    expect(screen.getByText('Outstanding')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Print / Save PDF' })).toBeTruthy();
    expect(requests).toContain('/api/invoices/invoice-1');
    await waitFor(() => expect(window.location.pathname).toBe('/invoices/invoice-1'));
  });

  it('blocks employee direct invoice routes before invoice APIs load', async () => {
    window.history.replaceState(null, '', '/invoices/invoice-1/print');
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => { requests.push(path); if (path.endsWith('/entitlement')) return Response.json({ state: 'ACTIVE', daysRemaining: 365, canCreateWork: true, canOperate: true });
      if (path.endsWith('/auth/me')) return Response.json(employee); throw new Error(`Unexpected request: ${path}`); }));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invoices' })).toBeNull();
    expect(requests).toEqual(['/api/auth/me']);
  });
});
