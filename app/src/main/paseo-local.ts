import { createPaseoClient } from '@getpaseo/client';

/**
 * Local mode's stand-in for paseo-sync/sync.mjs: read this machine's Paseo daemon directly and
 * return its catalog (the same shape the sync script pushes to a Gleeok server). Null when no
 * daemon answers. Same "most recently used workspace" rule as the script.
 */
export async function readLocalPaseo(): Promise<{ serverId: string; body: unknown } | null> {
  const http = (process.env.PASEO_URL ?? 'http://127.0.0.1:6767').replace(/\/$/, '');
  let status: { serverId: string; hostname: string; version: string };
  try {
    status = (await (await fetch(`${http}/api/status`, { signal: AbortSignal.timeout(3000) })).json()) as typeof status;
  } catch {
    return null;
  }
  const client = createPaseoClient({ url: `${http.replace(/^http/, 'ws')}/ws`, password: process.env.PASEO_PASSWORD || undefined });
  try {
    await client.connect();
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
      serverId: status.serverId,
      body: { hostname: status.hostname, version: status.version, webBase: process.env.PASEO_WEB_BASE ?? 'https://app.paseo.sh', projects: catalog },
    };
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}
