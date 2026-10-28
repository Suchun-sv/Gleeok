import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';

// Loaded at run time from node_modules, never bundled: a hot update has to find the same ones.
const external = ['electron', '@bitwarden/cli', 'node-pty', 'electron-updater', 'koffi'];

await build({
  entryPoints: { main: 'src/main/index.ts', preload: 'src/preload/index.ts', 'page-preload': 'src/preload/page.ts' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external,
  // server/src (used by local mode) imports hono; resolve it from the app's own node_modules.
  nodePaths: [resolve('node_modules')],
  outdir: 'dist',
  sourcemap: true,
  logLevel: 'info',
});
// Runs in the 文献库 reader page, next to Zotero's reader (app/vendor/zotero-reader).
await build({
  entryPoints: { 'reader-glue': 'src/reader/glue.ts' },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  outdir: 'dist',
  sourcemap: true,
  logLevel: 'info',
});
await viteBuild({ configFile: 'vite.config.mts', logLevel: 'warn' });

// What a hot update (beta channel) must match to run on an installed build: the Electron and the
// modules loaded from node_modules, and boot.js's way of starting it (BOOT).
const BOOT = 1;
const versionOf = (m) => JSON.parse(readFileSync(`node_modules/${m}/package.json`, 'utf8')).version;
const shell = { boot: BOOT, modules: Object.fromEntries(external.map((m) => [m, versionOf(m)])) };
const key = createHash('sha256').update(JSON.stringify(shell)).digest('hex').slice(0, 16);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/shell.json', JSON.stringify({ key, ...shell }, null, 1));

// Which code this is: the commit (CI passes it; else ask git) and when it was built.
let commit = process.env.GLEEOK_COMMIT || process.env.GITHUB_SHA || '';
if (!commit) {
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    commit = 'unknown';
  }
}
writeFileSync('dist/build.json', JSON.stringify({ commit, built: new Date().toISOString() }));
