import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
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
  DEV_OTP_CODE: z.string().regex(/^\d{6}$/).default('123456'),
  PAYU_MERCHANT_KEY: z.string().min(1).optional(),
  PAYU_MERCHANT_SALT: z.string().min(1).optional(),
  PAYU_BASE_URL: z.enum(['https://test.payu.in', 'https://secure.payu.in']).optional(),
  BILLING_POLICIES_APPROVED: z.enum(['true', 'false']).default('false'),
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
  if (env.NODE_ENV === 'production') {
    if (env.DEV_OTP_ENABLED === 'true') throw new Error('Development OTP cannot run in production');
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
  return {
    ...env,
    payuConfigured,
    secureCookie: env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE === undefined && env.NODE_ENV === 'production'),
    devOtp: env.NODE_ENV !== 'production' && env.DEV_OTP_ENABLED === 'true',
    stagingMode: env.STAGING_MODE === 'true',
  };
}

export type Config = ReturnType<typeof getConfig>;
