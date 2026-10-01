import type { Config } from './config.js';

export interface OtpProvider {
  send(mobile: string, code: string): Promise<void>;
}

class DevelopmentOtpProvider implements OtpProvider {
  async send(_mobile: string, _code: string) { /* The local code is documented in .env.example. */ }
}

class UnconfiguredOtpProvider implements OtpProvider {
  async send() { throw new Error('OTP provider is not configured'); }
}

export function createOtpProvider(config: Config): OtpProvider {
  return config.devOtp ? new DevelopmentOtpProvider() : new UnconfiguredOtpProvider();
}
