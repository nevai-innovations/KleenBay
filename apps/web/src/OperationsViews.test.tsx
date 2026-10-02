// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardView } from './OperationsViews';
import type { Job, Session } from './api';

const session = (role: 'OWNER' | 'EMPLOYEE'): Session => ({
  user: { id: 'user-1', role, name: 'Tester', organizationId: 'org-1', branchId: 'branch-1' },
  organization: { id: 'org-1', name: 'KleenBay' },
});

const job = {
  id: 'job-1', number: 1, status: 'RECEIVED', serviceId: 'service-1', branchId: 'branch-1', serviceName: 'Basic Wash', notify: true,
  checkedInAt: '2026-10-02T09:00:00Z', stageAt: '2026-10-02T09:00:00Z', expectedAt: '2026-10-03T09:00:00Z', handedOverAt: null,
  notes: null, handoverNotes: null, customer: { id: 'customer-1', name: 'Stage Driver', mobile: '+919845612399' },
  vehicle: { id: 'vehicle-1', registrationNumber: 'KL29AB1234', make: 'Hyundai', model: 'Creta', type: 'SUV' },
  branch: { id: 'branch-1', name: 'Main' }, stages: [], assignments: [], photos: [], inspection: null,
  messages: [{ id: 'message-1', event: 'VEHICLE_READY', status: 'FAILED', provider: 'MOCK', createdAt: '2026-10-02T09:00:00Z', sentAt: null, failedAt: '2026-10-02T09:01:00Z', failureReason: 'Simulated provider failure', attempts: 1, renderedText: 'Hi Stage Driver, your vehicle is ready.' }],
} as Job;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('customer updates in vehicle detail', () => {
  it.each(['OWNER', 'EMPLOYEE'] as const)('shows status and permits retry only for %s owner role', async (role) => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
      requests.push(`${options?.method ?? 'GET'} ${path}`);
      if (path.startsWith('/api/jobs?')) return Response.json([job]);
      if (path === '/api/jobs/job-1') return Response.json(role === 'OWNER' ? job : { ...job, messages: job.messages?.map(({ id, event, status, createdAt, sentAt, failedAt }) => ({ id, event, status, createdAt, sentAt, failedAt })) });
      if (path.startsWith('/api/board/metrics')) return Response.json({ inBay: 1, ready: 0, late: 0 });
      if (path.endsWith('/services') || path.endsWith('/branches') || path.endsWith('/operations/available-employees')) return Response.json([]);
      if (path.endsWith('/operations/capabilities')) return Response.json({ canHandover: false });
      if (path.endsWith('/messages/message-1/retry')) return Response.json({ status: 'pending' });
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user = userEvent.setup();
    render(<BoardView session={session(role)} />);
    await user.click(await screen.findByRole('button', { name: /KL29AB1234/ }));
    expect(await screen.findByRole('heading', { name: 'Customer updates' })).toBeTruthy();
    expect(screen.getByText(/Failed/, { selector: 'small' })).toBeTruthy();
    if (role === 'OWNER') {
      expect(screen.getByText(/Simulated provider failure/)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(requests.some((request) => request === 'POST /api/jobs/job-1/messages/message-1/retry')).toBe(true);
    } else {
      expect(screen.queryByText(/Simulated provider failure/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    }
  });
});
