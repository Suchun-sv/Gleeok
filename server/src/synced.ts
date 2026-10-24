import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono, type Context } from 'hono';
import { newLibraryKey } from '../../shared/src/library.ts';

export type Obj = Record<string, unknown>;
type Row = { key: string; version: number; data: string };

/**
 * A store of kinds of JSON objects that clients mirror with "everything since version N": one
 * SQLite file, a single version bumped per write, each object remembering its last change, and
 * tombstones for deletions. Subclasses say what each kind looks like and what a deletion takes
 * with it. (The 文献库 predates this and keeps its own copy, with files on top.)
 */
export abstract class SyncedStore<K extends string> {
  protected db: DatabaseSync;
  readonly kinds: readonly K[];

  constructor(path: string, kinds: readonly K[]) {
    this.kinds = kinds;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objects (
        kind TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL,
        parent TEXT, data TEXT NOT NULL, PRIMARY KEY (kind, key));
      CREATE INDEX IF NOT EXISTS objects_version ON objects (version);
      CREATE INDEX IF NOT EXISTS objects_parent ON objects (kind, parent);
      CREATE TABLE IF NOT EXISTS tombstones (
        kind TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (kind, key));
    `);
  }

  /** The object to store (without key/version), or a message saying what is wrong. */
  protected abstract parse(kind: K, obj: Obj): Obj | string;
  /** References that must exist (checked against the store and the objects created alongside). */
  protected checkRefs(_kind: K, _obj: Obj, _batch: Obj[]): string | undefined {
    return undefined;
  }
  /** Which column links an object to its owner, for cascades (e.g. a block's task). */
  protected parentOf(_kind: K, _obj: Obj): string | null {
    return null;
  }
  /** Fields the server sets on every write (timestamps). */
  protected stamp(_kind: K, _obj: Obj, _previous: Obj | undefined) {}
  /** What else goes when an object is deleted for good. */
  protected cascade(_kind: K, _key: string, _version: number) {}

  version(): number {
    const row = this.db.prepare(`SELECT v FROM meta WHERE k = 'version'`).get() as { v: string } | undefined;
    return row ? Number(row.v) : 0;
  }

  changes(since: number): Obj & { version: number; deleted: Record<string, string[]> } {
    const out: Obj & { version: number; deleted: Record<string, string[]> } = { version: this.version(), deleted: {} };
    for (const k of this.kinds) {
      out[k] = [];
      out.deleted[k] = [];
    }
    const rows = this.db.prepare(`SELECT kind, key, version, data FROM objects WHERE version > ? ORDER BY version`).all(since) as (Row & { kind: K })[];
    for (const r of rows) (out[r.kind] as unknown[])?.push(toObject(r));
    const gone = this.db.prepare(`SELECT kind, key FROM tombstones WHERE version > ?`).all(since) as { kind: K; key: string }[];
    for (const t of gone) out.deleted[t.kind]?.push(t.key);
    return out;
  }

  get(kind: K, key: string): Obj | undefined {
    const row = this.db.prepare(`SELECT key, version, data FROM objects WHERE kind = ? AND key = ?`).get(kind, key) as Row | undefined;
    return row && toObject(row);
  }

  children(kind: K, parent: string): string[] {
    return (this.db.prepare(`SELECT key FROM objects WHERE kind = ? AND parent = ?`).all(kind, parent) as { key: string }[]).map((r) => r.key);
  }

  create(kind: K, inputs: unknown[]): Obj[] | string {
    const parsed: Obj[] = [];
    for (const input of inputs) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return 'expected an object';
      const { version: _v, ...raw } = input as Obj;
      const obj = this.#checked(kind, raw);
      if (typeof obj === 'string') return obj;
      obj.key ??= newLibraryKey();
      if (this.get(kind, obj.key as string) || parsed.some((p) => p.key === obj.key)) return `key ${obj.key} already exists`;
      parsed.push(obj);
    }
    const problem = parsed.map((o) => this.checkRefs(kind, o, parsed)).find(Boolean);
    if (problem) return problem;
    return this.tx((v) =>
      parsed.map((o) => {
        this.stamp(kind, o, undefined);
        return this.put(kind, o, v);
      }),
    );
  }

  /** Set fields (null removes one), or replace the object; 'conflict' when it changed after `ifVersion`. */
  update(kind: K, key: string, body: unknown, ifVersion: number | undefined, replace = false): Obj | 'conflict' | undefined | string {
    const current = this.get(kind, key);
    if (!current) return undefined;
    if (ifVersion === undefined) return 'If-Unmodified-Since-Version is required';
    if (Number(current.version) > ifVersion) return 'conflict';
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'expected an object';
    const next: Obj = replace ? { key } : { ...current };
    for (const [field, value] of Object.entries(body as Obj)) {
      if (field === 'key' || field === 'version') continue;
      if (value === null) delete next[field];
      else next[field] = value;
    }
    delete next.version;
    const obj = this.#checked(kind, next);
    if (typeof obj === 'string') return obj;
    const problem = this.checkRefs(kind, obj, []);
    if (problem) return problem;
    return this.tx((v) => {
      this.stamp(kind, obj, current);
      return this.put(kind, obj, v);
    });
  }

  delete(kind: K, key: string): boolean {
    if (!this.get(kind, key)) return false;
    this.tx((v) => {
      this.cascade(kind, key, v);
      this.remove(kind, key, v);
    });
    return true;
  }

  #checked(kind: K, obj: Obj): Obj | string {
    if (obj.key !== undefined && (typeof obj.key !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(obj.key))) return `bad key ${String(obj.key)}`;
    if (JSON.stringify(obj).length > 256 * 1024) return 'object too large';
    return this.parse(kind, obj);
  }

  protected tx<T>(fn: (version: number) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const v = this.version() + 1;
      const out = fn(v);
      this.db.prepare(`INSERT INTO meta (k, v) VALUES ('version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).run(String(v));
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  protected put(kind: K, obj: Obj, version: number): Obj {
    const { key, version: _v, ...data } = obj;
    this.db
      .prepare(
        `INSERT INTO objects (kind, key, version, parent, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (kind, key) DO UPDATE SET version = excluded.version, parent = excluded.parent, data = excluded.data`,
      )
      .run(kind, key as string, version, this.parentOf(kind, obj), JSON.stringify(data));
    this.db.prepare(`DELETE FROM tombstones WHERE kind = ? AND key = ?`).run(kind, key as string);
    return { key, version, ...data };
  }

  protected remove(kind: K, key: string, version: number) {
    const gone = this.db.prepare(`DELETE FROM objects WHERE kind = ? AND key = ?`).run(kind, key);
    if (gone.changes) {
      this.db
        .prepare(`INSERT INTO tombstones (kind, key, version) VALUES (?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET version = excluded.version`)
        .run(kind, key, version);
    }
  }
}

function toObject(row: Row): Obj {
  return { key: row.key, version: row.version, ...(JSON.parse(row.data) as Obj) };
}

/** GET ?since=, GET/POST/PATCH/PUT/DELETE per kind, as the 文献库's API (mount under /api/<name>). */
export function syncedRoutes<K extends string>(store: SyncedStore<K>) {
  const r = new Hono();
  const isKind = (k: string): k is K => (store.kinds as readonly string[]).includes(k);
  const versioned = <T>(c: Context, body: T) => {
    c.header('Last-Modified-Version', String(store.version()));
    return body;
  };
  r.get('/', (c) => c.json(versioned(c, store.changes(Number(c.req.query('since') ?? 0) || 0))));
  r.get('/:kind/:key', (c) => {
    const kind = c.req.param('kind');
    if (!isKind(kind)) return c.json({ error: 'unknown kind' }, 404);
    const obj = store.get(kind, c.req.param('key'));
    return obj ? c.json(versioned(c, obj)) : c.json({ error: 'not found' }, 404);
  });
  r.post('/:kind', async (c) => {
    const kind = c.req.param('kind');
    if (!isKind(kind)) return c.json({ error: 'unknown kind' }, 404);
    const body = await c.req.json().catch(() => null);
    const result = store.create(kind, Array.isArray(body) ? body : [body]);
    if (typeof result === 'string') return c.json({ error: result }, 400);
    return c.json(versioned(c, Array.isArray(body) ? result : result[0]), 201);
  });
  const update = (replace: boolean) => async (c: Context) => {
    const kind = c.req.param('kind') ?? '';
    const key = c.req.param('key') ?? '';
    if (!isKind(kind)) return c.json({ error: 'unknown kind' }, 404);
    const header = c.req.header('If-Unmodified-Since-Version');
    const result = store.update(kind, key, await c.req.json().catch(() => null), header === undefined ? undefined : Number(header), replace);
    if (result === undefined) return c.json({ error: 'not found' }, 404);
    if (result === 'conflict') return c.json({ error: 'version conflict', current: store.get(kind, key) }, 409);
    if (typeof result === 'string') return c.json({ error: result }, result.startsWith('If-Unmodified') ? 428 : 400);
    return c.json(versioned(c, result));
  };
  r.patch('/:kind/:key', update(false));
  r.put('/:kind/:key', update(true));
  r.delete('/:kind/:key', (c) => {
    const kind = c.req.param('kind');
    if (!isKind(kind)) return c.json({ error: 'unknown kind' }, 404);
    return store.delete(kind, c.req.param('key')) ? c.body(null, 204) : c.json({ error: 'not found' }, 404);
  });
  return r;
}
