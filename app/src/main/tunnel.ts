import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';
import type { CodeTunnel, TunnelStatus } from '../../../shared/src/model.ts';

/**
 * SSH tunnels to code-servers (设置 → 代码): a code-server set to go "over SSH" is opened at
 * http://localhost:<port> on this machine, forwarded with the system's own `ssh` (so the
 * user's ~/.ssh/config, keys, agent and ProxyJump all apply) to the port it listens on over
 * there. Links keep their real address; only the page loaded is moved (see pageUrl / modelUrl).
 * A tunnel is started the first time one of its pages is opened, kept up (with retries) until
 * Gleeok quits, and stopped when it is turned off.
 */

export interface TunnelHooks {
  log(message: string): void;
  /** A tunnel came up, failed, or is trying again. */
  onStatus(origin: string, status: TunnelStatus): void;
}

interface Running {
  tunnel: CodeTunnel;
  child: ChildProcess | null;
  status: TunnelStatus;
  retry?: NodeJS.Timeout;
  /** Seconds before the next try after a failure; doubles up to a minute. */
  backoff: number;
}

/** The address a tunnel's pages are opened at. */
export const tunnelOrigin = (t: Pick<CodeTunnel, 'localPort'>) => `http://localhost:${t.localPort}`;

/** The same URL on another origin (path, query, hash kept). */
function moveOrigin(url: string, from: string, to: string): string | null {
  try {
    const u = new URL(url);
    if (u.origin !== from) return null;
    const target = new URL(to);
    return target.origin + u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}

/** Where a link's page is loaded: on the tunnel when its code-server has one. */
export function pageUrl(url: string, tunnels: CodeTunnel[]): string {
  for (const t of tunnels) {
    const moved = moveOrigin(url, t.origin, tunnelOrigin(t));
    if (moved) return moved;
  }
  return url;
}

/** What a page on a tunnel is, as the links know it (its code-server's real address). */
export function modelUrl(url: string, tunnels: CodeTunnel[]): string {
  for (const t of tunnels) {
    const moved = moveOrigin(url, tunnelOrigin(t), t.origin);
    if (moved) return moved;
  }
  return url;
}

/** A local port nobody listens on, at or after `from`, and not one of `taken`. */
export async function freePort(from: number, taken: number[]): Promise<number> {
  for (let port = from; port < from + 500; port++) {
    if (taken.includes(port)) continue;
    const free = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('no free local port');
}

/** Whether something answers on the local port. */
const answers = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = connect(port, '127.0.0.1');
    s.setTimeout(500);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
    s.once('timeout', () => {
      s.destroy();
      resolve(false);
    });
  });

export class Tunnels {
  #hooks: TunnelHooks;
  #running = new Map<string, Running>();
  #quitting = false;

  constructor(hooks: TunnelHooks) {
    this.#hooks = hooks;
  }

  status(origin: string): TunnelStatus | undefined {
    return this.#running.get(origin)?.status;
  }

  get statuses(): Record<string, TunnelStatus> {
    return Object.fromEntries([...this.#running].map(([origin, r]) => [origin, r.status]));
  }

  /** Have the tunnel up (a page on it is being opened). Started once; up or trying from then on. */
  want(tunnel: CodeTunnel) {
    const r = this.#running.get(tunnel.origin);
    if (r && sameTunnel(r.tunnel, tunnel)) return;
    if (r) this.#stop(tunnel.origin);
    const fresh: Running = { tunnel, child: null, status: { state: 'connecting' }, backoff: 2 };
    this.#running.set(tunnel.origin, fresh);
    this.#start(fresh);
  }

  /** The tunnels as now set: changed ones start over (if they were up), removed ones stop. */
  update(tunnels: CodeTunnel[]) {
    for (const [origin, r] of [...this.#running]) {
      const now = tunnels.find((t) => t.origin === origin);
      if (!now) this.#stop(origin);
      else if (!sameTunnel(now, r.tunnel)) this.want(now);
    }
  }

  /** Try a failed tunnel again now (the user asked). */
  retry(origin: string) {
    const r = this.#running.get(origin);
    if (!r || r.child) return;
    clearTimeout(r.retry);
    r.backoff = 2;
    this.#start(r);
  }

  stopAll() {
    this.#quitting = true;
    for (const origin of [...this.#running.keys()]) this.#stop(origin);
  }

  #stop(origin: string) {
    const r = this.#running.get(origin);
    if (!r) return;
    this.#running.delete(origin);
    clearTimeout(r.retry);
    r.child?.kill();
    this.#hooks.onStatus(origin, { state: 'off' });
  }

  #set(r: Running, status: TunnelStatus) {
    r.status = status;
    if (this.#running.get(r.tunnel.origin) === r) this.#hooks.onStatus(r.tunnel.origin, status);
  }

  #start(r: Running) {
    const { ssh, remotePort, localPort } = r.tunnel;
    const live = () => this.#running.get(r.tunnel.origin) === r && !this.#quitting;
    this.#set(r, { state: 'connecting' });
    const args = [
      '-N',
      '-o', 'BatchMode=yes', // keys or an agent only: nothing can type a password here
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'StrictHostKeyChecking=accept-new', // a machine never seen before is taken, a changed one is not
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ConnectTimeout=15',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      ssh,
    ];
    let child: ChildProcess;
    try {
      child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      this.#set(r, { state: 'failed', error: (e as Error).message });
      return;
    }
    r.child = child;
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    child.once('error', (e) => (stderr = e.message.includes('ENOENT') ? '这台电脑上找不到 ssh 命令' : e.message));
    child.once('exit', (code) => {
      r.child = null;
      if (!live()) return;
      const error = lastLine(stderr) || `ssh 退出（${code ?? '信号'}）`;
      this.#hooks.log(`code tunnel ${ssh}:${remotePort} closed: ${error}`);
      this.#set(r, { state: 'failed', error });
      r.retry = setTimeout(() => live() && this.#start(r), r.backoff * 1000);
      r.backoff = Math.min(r.backoff * 2, 60);
    });
    // ssh says nothing once forwarding works; the local port answering is the sign.
    const started = Date.now();
    const poll = async () => {
      if (!live() || r.child !== child) return;
      if (await answers(localPort)) {
        if (r.child !== child) return;
        r.backoff = 2;
        this.#hooks.log(`code tunnel up: localhost:${localPort} → ${ssh}:${remotePort}`);
        this.#set(r, { state: 'up' });
        return;
      }
      if (Date.now() - started < 30_000) setTimeout(poll, 200);
    };
    void poll();
  }
}

const sameTunnel = (a: CodeTunnel, b: CodeTunnel) => a.ssh === b.ssh && a.remotePort === b.remotePort && a.localPort === b.localPort;

/** ssh's last line of complaint, without its "debug"/"Warning: Permanently added" chatter. */
function lastLine(text: string) {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^Warning: Permanently added/.test(l))
      .pop() ?? ''
  );
}
