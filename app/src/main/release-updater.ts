import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { app } from 'electron';

/**
 * Updates for installed builds (from GitHub Releases, see .github/workflows/release.yml); a git
 * checkout updates itself through updater.ts instead. Windows (NSIS) and Linux (AppImage) use
 * electron-updater. On macOS that would go through Squirrel, which only accepts apps signed with an
 * Apple developer identity, so Gleeok swaps the app itself: download the zip for this Mac, check
 * its SHA-512 against latest-mac.yml, unpack it next to the running app and put it in its place.
 * A file the app downloads itself carries no quarantine flag, so Gatekeeper does not stop it.
 */

const REPO = 'Suchun-sv/Gleeok';

export function canReleaseUpdate(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === 'linux') return !!process.env.APPIMAGE; // a .deb or unpacked dir cannot replace itself
  return process.platform === 'darwin' || process.platform === 'win32';
}

/** Numeric x.y.z compare (a pre-release suffix sorts before its release). */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('-');
    return { nums: core.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) > (y.nums[i] ?? 0);
  return !x.pre && !!y.pre;
}

export interface Release {
  version: string;
  tag: string;
  /** The release notes as lines (the update dialog lists them like commits). */
  notes: string[];
}

/** The manifest each release carries for this platform (electron-builder writes them). */
const MANIFEST = process.platform === 'darwin' ? 'latest-mac.yml' : process.platform === 'win32' ? 'latest.yml' : 'latest-linux.yml';

/**
 * The latest published release, if it is newer than this build. Its version comes from the
 * release's download link (not the GitHub API, which allows 60 requests an hour per IP address,
 * soon used up behind a university's shared address); the notes from the API, when it answers.
 */
export async function latestRelease(): Promise<Release | null> {
  const res = await fetch(`https://github.com/${REPO}/releases/latest/download/${MANIFEST}`, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const version = /^version:\s*['"]?([^'"\s]+)/m.exec(await res.text())?.[1];
  if (!version || !newer(version, app.getVersion())) return null;
  const tag = `v${version}`;
  let notes: string[] = [];
  try {
    const api = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Gleeok' },
      signal: AbortSignal.timeout(10_000),
    });
    if (api.ok) {
      const body = ((await api.json()) as { body?: string }).body ?? '';
      notes = body
        .split('\n')
        .map((l) => l.replace(/^[-*]\s+/, '').replace(/\s+by @\S+ in https:\S+$/, '').trim())
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('**Full Changelog'));
    }
  } catch {}
  return { version, tag, notes: notes.length ? notes : [`Gleeok ${version}`] };
}

/** Download, check and install a release; resolves when the app is about to restart. */
export async function installRelease(release: Release, step: (text: string) => void): Promise<void> {
  if (!canReleaseUpdate()) throw new Error(`这个安装方式不能自己换成新版本：从 https://github.com/${REPO}/releases 下载 ${release.version}`);
  if (process.platform === 'darwin') return installMac(release, step);
  // Windows and the AppImage: electron-updater reads latest.yml / latest-linux.yml from the release.
  const { autoUpdater } = await import('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  step('查找安装包…');
  await autoUpdater.checkForUpdates();
  step('下载新版本…');
  autoUpdater.on('download-progress', (p) => step(`下载新版本… ${Math.round(p.percent)}%`));
  await autoUpdater.downloadUpdate();
  step('安装并重启…');
  autoUpdater.quitAndInstall(true, true);
}

/** latest-mac.yml's files: url, sha512 (base64), size. */
function parseFiles(yml: string): { url: string; sha512: string; size: number }[] {
  const files: { url: string; sha512: string; size: number }[] = [];
  for (const block of yml.split(/\n\s*-\s+url:\s*/).slice(1)) {
    const url = block.split('\n')[0].trim();
    const sha512 = /sha512:\s*(\S+)/.exec(block)?.[1] ?? '';
    const size = Number(/size:\s*(\d+)/.exec(block)?.[1] ?? 0);
    files.push({ url, sha512, size });
  }
  return files;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`${cmd} 退出码 ${code}`))));
  });
}

async function installMac(release: Release, step: (text: string) => void) {
  const base = `https://github.com/${REPO}/releases/download/${release.tag}`;
  step('查找安装包…');
  const yml = await fetch(`${base}/latest-mac.yml`, { signal: AbortSignal.timeout(15_000) });
  if (!yml.ok) throw new Error(`latest-mac.yml: HTTP ${yml.status}`);
  const files = parseFiles(await yml.text()).filter((f) => f.url.endsWith('.zip'));
  const file = files.find((f) => f.url.includes(process.arch)) ?? files[0];
  if (!file) throw new Error('这个版本没有 Mac 安装包');

  // The running bundle: …/Gleeok.app/Contents/MacOS/Gleeok.
  const bundle = resolve(app.getPath('exe'), '..', '..', '..');
  if (!bundle.endsWith('.app')) throw new Error(`不认识这个安装位置：${bundle}`);
  const work = mkdtempSync(join(tmpdir(), 'gleeok-update-'));
  try {
    step('下载新版本…');
    const zip = join(work, 'update.zip');
    const res = await fetch(`${base}/${encodeURIComponent(file.url)}`, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
    const hash = createHash('sha512');
    let got = 0;
    const counted = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream).on('data', (chunk: Buffer) => {
      hash.update(chunk);
      got += chunk.length;
      if (file.size) step(`下载新版本… ${Math.round((got / file.size) * 100)}%`);
    });
    await pipeline(counted, createWriteStream(zip));
    if (file.sha512 && hash.digest('base64') !== file.sha512) throw new Error('下载的文件校验不对，没有安装');

    step('解压…');
    const unpacked = join(work, 'app');
    await run('ditto', ['-x', '-k', zip, unpacked]);
    const name = readdirSync(unpacked).find((n) => n.endsWith('.app'));
    if (!name) throw new Error('安装包里没有 .app');
    const fresh = join(unpacked, name);

    step('替换应用…');
    // Next to the running one first (same volume, so the swap is two renames), then swap.
    const staged = join(dirname(bundle), `.Gleeok-update-${Date.now()}.app`);
    await run('ditto', [fresh, staged]);
    await run('xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => {});
    const old = `${bundle}.old-${Date.now()}`;
    renameSync(bundle, old);
    try {
      renameSync(staged, bundle);
    } catch (e) {
      renameSync(old, bundle);
      throw e;
    }
    rmSync(old, { recursive: true, force: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`没有权限替换 ${bundle}：把 Gleeok 放在自己能写的位置（比如 ~/Applications），或手动下载新版`);
    throw e;
  } finally {
    rmSync(work, { recursive: true, force: true });
    for (const n of existsSync(dirname(bundle)) ? readdirSync(dirname(bundle)) : []) {
      if (n.startsWith('.Gleeok-update-')) rmSync(join(dirname(bundle), n), { recursive: true, force: true });
    }
  }
  step('完成，正在重启…');
  app.relaunch();
  setTimeout(() => app.quit(), 500);
}
