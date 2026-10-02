import { describe, expect, it } from 'vitest';
import { getConfig } from '../src/config.js';
import { createTrackingToken, readTrackingToken, trackingHash } from '../src/tracking.js';

describe('job tracking tokens', () => {
  it('uses a stable local key and random encrypted, hashable tokens', () => {
    const secret = getConfig().trackingSecret;
    expect(getConfig().trackingSecret).toBe(secret);
    const first = createTrackingToken(secret);
    const second = createTrackingToken(secret);
    const token = readTrackingToken(secret, first.ciphertext);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.hash).toBe(trackingHash(token));
    expect(first.hash).not.toBe(second.hash);
    expect(first.ciphertext).not.toContain(token);
    expect(readTrackingToken(getConfig().trackingSecret, first.ciphertext)).toBe(token);
    expect(() => readTrackingToken('another-long-local-test-secret-not-valid', first.ciphertext)).toThrow();
  });
});
