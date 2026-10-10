// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WhatsAppSettingsView } from './WhatsAppSettingsView';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('owner WhatsApp settings', () => {
  it('shows real sender and independent approval states after a non-sending connection test', async () => {
    let verified = false;
    const settings = { provider: 'MSG91', enabled: true, senderNumber: '+918137994052', senderDisplayName: 'NevAi', templateReceived: 'kb_vehicle_received', templateWashing: 'kb_wash_started', templateReady: 'kb_vehicle_ready', templateHandedOver: null, status: 'NOT_CONNECTED', templateStatuses: {} };
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/whatsapp/test-connection') { verified = true; return Response.json({ message: 'Connected. No customer message was sent.' }); }
      return Response.json({ ...settings, ...(verified ? { status: 'CONNECTED', templateStatuses: { kb_vehicle_received: 'IN_REVIEW', kb_wash_started: 'IN_REVIEW', kb_vehicle_ready: 'IN_REVIEW' } } : {}) });
    }));
    render(<WhatsAppSettingsView />);
    expect(await screen.findByDisplayValue('+918137994052')).toBeTruthy();
    expect(screen.getByDisplayValue('NevAi')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connected. No customer message was sent.')).toBeTruthy();
    expect(await screen.findByText('kb_vehicle_received: IN REVIEW')).toBeTruthy();
    expect(screen.getByText('Not configured')).toBeTruthy();
    expect(screen.queryByText('private-test-key')).toBeNull();
  });
  it('shows mock status, saves sender/templates, and tests without sending', async () => {
    const settings = { provider: 'MOCK', enabled: true, senderNumber: null, senderDisplayName: null, msg91IntegratedNumberId: null, templateReceived: 'VEHICLE_RECEIVED', templateWashing: 'WASH_STARTED', templateReady: 'VEHICLE_READY', templateHandedOver: 'VEHICLE_HANDED_OVER', status: 'MOCK_ACTIVE', lastVerifiedAt: null };
    const requests: { path: string; method: string; body?: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
      const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : undefined;
      requests.push({ path, method: options?.method ?? 'GET', body });
      if (path === '/api/whatsapp/settings' && options?.method === 'PATCH') return Response.json({ ...settings, ...body });
      if (path === '/api/whatsapp/settings') return Response.json(settings);
      if (path === '/api/whatsapp/test-connection') return Response.json({ status: 'MOCK_ACTIVE', delivered: false, message: 'Mock provider active - no real WhatsApp messages are being sent.' });
      throw new Error(`Unexpected request ${path}`);
    }));
    render(<WhatsAppSettingsView />);
    const user = userEvent.setup();
    expect(await screen.findByText('Mock provider active — no real WhatsApp messages are being sent.')).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'Connected sender number' }), '0919876543210');
    await user.type(screen.getByRole('textbox', { name: 'Sender display name' }), 'Main Bay');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('WhatsApp settings saved.')).toBeTruthy();
    expect(requests.find((request) => request.method === 'PATCH')?.body).toMatchObject({ senderNumber: '0919876543210', senderDisplayName: 'Main Bay' });
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Mock provider active - no real WhatsApp messages are being sent.')).toBeTruthy();
    expect(requests.filter((request) => request.path === '/api/whatsapp/test-connection')).toHaveLength(1);
  });
});
