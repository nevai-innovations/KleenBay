import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';

afterEach(() => vi.unstubAllEnvs());

describe('reverse proxy trust and rate limiting', () => {
  it('uses only the configured nearest proxy, not attacker-controlled leftmost X-Forwarded-For', async () => {
    vi.stubEnv('TRUST_PROXY_HOPS', '1');
    vi.stubEnv('LOG_LEVEL', 'silent');
    const config = getConfig();
    const db = createDb(config.DATABASE_URL);
    const app = await buildApp(config, db);
    app.get('/test-ip', async (request) => ({ ip: request.ip }));
    try {
      const first = await app.inject({ url: '/test-ip', headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.10' } });
      const second = await app.inject({ url: '/test-ip', headers: { 'x-forwarded-for': '198.51.100.2, 203.0.113.10' } });
      expect(first.json()).toEqual({ ip: '203.0.113.10' });
      expect(second.json()).toEqual({ ip: '203.0.113.10' });
      for (let i = 0; i < 118; i++) await app.inject({ url: '/health', headers: { 'x-forwarded-for': `198.51.100.${i % 255}, 203.0.113.10` } });
      const blocked = await app.inject({ url: '/health', headers: { 'x-forwarded-for': '192.0.2.99, 203.0.113.10' } });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('RATE_LIMITED');
    } finally { await app.close(); await db.$disconnect(); }
  });

  it('ignores forwarded headers when no proxy is trusted', async () => {
    vi.stubEnv('TRUST_PROXY_HOPS', '0');
    vi.stubEnv('LOG_LEVEL', 'silent');
    const config = getConfig();
    const db = createDb(config.DATABASE_URL);
    const app = await buildApp(config, db);
    app.get('/test-ip', async (request) => ({ ip: request.ip }));
    try {
      const response = await app.inject({ url: '/test-ip', headers: { 'x-forwarded-for': '203.0.113.10' } });
      expect(response.json().ip).not.toBe('203.0.113.10');
    } finally { await app.close(); await db.$disconnect(); }
  });
});

describe('web security headers', () => {
  it('sets CSP and baseline protections for both app and tracking routes', async () => {
    const config = await readFile(new URL('../../../docker/web.nginx.conf', import.meta.url), 'utf8');
    expect(config.match(/add_header Content-Security-Policy/g)).toHaveLength(2);
    expect(config.match(/add_header X-Frame-Options DENY always/g)).toHaveLength(2);
    expect(config.match(/add_header X-Content-Type-Options nosniff always/g)).toHaveLength(2);
    expect(config).toContain("script-src 'self' https://verify.msg91.com");
    expect(config).toContain("frame-ancestors 'none'");
  });
});
