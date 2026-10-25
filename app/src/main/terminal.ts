import { chmodSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IPty } from 'node-pty';
import { parseTerminalUrl } from '../../../shared/src/model.ts';

type PtyModule = typeof import('node-pty');
let ptyModule: PtyModule | null | undefined;
let loadError = '';
/**
 * node-pty starts every terminal through its spawn-helper, which its npm package ships without the
 * executable bit (prebuilds/<platform>-<arch>/), so a packaged build failed with "posix_spawnp
 * failed". Set it where it is missing (the build also does, in build-hooks/vmp-sign.cjs).
 */
function fixSpawnHelper() {
  if (process.platform === 'win32') return;
  try {
    const root = dirname(require.resolve('node-pty/package.json'));
    for (const dir of ['build/Release', `prebuilds/${process.platform}-${process.arch}`]) {
      const helper = join(root, dir, 'spawn-helper');
      if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755);
    }
  } catch {
    // Read-only install: the build has set it already, or the terminal reports the failure.
  }
}

/** node-pty is native; if it is missing or failed to build, terminals say so instead of crashing. */
function pty(): PtyModule | null {
  if (ptyModule === undefined) {
    try {
      fixSpawnHelper();
      ptyModule = require('node-pty') as PtyModule;
    } catch (e) {
      ptyModule = null;
      loadError = String(e).split('\n')[0];
    }
  }
  return ptyModule;
}

/** Output kept per terminal, so a tab that is redrawn (another window, after hibernation) gets its screen back. */
const KEEP = 256 * 1024;

interface Term {
  proc: IPty | null;
  buffer: string;
  /** Characters emitted so far; lets a re-attaching view drop events already in the buffer. */
  end: number;
}

export type TermEvent = { tabId: string; data: string; end: number } | { tabId: string; exit: number };

/** Shells behind terminal tabs, keyed by tab id; they outlive views and hibernation, not the app. */
export class Terminals {
  #terms = new Map<string, Term>();
  constructor(private emit: (e: TermEvent) => void) {}

  /** Start the shell if needed (or again after it exited) and return what it has printed. */
  attach(tabId: string, url: string, cols: number, rows: number): { buffer: string; end: number; error?: string } {
    let t = this.#terms.get(tabId);
    if (t?.proc) {
      t.proc.resize(cols, rows);
      return { buffer: t.buffer, end: t.end };
    }
    const mod = pty();
    if (!mod) return { buffer: '', end: 0, error: `终端不可用：node-pty 没有装好（${loadError}）。在 app 目录重新运行 npm install。` };
    const { file, args, cwd } = command(url);
    t = t ?? { proc: null, buffer: '', end: 0 };
    this.#terms.set(tabId, t);
    try {
      const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>;
      delete env.ELECTRON_RUN_AS_NODE;
      const proc = mod.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
      t.proc = proc;
      proc.onData((data) => {
        t!.buffer = (t!.buffer + data).slice(-KEEP);
        t!.end += data.length;
        this.emit({ tabId, data, end: t!.end });
      });
      proc.onExit(({ exitCode }) => {
        if (t!.proc !== proc) return;
        t!.proc = null;
        this.emit({ tabId, exit: exitCode });
      });
    } catch (e) {
      return { buffer: t.buffer, end: t.end, error: `启动失败：${String(e).split('\n')[0]}` };
    }
    return { buffer: t.buffer, end: t.end };
  }

  input(tabId: string, data: string) {
    this.#terms.get(tabId)?.proc?.write(data);
  }

  resize(tabId: string, cols: number, rows: number) {
    if (cols > 0 && rows > 0) this.#terms.get(tabId)?.proc?.resize(cols, rows);
  }

  /** End the shells whose tabs are gone (closed, or navigated to a web page). */
  retain(tabIds: Set<string>) {
    for (const id of this.#terms.keys()) if (!tabIds.has(id)) this.kill(id);
  }

  kill(tabId: string) {
    const t = this.#terms.get(tabId);
    this.#terms.delete(tabId);
    try {
      t?.proc?.kill();
    } catch {}
  }

  killAll() {
    for (const id of [...this.#terms.keys()]) this.kill(id);
  }
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Local login shell in cwd (home if it doesn't exist here), or ssh to host and cd there. */
function command(url: string): { file: string; args: string[]; cwd: string } {
  const t = parseTerminalUrl(url);
  const home = homedir();
  if (t.host) {
    // ~ must stay unquoted for the remote shell to expand it.
    const dir = t.cwd ? (t.cwd.startsWith('~/') ? `~/${quote(t.cwd.slice(2))}` : t.cwd === '~' ? '~' : quote(t.cwd)) : '';
    const remote = dir ? `cd ${dir} 2>/dev/null; exec $SHELL -l` : 'exec $SHELL -l';
    return { file: 'ssh', args: ['-t', t.host, remote], cwd: home };
  }
  const local = t.cwd?.replace(/^~(?=$|[\\/])/, home);
  const cwd = local && existsSync(local) ? local : home;
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'], cwd };
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'], cwd };
}
