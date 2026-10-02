export type Msg91WidgetConfig = { widgetId: string; widgetToken: string };
type Payload = Record<string, unknown>;
type Callback = (value: Payload) => void;

declare global {
  interface Window {
    initSendOTP?: (config: { widgetId: string; tokenAuth: string; exposeMethods: true; captchaRenderId: string; success: Callback; failure: (error: unknown) => void }) => void;
    sendOtp?: (mobile: string, success: Callback, failure: (error: unknown) => void) => void;
    verifyOtp?: (code: string, success: Callback, failure: (error: unknown) => void, requestId?: string) => void;
  }
}

const scriptUrl = 'https://verify.msg91.com/otp-provider.js';
export const captchaId = 'kleenbay-msg91-captcha';
let initialization: Promise<void> | null = null;
let initializedKey = '';
let callbackToken = '';
const listeners = new Set<(token: string) => void>();

function value(data: Payload, keys: string[]) {
  const nested = data.data && typeof data.data === 'object' ? data.data as Payload : {};
  for (const entry of [data, nested]) for (const key of keys) if (typeof entry[key] === 'string' && entry[key]) return entry[key] as string;
  return '';
}

function accessToken(data: Payload) {
  const token = value(data, ['access-token', 'accessToken', 'access_token', 'token']) || value(data, ['message']);
  return token.length >= 32 && token.length <= 8192 && /^\S+$/.test(token) ? token : '';
}

function safeFailure(error: unknown, fallback: string) {
  const message = typeof error === 'string' ? error : error && typeof error === 'object' ? String((error as Payload).message ?? '') : '';
  if (/captcha|security\s+check/i.test(message)) return 'Complete the security check, then select Send OTP again.';
  if (/already\s+(verified|used)/i.test(message)) return 'This code was already used. Request a new one.';
  if (/expired|invalid|incorrect|wrong\s+otp/i.test(message)) return 'Invalid or expired code. Request a new one.';
  if (/limit|too\s+many|attempt|blocked|throttl/i.test(message)) return 'Too many attempts. Please try again later.';
  return fallback;
}

async function loadScript() {
  if (window.initSendOTP) return;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${scriptUrl}"]`);
    if (existing?.dataset.otpState === 'loading') {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Unable to load OTP service')), { once: true });
      return;
    }
    existing?.remove();
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    script.dataset.otpState = 'loading';
    script.onload = () => {
      script.dataset.otpState = 'loaded';
      if (window.initSendOTP) resolve();
      else reject(new Error('Unable to initialize OTP service'));
    };
    script.onerror = () => { script.remove(); reject(new Error('Unable to load OTP service')); };
    document.head.appendChild(script);
  });
}

export function initializeWidget(config: Msg91WidgetConfig) {
  const key = `${config.widgetId}:${config.widgetToken}`;
  if (initialization && initializedKey !== key) throw new Error('OTP configuration changed. Reload and try again.');
  if (!initialization) {
    initializedKey = key;
    initialization = (async () => {
      if (!config.widgetId || !config.widgetToken) throw new Error('OTP service is not configured');
      await loadScript();
      let failure = '';
      window.initSendOTP!({
        widgetId: config.widgetId, tokenAuth: config.widgetToken, exposeMethods: true, captchaRenderId: captchaId,
        success: (data) => { const token = accessToken(data); if (token) { callbackToken = token; listeners.forEach((listener) => listener(token)); } },
        failure: (error) => { failure = safeFailure(error, 'OTP service is unavailable'); },
      });
      const deadline = Date.now() + 15_000;
      while (!window.sendOtp || !window.verifyOtp) {
        if (failure) throw new Error(failure);
        if (Date.now() >= deadline) throw new Error('OTP service is not ready');
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
    })().catch((error) => { initialization = null; initializedKey = ''; throw error; });
  }
  return initialization;
}

export async function sendWidgetOtp(config: Msg91WidgetConfig, mobile: string) {
  await initializeWidget(config);
  callbackToken = '';
  return new Promise<string | undefined>((resolve, reject) => {
    window.sendOtp!(mobile.slice(1), (data) => resolve(value(data, ['reqId', 'req_id', 'requestId']) || undefined),
      (error) => reject(new Error(safeFailure(error, 'Unable to send OTP'))));
  });
}

export async function verifyWidgetOtp(config: Msg91WidgetConfig, code: string, requestId?: string) {
  await initializeWidget(config);
  if (callbackToken) { const token = callbackToken; callbackToken = ''; return token; }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const done = (token: string) => { if (settled) return; settled = true; listeners.delete(onSuccess); callbackToken = ''; resolve(token); };
    const onSuccess = (token: string) => done(token);
    listeners.add(onSuccess);
    window.verifyOtp!(code, (data) => {
      const token = accessToken(data);
      if (token) done(token);
      else window.setTimeout(() => { if (!settled) { listeners.delete(onSuccess); reject(new Error('OTP verification returned no access token')); } }, 750);
    }, (error) => {
      const message = safeFailure(error, 'Invalid or expired code');
      window.setTimeout(() => { if (!settled) { listeners.delete(onSuccess); reject(new Error(message)); } }, /already used/i.test(message) ? 750 : 0);
    }, requestId);
  });
}
