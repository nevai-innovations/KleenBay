import { defineConfig } from 'prisma/config';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

config({ path: resolve(fileURLToPath(new URL('../../.env', import.meta.url))) });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
