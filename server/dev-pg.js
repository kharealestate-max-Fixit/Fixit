// Dev launcher: boots a self-contained embedded PostgreSQL (no system install),
// then starts the FixIt server pointed at it. Production uses a managed
// DATABASE_URL with `npm start` instead.
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '.pgdata');
const PG_PORT = parseInt(process.env.PG_PORT || '5433', 10);
const DB_NAME = 'fixit';

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: 'postgres',
  password: 'postgres',
  port: PG_PORT,
  persistent: true,
});

const fresh = !fs.existsSync(DATA_DIR);
if (fresh) {
  console.log('[PG] initialising embedded Postgres data dir…');
  await pg.initialise();
}
await pg.start();
try {
  await pg.createDatabase(DB_NAME);
} catch (e) {
  if (!/already exists/i.test(String(e.message || e))) throw e;
}
console.log(`[PG] embedded Postgres up on port ${PG_PORT} (db "${DB_NAME}")`);

process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost:${PG_PORT}/${DB_NAME}`;
process.env.PGSSL = 'disable';

async function shutdown() {
  try { await pg.stop(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Import the server only after DATABASE_URL is set (db.js builds its pool on import).
await import('./server.js');
