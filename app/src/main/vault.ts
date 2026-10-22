import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFile, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, type WebContents } from 'electron';
import { uriMatches } from './domain.ts';

/**
 * Password vault: the user's self-hosted Vaultwarden, reached through the official Bitwarden CLI
 * (bundled as a dependency, run with Electron's own Node). The master password is only handed
 * to the CLI for login/unlock; the session key lives in memory and dies with the app or a lock.
 * When filling, passwords never reach the renderer: main fetches them and types them into the page.
 */
/** Bitwarden's own cloud; a Gleeok server or client.json can point elsewhere (e.g. a Vaultwarden). */
export const VAULT_URL_DEFAULT = 'https://vault.bitwarden.com';

export interface VaultLogin {
  id: string;
  name: string;
  username: string;
}

/**
 * A `bw unlock` already past its slow start-up, blocked reading the master password from a
 * channel only this user can open: a FIFO in a private temp dir (macOS/Linux) or a named pipe
 * (Windows). Nothing is written to disk.
 */
interface Warm {
  child: ChildProcess;
  give(password: string): void;
  result: Promise<{ code: number | null; out: string }>;
}

/** The path bw reads the password from, and how to hand the password over once it is known. */
function passwordChannel(): { path: string; give(password: string): void; cleanup(): void } {
  if (process.platform === 'win32') {
    // Unguessable name: the default pipe ACL lets other local accounts connect, and the password
    // goes to the first client (bw connects right away at launch, long before it is typed).
    const path = `\\\\.\\pipe\\gleeok-bw-${randomUUID()}`;
    let password: string | null = null;
    let waiting: ((p: string) => void) | null = null;
    const server: Server = createServer((socket) => {
      const send = (p: string) => socket.end(p);
      if (password !== null) send(password);
      else waiting = send;
    });
    server.listen(path);
    return {
      path,
      give: (p) => (waiting ? waiting(p) : (password = p)),
      cleanup: () => server.close(),
    };
  }
  const dir = mkdtempSync(join(tmpdir(), 'gleeok-bw-'));
  const path = join(dir, 'pw');
  execFileSync('mkfifo', ['-m', '600', path]);
  return {
    path,
    give: (p) => writeFile(path, p, () => {}),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

interface CachedLogin extends VaultLogin {
  password: string;
  uris: string[];
}

export class Vault {
  #session: string | null = null;
  /** Decrypted logins, held only in this process while unlocked (as Bitwarden's own apps do). */
  #cache: CachedLogin[] = [];
  #loading: Promise<void> = Promise.resolve();
  #syncTimer: NodeJS.Timeout | undefined;
  #warm: Warm | null = null;
  #dir = join(app.getPath('userData'), 'bitwarden');
  #prefsPath = join(app.getPath('userData'), 'vault.json');
  /** Only used for the first login on a machine; later unlocks use what the CLI remembers. */
  serverUrl: string;

  constructor(serverUrl = VAULT_URL_DEFAULT) {
    this.serverUrl = serverUrl;
    mkdirSync(this.#dir, { recursive: true });
  }

  get unlocked() {
    return this.#session !== null;
  }

  /** The account email is not secret; remember it so unlocking only asks for the password. */
  get email(): string {
    try {
      return (JSON.parse(readFileSync(this.#prefsPath, 'utf8')) as { email?: string }).email ?? '';
    } catch {
      return '';
    }
  }

  #env(extra: Record<string, string> = {}) {
    return {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      BITWARDENCLI_APPDATA_DIR: this.#dir,
      BW_NOINTERACTION: 'true',
      ...(this.#session ? { BW_SESSION: this.#session } : {}),
      ...extra,
    };
  }

  // Every CLI call is a fresh process that takes ~2.5s to start, so calls are kept to a minimum:
  // one to unlock (started ahead of time, see prewarm), one to read the vault into memory, and
  // background syncs.
  #run(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
    const bw = require.resolve('@bitwarden/cli/build/bw.js');
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bw, ...args], { env: this.#env(extraEnv) });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error((err || out).trim() || `bw exited ${code}`))));
    });
  }

  /**
   * Start `bw unlock` now so its start-up is over before the password is typed; it then blocks
   * reading the password from a private channel (see passwordChannel). Only for machines that
   * have logged in before; the first login needs the email anyway.
   */
  prewarm() {
    if (this.#session || this.#warm || !this.email) return;
    try {
      const channel = passwordChannel();
      const child = spawn(process.execPath, [require.resolve('@bitwarden/cli/build/bw.js'), 'unlock', '--passwordfile', channel.path, '--raw'], {
        env: this.#env(),
      });
      let out = '';
      child.stdout?.on('data', (d) => (out += d));
      child.stderr?.on('data', (d) => (out += d));
      const result = new Promise<{ code: number | null; out: string }>((resolve) => {
        child.on('close', (code) => {
          channel.cleanup();
          resolve({ code, out: out.trim() });
        });
        child.on('error', () => resolve({ code: -1, out: '' }));
      });
      this.#warm = { child, give: channel.give, result };
    } catch {
      this.#warm = null;
    }
  }

  /** Stop a waiting pre-started unlock (app quitting). */
  dispose() {
    this.#warm?.child.kill();
    this.#warm = null;
  }

  async unlock(email: string, password: string, server?: string) {
    if (server) this.serverUrl = server.trim().replace(/\/$/, '');
    const env = { BW_MASTER: password };
    const warm = this.#warm;
    this.#warm = null;
    if (warm && warm.child.exitCode === null) {
      warm.give(password);
      const { code, out } = await warm.result;
      if (code === 0) {
        this.#session = out;
        return this.#afterUnlock();
      }
      if (/invalid master password/i.test(out)) {
        this.prewarm(); // ready for the next attempt
        throw new Error(out);
      }
      // Anything else (not logged in here, or the head start itself misbehaving): do it the
      // ordinary way below, so a failed shortcut never blocks unlocking.
    }
    try {
      this.#session = await this.#run(['unlock', '--passwordenv', 'BW_MASTER', '--raw'], env);
    } catch (e) {
      // First use on this machine: point the CLI at the server and log in (which also syncs).
      if (!/not logged in/i.test(String(e))) throw e;
      await this.#run(['config', 'server', this.serverUrl]).catch(() => {});
      this.#session = await this.#run(['login', email, '--passwordenv', 'BW_MASTER', '--raw'], env);
      writeFileSync(this.#prefsPath, JSON.stringify({ email }));
    }
    this.#afterUnlock();
  }

  /** Called when the decrypted list changes (the palette shows entries). */
  onChange: () => void = () => {};

  #afterUnlock() {
    this.#loading = this.#reload().then(() => this.onChange());
    // Fresh data from the server in the background, then every 10 minutes while unlocked.
    void this.#loading.then(() => this.#syncNow());
    clearInterval(this.#syncTimer);
    this.#syncTimer = setInterval(() => void this.#syncNow(), 10 * 60_000);
  }

  async #reload() {
    const items = JSON.parse(await this.#run(['list', 'items'])) as {
      id: string;
      name: string;
      type: number;
      login?: { username?: string | null; password?: string | null; uris?: { uri?: string | null }[] | null };
    }[];
    this.#cache = items
      .filter((i) => i.type === 1 && i.login)
      .map((i) => ({
        id: i.id,
        name: i.name,
        username: i.login!.username ?? '',
        password: i.login!.password ?? '',
        uris: (i.login!.uris ?? []).map((u) => u.uri ?? '').filter(Boolean),
      }));
  }

  async #syncNow() {
    if (!this.#session) return;
    await this.#run(['sync']).catch(() => {});
    if (this.#session) this.#loading = this.#reload().then(() => this.onChange(), () => {});
  }

  async lock() {
    this.#session = null;
    this.#cache = [];
    clearInterval(this.#syncTimer);
    await this.#run(['lock']).catch(() => {});
    this.prewarm();
  }

  /** Name, username and saved web addresses of every login, for the palette (never passwords). */
  entries(): { id: string; name: string; username: string; urls: string[]; hasPassword: boolean }[] {
    if (!this.#session) return [];
    return this.#cache.map((l) => ({
      id: l.id,
      name: l.name,
      username: l.username,
      urls: l.uris.filter((u) => /^https?:\/\//i.test(u)),
      hasPassword: !!l.password,
    }));
  }

  /** One field of an entry, for copying to the clipboard (main process only). */
  field(id: string, what: 'url' | 'username' | 'password', index = 0): string | null {
    const l = this.#cache.find((x) => x.id === id);
    if (!l) return null;
    if (what === 'password') return l.password || null;
    if (what === 'username') return l.username || null;
    return l.uris.filter((u) => /^https?:\/\//i.test(u))[index] ?? null;
  }

  /** Logins whose saved URIs match the page (Bitwarden's default base-domain rule). Instant once loaded. */
  async loginsFor(url: string): Promise<CachedLogin[]> {
    await this.#loading;
    return this.#cache.filter((l) => l.uris.some((u) => uriMatches(u, url)));
  }

  async save(login: { name: string; url: string; username: string; password: string }) {
    const item = {
      type: 1,
      name: login.name,
      notes: null,
      favorite: false,
      fields: [],
      reprompt: 0,
      folderId: null,
      organizationId: null,
      collectionIds: [],
      login: { uris: [{ match: null, uri: login.url }], username: login.username, password: login.password, totp: null },
    };
    const created = JSON.parse(await this.#run(['create', 'item', Buffer.from(JSON.stringify(item)).toString('base64')])) as {
      id: string;
    };
    this.#cache.push({ id: created.id, name: login.name, username: login.username, password: login.password, uris: [login.url] });
    this.onChange();
  }
}

// ---- page side: runs inside the web page (every frame), so it must be self-contained ----

const FIELDS = `
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const inputs = [...document.querySelectorAll('input')].filter((i) => visible(i) && !i.disabled);
  const textish = (i) => ['email', 'text', 'tel', ''].includes(i.type);
  const pw = inputs.find((i) => i.type === 'password');
  const user = pw
    ? inputs.slice(0, inputs.indexOf(pw)).reverse().find(textish) ?? null
    : inputs.find((i) => textish(i) && /user|email|login|account|name|identifier/i.test(i.name + i.id + i.autocomplete + i.placeholder + (i.getAttribute('aria-label') || ''))) ?? null;
`;

/**
 * Type a login into the page's form (multi-step logins: whichever field is on screen).
 * Text goes in through insertText, i.e. as trusted input like real typing: scripted value changes
 * are flagged as automation by sign-in pages such as Google's, and some frameworks ignore them.
 */
export async function fillPage(wc: WebContents, username: string, password: string): Promise<boolean> {
  const focus = (which: 'user' | 'pw') => `(() => {${FIELDS}
    const el = ${which === 'user' ? 'user' : 'pw'};
    if (!el) return false;
    el.focus();
    el.select();
    return true;
  })()`;
  for (const frame of wc.mainFrame.framesInSubtree) {
    let filled = false;
    if (username && (await frame.executeJavaScript(focus('user')).catch(() => false))) {
      await wc.insertText(username);
      filled = true;
    }
    if (await frame.executeJavaScript(focus('pw')).catch(() => false)) {
      await wc.insertText(password);
      filled = true;
    }
    if (filled) return true;
  }
  return false;
}

/** What the user has typed into the page's login form, to offer saving it. */
export async function readPage(wc: WebContents): Promise<{ username: string; password: string }> {
  const script = `(() => {${FIELDS} return { username: user ? user.value : '', password: pw ? pw.value : '' }; })()`;
  for (const frame of wc.mainFrame.framesInSubtree) {
    const r = (await frame.executeJavaScript(script).catch(() => null)) as { username: string; password: string } | null;
    if (r && (r.username || r.password)) return r;
  }
  return { username: '', password: '' };
}
