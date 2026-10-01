// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DailySummary } from '@carwash/shared';
import { DailySummaryView } from './DailySummaryView';

const base: DailySummary = {
  date: '2026-10-01', timeZone: 'Asia/Kolkata', asOf: '2026-10-01T10:00:00.000Z', branchId: null,
  receivedCount: 3, handedOverCount: 2, stillOnBoardCount: 1,
  collectedPaise: 79900, collectionByMethod: [{ method: 'CASH', amountPaise: 49900 }, { method: 'UPI', amountPaise: 30000 }],
  unpaidPaise: 29900, unpaidInvoiceCount: 1, pipelinePaise: 29900,
  avgTurnaroundMinutes: 105, lateCount: 2,
  services: [{ name: 'Basic Wash', count: 2, valuePaise: 79800 }, { name: 'Premium Wash', count: 1, valuePaise: 59900 }],
  hours: [{ hour: 9, count: 1 }, { hour: 10, count: 2 }], busiestHour: 10,
  staff: [{ id: 'employee-1', name: 'Ravi', cars: 2, updates: 3, handovers: 1 }],
  customers: { newCount: 2, returningCount: 1 },
  attention: [{ kind: 'UNPAID', jobId: 'job-1', registrationNumber: 'KA01AB1002', customerName: 'Returning Customer', detail: 'Invoice outstanding', amountPaise: 29900 }],
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('daily summary view', () => {
  it('renders authoritative figures and filters by branch', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      requests.push(path);
      if (path === '/api/branches') return Response.json([{ id: 'main', name: 'Main' }, { id: 'second', name: 'Second' }]);
      if (path === '/api/summary/daily') return Response.json(base);
      if (path === '/api/summary/daily?branchId=main') return Response.json({ ...base, branchId: 'main', receivedCount: 2, collectedPaise: 30000, collectionByMethod: [{ method: 'UPI', amountPaise: 30000 }] });
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user = userEvent.setup();
    render(<DailySummaryView />);
    expect(await screen.findByText('₹799')).toBeTruthy();
    expect(screen.getByText('1h 45m')).toBeTruthy();
    expect(screen.getByText('Cash ₹499 · UPI ₹300')).toBeTruthy();
    expect(screen.getByText('busiest 10am')).toBeTruthy();
    expect(screen.getByText('KA01AB1002')).toBeTruthy();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Summary branch' }), 'main');
    expect(await screen.findByText('₹300')).toBeTruthy();
    await waitFor(() => expect(requests).toContain('/api/summary/daily?branchId=main'));
  });

  it('shows real empty states when there is no business activity', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/branches') return Response.json([{ id: 'main', name: 'Main' }]);
      if (path === '/api/summary/daily') return Response.json({ ...base, receivedCount: 0, handedOverCount: 0, stillOnBoardCount: 0, collectedPaise: 0, collectionByMethod: [], unpaidPaise: 0, unpaidInvoiceCount: 0, pipelinePaise: 0, avgTurnaroundMinutes: null, lateCount: 0, services: [], hours: [], busiestHour: null, staff: [], customers: { newCount: 0, returningCount: 0 }, attention: [] });
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(<DailySummaryView />);
    expect(await screen.findByText('No vehicles checked in today.')).toBeTruthy();
    expect(screen.getByText('No payments collected today')).toBeTruthy();
    expect(screen.getByText('No check-ins yet today.')).toBeTruthy();
    expect(screen.getByText('Nothing needs attention right now.')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });
});
