import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { Library } from './library.ts';
import { Planner } from './planner.ts';
import { Store } from './store.ts';

const token = process.env.GLEEOK_TOKEN;
if (!token) {
  console.error('GLEEOK_TOKEN is not set');
  process.exit(1);
}
const hostname = process.env.GLEEOK_HOST ?? '127.0.0.1';
const port = Number(process.env.GLEEOK_PORT ?? 7420);
const dbPath = process.env.GLEEOK_DB ?? join(homedir(), '.local/share/gleeok/gleeok.db');
mkdirSync(dirname(dbPath), { recursive: true });

// The 文献库: library.db and the attachment files, next to the main database unless set.
const libraryDir = process.env.GLEEOK_LIBRARY_DIR ?? dirname(dbPath);

const app = createApp(new Store(dbPath), {
  token,
  vaultUrl: process.env.GLEEOK_VAULT_URL || undefined,
  library: new Library(libraryDir),
  planner: new Planner(libraryDir),
});

serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`gleeok server listening on http://${info.address}:${info.port} (db ${dbPath}, library ${libraryDir})`);
});
