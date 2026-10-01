import { buildApp } from './app.js';
import { getConfig } from './config.js';
import { createDb } from './db.js';

const config = getConfig();
const db = createDb(config.DATABASE_URL);
const app = await buildApp(config, db);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => { await app.close(); await db.$disconnect(); process.exit(0); });
}

try { await app.listen({ host: config.HOST, port: config.PORT }); }
catch (error) { app.log.error(error); await db.$disconnect(); process.exit(1); }
