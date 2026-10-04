import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { assertDatabaseTarget } from './database-target.js';

loadEnv({ path: resolve(fileURLToPath(new URL('../../../.env', import.meta.url))) });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  EXPECTED_DATABASE_NAME: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  DEV_OTP_ENABLED: z.enum(['true', 'false']).default('false'),
  STAGING_MODE: z.enum(['true', 'false']).default('false'),
  POD_NAMESPACE: z.string().optional(),
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  S3_BUCKET: z.string().min(3).optional(),
  S3_REGION: z.string().min(1).optional(),
  MESSAGING_PROVIDER: z.enum(['mock', 'msg91']).default('mock'),
  MSG91_WHATSAPP_AUTH_KEYS_JSON: z.string().optional(),
  MOCK_MESSAGING_FAIL: z.enum(['true', 'false']).default('false'),
  DEV_OTP_FIXED_CODE: z.string().regex(/^\d{6}$/).optional(),
  DEV_OTP_CODE: z.string().regex(/^\d{6}$/).optional(),
  OTP_PROVIDER: z.enum(['unconfigured', 'msg91', 'MSG91', 'DUMMY_OTP']).default('unconfigured'),
  DUMMY_OTP: z.string().regex(/^\d{6}$/).optional(),
  OTP_HASH_SECRET: z.string().min(32).optional(),
  TRACKING_TOKEN_SECRET: z.string().min(32).optional(),
  TRACKING_EXPIRY_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  MSG91_AUTH_KEY: z.string().min(1).optional(),
  MSG91_WIDGET_ID: z.string().min(1).optional(),
  MSG91_WIDGET_TOKEN: z.string().min(1).optional(),
  MSG91_WIDGET_OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  PAYU_MERCHANT_KEY: z.string().min(1).optional(),
  PAYU_MERCHANT_SALT: z.string().min(1).optional(),
  PAYU_BASE_URL: z.enum(['https://test.payu.in', 'https://secure.payu.in']).optional(),
  BILLING_POLICIES_APPROVED: z.enum(['true', 'false']).default('false'),
  OTP_TTL_MINUTES: z.coerce.number().int().min(1).max(15).default(5),
  OTP_RESEND_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(10).default(5),
  OTP_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
  OTP_MAX_REQUESTS_PER_PHONE_WINDOW: z.coerce.number().int().min(1).max(10).default(5),
  OTP_MAX_REQUESTS_PER_SOURCE_WINDOW: z.coerce.number().int().min(1).max(30).default(12),
  SESSION_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
});

export function getConfig() {
  const env = schema.parse(process.env);
  assertDatabaseTarget(env.DATABASE_URL, env.EXPECTED_DATABASE_NAME, env.NODE_ENV === 'production');
  if (env.STAGING_MODE === 'true' && env.NODE_ENV !== 'production') {
    throw new Error('Staging mode requires production runtime settings');
  }
  if (env.NODE_ENV === 'production' || env.STAGING_MODE === 'true') {
    if (env.DEV_OTP_ENABLED === 'true' || process.env.DEV_OTP_FIXED_CODE !== undefined || process.env.DEV_OTP_CODE !== undefined) throw new Error('Development OTP settings cannot run on public stage or production');
  }
  if (env.NODE_ENV === 'production') {
    if (env.COOKIE_SECURE === 'false' || !env.APP_ORIGIN.startsWith('https://')) {
      throw new Error('Production requires HTTPS origin and secure cookies');
    }
  }
  const payuConfigured = Boolean(env.PAYU_MERCHANT_KEY && env.PAYU_MERCHANT_SALT && env.PAYU_BASE_URL);
  if (!payuConfigured && (env.PAYU_MERCHANT_KEY || env.PAYU_MERCHANT_SALT || env.PAYU_BASE_URL)) throw new Error('PayU requires merchant key, salt and base URL together');
  if (payuConfigured) {
    if (env.STAGING_MODE === 'true' && env.PAYU_BASE_URL !== 'https://test.payu.in') throw new Error('Stage PayU must use the test environment');
    if (env.NODE_ENV !== 'production' && env.PAYU_BASE_URL !== 'https://test.payu.in') throw new Error('Local PayU must use the test environment');
    if (env.NODE_ENV === 'production' && env.STAGING_MODE !== 'true' && env.PAYU_BASE_URL !== 'https://secure.payu.in') throw new Error('Production PayU must use the live environment');
    if (env.NODE_ENV === 'production' && env.STAGING_MODE !== 'true' && env.BILLING_POLICIES_APPROVED !== 'true') throw new Error('Live PayU requires approved billing policies');
  }
  if (env.NODE_ENV === 'production' && env.STAGING_MODE !== 'true' && env.STORAGE_PROVIDER !== 's3') throw new Error('Production requires S3 storage');
  if (env.STORAGE_PROVIDER === 's3' && (!env.S3_BUCKET || !env.S3_REGION)) throw new Error('S3 storage requires S3_BUCKET and S3_REGION');
  let whatsAppKeys: Record<string, string> = {};
  if (env.MSG91_WHATSAPP_AUTH_KEYS_JSON) {
    try { whatsAppKeys = z.record(z.string().regex(/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/), z.string().min(1)).parse(JSON.parse(env.MSG91_WHATSAPP_AUTH_KEYS_JSON)); }
    catch { throw new Error('Invalid MSG91 WhatsApp credential mapping'); }
  }
  if (env.MESSAGING_PROVIDER === 'msg91' && !Object.keys(whatsAppKeys).length) throw new Error('MSG91 WhatsApp requires scoped credential mapping');
  if (env.NODE_ENV === 'production' && env.STAGING_MODE !== 'true' && env.MESSAGING_PROVIDER === 'mock') throw new Error('Mock messaging is limited to local development and stage');
  if (process.env.MSG91_TEMPLATE_ID !== undefined || process.env.OTP_PROVIDER === 'dummy') throw new Error('Unsupported OTP configuration');
  const msg91Otp = env.OTP_PROVIDER === 'msg91' || env.OTP_PROVIDER === 'MSG91';
  const dummyOtp = env.OTP_PROVIDER === 'DUMMY_OTP';
  const msg91Configured = ['MSG91_AUTH_KEY', 'MSG91_WIDGET_ID', 'MSG91_WIDGET_TOKEN'].some((key) => process.env[key] !== undefined);
  if (dummyOtp) {
    if (env.NODE_ENV !== 'production' || env.STAGING_MODE !== 'true' || env.POD_NAMESPACE !== 'kleenbay-stage' || env.EXPECTED_DATABASE_NAME !== 'kleenbay_stage' || env.APP_ORIGIN !== 'https://stage.kleenbay.com') throw new Error('Dummy OTP is restricted to the KleenBay stage deployment');
    if (!env.DUMMY_OTP || !env.OTP_HASH_SECRET || msg91Configured) throw new Error('Stage dummy OTP requires its code and hash secret, without MSG91 credentials');
  } else if (process.env.DUMMY_OTP !== undefined) throw new Error('DUMMY_OTP requires OTP_PROVIDER=DUMMY_OTP');
  if (msg91Otp) {
    if (env.DEV_OTP_ENABLED === 'true' || process.env.DEV_OTP_FIXED_CODE !== undefined || process.env.DEV_OTP_CODE !== undefined || !env.MSG91_AUTH_KEY || !env.MSG91_WIDGET_ID || !env.MSG91_WIDGET_TOKEN || !env.OTP_HASH_SECRET) throw new Error('MSG91 requires its widget, AuthKey and OTP hash secret, without development OTP');
  } else if (msg91Configured) throw new Error('MSG91 credentials require OTP_PROVIDER=msg91');
  if (env.NODE_ENV === 'production' && env.STAGING_MODE !== 'true' && !msg91Otp) throw new Error('Production employee OTP requires MSG91');
  if (env.DEV_OTP_ENABLED === 'true' && !(env.DEV_OTP_FIXED_CODE ?? env.DEV_OTP_CODE)) throw new Error('DEV_OTP_FIXED_CODE is required for local OTP');
  return {
    ...env,
    DEV_OTP_FIXED_CODE: env.DEV_OTP_FIXED_CODE ?? env.DEV_OTP_CODE,
    OTP_HASH_SECRET: env.OTP_HASH_SECRET ?? randomBytes(32).toString('hex'),
    trackingSecret: env.TRACKING_TOKEN_SECRET ?? (env.NODE_ENV === 'production' ? env.OTP_HASH_SECRET! : 'kleenbay-local-tracking-key-not-for-production-v1'),
    secureCookie: env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE === undefined && env.NODE_ENV === 'production'),
    devOtp: env.NODE_ENV !== 'production' && env.DEV_OTP_ENABLED === 'true',
    dummyOtp,
    otpMode: msg91Otp ? 'msg91' as const : dummyOtp ? 'dummy' as const : env.NODE_ENV !== 'production' && env.DEV_OTP_ENABLED === 'true' ? 'development' as const : 'unconfigured' as const,
    stagingMode: env.STAGING_MODE === 'true',
    whatsAppKeys,
    payuConfigured,
  };
}

export type Config = ReturnType<typeof getConfig>;
