import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';

loadEnv({ path: resolve(fileURLToPath(new URL('../../../.env', import.meta.url))) });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  DEV_OTP_ENABLED: z.enum(['true', 'false']).default('false'),
  DEV_OTP_CODE: z.string().regex(/^\d{6}$/).default('123456'),
  SESSION_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
});

export function getConfig() {
  const env = schema.parse(process.env);
  if (env.NODE_ENV === 'production') {
    if (env.DEV_OTP_ENABLED === 'true') throw new Error('Development OTP cannot run in production');
    if (env.COOKIE_SECURE === 'false' || !env.APP_ORIGIN.startsWith('https://')) {
      throw new Error('Production requires HTTPS origin and secure cookies');
    }
  }
  return {
    ...env,
    secureCookie: env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE === undefined && env.NODE_ENV === 'production'),
    devOtp: env.NODE_ENV !== 'production' && env.DEV_OTP_ENABLED === 'true',
  };
}

export type Config = ReturnType<typeof getConfig>;
