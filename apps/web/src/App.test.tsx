// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

const employeeSession = {
  user: { id: 'employee-1', role: 'EMPLOYEE', name: 'Anu', organizationId: 'org-1', branchId: 'branch-1' },
  organization: { id: 'org-1', name: 'Sparkle Car Wash' },
};
const ownerSession = {
  user: { id: 'owner-1', role: 'OWNER', name: 'Suresh', organizationId: 'org-1', branchId: 'branch-1' },
  organization: { id: 'org-1', name: 'Sparkle Car Wash' },
};

function mockApi(provider: 'development' | 'dummy' | 'msg91' = 'development') {
  const requests: Array<{ path: string; body?: Record<string, string> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) as Record<string, string> : undefined;
    requests.push({ path, body });
    if (path.endsWith('/auth/me')) return Response.json({ error: { message: 'Sign in required' } }, { status: 401 });
    if (path.endsWith('/auth/employee/otp-config')) return Response.json(provider === 'msg91' ? { provider, otpLength: 6, widgetId: 'test-widget', widgetToken: 'public-token' } : { provider, otpLength: 6 });
    if (path.endsWith('/auth/employee/request-otp')) return Response.json({ status: 'sent', resendAfterSeconds: 60, expiresInSeconds: 300, otpLength: 6 });
    if (path.endsWith('/auth/employee/verify-otp')) return Response.json(employeeSession);
    if (path.startsWith('/api/jobs?')) return Response.json([]);
    if (path.startsWith('/api/board/metrics')) return Response.json({ inBay: 0, ready: 0, late: 0 });
    if (path.endsWith('/services') || path.endsWith('/branches') || path.endsWith('/operations/available-employees')) return Response.json([]);
    if (path.endsWith('/operations/capabilities')) return Response.json({ allowOutstanding: true, canHandover: true });
    throw new Error(`Unexpected API request: ${path}`);
  }));
  return requests;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('billing access', () => {
  it('shows Billing only to owners and opens the owner billing page', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      requests.push(path);
      if (path.endsWith('/auth/me')) return Response.json(ownerSession);
      if (path.endsWith('/employees') || path.endsWith('/branches')) return Response.json([]);
      if (path.endsWith('/billing')) return Response.json({ plan: { code: 'KLEENBAY_ANNUAL', name: 'KleenBay Annual', pricePaise: 720000, currency: 'INR', billingInterval: 'YEAR' }, checkoutAvailable: false, subscription: { status: 'INACTIVE', currentPeriodStart: null, currentPeriodEnd: null, daysRemaining: 0 }, payments: [] });
      if (path.startsWith('/api/jobs?')) return Response.json([]);
      if (path.startsWith('/api/board/metrics')) return Response.json({ inBay: 0, ready: 0, late: 0 });
      if (path.endsWith('/services') || path.endsWith('/operations/available-employees')) return Response.json([]);
      if (path.endsWith('/operations/capabilities')) return Response.json({ allowOutstanding: true, canHandover: true });
      throw new Error(`Unexpected API request: ${path}`);
    }));
    const user = userEvent.setup();
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Owner navigation' });
    await user.click(within(nav).getByRole('button', { name: 'Billing' }));
    expect(await screen.findByRole('heading', { name: 'KleenBay Annual' })).toBeTruthy();
    expect(window.location.pathname).toBe('/billing');
    expect(requests.some((path) => path.endsWith('/billing'))).toBe(true);
  });

  it('denies an employee direct /billing route without loading subscription data', async () => {
    window.history.replaceState(null, '', '/billing');
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      requests.push(path);
      if (path.endsWith('/auth/me')) return Response.json(employeeSession);
      throw new Error(`Unexpected API request: ${path}`);
    }));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Owner navigation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Billing' })).toBeNull();
    expect(requests.some((path) => path.endsWith('/billing'))).toBe(false);
  });
});

describe('login screens', () => {
  it('switches from owner to employee and returns from verification to mobile entry', async () => {
    const requests = mockApi();
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('tab', { name: 'Owner Login' })).toHaveProperty('ariaSelected', 'true');
    expect(document.querySelector('.login-brand img')?.getAttribute('src')).toBe('/kleenbay-monogram.png');
    await user.click(screen.getByRole('tab', { name: 'Employee Login' }));
    expect(screen.getByRole('textbox', { name: 'Mobile number' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Username / Email' })).toBeNull();
    await user.type(screen.getByRole('textbox', { name: 'Mobile number' }), '9876543212');
    await user.click(screen.getByRole('button', { name: 'Send OTP' }));
    expect(await screen.findByRole('heading', { name: 'Enter test code' })).toBeTruthy();
    expect(screen.getByText('No SMS is sent in this test environment')).toBeTruthy();
    expect(screen.getAllByText('', { selector: '.otp-slot' })).toHaveLength(6);
    expect(requests.some((request) => request.path.endsWith('/auth/employee/request-otp'))).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Edit mobile number' }));
    expect(screen.getByRole('textbox', { name: 'Mobile number' })).toHaveProperty('value', '9876543212');
  });

  it('accepts a six-digit code and opens the employee portal', async () => {
    const requests = mockApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('tab', { name: 'Employee Login' });
    await user.click(screen.getByRole('tab', { name: 'Employee Login' }));
    await user.type(screen.getByRole('textbox', { name: 'Mobile number' }), '9876543212');
    await user.click(screen.getByRole('button', { name: 'Send OTP' }));
    const input = await screen.findByRole('textbox', { name: 'Verification code' });
    await user.type(input, '123456');
    expect(screen.getByRole('button', { name: 'Verify' }).hasAttribute('disabled')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeTruthy();
    expect(document.querySelector('.rail .login-brand img')?.getAttribute('src')).toBe('/kleenbay-monogram.png');
    expect(document.querySelector('.topbar .mobile-brand-art img')?.getAttribute('src')).toBe('/kleenbay-monogram.png');
    expect(screen.queryByText('Sparkle Car Wash')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check-in Vehicle' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Daily Summary' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Billing' })).toBeNull();
    await waitFor(() => expect(requests.find((request) => request.path.endsWith('/auth/employee/verify-otp'))?.body?.code).toBe('123456'));
  });

  it('uses the stage dummy code without loading or calling the MSG91 widget', async () => {
    const requests = mockApi('dummy');
    const widget = vi.fn();
    vi.stubGlobal('initSendOTP', widget);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('tab', { name: 'Employee Login' }));
    await user.type(screen.getByRole('textbox', { name: 'Mobile number' }), '9876543212');
    await user.click(screen.getByRole('button', { name: 'Send OTP' }));
    expect(await screen.findByRole('heading', { name: 'Enter test code' })).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'Verification code' }), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeTruthy();
    expect(widget).not.toHaveBeenCalled();
    expect(requests.find((request) => request.path.endsWith('/auth/employee/verify-otp'))?.body).toEqual({ mobile: '9876543212', code: '123456' });
  });

  it('uses the MSG91 widget token exchange without sending the code to KleenBay API', async () => {
    const requests = mockApi('msg91');
    const accessToken = 'secure-access-token-'.repeat(3);
    const sendOtp = vi.fn((_mobile: string, success: (result: object) => void) => success({ reqId: 'request-1' }));
    const verifyOtp = vi.fn((_code: string, success: (result: object) => void) => success({ 'access-token': accessToken }));
    vi.stubGlobal('initSendOTP', vi.fn());
    vi.stubGlobal('sendOtp', sendOtp);
    vi.stubGlobal('verifyOtp', verifyOtp);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('tab', { name: 'Employee Login' }));
    await user.type(screen.getByRole('textbox', { name: 'Mobile number' }), '9876543212');
    await user.click(screen.getByRole('button', { name: 'Send OTP' }));
    expect(await screen.findByRole('heading', { name: 'We just sent an SMS' })).toBeTruthy();
    expect(sendOtp.mock.calls[0]?.[0]).toBe('919876543212');
    await user.type(screen.getByRole('textbox', { name: 'Verification code' }), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeTruthy();
    expect(verifyOtp.mock.calls[0]?.[0]).toBe('123456');
    const body = requests.find((request) => request.path.endsWith('/auth/employee/verify-otp'))?.body;
    expect(body).toEqual({ mobile: '9876543212', accessToken });
    expect(body).not.toHaveProperty('code');
  });

  it('retries a captcha-blocked SMS without requesting another backend challenge', async () => {
    const requests = mockApi('msg91');
    const sendOtp = vi.fn()
      .mockImplementationOnce((_mobile: string, _success: unknown, failure: (error: object) => void) => failure({ message: 'Invalid captcha' }))
      .mockImplementationOnce((_mobile: string, success: (result: object) => void) => success({ reqId: 'request-2' }));
    vi.stubGlobal('initSendOTP', vi.fn());
    vi.stubGlobal('sendOtp', sendOtp);
    vi.stubGlobal('verifyOtp', vi.fn());
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('tab', { name: 'Employee Login' }));
    await user.type(screen.getByRole('textbox', { name: 'Mobile number' }), '9876543212');
    await user.click(screen.getByRole('button', { name: 'Send OTP' }));
    expect(await screen.findByText('Complete the security check, then select Send OTP again.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Send OTP' }));
    expect(await screen.findByRole('heading', { name: 'We just sent an SMS' })).toBeTruthy();
    expect(sendOtp).toHaveBeenCalledTimes(2);
    expect(requests.filter((request) => request.path.endsWith('/auth/employee/request-otp'))).toHaveLength(1);
  });
});

describe('owner catalog', () => {
  it('opens customer search and vehicle pricing from the owner portal', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      requests.push(path);
      if (path.endsWith('/auth/me')) return Response.json(ownerSession);
      if (path.endsWith('/employees')) return Response.json([]);
      if (path.endsWith('/branches')) return Response.json([{ id: 'branch-1', name: 'Main', address: null, phone: null }]);
      if (path.startsWith('/api/jobs?')) return Response.json([]);
      if (path.startsWith('/api/board/metrics')) return Response.json({ inBay: 0, ready: 0, late: 0, collectedPaise: 0 });
      if (path.endsWith('/operations/available-employees')) return Response.json([]);
      if (path.endsWith('/operations/capabilities')) return Response.json({ allowOutstanding: true, canHandover: true });
      if (path.startsWith('/api/customers')) return Response.json([{ id: 'customer-1', name: 'Meera Nair', mobile: '+919845612300', email: null, notes: null, tags: [], vehicles: [{ id: 'vehicle-1', customerId: 'customer-1', registrationNumber: 'KL07AB1234', make: 'Hyundai', model: 'i20', type: 'HATCHBACK', colour: null }] }]);
      if (path.startsWith('/api/vehicles')) return Response.json([{ id: 'vehicle-1', customerId: 'customer-1', registrationNumber: 'KL07AB1234', make: 'Hyundai', model: 'i20', type: 'HATCHBACK', colour: null, customer: { id: 'customer-1', name: 'Meera Nair', mobile: '+919845612300' } }]);
      if (path.endsWith('/services')) return Response.json([{ id: 'service-1', name: 'Premium Wash', category: 'Wash', description: null, basePricePaise: 59900, estimatedMinutes: 45, active: true, prices: [{ id: 'price-1', branchId: null, vehicleType: 'HATCHBACK', pricePaise: 49900 }], branches: [] }]);
      throw new Error(`Unexpected API request: ${path}`);
    }));
    const user = userEvent.setup();
    render(<App />);
    const navigation = await screen.findByRole('navigation', { name: 'Owner sections' });
    expect(document.querySelector('.rail .login-brand img')?.getAttribute('src')).toBe('/kleenbay-monogram.png');
    expect(document.querySelector('.topbar .mobile-brand-art img')?.getAttribute('src')).toBe('/kleenbay-monogram.png');
    expect(screen.queryByText('Sparkle Car Wash')).toBeNull();
    expect(within(navigation).getByRole('button', { name: 'Daily Summary' })).toBeTruthy();
    expect(within(navigation).queryByRole('button', { name: 'Owners' })).toBeNull();
    await user.click(within(navigation).getByRole('button', { name: 'Customers' }));
    expect(await screen.findByRole('button', { name: /Meera Nair/ })).toBeTruthy();
    await user.type(screen.getByRole('searchbox', { name: 'Search customers' }), 'KL07AB1234');
    await waitFor(() => expect(requests.some((path) => path.includes('/customers?q=KL07AB1234'))).toBe(true));
    await user.click(within(navigation).getByRole('button', { name: 'Vehicles' }));
    expect(await screen.findByRole('button', { name: /KL07AB1234/ })).toBeTruthy();
    await user.click(within(navigation).getByRole('button', { name: 'Services' }));
    await user.click(await screen.findByRole('button', { name: /Premium Wash/ }));
    expect(screen.getByText('₹499.00')).toBeTruthy();
  });
});

describe('billing access', () => {
  it('shows Billing only to owners and loads the owner page', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path.endsWith('/auth/me')) return Response.json(ownerSession);
      if (path.endsWith('/employees') || path.endsWith('/branches')) return Response.json([]);
      if (path.endsWith('/billing')) return Response.json({ plan: { code: 'KLEENBAY_ANNUAL', name: 'KleenBay Annual', pricePaise: 720000, currency: 'INR', billingInterval: 'YEAR' }, checkoutAvailable: false, subscription: { status: 'INACTIVE', currentPeriodStart: null, currentPeriodEnd: null, daysRemaining: 0 }, payments: [] });
      if (path.startsWith('/api/jobs?')) return Response.json([]);
      if (path.startsWith('/api/board/metrics')) return Response.json({ inBay: 0, ready: 0, late: 0 });
      if (path.endsWith('/operations/available-employees')) return Response.json([]);
      if (path.endsWith('/operations/capabilities')) return Response.json({ allowOutstanding: true, canHandover: true });
      throw new Error(`Unexpected API request: ${path}`);
    }));
    render(<App />);
    const navigation = await screen.findByRole('navigation', { name: 'Owner sections' });
    await userEvent.click(within(navigation).getByRole('button', { name: 'Billing' }));
    expect(window.location.pathname).toBe('/billing');
    expect(await screen.findByRole('heading', { name: 'KleenBay Annual' })).toBeTruthy();
  });

  it('does not render Billing for employees, including a direct URL', async () => {
    window.history.replaceState(null, '', '/billing');
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      requests.push(path);
      if (path.endsWith('/auth/me')) return Response.json(employeeSession);
      throw new Error(`Unexpected API request: ${path}`);
    }));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Billing' })).toBeNull();
    expect(requests).not.toContain('/api/billing');
  });
});
