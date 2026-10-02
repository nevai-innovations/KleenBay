import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { HttpError } from './errors.js';

const VERIFY_URL = 'https://control.msg91.com/api/v5/widget/verifyAccessToken';

export interface OtpProvider {
  verifyAccessToken(accessToken: string): Promise<string>;
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const stringValue = (value: RecordValue | null, keys: string[]) => keys.map((key) => value?.[key]).find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);

function tokenExpired(accessToken: string) {
  try {
    const payload = record(JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')));
    return typeof payload?.exp === 'number' && Number.isFinite(payload.exp) && payload.exp * 1000 <= Date.now();
  } catch { return false; }
}

export function hashOtp(value: string, secret: string) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function matchesOtp(expected: string, actual: string) {
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(actual, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createChallengeSecret() {
  return randomBytes(32).toString('base64url');
}

export function createOtpProvider(config: Config, fetchImpl: typeof fetch = fetch): OtpProvider {
  return {
    async verifyAccessToken(accessToken: string) {
      if (config.otpMode !== 'msg91' || !config.MSG91_AUTH_KEY) throw new HttpError(503, 'OTP_UNAVAILABLE', 'Employee OTP is not configured');
      if (accessToken.length < 32 || accessToken.length > 8192 || /\s/.test(accessToken)) throw new HttpError(401, 'INVALID_OTP', 'Invalid or expired code');
      let response: Response;
      let payload: unknown;
      try {
        response = await fetchImpl(VERIFY_URL, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ authkey: config.MSG91_AUTH_KEY, 'access-token': accessToken }),
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
        });
        payload = await response.json();
      } catch {
        throw new HttpError(503, 'OTP_PROVIDER_UNAVAILABLE', 'OTP verification is temporarily unavailable');
      }
      const root = record(payload);
      const status = stringValue(root, ['type', 'status']);
      const identifier = stringValue(record(root?.data), ['identifier', 'mobile', 'mobileNumber', 'phone'])
        ?? stringValue(record(root?.message), ['identifier', 'mobile', 'mobileNumber', 'phone'])
        ?? stringValue(root, ['identifier', 'mobile', 'mobileNumber', 'phone'])
        ?? (typeof root?.message === 'string' && /^\+?\d{7,15}$/.test(root.message.trim()) ? root.message.trim() : undefined);
      if (!response.ok || (status && !/success|verified/i.test(status)) || !identifier || tokenExpired(accessToken)) throw new HttpError(401, 'INVALID_OTP', 'Invalid or expired code');
      return identifier;
    },
  };
}
