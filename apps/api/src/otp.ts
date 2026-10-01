import type { Config } from './config.js';
import { HttpError } from './errors.js';

export interface OtpProvider {
  send(mobile: string, code: string): Promise<void>;
}

class DevelopmentOtpProvider implements OtpProvider {
  async send(_mobile: string, _code: string) { /* The local code is documented in .env.example. */ }
}

class UnconfiguredOtpProvider implements OtpProvider {
  async send() { throw new HttpError(503, 'OTP_UNAVAILABLE', 'Employee OTP is not configured'); }
}

export function createOtpProvider(config: Config): OtpProvider {
  return config.devOtp ? new DevelopmentOtpProvider() : new UnconfiguredOtpProvider();
}
