// hot.json for a beta hot update: node dev/hot-manifest.mjs <hot.tar.gz> (run in app/, after
// npm run build). Says which commit it is, which installed shell it needs (dist/shell.json), its
// SHA-256, and the commits since the last release as notes (see app/src/main/hot-update.ts).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const archive = process.argv[2];
// The release asset's name (hot-<commit>.tar.gz).
const file = process.argv[3] || 'hot.tar.gz';
const build = JSON.parse(readFileSync('dist/build.json', 'utf8'));
const shell = JSON.parse(readFileSync('dist/shell.json', 'utf8'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
let since = '';
try {
  since = git('describe', '--tags', '--abbrev=0', '--match', 'v*');
} catch {}
const notes = git('log', '--format=%s', '-n', '30', since ? `${since}..HEAD` : 'HEAD').split('\n').filter(Boolean);
console.log(
  JSON.stringify(
    {
      commit: build.commit,
      file,
      date: build.built,
      shell: shell.key,
      sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
      size: statSync(archive).size,
      notes,
    },
    null,
    1,
  ),
);
