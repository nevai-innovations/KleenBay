import { defineConfig } from 'prisma/config';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { assertDatabaseTarget } from './src/database-target.js';

config({ path: resolve(fileURLToPath(new URL('../../.env', import.meta.url))) });

const databaseUrl = process.env.DATABASE_URL ?? '';
if (databaseUrl) {
  assertDatabaseTarget(databaseUrl, process.env.EXPECTED_DATABASE_NAME, process.env.NODE_ENV === 'production');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: databaseUrl },
});
