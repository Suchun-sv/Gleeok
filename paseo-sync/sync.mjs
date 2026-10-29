#!/usr/bin/env node
// Push this machine's Paseo project catalog to the Gleeok server.
//
// Runs next to a Paseo daemon (the daemon only listens on localhost). Needs no npm install:
// it borrows @getpaseo/client from the installed `paseo` CLI.
//
//   node paseo-sync/sync.mjs [--dry-run]
//
// Env: PASEO_URL (default http://127.0.0.1:6767), PASEO_PASSWORD, PASEO_WEB_BASE
// (default https://app.paseo.sh), GLEEOK_CLIENT_CONFIG (default ~/.config/gleeok/client.json).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dryRun = process.argv.includes('--dry-run');
const daemonHttp = (process.env.PASEO_URL ?? 'http://127.0.0.1:6767').replace(/\/$/, '');
const webBase = process.env.PASEO_WEB_BASE ?? 'https://app.paseo.sh';
const gleeok = JSON.parse(
  readFileSync(process.env.GLEEOK_CLIENT_CONFIG ?? join(homedir(), '.config/gleeok/client.json'), 'utf8'),
);

function findClientEntry() {
  const cli = realpathSync(execFileSync('which', ['paseo'], { encoding: 'utf8' }).trim());
  for (let dir = dirname(cli); dir !== '/'; dir = dirname(dir)) {
    const entry = join(dir, 'node_modules/@getpaseo/client/dist/index.js');
    if (existsSync(entry)) return entry;
  }
  throw new Error(`@getpaseo/client not found next to ${cli}`);
}

const status = await (await fetch(`${daemonHttp}/api/status`)).json();
const { createPaseoClient } = await import(pathToFileURL(findClientEntry()).href);
const client = createPaseoClient({
  url: `${daemonHttp.replace(/^http/, 'ws')}/ws`,
  password: process.env.PASEO_PASSWORD || undefined,
});
await client.connect();

const { projects } = await client.projects.list();
const workspaces = [];
let cursor;
do {
  const page = await client.workspaces.list({ page: { limit: 200, cursor } });
  workspaces.push(...page.entries);
  cursor = page.pageInfo?.nextCursor;
} while (cursor);

// "Most recently used": activityAt when the daemon reports it, else when the workspace last
// changed status (an agent started or finished there).
const usedAt = (w) => w.activityAt ?? w.statusEnteredAt ?? null;

const catalog = projects.map((p) => {
  const own = workspaces.filter((w) => w.projectId === p.projectId && !w.archivingAt && !w.background);
  own.sort((a, b) => (usedAt(b) ?? '').localeCompare(usedAt(a) ?? ''));
  const top = own[0];
  return {
    projectId: p.projectId,
    name: p.projectDisplayName,
    path: p.projectRootPath,
    workspaceCount: own.length,
    latest: top ? { workspaceId: top.id, name: top.name, at: usedAt(top), dir: top.workspaceDirectory ?? null } : null,
  };
});

// A terminal in each project's latest workspace, if one is open, for a direct "终端" link.
await Promise.all(
  catalog.map(async (p) => {
    if (!p.latest) return;
    const r = await client.terminals.list({ workspaceId: p.latest.workspaceId }).catch(() => null);
    p.latest.terminalId = r?.entries[0]?.id ?? null;
  }),
);
await client.close();

const body = { hostname: status.hostname, version: status.version, webBase, projects: catalog };
if (dryRun) {
  console.log(JSON.stringify({ serverId: status.serverId, ...body }, null, 2));
  process.exit(0);
}

const res = await fetch(new URL(`/api/paseo/daemons/${status.serverId}`, gleeok.serverUrl), {
  method: 'PUT',
  headers: { authorization: `Bearer ${gleeok.token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
if (!res.ok) throw new Error(`gleeok server: ${res.status} ${await res.text()}`);
console.log(`${status.hostname} (${status.serverId}): ${catalog.length} projects synced`, await res.json());
// The Paseo client can leave a socket open after close(); a run that never ends keeps the timer
// from starting the next one (the catalog went 2 days stale on 2026-10-27).
process.exit(0);
