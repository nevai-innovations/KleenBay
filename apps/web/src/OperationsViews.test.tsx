// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardView, HistoryView } from './OperationsViews';
import type { Job, Session } from './api';

const owner: Session = { user: { id: 'owner-1', role: 'OWNER', name: 'Suresh', organizationId: 'org-1', branchId: 'branch-1' }, organization: { id: 'org-1', name: 'Sparkle Car Wash' } };
const employee: Session = { user: { ...owner.user, id: 'employee-1', role: 'EMPLOYEE', name: 'Anu' }, organization: owner.organization };

function mockOperations(role: Session['user']['role'] = 'OWNER') {
  let jobs: Job[] = [];
  const visibleJob = (job: Job) => role === 'OWNER' ? job : {
    id: job.id, number: job.number, status: job.status, serviceName: job.serviceName,
    checkedInAt: job.checkedInAt, stageAt: job.stageAt, expectedAt: job.expectedAt,
    handedOverAt: job.handedOverAt, notes: job.notes, customer: job.customer,
    vehicle: job.vehicle, branch: job.branch, stages: job.stages, assignments: job.assignments,
    messages: job.messages,
  };
  const requests: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : undefined;
    requests.push({ path, method, body });
    if (path.startsWith('/api/jobs?')) return Response.json(jobs.filter((job) => path.includes('view=history') ? job.status === 'HANDED_OVER' : job.status !== 'HANDED_OVER').map(visibleJob));
    if (path.startsWith('/api/board/metrics')) return Response.json({ inBay: jobs.filter((job) => ['RECEIVED', 'WASHING'].includes(job.status)).length, ready: jobs.filter((job) => job.status === 'READY').length, late: 0, ...(role === 'OWNER' ? { collectedPaise: 0 } : {}) });
    if (path === '/api/branches') return Response.json([{ id: 'branch-1', name: 'Main Branch' }]);
    if (path === '/api/services') return Response.json([{ id: 'service-1', name: 'Premium Wash', active: true, estimatedMinutes: 45 }]);
    if (path === '/api/operations/available-employees') return Response.json([{ id: 'employee-1', name: 'Anu', branchId: 'branch-1' }]);
    if (path === '/api/operations/capabilities') return Response.json({ ...(role === 'OWNER' ? { allowOutstanding: true } : {}), canHandover: true });
    if (path.startsWith('/api/customers?q=') || path.startsWith('/api/vehicles?q=')) return Response.json([]);
    if (path === '/api/jobs/check-in' && body) {
      const job: Job = { id: 'job-1', number: 1, status: 'RECEIVED', serviceId: String(body.serviceId), serviceName: 'Premium Wash', branchId: 'branch-1', checkedInAt: new Date().toISOString(), stageAt: new Date().toISOString(), expectedAt: String(body.expectedAt), handedOverAt: null, notes: null, handoverNotes: null, notify: true, customer: { id: 'customer-1', name: String(body.customerName), mobile: String(body.mobile) }, vehicle: { id: 'vehicle-1', registrationNumber: String(body.registrationNumber), make: String(body.make), model: String(body.model), type: String(body.vehicleType) }, branch: { id: 'branch-1', name: 'Main Branch' }, totalPaise: 59900, paidPaise: 0, outstandingPaise: 59900, paymentStatus: 'UNPAID', stages: [{ id: 'stage-1', fromStage: null, toStage: 'RECEIVED', note: 'Vehicle checked in', createdAt: new Date().toISOString(), actor: { id: 'owner-1', name: 'Suresh' } }], assignments: [], messages: [], invoice: null };
      jobs = [job]; return Response.json(visibleJob(job), { status: 201 });
    }
    if (path === '/api/jobs/job-1' && method === 'GET') return Response.json(visibleJob(jobs[0]!));
    if (path === '/api/jobs/job-1/advance' && body) { jobs = jobs.map((job) => ({ ...job, status: body.to as Job['status'] })); return Response.json(visibleJob(jobs[0]!)); }
    if (path === '/api/jobs/job-1/handover' && body) { jobs = jobs.map((job) => ({ ...job, status: 'HANDED_OVER', handedOverAt: new Date().toISOString(), invoice: { id: 'invoice-1', invoiceNumber: 'KB-00001', totalPaise: 59900, status: 'PAID', issuedAt: new Date().toISOString(), payments: [] } })); return Response.json(visibleJob(jobs[0]!)); }
    throw new Error(`Unexpected API request: ${method} ${path}`);
  }));
  return requests;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('vehicle board', () => {
  it('checks in, advances by drag and action, then confirms Handover into History', async () => {
    const requests = mockOperations();
    const user = userEvent.setup();
    const { container } = render(<BoardView session={owner} />);
    await user.click(await screen.findByRole('button', { name: 'Check-in Vehicle' }));
    const dialog = screen.getByRole('dialog', { name: 'Check-in Vehicle' });
    expect(within(dialog).getByText('Assign employees (optional)')).toBeTruthy();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Anu' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Customer mobile number' }), '9845612300');
    await user.type(within(dialog).getByRole('textbox', { name: 'Customer name' }), 'Meera Nair');
    await user.type(within(dialog).getByRole('textbox', { name: 'Vehicle registration number' }), 'KL29AB1234');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Vehicle type' }), 'SUV');
    await user.type(within(dialog).getByRole('textbox', { name: 'Make' }), 'Hyundai');
    await user.type(within(dialog).getByRole('textbox', { name: 'Model' }), 'Creta');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Wash service' }), 'service-1');
    await user.click(within(dialog).getByRole('button', { name: 'Check-in Vehicle' }));
    expect(await screen.findByRole('button', { name: /KL29AB1234/ })).toBeTruthy();
    expect(requests.find((request) => request.path === '/api/jobs/check-in')?.body?.idempotencyKey).toBeTruthy();
    expect(requests.find((request) => request.path === '/api/jobs/check-in')?.body?.employeeIds).toEqual(['employee-1']);

    const transfer = { values: new Map<string, string>(), types: ['text/plain'], setData(type: string, value: string) { this.values.set(type, value); }, getData(type: string) { return this.values.get(type) ?? ''; }, effectAllowed: 'none' };
    fireEvent.dragStart(container.querySelector('[data-job-id="job-1"]')!, { dataTransfer: transfer });
    fireEvent.dragOver(container.querySelector('[data-drop="WASHING"]')!, { dataTransfer: transfer });
    fireEvent.drop(container.querySelector('[data-drop="WASHING"]')!, { dataTransfer: transfer });
    await waitFor(() => expect(requests.some((request) => request.path.endsWith('/advance') && request.body?.to === 'WASHING')).toBe(true));
    await user.click(await screen.findByRole('button', { name: 'Mark Ready' }));
    await user.click(await screen.findByRole('button', { name: 'Handover' }));
    const handover = await screen.findByRole('dialog', { name: 'Handover' });
    expect(within(handover).getAllByText('₹599.00')).toHaveLength(2);
    await user.click(within(handover).getByRole('button', { name: 'Confirm Handover' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /KL29AB1234/ })).toBeNull());
    expect(requests.some((request) => request.path.endsWith('/handover'))).toBe(true);
    cleanup();
    render(<HistoryView session={owner} />);
    expect(await screen.findByRole('button', { name: /KL29AB1234/ })).toBeTruthy();
  });

  it('keeps the employee board operational without a collected-revenue tile', async () => {
    const requests = mockOperations('EMPLOYEE');
    const user = userEvent.setup();
    render(<BoardView session={employee} />);
    await user.click(await screen.findByRole('button', { name: 'Check-in Vehicle' }));
    const dialog = screen.getByRole('dialog', { name: 'Check-in Vehicle' });
    expect(within(dialog).queryByText('Assign employees (optional)')).toBeNull();
    expect(requests.some((request) => request.path === '/api/operations/available-employees')).toBe(false);
    await user.type(within(dialog).getByRole('textbox', { name: 'Customer mobile number' }), '9845612301');
    await user.type(within(dialog).getByRole('textbox', { name: 'Customer name' }), 'Arjun Shah');
    await user.type(within(dialog).getByRole('textbox', { name: 'Vehicle registration number' }), '22BH1234AA');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Vehicle type' }), 'SUV');
    await user.type(within(dialog).getByRole('textbox', { name: 'Make' }), 'Tata');
    await user.type(within(dialog).getByRole('textbox', { name: 'Model' }), 'Nexon');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Wash service' }), 'service-1');
    await user.click(within(dialog).getByRole('button', { name: 'Check-in Vehicle' }));
    await screen.findByRole('button', { name: /22BH1234AA/ });
    expect(requests.find((request) => request.path === '/api/jobs/check-in')?.body?.employeeIds).toBeUndefined();
    expect(screen.queryByText('Collected today')).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Start Washing' }));
    await user.click(await screen.findByRole('button', { name: 'Mark Ready' }));
    await user.click(await screen.findByRole('button', { name: 'Handover' }));
    const handover = await screen.findByRole('dialog', { name: 'Handover' });
    expect(within(handover).queryByText('Total')).toBeNull();
    expect(within(handover).queryByText('Outstanding')).toBeNull();
    expect(within(handover).queryByText('Payment status')).toBeNull();
    expect(within(handover).queryByRole('spinbutton')).toBeNull();
    await user.click(within(handover).getByRole('button', { name: 'Confirm Handover' }));
    await waitFor(() => expect(requests.find((request) => request.path.endsWith('/handover'))?.body).toEqual({ paymentAmountPaise: 0, notes: '' }));
  });
});
