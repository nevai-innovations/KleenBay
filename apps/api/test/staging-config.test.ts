import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createMessagingProvider, MockMessagingProvider } from '../src/messaging.js';
import { createOtpProvider } from '../src/otp.js';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DATABASE_URL', 'postgresql://stage:secret@localhost:5432/kleenbay_stage');
  vi.stubEnv('EXPECTED_DATABASE_NAME', 'kleenbay_stage');
  vi.stubEnv('APP_ORIGIN', 'https://stage.kleenbay.com');
  vi.stubEnv('COOKIE_SECURE', 'true');
  vi.stubEnv('DEV_OTP_ENABLED', 'false');
  vi.stubEnv('DEV_OTP_CODE', undefined);
  vi.stubEnv('DEV_OTP_FIXED_CODE', undefined);
  vi.stubEnv('POD_NAMESPACE', undefined);
  vi.stubEnv('DUMMY_OTP', undefined);
  vi.stubEnv('OTP_PROVIDER', 'unconfigured');
  vi.stubEnv('OTP_HASH_SECRET', undefined);
  vi.stubEnv('MSG91_AUTH_KEY', undefined);
  vi.stubEnv('MSG91_WIDGET_ID', undefined);
  vi.stubEnv('MSG91_WIDGET_TOKEN', undefined);
  vi.stubEnv('STAGING_MODE', 'true');
  vi.stubEnv('MESSAGING_PROVIDER', 'mock');
  vi.stubEnv('MOCK_MESSAGING_FAIL', 'false');
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

  it('allows the shared test code only for the exact KleenBay stage runtime', () => {
    vi.stubEnv('OTP_PROVIDER', 'DUMMY_OTP');
    vi.stubEnv('DUMMY_OTP', '123456');
    vi.stubEnv('OTP_HASH_SECRET', 'stage-test-hash-secret-not-for-real-use');
    vi.stubEnv('POD_NAMESPACE', 'kleenbay-stage');
    expect(getConfig()).toMatchObject({ otpMode: 'dummy', dummyOtp: true, devOtp: false, DUMMY_OTP: '123456' });
    vi.stubEnv('POD_NAMESPACE', 'kleenbay-prod');
    expect(() => getConfig()).toThrow('restricted to the KleenBay stage');
    vi.stubEnv('POD_NAMESPACE', 'kleenbay-stage');
    vi.stubEnv('APP_ORIGIN', 'https://kleenbay.com');
    expect(() => getConfig()).toThrow('restricted to the KleenBay stage');
    vi.stubEnv('APP_ORIGIN', 'https://stage.kleenbay.com');
    vi.stubEnv('EXPECTED_DATABASE_NAME', 'kleenbay');
    vi.stubEnv('DATABASE_URL', 'postgresql://prod:secret@localhost:5432/kleenbay');
    expect(() => getConfig()).toThrow('restricted to the KleenBay stage');
  });

  it('requires a stage code and secret, and cannot mix dummy and MSG91 settings', () => {
    vi.stubEnv('OTP_PROVIDER', 'DUMMY_OTP');
    vi.stubEnv('POD_NAMESPACE', 'kleenbay-stage');
    vi.stubEnv('OTP_HASH_SECRET', 'stage-test-hash-secret-not-for-real-use');
    expect(() => getConfig()).toThrow('requires its code and hash secret');
    vi.stubEnv('DUMMY_OTP', '123456');
    vi.stubEnv('MSG91_AUTH_KEY', 'not-a-real-key');
    expect(() => getConfig()).toThrow('without MSG91 credentials');
    vi.stubEnv('MSG91_AUTH_KEY', undefined);
    vi.stubEnv('OTP_PROVIDER', 'MSG91');
    expect(() => getConfig()).toThrow('DUMMY_OTP requires OTP_PROVIDER=DUMMY_OTP');
  });

  it('refuses a fixed OTP while allowing only simulated stage messaging', async () => {
    vi.stubEnv('DEV_OTP_ENABLED', 'true');
    expect(() => getConfig()).toThrow('Development OTP settings cannot run on public stage or production');
    vi.stubEnv('DEV_OTP_ENABLED', 'false');
    vi.stubEnv('DEV_OTP_FIXED_CODE', '123456');
    expect(() => getConfig()).toThrow('Development OTP settings cannot run on public stage or production');
    vi.stubEnv('DEV_OTP_FIXED_CODE', undefined);
    await expect(
      createOtpProvider(getConfig()).verifyAccessToken('a'.repeat(32)),
    ).rejects.toMatchObject({ statusCode: 503, code: 'OTP_UNAVAILABLE' });
    const provider = createMessagingProvider(getConfig());
    expect(provider).toBeInstanceOf(MockMessagingProvider);
    expect(provider.name).toBe('MOCK');
    expect(await provider.send({ recipient: '+919876543210', text: 'test', templateKey: 'VEHICLE_RECEIVED', idempotencyKey: 'test' })).toEqual({ providerMessageId: 'mock:test' });
  });

  it('supports a failing mock without contacting a provider', async () => {
    vi.stubEnv('MOCK_MESSAGING_FAIL', 'true');
    await expect(createMessagingProvider(getConfig()).send({ recipient: '+919876543210', text: 'test', templateKey: 'VEHICLE_RECEIVED', idempotencyKey: 'test' })).rejects.toThrow('Simulated provider failure');
  });

  it('does not allow mock messaging in production or a premature MSG91 adapter', () => {
    vi.stubEnv('STAGING_MODE', 'false');
    expect(() => getConfig()).toThrow('Mock messaging is limited');
    vi.stubEnv('MESSAGING_PROVIDER', 'msg91');
    expect(() => getConfig()).toThrow('MSG91 WhatsApp messaging is not configured');
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
