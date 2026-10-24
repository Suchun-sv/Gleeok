import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { createApp } from '../../../server/src/app.ts';
import { Library } from '../../../server/src/library.ts';
import { Planner } from '../../../server/src/planner.ts';
import { Store } from '../../../server/src/store.ts';
import type { ServerStatus } from '../../../shared/src/ipc.ts';
import { isCodeLink, sameUrl, type DeviceSession, type Link, type PaseoDaemon, type Project } from '../../../shared/src/model.ts';

interface ClientConfig {
  serverUrl: string;
  token: string;
  /** Password vault server; otherwise whatever the Gleeok server suggests, else Bitwarden's cloud. */
  vaultUrl?: string;
}

export class ConflictError extends Error {}

/**
 * Projects, links and synced tabs. With ~/.config/gleeok/client.json it talks to a Gleeok server
 * (keeping a local copy so the app still opens offline); without one it runs in local mode: the
 * same API (server/src/app.ts) is served in-process from a SQLite file in userData.
 */
export class ConfigClient {
  projects: Project[] = [];
  paseo: PaseoDaemon[] = [];
  status: ServerStatus = 'unconfigured';
  error?: string;
  #conf?: ClientConfig;
  #suggestedVaultUrl?: string;
  #mobileUrl: string | undefined;
  #local: ReturnType<typeof createApp> | null = null;
  #cachePath = join(app.getPath('userData'), 'projects-cache.json');

  get serverUrl() {
    return this.#conf?.serverUrl;
  }

  get local() {
    return this.#local !== null;
  }

  /** The phone page with this machine's token in its fragment (the page keeps it and drops it from the URL). */
  get mobileLink(): string | null {
    if (!this.#mobileUrl || !this.#conf?.token) return null;
    return `${this.#mobileUrl}#token=${encodeURIComponent(this.#conf.token)}`;
  }

  get vaultUrl() {
    return this.#conf?.vaultUrl ?? this.#suggestedVaultUrl;
  }

  load() {
    const path = process.env.GLEEOK_CLIENT_CONFIG ?? join(homedir(), '.config/gleeok/client.json');
    try {
      this.#conf = JSON.parse(readFileSync(path, 'utf8')) as ClientConfig;
      this.status = 'offline';
    } catch {
      this.#local = createApp(new Store(join(app.getPath('userData'), 'gleeok.db')), {
        local: true,
        library: new Library(app.getPath('userData')),
        planner: new Planner(app.getPath('userData')),
      });
      this.status = 'local';
      return;
    }
    try {
      const cache = JSON.parse(readFileSync(this.#cachePath, 'utf8')) as { projects: Project[]; paseo: PaseoDaemon[] };
      this.projects = cache.projects ?? [];
      this.paseo = cache.paseo ?? [];
    } catch {
      this.projects = [];
    }
  }

  async refresh() {
    try {
      [this.projects, this.paseo] = (await Promise.all([
        this.#request('GET', '/api/projects'),
        this.#request('GET', '/api/paseo/daemons'),
      ])) as [Project[], PaseoDaemon[]];
      if (this.#local) return;
      this.status = 'ok';
      this.error = undefined;
      writeFileSync(this.#cachePath, JSON.stringify({ projects: this.projects, paseo: this.paseo }));
      // Older servers lack this endpoint; the vault then falls back to the default.
      const cfg = (await this.#request('GET', '/api/client-config').catch(() => null)) as { vaultUrl?: string | null; mobileUrl?: string | null } | null;
      this.#suggestedVaultUrl = cfg?.vaultUrl ?? undefined;
      this.#mobileUrl = cfg?.mobileUrl ?? undefined;
    } catch (e) {
      this.status = 'offline';
      this.error = String(e);
    }
  }

  async create(name: string): Promise<Project> {
    const p = (await this.#request('POST', '/api/projects', { name })) as Project;
    await this.refresh();
    return p;
  }

  async save(project: Project): Promise<Project> {
    const saved = (await this.#request('PUT', `/api/projects/${project.id}`, project)) as Project;
    await this.refresh();
    return saved;
  }

  async importPaseo(serverId: string, projectIds: string[]): Promise<Project[]> {
    const created = (await this.#request('POST', '/api/paseo/import', { serverId, projectIds })) as Project[];
    await this.refresh();
    return created;
  }

  /** Append a link unless the project already has that URL. Returns whether it was added. */
  async addLink(projectId: string, link: Link): Promise<boolean> {
    return this.#editLinks(projectId, (links) => (links.some((l) => sameUrl(l.url, link.url)) ? null : [...links, link]));
  }

  /** Replace the link with the same id, or append it. */
  async upsertLink(projectId: string, link: Link): Promise<boolean> {
    return this.#editLinks(projectId, (links) =>
      links.some((l) => l.id === link.id) ? links.map((l) => (l.id === link.id ? link : l)) : [...links, link],
    );
  }

  async removeLink(projectId: string, linkId: string): Promise<boolean> {
    return this.#editLinks(projectId, (links) => links.filter((l) => l.id !== linkId));
  }

  async setArchived(projectId: string, archived: boolean): Promise<boolean> {
    return this.#edit(projectId, (p) => (p.archived === archived ? null : { ...p, archived }));
  }

  #editLinks(projectId: string, edit: (links: Link[]) => Link[] | null): Promise<boolean> {
    return this.#edit(projectId, (p) => {
      const links = edit(p.links);
      return links && { ...p, links };
    });
  }

  /** Apply an edit to the latest copy of a project; on a version conflict, refresh and retry once. */
  async #edit(projectId: string, edit: (p: Project) => Project | null): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const project = this.projects.find((p) => p.id === projectId);
      const next = project && edit(project);
      if (!project || !next) return false;
      try {
        await this.save(next);
        return true;
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
        await this.refresh();
      }
    }
    return false;
  }

  /** Mark one code link as the project's primary; the others lose the mark. */
  async setPrimaryCode(projectId: string, linkId: string): Promise<boolean> {
    return this.#editLinks(projectId, (links) =>
      links.map((l) => {
        if (!isCodeLink(l)) return l;
        const { primary: _, ...rest } = l;
        return l.id === linkId ? { ...rest, primary: true } : rest;
      }),
    );
  }

  async setDaemonSettings(serverId: string, settings: { codeServer: string | null }) {
    await this.#request('PUT', `/api/paseo/daemons/${serverId}/settings`, settings);
    await this.refresh();
  }

  async detectCodeServer(serverId: string): Promise<string | null> {
    const r = (await this.#request('POST', `/api/paseo/daemons/${serverId}/detect`)) as { codeServer: string | null };
    await this.refresh();
    return r.codeServer;
  }

  /** Store a Paseo daemon's catalog (local mode feeds it from the local daemon). */
  async putPaseoDaemon(serverId: string, body: unknown) {
    await this.#request('PUT', `/api/paseo/daemons/${serverId}`, body);
  }

  /** Every device's tabs for a project, newest first. */
  async listSessions(projectId: string): Promise<DeviceSession[]> {
    return (await this.#request('GET', `/api/projects/${projectId}/sessions`)) as DeviceSession[];
  }

  async putSession(projectId: string, session: DeviceSession) {
    await this.#request('PUT', `/api/projects/${projectId}/sessions/${session.deviceId}`, session);
  }

  async remove(id: string) {
    await this.#request('DELETE', `/api/projects/${id}`);
    await this.refresh();
  }

  /** A request to the sync server (or the in-process app in local mode), for callers that read the response themselves. */
  async fetchRaw(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<Response> {
    const req = {
      method,
      headers: { authorization: `Bearer ${this.#conf?.token ?? ''}`, ...init.headers },
      body: init.body,
    };
    if (this.#local) return this.#local.fetch(new Request(new URL(path, 'http://local'), req));
    if (this.#conf) return fetch(new URL(path, this.#conf.serverUrl), { ...req, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) });
    throw new Error('server not configured');
  }

  async #request(method: string, path: string, body?: unknown): Promise<unknown> {
    const init = {
      method,
      headers: { authorization: `Bearer ${this.#conf?.token ?? ''}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    let res: Response;
    if (this.#local) res = await this.#local.fetch(new Request(new URL(path, 'http://local'), init));
    else if (this.#conf) res = await fetch(new URL(path, this.#conf.serverUrl), { ...init, signal: AbortSignal.timeout(5000) });
    else throw new Error('server not configured');
    if (res.status === 409) throw new ConflictError('项目已在别处被修改，已刷新为最新版本');
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? undefined : res.json();
  }
}
