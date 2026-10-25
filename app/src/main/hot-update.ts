import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * The beta channel's hot updates. Every push to main builds Gleeok's code alone (dist/, vendor/,
 * assets/: a few MB, no Electron) into the rolling "beta" prerelease (.github/workflows/beta.yml),
 * with hot.json saying which commit it is and which installed shell it needs (dist/shell.json: the
 * Electron and native modules). It is unpacked into <userData>/hot/<commit>/ and boot.js runs it
 * from there, leaving the installed (signed) app untouched; a hot update that fails to start is
 * dropped by boot.js, which goes back to the bundled code.
 */

const BETA = process.env.GLEEOK_BETA_URL || 'https://github.com/Suchun-sv/Gleeok/releases/download/beta';

export interface HotUpdate {
  commit: string;
  /** The archive's asset name (hot-<commit>.tar.gz); older manifests had none. */
  file?: string;
  date: string;
  /** dist/shell.json key it needs. */
  shell: string;
  sha256: string;
  size: number;
  /** Commit subjects since the last release. */
  notes: string[];
}

const hotDir = () => join(app.getPath('userData'), 'hot');
const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

/** The code running now: its commit and build time (dist/build.json next to it). */
export function buildInfo(): { commit: string; built: string } {
  return readJson(join(__dirname, 'build.json')) ?? { commit: 'unknown', built: '' };
}

/** Whether this is a hot update (code from userData/hot) rather than the installed build's own. */
export const runningHot = () => __dirname.startsWith(hotDir());

/** The installed build's shell key (its own dist, not the hot code's). */
function installedShell(): string {
  return readJson<{ key: string }>(join(app.getAppPath(), 'dist', 'shell.json'))?.key ?? '';
}

/** The newest beta build, if it is newer than the code running; compatible: it can run on this install. */
export async function latestHot(): Promise<{ hot: HotUpdate; compatible: boolean } | null> {
  const res = await fetch(`${BETA}/hot.json`, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`测试版：HTTP ${res.status}`);
  const hot = (await res.json()) as HotUpdate;
  const here = buildInfo();
  if (hot.commit === here.commit || Date.parse(hot.date) <= Date.parse(here.built)) return null;
  // One that failed to start here is not offered again.
  let failed = '';
  try {
    failed = readFileSync(join(hotDir(), 'failed'), 'utf8');
  } catch {}
  if (failed === hot.commit) return null;
  return { hot, compatible: hot.shell === installedShell() };
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`${cmd} 退出码 ${code}`))));
  });
}

/** Download, check and unpack a hot update, make it current, restart into it. */
export async function installHot(hot: HotUpdate, step: (text: string) => void): Promise<void> {
  const dir = hotDir();
  mkdirSync(dir, { recursive: true });
  step('下载测试版…');
  const res = await fetch(`${BETA}/${hot.file ?? 'hot.tar.gz'}`, { signal: AbortSignal.timeout(10 * 60_000) });
  if (res.status === 404) throw new Error('这一版测试版已经被更新的替换了，再点一次就会装最新的');
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== hot.sha256) throw new Error('下载的文件校验不对（可能刚好有新的测试版），稍后再试');
  step('解压…');
  const archive = join(dir, `${hot.commit}.tar.gz`);
  const unpacking = join(dir, `${hot.commit}.part`);
  writeFileSync(archive, bytes);
  rmSync(unpacking, { recursive: true, force: true });
  mkdirSync(unpacking);
  try {
    await run('tar', ['-xzf', archive, '-C', unpacking]);
    if (!existsSync(join(unpacking, 'dist', 'main.js'))) throw new Error('测试版的包不完整');
    rmSync(join(dir, hot.commit), { recursive: true, force: true });
    renameSync(unpacking, join(dir, hot.commit));
  } finally {
    rmSync(archive, { force: true });
    rmSync(unpacking, { recursive: true, force: true });
  }
  writeFileSync(join(dir, 'current.json'), JSON.stringify({ commit: hot.commit, shell: hot.shell }));
  // Older hot updates (not the one running now) are no longer needed.
  const running = runningHot() ? buildInfo().commit : '';
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name !== hot.commit && name !== running && /^[0-9a-f]{7,40}$/.test(name)) rmSync(path, { recursive: true, force: true });
  }
  step('完成，正在重启…');
  if (!process.env.GLEEOK_NO_RELAUNCH) app.relaunch();
  setTimeout(() => app.quit(), 500);
}

/** The code started fine: boot.js keeps using it. */
export function confirmHotBoot() {
  rmSync(join(hotDir(), 'booting'), { force: true });
}

/** Back to the installed build's own code on the next start (leaving the beta channel). */
export function leaveHot() {
  rmSync(join(hotDir(), 'current.json'), { force: true });
}
