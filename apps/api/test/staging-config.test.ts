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
    expect(provider.forProvider!('MOCK')).toBeInstanceOf(MockMessagingProvider);
    expect(provider.name).toBe('MOCK');
    expect(await provider.send({ recipient: '+919876543210', text: 'test', templateKey: 'VEHICLE_RECEIVED', idempotencyKey: 'test' })).toEqual({ providerMessageId: 'mock:test' });
  });

  it('supports a failing mock without contacting a provider', async () => {
    vi.stubEnv('MOCK_MESSAGING_FAIL', 'true');
    await expect(createMessagingProvider(getConfig()).send({ recipient: '+919876543210', text: 'test', templateKey: 'VEHICLE_RECEIVED', idempotencyKey: 'test' })).rejects.toThrow('Simulated provider failure');
  });

  it('requires S3, MSG91 messaging and real OTP in production', async () => {
    vi.stubEnv('STAGING_MODE', 'false');
    expect(() => getConfig()).toThrow('Production requires S3 storage');
    vi.stubEnv('STORAGE_PROVIDER', 's3');
    expect(() => getConfig()).toThrow('S3 storage requires');
    vi.stubEnv('S3_BUCKET', 'kleenbay-private-test');
    vi.stubEnv('S3_REGION', 'us-east-1');
    expect(() => getConfig()).toThrow('Mock messaging is limited');
    vi.stubEnv('MESSAGING_PROVIDER', 'msg91');
    expect(() => getConfig()).toThrow('MSG91 WhatsApp requires scoped credential mapping');
    vi.stubEnv('MSG91_WHATSAPP_AUTH_KEYS_JSON', '{"tenant-a:primary":"test-secret"}');
    expect(() => getConfig()).toThrow('Production employee OTP requires MSG91');
    vi.stubEnv('OTP_PROVIDER', 'MSG91');
    vi.stubEnv('MSG91_AUTH_KEY', 'test-otp-key');
    vi.stubEnv('MSG91_WIDGET_ID', 'widget');
    vi.stubEnv('MSG91_WIDGET_TOKEN', 'test-widget-token');
    vi.stubEnv('OTP_HASH_SECRET', 'a-test-hash-secret-over-thirty-two-chars');
    const config = getConfig();
    expect(config).toMatchObject({ STORAGE_PROVIDER: 's3', MESSAGING_PROVIDER: 'msg91', otpMode: 'msg91' });
    const db = createDb(config.DATABASE_URL);
    const app = await buildApp(config, db);
    try { expect((await app.inject('/health')).statusCode).toBe(200); }
    finally { await app.close(); await db.$disconnect(); }
  });

  it('refuses staging mode with development runtime settings', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(() => getConfig()).toThrow('Staging mode requires production runtime settings');
  });

  it('accepts only test Razorpay credentials on stage and requires a webhook secret', () => {
    vi.stubEnv('RAZORPAY_KEY_ID', 'rzp_test_local');
    expect(() => getConfig()).toThrow('Razorpay requires key ID and key secret together');
    vi.stubEnv('RAZORPAY_KEY_SECRET', 'test-secret');
    expect(() => getConfig()).toThrow('Public Razorpay requires a webhook secret');
    vi.stubEnv('RAZORPAY_WEBHOOK_SECRET', 'test-webhook-secret-long');
    expect(getConfig().razorpayConfigured).toBe(true);
    vi.stubEnv('RAZORPAY_ENV', 'live');
    expect(() => getConfig()).toThrow('must use test mode');
    vi.stubEnv('RAZORPAY_ENV', 'test');
    vi.stubEnv('RAZORPAY_KEY_ID', 'rzp_live_forbidden');
    expect(() => getConfig()).toThrow('must use test mode');
  });

  it('requires approved policies before live Razorpay can be enabled', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://prod:secret@localhost:5432/kleenbay');
    vi.stubEnv('EXPECTED_DATABASE_NAME', 'kleenbay');
    vi.stubEnv('APP_ORIGIN', 'https://kleenbay.com');
    vi.stubEnv('STAGING_MODE', 'false');
    vi.stubEnv('RAZORPAY_KEY_ID', 'rzp_live_local');
    vi.stubEnv('RAZORPAY_KEY_SECRET', 'live-secret');
    vi.stubEnv('RAZORPAY_ENV', 'live');
    expect(() => getConfig()).toThrow('Live Razorpay requires approved billing policies');
  });
});
