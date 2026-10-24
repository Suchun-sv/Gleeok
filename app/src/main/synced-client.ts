import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { ConfigClient } from './config.ts';

type Obj = { key: string; version: number; [field: string]: unknown };

/**
 * This machine's copy of a SyncedStore on the server (see server/src/synced.ts): cached on disk so
 * it opens instantly and offline, kept current with "changes since version N", and written with
 * versioned PATCHes that re-apply their fields once after a conflict. The 日程 uses it.
 */
export class SyncedClient<K extends string> {
  #version = 0;
  #objects = new Map<K, Map<string, Obj>>();
  #syncing: Promise<void> | null = null;
  #saveTimer: NodeJS.Timeout | undefined;
  status: 'loading' | 'ok' | 'offline' | 'unavailable' = 'loading';
  error: string | undefined;
  onChange: () => void = () => {};

  constructor(
    private config: ConfigClient,
    private name: string,
    private kinds: readonly K[],
  ) {
    for (const k of kinds) this.#objects.set(k, new Map());
  }

  get #cachePath() {
    return join(app.getPath('userData'), `${this.name}-cache.json`);
  }

  load() {
    try {
      const c = JSON.parse(readFileSync(this.#cachePath, 'utf8')) as { version: number; objects: Record<string, Obj[]> };
      this.#version = c.version;
      for (const k of this.kinds) for (const o of c.objects[k] ?? []) this.#objects.get(k)!.set(o.key, o);
    } catch {
      // First run on this machine: the first sync fills it.
    }
  }

  all<T>(kind: K): T[] {
    return [...this.#objects.get(kind)!.values()] as T[];
  }

  get<T>(kind: K, key: string): T | undefined {
    return this.#objects.get(kind)!.get(key) as T | undefined;
  }

  snapshot() {
    return { status: this.status, error: this.error, version: this.#version, ...Object.fromEntries(this.kinds.map((k) => [k, this.all(k)])) };
  }

  sync(): Promise<void> {
    this.#syncing ??= (async () => {
      try {
        const res = await this.config.fetchRaw('GET', `/api/${this.name}?since=${this.#version}`);
        if (res.status === 404) {
          this.status = 'unavailable';
          this.error = '同步服务器还没有这个功能，请更新服务器';
          return;
        }
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        const c = (await res.json()) as { version: number; deleted: Record<string, string[]> } & Record<string, Obj[]>;
        for (const k of this.kinds) {
          for (const o of c[k] ?? []) this.#store(k, o);
          for (const key of c.deleted[k] ?? []) this.#objects.get(k)!.delete(key);
        }
        this.#version = Math.max(this.#version, c.version);
        this.status = 'ok';
        this.error = undefined;
        this.#changed();
      } catch (e) {
        this.status = this.#version > 0 ? 'offline' : 'unavailable';
        this.error = String((e as Error).message ?? e);
      } finally {
        this.#syncing = null;
        this.onChange();
      }
    })();
    return this.#syncing;
  }

  async create<T>(kind: K, objects: Record<string, unknown>[]): Promise<T[]> {
    const res = await this.config.fetchRaw('POST', `/api/${this.name}/${kind}`, { body: JSON.stringify(objects), headers: { 'content-type': 'application/json' } });
    if (!res.ok) throw new Error(await errorText(res));
    const created = (await res.json()) as Obj[];
    for (const o of created) this.#store(kind, o);
    this.#changed();
    return created as T[];
  }

  async patch<T>(kind: K, key: string, fields: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const current = this.#objects.get(kind)!.get(key);
      const res = await this.config.fetchRaw('PATCH', `/api/${this.name}/${kind}/${key}`, {
        body: JSON.stringify(fields),
        headers: { 'content-type': 'application/json', 'If-Unmodified-Since-Version': String(current?.version ?? 0) },
      });
      if (res.status === 409 && attempt === 0) {
        this.#store(kind, ((await res.json()) as { current: Obj }).current);
        continue;
      }
      if (!res.ok) throw new Error(await errorText(res));
      const saved = (await res.json()) as Obj;
      this.#store(kind, saved);
      this.#changed();
      return saved as T;
    }
  }

  async remove(kind: K, key: string) {
    const res = await this.config.fetchRaw('DELETE', `/api/${this.name}/${kind}/${key}`);
    if (!res.ok && res.status !== 404) throw new Error(await errorText(res));
    // The server may have removed more (a task's blocks): catch up.
    await this.sync();
  }

  #store(kind: K, o: Obj) {
    const prev = this.#objects.get(kind)!.get(o.key);
    if (!prev || prev.version <= o.version) this.#objects.get(kind)!.set(o.key, o);
  }

  #changed() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      const objects = Object.fromEntries(this.kinds.map((k) => [k, this.all(k)]));
      writeFileSync(this.#cachePath, JSON.stringify({ version: this.#version, objects }));
    }, 500);
    this.onChange();
  }
}

async function errorText(res: Response) {
  const text = await res.text();
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    return `${res.status} ${text}`;
  }
}
