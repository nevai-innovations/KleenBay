// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BranchesView } from './BranchesView';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('branches view', () => {
  it('shows branch facts and submits a new branch without organizationId', async () => {
    const requests: { path: string; body?: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
      const body = options?.body ? JSON.parse(String(options.body)) as Record<string, string> : undefined;
      requests.push({ path, body });
      if (path === '/api/branches' && !body) return Response.json([{ id: 'main', name: 'Main', city: 'Kollam', state: 'Kerala', phone: '+919847010000', active: true, employeeCount: 2, activeJobCount: 3, todayJobCount: 4 }]);
      if (path === '/api/branches' && body) return Response.json({ id: 'new', ...body, active: true }, { status: 201 });
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();
    render(<BranchesView />);
    expect(await screen.findByText('Main')).toBeTruthy();
    expect(screen.getByText('Kollam, Kerala')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add Branch' }));
    await user.type(screen.getByRole('textbox', { name: 'Branch name' }), 'Kottiyam');
    await user.type(screen.getByRole('textbox', { name: 'Phone' }), '9847020000');
    await user.type(screen.getByRole('textbox', { name: 'Address' }), 'Market Road');
    await user.type(screen.getByRole('textbox', { name: 'City' }), 'Kollam');
    await user.type(screen.getByRole('textbox', { name: 'State' }), 'Kerala');
    await user.type(screen.getByRole('textbox', { name: 'Postal code' }), '691001');
    await user.click(screen.getByRole('button', { name: 'Create branch' }));
    await waitFor(() => expect(requests.some((item) => item.body?.name === 'Kottiyam')).toBe(true));
    expect(requests.find((item) => item.body?.name === 'Kottiyam')?.body).not.toHaveProperty('organizationId');
  });
});
