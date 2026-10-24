import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * Self-update when running from a git checkout (the usual way to run Gleeok): pull, install,
 * build, restart. Packaged builds and copies without .git do not offer it.
 */
const appDir = app.getAppPath();
const repoDir = join(appDir, '..');

export function canSelfUpdate() {
  return !app.isPackaged && existsSync(join(repoDir, '.git'));
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // npm is npm.cmd on Windows, which needs a shell to start.
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32', env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} ${args.join(' ')}: ${out.trim().split('\n').slice(-3).join(' ')}`))));
  });
}

/** Commits on the remote branch that this checkout does not have yet (subjects, newest first). */
export async function pendingUpdates(): Promise<{ head: string; commits: string[] }> {
  await run('git', ['fetch', '--quiet'], repoDir);
  const head = await run('git', ['rev-parse', '@{u}'], repoDir);
  const log = await run('git', ['log', '--format=%s', 'HEAD..@{u}'], repoDir);
  return { head, commits: log ? log.split('\n') : [] };
}

/** Pull, install and build; reports each step. Throws with the failing step's tail on error. */
export async function selfUpdate(step: (text: string) => void) {
  step('拉取最新代码…');
  // npm may rewrite the lockfiles (an older npm on Windows does); they are npm's, not the user's,
  // and a modified one would make the fast-forward refuse.
  await run('git', ['checkout', '--', 'app/package-lock.json', 'server/package-lock.json'], repoDir).catch(() => {});
  await run('git', ['pull', '--ff-only'], repoDir);
  step('安装依赖…');
  await run('npm', ['install', '--no-fund', '--no-audit'], appDir);
  step('构建…');
  await run('npm', ['run', 'build'], appDir);
  // A new Electron arrives named "Electron" and without the production VMP signature this Mac may
  // have given the old one: the script renames it, and signs it if this machine signed before.
  if (process.platform === 'darwin') {
    step('给新的 Electron 改名和签名…');
    await run('bash', [join(repoDir, 'deploy', 'macos-vmp-sign.sh'), '--if-needed'], repoDir).catch(() => {
      // Not fatal: Gleeok starts anyway and says how to sign by hand.
    });
  }
}

/** Where deploy/macos-vmp-sign.sh records the Electron version it signed. */
const VMP_MARKER = join(homedir(), '.config', 'gleeok', 'vmp-signed');

/**
 * macOS: whether this checkout's Electron carries the production VMP signature (DRM services such
 * as Apple Music need it there). none: never signed on this machine; stale: signed, but for an
 * older Electron.
 */
export function vmpStatus(): { state: 'signed' | 'stale' | 'none' | 'n/a'; signed?: string } {
  if (process.platform !== 'darwin' || app.isPackaged) return { state: 'n/a' };
  let signed: string;
  try {
    signed = readFileSync(VMP_MARKER, 'utf8').trim();
  } catch {
    return { state: 'none' };
  }
  return { state: signed === installedElectron() ? 'signed' : 'stale', signed };
}

/** The Electron version npm has installed in this checkout (as the signing script records it). */
function installedElectron(): string {
  try {
    return (JSON.parse(readFileSync(join(appDir, 'node_modules', 'electron', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '';
  }
}
