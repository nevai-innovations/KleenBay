import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from './config.js';

const maxImageBytes = 8 * 1024 * 1024;
const keyPattern = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[a-f0-9-]+\.(jpg|png|webp)$/;

function checkedKey(key: string) {
  if (!keyPattern.test(key)) throw new Error('Invalid storage key');
  return key;
}

function checkedImage(input: { extension: 'jpg' | 'png' | 'webp'; data: Buffer }) {
  const type = imageType(input.data);
  if (!type || type.extension !== input.extension || input.data.length > maxImageBytes) throw new Error('Invalid image');
  return type;
}

export interface StorageProvider {
  put(input: { organizationId: string; jobId: string; extension: 'jpg' | 'png' | 'webp'; data: Buffer }): Promise<string>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly root = resolve(fileURLToPath(new URL('../../../.local-data/uploads/', import.meta.url)))) {}

  private path(key: string) {
    const path = resolve(this.root, checkedKey(key));
    if (!path.startsWith(`${this.root}${sep}`)) throw new Error('Invalid storage key');
    return path;
  }

  async put(input: { organizationId: string; jobId: string; extension: 'jpg' | 'png' | 'webp'; data: Buffer }) {
    checkedImage(input);
    const key = `${input.organizationId}/${input.jobId}/${randomUUID()}.${input.extension}`;
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.data, { flag: 'wx' });
    return key;
  }

  async get(key: string) { return readFile(this.path(key)); }
  async remove(key: string) { await rm(this.path(key), { force: true }); }
}

export class S3StorageProvider implements StorageProvider {
  constructor(private readonly bucket: string, private readonly client: S3Client) {}

  async put(input: { organizationId: string; jobId: string; extension: 'jpg' | 'png' | 'webp'; data: Buffer }) {
    const type = checkedImage(input);
    const key = checkedKey(`${input.organizationId}/${input.jobId}/${randomUUID()}.${input.extension}`);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: input.data, ContentType: type.mimeType, ServerSideEncryption: 'AES256' }));
    return key;
  }

  async get(key: string) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: checkedKey(key) }));
    if (!result.Body) throw new Error('Stored object has no body');
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: checkedKey(key) }));
  }

  signedReadUrl(key: string, expiresIn = 300) {
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 900) throw new Error('Invalid signed URL lifetime');
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: checkedKey(key) }), { expiresIn });
  }
}

export function createStorageProvider(config: Config): StorageProvider {
  if (config.STORAGE_PROVIDER === 's3') return new S3StorageProvider(config.S3_BUCKET!, new S3Client({ region: config.S3_REGION! }));
  return new LocalStorageProvider();
}

export function imageType(data: Buffer): { mimeType: string; extension: 'jpg' | 'png' | 'webp' } | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { mimeType: 'image/jpeg', extension: 'jpg' };
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mimeType: 'image/png', extension: 'png' };
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return { mimeType: 'image/webp', extension: 'webp' };
  return null;
}
