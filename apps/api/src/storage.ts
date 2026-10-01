import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StorageProvider {
  put(input: { organizationId: string; jobId: string; extension: 'jpg' | 'png' | 'webp'; data: Buffer }): Promise<string>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly root = resolve(fileURLToPath(new URL('../../../.local-data/uploads/', import.meta.url)))) {}

  private path(key: string) {
    if (!/^[a-zA-Z0-9/_-]+\.(jpg|png|webp)$/.test(key)) throw new Error('Invalid storage key');
    const path = resolve(this.root, key);
    if (!path.startsWith(`${this.root}${sep}`)) throw new Error('Invalid storage key');
    return path;
  }

  async put(input: { organizationId: string; jobId: string; extension: 'jpg' | 'png' | 'webp'; data: Buffer }) {
    const key = `${input.organizationId}/${input.jobId}/${randomUUID()}.${input.extension}`;
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.data, { flag: 'wx' });
    return key;
  }

  get(key: string) { return readFile(this.path(key)); }
  async remove(key: string) { await rm(this.path(key), { force: true }); }
}

export function imageType(data: Buffer): { mimeType: string; extension: 'jpg' | 'png' | 'webp' } | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { mimeType: 'image/jpeg', extension: 'jpg' };
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mimeType: 'image/png', extension: 'png' };
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return { mimeType: 'image/webp', extension: 'webp' };
  return null;
}
