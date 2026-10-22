import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  await run('git', ['pull', '--ff-only'], repoDir);
  step('安装依赖…');
  await run('npm', ['install', '--no-fund', '--no-audit'], appDir);
  step('构建…');
  await run('npm', ['run', 'build'], appDir);
}
