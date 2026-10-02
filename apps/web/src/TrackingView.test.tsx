// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import App from './App';
import type { TrackingStatus } from './api';

const base = {
  businessName: 'KleenBay Test Wash', businessLogoUrl: null, vehicleRegistration: 'KL07AB1234', vehicleMake: 'Tata', vehicleModel: 'Nexon', serviceName: 'Premium Wash',
  status: 'RECEIVED', expectedCompletionAt: '2026-10-03T10:00:00.000Z', receivedAt: '2026-10-03T08:00:00.000Z', washingStartedAt: null, readyAt: null, handedOverAt: null, photos: [],
};

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('public customer tracking', () => {
  it('opens without an auth request and shows progress, ready and completion updates', async () => {
    window.history.replaceState(null, '', '/track/secure-test-token');
    vi.useFakeTimers();
    let state: TrackingStatus = { ...base, status: 'RECEIVED' };
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      urls.push(url);
      expect(options?.credentials).toBe('omit');
      return Response.json(state);
    }));
    await act(async () => { render(<App />); await Promise.resolve(); });
    expect(screen.getByRole('heading', { name: 'KL07AB1234' })).toBeTruthy();
    expect(screen.getByText('KleenBay Test Wash')).toBeTruthy();
    expect(screen.getByText('Your vehicle has been received')).toBeTruthy();
    expect(screen.getByText('3 Oct 2026, 1:30 pm IST')).toBeTruthy();
    state = { ...state, status: 'WASHING', washingStartedAt: '2026-10-03T08:15:00.000Z' };
    await act(async () => { vi.advanceTimersByTime(25_000); await Promise.resolve(); });
    expect(screen.getByText('Your vehicle is being washed')).toBeTruthy();
    state = { ...state, status: 'READY', readyAt: '2026-10-03T09:15:00.000Z' };
    await act(async () => { vi.advanceTimersByTime(25_000); await Promise.resolve(); });
    expect(screen.getByText('Your vehicle is ready for pickup.')).toBeTruthy();
    expect(urls.every((url) => url === '/api/public/tracking/secure-test-token')).toBe(true);
    state = { ...state, status: 'HANDED_OVER', handedOverAt: '2026-10-03T09:45:00.000Z' };
    await act(async () => { vi.advanceTimersByTime(25_000); await Promise.resolve(); });
    expect(screen.getByText('Service completed')).toBeTruthy();
  });

  it('shows the expiry message without revealing a login screen', async () => {
    window.history.replaceState(null, '', '/track/expired-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 410 })));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This tracking link has expired.');
    expect(screen.queryByText('Owner Login')).toBeNull();
  });
});
