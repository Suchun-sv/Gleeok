import { resolve } from 'node:path';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';

await build({
  entryPoints: { main: 'src/main/index.ts', preload: 'src/preload/index.ts', 'page-preload': 'src/preload/page.ts' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', '@bitwarden/cli', 'node-pty', 'electron-updater'],
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
