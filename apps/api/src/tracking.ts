import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

function key(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'kleenbay-tracking-v1', 'job-token-encryption', 32));
}

export function trackingHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createTrackingToken(secret: string) {
  const token = randomBytes(32).toString('base64url');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { hash: trackingHash(token), ciphertext: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url') };
}

export function readTrackingToken(secret: string, ciphertext: string): string {
  const data = Buffer.from(ciphertext, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key(secret), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

export function trackingUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/track/${token}`;
}
