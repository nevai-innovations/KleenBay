// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OwnerSetupView } from './OwnerSetupView';
import App from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('owner password setup UI', () => {
  it('requires matching passwords and submits a setup token without exposing it in page text', async () => {
    const token = 'b'.repeat(43);
    const onComplete = vi.fn();
    const fetchMock = vi.fn(async (_path: string, options?: RequestInit) => {
      expect(JSON.parse(String(options?.body))).toMatchObject({ token, password: 'a-long-secret-password' });
      return Response.json({ status: 'ready' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<OwnerSetupView token={token} onComplete={onComplete} />);
    expect(screen.queryByText(token)).toBeNull();
    await user.type(screen.getByLabelText('New password'), 'a-long-secret-password');
    await user.type(screen.getByLabelText('Confirm password'), 'a-long-secret-password');
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps an unused setup link on refresh and removes it after password setup', async () => {
    const token = 'c'.repeat(43);
    window.history.replaceState(null, '', `/#owner-setup=${token}`);
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/auth/me')
      ? Response.json({ error: { message: 'Sign in required' } }, { status: 401 })
      : Response.json({ status: 'ready' })));
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Set your owner password' })).toBeTruthy();
    expect(window.location.hash).toBe(`#owner-setup=${token}`);
    await user.type(screen.getByLabelText('New password'), 'another-long-secret-password');
    await user.type(screen.getByLabelText('Confirm password'), 'another-long-secret-password');
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByRole('tab', { name: 'Owner Login' })).toBeTruthy();
    expect(window.location.hash).toBe('');
  });
});
