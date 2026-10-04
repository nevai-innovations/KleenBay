import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageProvider, S3StorageProvider } from '../src/storage.js';
import { MockMessagingProvider, Msg91WhatsAppProvider } from '../src/messaging.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
let directory = '';
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = ''; });

describe('storage providers', () => {
  it('stores and removes local images under the tenant and job', async () => {
    directory = await mkdtemp(join(tmpdir(), 'kleenbay-storage-'));
    const storage = new LocalStorageProvider(directory);
    const key = await storage.put({ organizationId: 'tenant-a', jobId: 'job-a', extension: 'jpg', data: jpeg });
    expect(key).toMatch(/^tenant-a\/job-a\/[^/]+\.jpg$/);
    expect(await storage.get(key)).toEqual(jpeg);
    await expect(storage.get('../secrets.jpg')).rejects.toThrow('Invalid storage key');
    await storage.remove(key);
    await expect(storage.get(key)).rejects.toThrow();
    await expect(storage.put({ organizationId: 'tenant-a', jobId: 'job-a', extension: 'png', data: jpeg })).rejects.toThrow('Invalid image');
  });

  it('uses private S3 object keys and validates files before upload', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => jpeg } };
      return {};
    });
    const storage = new S3StorageProvider('private-test-bucket', { send } as unknown as S3Client);
    const key = await storage.put({ organizationId: 'tenant-a', jobId: 'job-a', extension: 'jpg', data: jpeg });
    expect(key).toMatch(/^tenant-a\/job-a\/[^/]+\.jpg$/);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect((send.mock.calls[0]?.[0] as PutObjectCommand).input).toMatchObject({ Bucket: 'private-test-bucket', Key: key, ContentType: 'image/jpeg', ServerSideEncryption: 'AES256' });
    expect(await storage.get(key)).toEqual(jpeg);
    await storage.remove(key);
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(DeleteObjectCommand);
    await expect(storage.get('../other.jpg')).rejects.toThrow('Invalid storage key');
    await expect(storage.put({ organizationId: 'tenant-a', jobId: 'job-a', extension: 'png', data: jpeg })).rejects.toThrow('Invalid image');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('creates a short-lived signed private URL without contacting S3', async () => {
    const storage = new S3StorageProvider('private-test-bucket', new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'local-test', secretAccessKey: 'local-test-secret' } }));
    const url = await storage.signedReadUrl('tenant-a/job-a/00000000-0000-0000-0000-000000000000.jpg', 60);
    expect(url).toContain('X-Amz-Expires=60');
    expect(url).toContain('tenant-a/job-a/');
    expect(() => storage.signedReadUrl('../private.jpg')).toThrow('Invalid storage key');
    expect(() => storage.signedReadUrl('tenant-a/job-a/00000000-0000-0000-0000-000000000000.jpg', 901)).toThrow('Invalid signed URL lifetime');
  });
});

describe('messaging providers', () => {
  const message = { recipient: '+919876543210', text: 'test', templateKey: 'vehicle_ready', templateVariables: ['Asha', 'KA01AB1234', 'KleenBay', 'https://example.com/track/token'], idempotencyKey: 'job:event', organizationId: 'tenant-a', senderNumber: '+919999999999', integratedNumberId: 'integrated-a', credentialRef: 'primary' };

  it('keeps mock sends deterministic and supports simulated failure', async () => {
    expect(await new MockMessagingProvider().send(message)).toEqual({ providerMessageId: 'mock:job:event' });
    await expect(new MockMessagingProvider(true).send(message)).rejects.toThrow('Simulated provider failure');
  });

  it('sends a scoped MSG91 approved-template request without leaking the key', async () => {
    const request = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ message_id: 'provider-id' }), { status: 200 }));
    const provider = new Msg91WhatsAppProvider({ 'tenant-a:primary': 'secret-a' }, request as typeof fetch);
    expect(await provider.send(message)).toEqual({ providerMessageId: 'provider-id' });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/');
    expect(init.headers).toMatchObject({ authkey: 'secret-a' });
    const body = JSON.parse(String(init.body));
    expect(body.payload.template.to_and_components[0]).toMatchObject({ to: ['919876543210'], components: { body_1: { type: 'text', value: 'Asha' } } });
    expect(JSON.stringify(body)).not.toContain('secret-a');
    await expect(provider.send({ ...message, organizationId: 'tenant-b' })).rejects.toThrow('not configured');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fails closed on provider errors', async () => {
    const provider = new Msg91WhatsAppProvider({ 'tenant-a:primary': 'secret-a' }, async () => new Response('{}', { status: 429 }));
    await expect(provider.send(message)).rejects.toThrow('MSG91 rejected');
    const acceptedError = new Msg91WhatsAppProvider({ 'tenant-a:primary': 'secret-a' }, async () => new Response('{"status":"error"}', { status: 200 }));
    await expect(acceptedError.send(message)).rejects.toThrow('MSG91 rejected');
    await expect(provider.send({ ...message, recipient: '+1234' })).rejects.toThrow('not configured');
  });
});
