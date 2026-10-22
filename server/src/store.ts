import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isManagedLink, managedPaseoLinks, type DeviceSession, type Link, type PaseoDaemon, type Project, type ProjectInput } from '../../shared/src/model.ts';

/** Projects are stored as JSON documents; the table is just id → document. */
export class Store {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paseo_daemons (server_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paseo_daemon_settings (server_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        project_id TEXT NOT NULL, device_id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (project_id, device_id)
      );
    `);
  }

  list(): Project[] {
    const rows = this.#db.prepare('SELECT data FROM projects').all() as { data: string }[];
    return rows
      .map((r) => JSON.parse(r.data) as Project)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }

  get(id: string): Project | undefined {
    const row = this.#db.prepare('SELECT data FROM projects WHERE id = ?').get(id) as { data: string } | undefined;
    return row && (JSON.parse(row.data) as Project);
  }

  create(input: ProjectInput): Project {
    const maxOrder = this.list().reduce((m, p) => Math.max(m, p.order), -1);
    const project: Project = {
      id: `p_${randomUUID().slice(0, 8)}`,
      name: input.name,
      source: input.source ?? 'manual',
      paseo: input.paseo,
      links: input.links ?? [],
      order: input.order ?? maxOrder + 1,
      archived: input.archived ?? false,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    this.#write(project);
    return project;
  }

  /** Optimistic concurrency: the caller must send the version it last saw. */
  update(id: string, input: ProjectInput, version: number): Project | 'conflict' | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    if (current.version !== version) return 'conflict';
    const next: Project = {
      ...current,
      ...input,
      id,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.#write(next);
    return next;
  }

  delete(id: string): boolean {
    this.#db.prepare('DELETE FROM sessions WHERE project_id = ?').run(id);
    return this.#db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  }

  /** Each device writes only its own row, so concurrent devices never overwrite each other. */
  listSessions(projectId: string): DeviceSession[] {
    const rows = this.#db.prepare('SELECT data FROM sessions WHERE project_id = ?').all(projectId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as DeviceSession).sort((a, b) => b.changedAt - a.changedAt);
  }

  putSession(projectId: string, session: DeviceSession) {
    this.#db
      .prepare(
        'INSERT INTO sessions (project_id, device_id, data) VALUES (?, ?, ?) ON CONFLICT(project_id, device_id) DO UPDATE SET data = excluded.data',
      )
      .run(projectId, session.deviceId, JSON.stringify(session));
  }

  /** Catalogs as the syncs reported them, plus the user's per-daemon settings (code-server). */
  listDaemons(): PaseoDaemon[] {
    const rows = this.#db.prepare('SELECT data FROM paseo_daemons').all() as { data: string }[];
    return rows
      .map((r) => JSON.parse(r.data) as PaseoDaemon)
      .map((d) => ({ ...d, ...this.#daemonSettings(d.serverId) }))
      .sort((a, b) => a.hostname.localeCompare(b.hostname));
  }

  #daemonSettings(serverId: string): DaemonSettings {
    const row = this.#db.prepare('SELECT data FROM paseo_daemon_settings WHERE server_id = ?').get(serverId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as DaemonSettings) : {};
  }

  /** Store a daemon's catalog and re-point managed Paseo links of projects imported from it. */
  putDaemon(daemon: PaseoDaemon): number {
    const { codeServer: _, ...catalog } = daemon;
    this.#db
      .prepare('INSERT INTO paseo_daemons (server_id, data) VALUES (?, ?) ON CONFLICT(server_id) DO UPDATE SET data = excluded.data')
      .run(daemon.serverId, JSON.stringify(catalog));
    return this.#relink({ ...catalog, ...this.#daemonSettings(daemon.serverId) });
  }

  /** Returns undefined for an unknown daemon, else how many projects' links changed. */
  setDaemonSettings(serverId: string, settings: DaemonSettings): number | undefined {
    if (!this.#db.prepare('SELECT 1 FROM paseo_daemons WHERE server_id = ?').get(serverId)) return undefined;
    this.#db
      .prepare('INSERT INTO paseo_daemon_settings (server_id, data) VALUES (?, ?) ON CONFLICT(server_id) DO UPDATE SET data = excluded.data')
      .run(serverId, JSON.stringify(settings));
    return this.#relink(this.listDaemons().find((d) => d.serverId === serverId)!);
  }

  #relink(daemon: PaseoDaemon): number {
    let updated = 0;
    for (const project of this.list()) {
      if (project.paseo?.daemonId !== daemon.serverId) continue;
      const source = daemon.projects.find((p) => p.projectId === project.paseo!.projectId);
      if (!source) continue;
      // Managed links are rebuilt from the catalog; the user's own links keep their place after them.
      const managed = managedPaseoLinks(daemon, source, project.links, newLinkId);
      const links = [...managed, ...project.links.filter((l) => !isManagedLink(l))];
      if (canonical(links) === canonical(project.links)) continue;
      this.#write({ ...project, links, version: project.version + 1, updatedAt: new Date().toISOString() });
      updated++;
    }
    return updated;
  }

  /** Create Gleeok projects for the given Paseo projects; ones already imported are skipped. */
  importPaseo(serverId: string, projectIds: string[]): Project[] {
    const daemon = this.listDaemons().find((d) => d.serverId === serverId);
    if (!daemon) return [];
    const existing = new Set(
      this.list()
        .filter((p) => p.paseo?.daemonId === serverId)
        .map((p) => p.paseo!.projectId),
    );
    const created: Project[] = [];
    for (const id of projectIds) {
      const source = daemon.projects.find((p) => p.projectId === id);
      if (!source || existing.has(id)) continue;
      created.push(
        this.create({
          name: source.name,
          source: 'paseo',
          paseo: { daemonId: serverId, projectId: id, cwd: source.path },
          links: managedPaseoLinks(daemon, source, [], newLinkId),
        }),
      );
    }
    return created;
  }

  #write(p: Project) {
    this.#db
      .prepare('INSERT INTO projects (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(p.id, JSON.stringify(p));
  }
}

export interface DaemonSettings {
  codeServer?: string;
}

const newLinkId = () => `l_${randomUUID().slice(0, 8)}`;

/** Key order must not make an unchanged link list look changed (that would bump versions every sync). */
const canonical = (links: Link[]) => JSON.stringify(links.map((l) => Object.fromEntries(Object.entries(l).sort())));

export function parseSession(deviceId: string, body: unknown): DeviceSession | string {
  const b = body as Partial<DeviceSession> | null;
  if (!b || typeof b.deviceName !== 'string' || typeof b.changedAt !== 'number' || !Array.isArray(b.panes)) {
    return 'expected { deviceName, changedAt, panes[] }';
  }
  const panes: DeviceSession['panes'] = [];
  for (const pane of b.panes) {
    if (!Array.isArray(pane?.tabs)) return 'each pane needs tabs[]';
    const tabs = pane.tabs
      .filter((t) => typeof t?.url === 'string')
      .map((t) => ({
        url: t.url,
        title: typeof t.title === 'string' ? t.title : '',
        ...(typeof t.favicon === 'string' && t.favicon.length <= 2048 ? { favicon: t.favicon } : {}),
      }));
    panes.push({ tabs, active: typeof pane.active === 'number' ? pane.active : 0 });
  }
  return { deviceId, deviceName: b.deviceName, changedAt: b.changedAt, panes };
}

export function parseDaemon(serverId: string, body: unknown): PaseoDaemon | string {
  const b = body as Partial<PaseoDaemon> | null;
  if (!b || typeof b.hostname !== 'string' || !Array.isArray(b.projects)) return 'expected { hostname, projects[] }';
  for (const p of b.projects) {
    if (typeof p?.projectId !== 'string' || typeof p.name !== 'string' || typeof p.path !== 'string')
      return 'each project needs projectId, name, path';
  }
  return {
    serverId,
    hostname: b.hostname,
    version: String(b.version ?? ''),
    webBase: typeof b.webBase === 'string' && b.webBase ? b.webBase : 'https://app.paseo.sh',
    syncedAt: new Date().toISOString(),
    projects: b.projects.map((p) => ({
      projectId: p.projectId,
      name: p.name,
      path: p.path,
      workspaceCount: Number(p.workspaceCount ?? 0),
      latest: p.latest && typeof p.latest.workspaceId === 'string' ? p.latest : null,
    })),
  };
}

export function parseProjectInput(body: unknown): ProjectInput | string {
  if (typeof body !== 'object' || body === null) return 'body must be an object';
  const b = body as Record<string, unknown>;
  if (typeof b.name !== 'string' || !b.name.trim()) return 'name is required';
  const input: ProjectInput = { name: b.name.trim() };
  if (b.source === 'paseo' || b.source === 'manual') input.source = b.source;
  if (typeof b.order === 'number') input.order = b.order;
  if (typeof b.archived === 'boolean') input.archived = b.archived;
  if (b.paseo !== undefined) {
    const p = b.paseo as Record<string, unknown>;
    if (typeof p?.daemonId !== 'string' || typeof p.projectId !== 'string' || typeof p.cwd !== 'string')
      return 'paseo must be { daemonId, projectId, cwd }';
    input.paseo = { daemonId: p.daemonId, projectId: p.projectId, cwd: p.cwd };
  }
  if (b.links !== undefined) {
    if (!Array.isArray(b.links)) return 'links must be an array';
    const links: Link[] = [];
    for (const l of b.links as Record<string, unknown>[]) {
      if (typeof l?.id !== 'string' || typeof l.label !== 'string' || typeof l.url !== 'string')
        return 'each link needs id, label, url';
      const link: Link = { id: l.id, label: l.label, url: l.url };
      if (typeof l.pinnedPane === 'number') link.pinnedPane = l.pinnedPane;
      if (l.kind === 'paseo' || l.kind === 'paseo-terminal' || l.kind === 'paseo-code' || l.kind === 'code') link.kind = l.kind;
      // One primary code link per project: the first one marked wins.
      if (l.primary === true && link.kind && link.kind !== 'paseo' && link.kind !== 'paseo-terminal' && !links.some((x) => x.primary))
        link.primary = true;
      if (typeof l.icon === 'string' && l.icon.length <= 2048) link.icon = l.icon;
      links.push(link);
    }
    input.links = links;
  }
  return input;
}
