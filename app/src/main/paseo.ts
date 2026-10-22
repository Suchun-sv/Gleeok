import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

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

/** This machine's daemon at PASEO_URL; null when none answers. */
export async function readLocalPaseo(clientId: string): Promise<Catalog | null> {
  const http = (process.env.PASEO_URL ?? 'http://127.0.0.1:6767').replace(/\/$/, '');
  let status: { serverId: string; hostname: string; version: string };
  try {
    status = (await (await fetch(`${http}/api/status`, { signal: AbortSignal.timeout(3000) })).json()) as typeof status;
  } catch {
    return null;
  }
  const client = new DaemonClient({
    url: `${http.replace(/^http/, 'ws')}/ws`,
    clientId,
    clientType: 'cli',
    password: process.env.PASEO_PASSWORD || undefined,
    reconnect: { enabled: false },
  });
  try {
    return await readCatalog(client, status);
  } catch {
    return null;
  }
}

/** A daemon through its pairing link; throws with the reason when it cannot be reached. */
export async function readPairedPaseo(url: string, clientId: string): Promise<Catalog> {
  const offer = parseOffer(url);
  const client = new DaemonClient({
    url: relayUrl(offer),
    clientId,
    clientType: 'cli',
    connectTimeoutMs: 20_000,
    e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
    reconnect: { enabled: false },
  });
  return readCatalog(client, { serverId: offer.serverId });
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
          latest: top ? { workspaceId: top.id, name: top.name, at: usedAt(top), terminalId: terminals?.entries[0]?.id ?? null } : null,
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
