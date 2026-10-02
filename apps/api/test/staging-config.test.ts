import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { DisabledMessagingProvider } from '../src/messaging.js';
import { createOtpProvider } from '../src/otp.js';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DATABASE_URL', 'postgresql://stage:secret@localhost:5432/kleenbay_stage');
  vi.stubEnv('EXPECTED_DATABASE_NAME', 'kleenbay_stage');
  vi.stubEnv('APP_ORIGIN', 'https://stage.kleenbay.com');
  vi.stubEnv('COOKIE_SECURE', 'true');
  vi.stubEnv('DEV_OTP_ENABLED', 'false');
  vi.stubEnv('STAGING_MODE', 'true');
});

afterEach(() => vi.unstubAllEnvs());

describe('public staging safeguards', () => {
  it('runs with secure production settings and explicit stage mode', async () => {
    const config = getConfig();
    expect(config.secureCookie).toBe(true);
    expect(config.devOtp).toBe(false);
    expect(config.stagingMode).toBe(true);
    const db = createDb(config.DATABASE_URL);
    const app = await buildApp(config, db);
    try {
      expect((await app.inject('/health')).statusCode).toBe(200);
    } finally {
      await app.close();
      await db.$disconnect();
    }
  });

  it('refuses a fixed OTP and does not claim simulated messages were sent', async () => {
    vi.stubEnv('DEV_OTP_ENABLED', 'true');
    expect(() => getConfig()).toThrow('Development OTP cannot run in production');
    vi.stubEnv('DEV_OTP_ENABLED', 'false');
    await expect(
      createOtpProvider(getConfig()).send('+919876543210', '123456'),
    ).rejects.toMatchObject({ statusCode: 503, code: 'OTP_UNAVAILABLE' });
    await expect(new DisabledMessagingProvider().send()).rejects.toThrow('not configured');
  });

  it('refuses staging mode with development runtime settings', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(() => getConfig()).toThrow('Staging mode requires production runtime settings');
  });

  it('accepts only sandbox PayU credentials on stage', () => {
    vi.stubEnv('PAYU_MERCHANT_KEY', 'test-key');
    expect(() => getConfig()).toThrow('PayU requires merchant key, salt and base URL together');
    vi.stubEnv('PAYU_MERCHANT_SALT', 'test-salt');
    vi.stubEnv('PAYU_BASE_URL', 'https://secure.payu.in');
    expect(() => getConfig()).toThrow('Stage PayU must use the test environment');
    vi.stubEnv('PAYU_BASE_URL', 'https://test.payu.in');
    expect(getConfig().payuConfigured).toBe(true);
  });

  it('requires approved policies before live PayU can be enabled', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://prod:secret@localhost:5432/kleenbay');
    vi.stubEnv('EXPECTED_DATABASE_NAME', 'kleenbay');
    vi.stubEnv('APP_ORIGIN', 'https://kleenbay.com');
    vi.stubEnv('STAGING_MODE', 'false');
    vi.stubEnv('PAYU_MERCHANT_KEY', 'live-key');
    vi.stubEnv('PAYU_MERCHANT_SALT', 'live-salt');
    vi.stubEnv('PAYU_BASE_URL', 'https://secure.payu.in');
    expect(() => getConfig()).toThrow('Live PayU requires approved billing policies');
  });
});
