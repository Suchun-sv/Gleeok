import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient, getDaemonAuthFailureReason } from '@getpaseo/client/internal/daemon-client';
import type { NewPaseoProject } from '../../../shared/src/ipc.ts';

/**
 * Read Paseo daemons' catalogs (the same shape paseo-sync/sync.mjs pushes to a Gleeok server):
 * this machine's daemon in local mode, plus any daemon whose pairing link was pasted here. A
 * pairing link reaches its daemon through Paseo's end-to-end encrypted relay, so the daemon
 * needs no open port. Same "most recently used workspace" rule as the script.
 */

/** What a pairing link (`https://app.paseo.sh/#offer=…`) carries. */
interface Offer {
  v: 2;
  serverId: string;
  daemonPublicKeyB64: string;
  relay: { endpoint: string; useTls?: boolean };
}

/** Parse a pairing link; throws with a short reason when it is not one. */
export function parseOffer(url: string): Offer {
  const at = url.indexOf('#offer=');
  if (at < 0) throw new Error('不是 Paseo 配对链接（缺少 #offer=）');
  let offer: Offer;
  try {
    offer = JSON.parse(Buffer.from(url.slice(at + 7).trim(), 'base64url').toString('utf8')) as Offer;
  } catch {
    throw new Error('配对链接不完整');
  }
  if (offer.v !== 2 || !offer.serverId || !offer.daemonPublicKeyB64 || !offer.relay?.endpoint) {
    throw new Error('无法识别的配对链接版本');
  }
  return offer;
}

/** Relay socket for a client of the offer's daemon (as `buildRelayWebSocketUrl` in @getpaseo/protocol). */
function relayUrl(offer: Offer) {
  const { endpoint } = offer.relay;
  // The hosted relay predates the explicit flag and runs on 443.
  const tls = offer.relay.useTls ?? /:443$/.test(endpoint);
  const url = new URL(`${tls ? 'wss' : 'ws'}://${endpoint}/ws`);
  url.searchParams.set('serverId', offer.serverId);
  url.searchParams.set('role', 'client');
  url.searchParams.set('v', '2');
  return url.toString();
}

export type Catalog = { serverId: string; body: unknown };

const localHttp = () => (process.env.PASEO_URL ?? 'http://127.0.0.1:6767').replace(/\/$/, '');

type Status = { serverId: string; hostname: string; version: string };

/** Who this machine's daemon is; null when none answers. */
export async function localPaseoStatus(): Promise<Status | null> {
  try {
    return (await (await fetch(`${localHttp()}/api/status`, { signal: AbortSignal.timeout(3000) })).json()) as Status;
  } catch {
    return null;
  }
}

/** A client of this machine's daemon, not yet connected. */
export function localDaemon(clientId: string) {
  return new DaemonClient({
    url: `${localHttp().replace(/^http/, 'ws')}/ws`,
    clientId,
    clientType: 'cli',
    password: process.env.PASEO_PASSWORD || undefined,
    reconnect: { enabled: false },
  });
}

/**
 * A client of a paired daemon through Paseo's relay, not yet connected. The relay only carries the
 * encrypted connection: a daemon with a password set still asks for it.
 */
export function pairedDaemon(url: string, clientId: string, password?: string) {
  const offer = parseOffer(url);
  return new DaemonClient({
    url: relayUrl(offer),
    clientId,
    clientType: 'cli',
    password: password || undefined,
    connectTimeoutMs: 20_000,
    e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
    reconnect: { enabled: false },
  });
}

/** This machine's daemon at PASEO_URL; null when none answers. */
export async function readLocalPaseo(clientId: string): Promise<Catalog | null> {
  const status = await localPaseoStatus();
  if (!status) return null;
  try {
    return await readCatalog(localDaemon(clientId), status);
  } catch {
    return null;
  }
}

/** A daemon through its pairing link; throws with the reason when it cannot be reached. */
export async function readPairedPaseo(url: string, clientId: string, password?: string): Promise<Catalog> {
  return readCatalog(pairedDaemon(url, clientId, password), { serverId: parseOffer(url).serverId });
}

/** Why a daemon could not be used, in the words the settings show. */
export function paseoError(e: unknown): { error: string; auth?: 'password_required' | 'incorrect_password' } {
  const auth = getDaemonAuthFailureReason(e) ?? undefined;
  if (auth) return { error: auth === 'password_required' ? '需要密码' : '密码错误', auth };
  return { error: String((e as Error)?.message ?? e).slice(0, 200) };
}

// --- Acting on a daemon ----------------------------------------------------------------------
// A connection stays open for a minute after its last use, so typing into a search (one request
// per pause) does not pay for a relay handshake each time.

const open = new Map<string, { daemon: DaemonClient; ready: Promise<void>; timer?: ReturnType<typeof setTimeout> }>();

export async function withDaemon<T>(key: string, make: () => DaemonClient, use: (d: DaemonClient) => Promise<T>): Promise<T> {
  let conn = open.get(key);
  if (!conn) {
    const daemon = make();
    conn = { daemon, ready: daemon.connect() };
    open.set(key, conn);
  }
  const c = conn;
  clearTimeout(c.timer);
  const drop = () => {
    if (open.get(key) === c) open.delete(key);
    void c.daemon.close().catch(() => {});
  };
  try {
    await c.ready;
    return await use(c.daemon);
  } catch (e) {
    // A dropped or refused connection: the next call starts a fresh one.
    drop();
    throw e;
  } finally {
    if (open.get(key) === c) {
      clearTimeout(c.timer);
      c.timer = setTimeout(drop, 60_000);
    }
  }
}

const DIR_ERRORS: Record<string, string> = {
  directory_exists: '已经有这个文件夹了',
  parent_directory_not_found: '上级文件夹不存在',
  permission_denied: '没有权限在这里新建',
  invalid_name: '名称不能当文件夹名',
};

/** Make the project on the daemon; returns its id and absolute folder. */
export async function createPaseoProject(d: DaemonClient, req: NewPaseoProject): Promise<{ projectId: string; path: string }> {
  if (req.kind === 'empty') {
    const r = await d.createProjectDirectory({ parentPath: req.parent, name: req.name });
    if (!r.project) throw new Error((r.errorCode && DIR_ERRORS[r.errorCode]) || r.error || '没能新建文件夹');
    return { projectId: r.project.projectId, path: r.directoryPath ?? r.project.projectRootPath };
  }
  if (req.kind === 'dir') {
    const r = await d.addProject(req.path);
    if (!r.project) throw new Error(r.errorCode === 'directory_not_found' ? '没有这个文件夹' : r.error || '没能添加');
    return { projectId: r.project.projectId, path: r.project.projectRootPath };
  }
  // owner/repo needs a protocol; https works with gh's credential helper and for public repositories.
  const url = /^(https?:\/\/|git@|ssh:\/\/)/.test(req.repo);
  const r = await d.cloneGithubProject({ repo: req.repo, targetDirectory: req.parent, ...(url ? {} : { cloneProtocol: 'https' as const }) });
  if (!r.project) {
    const exists = r.error?.startsWith('Checkout path already exists');
    throw new Error(exists ? '已经有这个文件夹了' : r.error || '没能克隆');
  }
  return { projectId: r.project.projectId, path: r.checkoutPath ?? r.project.projectRootPath };
}

/** Folders on the daemon's machine matching what was typed (absolute paths). */
export async function suggestDirs(d: DaemonClient, query: string): Promise<string[]> {
  const r = await d.getDirectorySuggestions({ query, includeDirectories: true, includeFiles: false, limit: 8 });
  return r.directories;
}

/** GitHub repositories through the daemon machine's gh. */
export async function searchRepos(d: DaemonClient, query: string) {
  const r = await d.searchGithubRepositories({ query, limit: 8 });
  const error =
    r.status === 'unavailable' ? '这台机器没装 gh' : r.status === 'unauthenticated' ? '这台机器的 gh 还没登录（gh auth login）' : r.error ?? undefined;
  return {
    repos: r.repositories.map((x) => ({ name: x.nameWithOwner, description: x.description ?? '', private: x.visibility !== 'public' })),
    error,
  };
}

async function readCatalog(daemon: DaemonClient, known: { serverId: string; hostname?: string; version?: string }): Promise<Catalog> {
  const client = createPaseoApi(daemon);
  try {
    await daemon.connect();
    // Over the relay there is no /api/status; the daemon's hello carries the same details.
    const info = daemon.getLastServerInfoMessage();
    const { projects } = await client.projects.list();
    const workspaces: {
      id: string;
      projectId: string;
      name: string;
      archivingAt?: string | null;
      background?: boolean;
      activityAt?: string | null;
      statusEnteredAt?: string | null;
      workspaceDirectory?: string;
    }[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.workspaces.list({ page: { limit: 200, cursor } });
      workspaces.push(...(page.entries as typeof workspaces));
      cursor = page.pageInfo?.nextCursor ?? undefined;
    } while (cursor);

    const usedAt = (w: (typeof workspaces)[number]) => w.activityAt ?? w.statusEnteredAt ?? null;
    const catalog = await Promise.all(
      projects.map(async (p) => {
        const own = workspaces.filter((w) => w.projectId === p.projectId && !w.archivingAt && !w.background);
        own.sort((a, b) => (usedAt(b) ?? '').localeCompare(usedAt(a) ?? ''));
        const top = own[0];
        const terminals = top ? await client.terminals.list({ workspaceId: top.id }).catch(() => null) : null;
        return {
          projectId: p.projectId,
          name: p.projectDisplayName,
          path: p.projectRootPath,
          workspaceCount: own.length,
          latest: top
            ? { workspaceId: top.id, name: top.name, at: usedAt(top), terminalId: terminals?.entries[0]?.id ?? null, dir: top.workspaceDirectory ?? null }
            : null,
        };
      }),
    );
    return {
      serverId: info?.serverId ?? known.serverId,
      body: {
        hostname: info?.hostname ?? known.hostname ?? known.serverId,
        version: info?.version ?? known.version ?? '',
        webBase: process.env.PASEO_WEB_BASE ?? 'https://app.paseo.sh',
        projects: catalog,
      },
    };
  } finally {
    await client.dispose().catch(() => {});
    await daemon.close().catch(() => {});
  }
}

/** A pairing link remembered on this machine only: it grants full control of its daemon. */
export interface Pairing {
  serverId: string;
  url: string;
  /** The daemon's own password, when it has one (kept with the link, same file, owner-only). */
  password?: string;
  addedAt: string;
}

const pairingsFile = () => join(app.getPath('userData'), 'paseo-pairings.json');

export function loadPairings(): Pairing[] {
  try {
    return JSON.parse(readFileSync(pairingsFile(), 'utf8')) as Pairing[];
  } catch {
    return [];
  }
}

export function savePairings(pairings: Pairing[]) {
  writeFileSync(pairingsFile(), JSON.stringify(pairings, null, 2), { mode: 0o600 });
  // writeFileSync's mode only applies when it creates the file.
  if (process.platform !== 'win32') chmodSync(pairingsFile(), 0o600);
}
