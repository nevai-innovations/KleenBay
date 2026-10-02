import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@carwash/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) } },
  test: { pool: 'forks', fileParallelism: false, hookTimeout: 30_000, testTimeout: 20_000 },
});
