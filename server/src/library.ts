import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono, type Context } from 'hono';
import { byAgent } from './synced.ts';
import {
  KEY_RE,
  LIBRARY_KINDS,
  newLibraryKey,
  type LibraryChanges,
  type LibraryKind,
} from '../../shared/src/library.ts';

/**
 * The 文献库 store: one SQLite file plus a directory of attachment files. Every write bumps a
 * single library version, and each object remembers the version of its last change, so a
 * client asks for "everything since version N" (Zotero's sync model). Deletions leave
 * tombstones for the same purpose; the trash is just `deleted: true` on an item.
 */
export class Library {
  #db: DatabaseSync;
  #files: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.#files = join(dir, 'library');
    mkdirSync(this.#files, { recursive: true });
    this.#db = new DatabaseSync(join(dir, 'library.db'));
    this.#db.exec(`
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

  version(): number {
    const row = this.#db.prepare(`SELECT v FROM meta WHERE k = 'version'`).get() as { v: string } | undefined;
    return row ? Number(row.v) : 0;
  }

  changes(since: number): LibraryChanges {
    const out: LibraryChanges = {
      version: this.version(),
      items: [],
      collections: [],
      annotations: [],
      states: [],
      deleted: { items: [], collections: [], annotations: [], states: [] },
    };
    const rows = this.#db
      .prepare(`SELECT kind, key, version, data FROM objects WHERE version > ? ORDER BY version`)
      .all(since) as { kind: LibraryKind; key: string; version: number; data: string }[];
    for (const r of rows) (out[r.kind] as unknown[]).push(toObject(r));
    const gone = this.#db.prepare(`SELECT kind, key FROM tombstones WHERE version > ?`).all(since) as { kind: LibraryKind; key: string }[];
    for (const t of gone) out.deleted[t.kind].push(t.key);
    return out;
  }

  get(kind: LibraryKind, key: string): Obj | undefined {
    const row = this.#db.prepare(`SELECT key, version, data FROM objects WHERE kind = ? AND key = ?`).get(kind, key) as Row | undefined;
    return row && toObject(row);
  }

  /** Create objects (one transaction, one version); a key already in use is an error. */
  create(kind: LibraryKind, inputs: unknown[]): Obj[] | string {
    const parsed: Obj[] = [];
    for (const input of inputs) {
      const obj = parse(kind, input, undefined);
      if (typeof obj === 'string') return obj;
      obj.key ??= newLibraryKey();
      if (this.get(kind, obj.key as string) || parsed.some((p) => p.key === obj.key)) return `key ${obj.key} already exists`;
      parsed.push(obj);
    }
    const problem = parsed.map((o) => this.#checkRefs(kind, o, parsed)).find(Boolean);
    if (problem) return problem;
    return this.#tx((v) => {
      const now = new Date().toISOString();
      return parsed.map((o) => {
        if (kind === 'items') {
          o.dateAdded ??= now;
          o.dateModified = now;
        }
        return this.#put(kind, o, v);
      });
    });
  }

  /**
   * Change one object. `patch` sets fields (null removes one); `replace` swaps the whole object.
   * Fails with 'conflict' when the object changed after `ifVersion` (states skip the check).
   */
  update(kind: LibraryKind, key: string, body: unknown, ifVersion: number | undefined, replace = false): Obj | 'conflict' | undefined | string {
    const current = this.get(kind, key);
    if (!current) {
      // A state is created by its first write.
      if (kind !== 'states') return undefined;
    } else if (kind !== 'states') {
      if (ifVersion === undefined) return 'If-Unmodified-Since-Version is required';
      if (Number(current.version) > ifVersion) return 'conflict';
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'expected an object';
    const next: Obj = replace || !current ? { key } : { ...current };
    for (const [field, value] of Object.entries(body as Obj)) {
      if (field === 'key' || field === 'version') continue;
      if (value === null) delete next[field];
      else next[field] = value;
    }
    const obj = parse(kind, next, key);
    if (typeof obj === 'string') return obj;
    const problem = this.#checkRefs(kind, obj, []);
    if (problem) return problem;
    return this.#tx((v) => {
      if (kind === 'items') {
        obj.dateAdded ??= current?.dateAdded ?? new Date().toISOString();
        obj.dateModified = new Date().toISOString();
        // Server-owned: only an upload changes them.
        if (current?.fileHash) obj.fileHash = current.fileHash;
        if (current?.fileSize) obj.fileSize = current.fileSize;
      }
      return this.#put(kind, obj, v);
    });
  }

  /**
   * Delete for good. An item takes its notes, attachments, their annotations, reading states and
   * files with it; a collection takes its subcollections, and its items just leave it.
   */
  delete(kind: LibraryKind, key: string): boolean {
    if (!this.get(kind, key)) return false;
    this.#tx((v) => {
      if (kind === 'items') {
        const children = this.#children('items', key);
        for (const k of [key, ...children]) {
          for (const a of this.#children('annotations', k)) this.#remove('annotations', a, v);
          this.#remove('states', k, v);
          rmSync(join(this.#files, k), { recursive: true, force: true });
          this.#remove('items', k, v);
        }
      } else if (kind === 'collections') {
        const gone = [key, ...this.#descendants(key)];
        for (const c of gone) this.#remove('collections', c, v);
        const rows = this.#db.prepare(`SELECT key, version, data FROM objects WHERE kind = 'items'`).all() as Row[];
        for (const row of rows) {
          const item = toObject(row);
          const cols = (item.collections as string[] | undefined) ?? [];
          if (cols.some((c) => gone.includes(c))) this.#put('items', { ...item, collections: cols.filter((c) => !gone.includes(c)) }, v);
        }
      } else {
        this.#remove(kind, key, v);
      }
    });
    return true;
  }

  /** Store an attachment's file; the item records its hash and size (and gets a new version). */
  putFile(key: string, bytes: Uint8Array, expectedSha256?: string): Obj | string | undefined {
    const item = this.get('items', key);
    if (!item) return undefined;
    if (item.itemType !== 'attachment') return 'not an attachment';
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (expectedSha256 && expectedSha256.toLowerCase() !== sha256) return 'checksum mismatch';
    const dir = join(this.#files, key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'file.part'), bytes);
    renameSync(join(dir, 'file.part'), join(dir, 'file'));
    return this.#tx((v) => this.#put('items', { ...item, fileHash: sha256, fileSize: bytes.length, dateModified: new Date().toISOString() }, v));
  }

  getFile(key: string): { bytes: Buffer; item: Obj } | undefined {
    const item = this.get('items', key);
    const path = join(this.#files, key, 'file');
    if (!item || !existsSync(path)) return undefined;
    return { bytes: readFileSync(path), item };
  }

  #tx<T>(fn: (version: number) => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const v = this.version() + 1;
      const out = fn(v);
      this.#db.prepare(`INSERT INTO meta (k, v) VALUES ('version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).run(String(v));
      this.#db.exec('COMMIT');
      return out;
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
  }

  #put(kind: LibraryKind, obj: Obj, version: number): Obj {
    const { key, version: _v, ...data } = obj;
    const parent = kind === 'collections' ? (data.parentCollection || null) : ((data.parentItem as string | undefined) ?? null);
    this.#db
      .prepare(
        `INSERT INTO objects (kind, key, version, parent, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (kind, key) DO UPDATE SET version = excluded.version, parent = excluded.parent, data = excluded.data`,
      )
      .run(kind, key as string, version, parent as string | null, JSON.stringify(data));
    this.#db.prepare(`DELETE FROM tombstones WHERE kind = ? AND key = ?`).run(kind, key as string);
    return { key, version, ...data };
  }

  #remove(kind: LibraryKind, key: string, version: number) {
    const gone = this.#db.prepare(`DELETE FROM objects WHERE kind = ? AND key = ?`).run(kind, key);
    if (gone.changes) {
      this.#db
        .prepare(`INSERT INTO tombstones (kind, key, version) VALUES (?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET version = excluded.version`)
        .run(kind, key, version);
    }
  }

  #children(kind: LibraryKind, parent: string): string[] {
    return (this.#db.prepare(`SELECT key FROM objects WHERE kind = ? AND parent = ?`).all(kind, parent) as { key: string }[]).map((r) => r.key);
  }

  #descendants(collection: string): string[] {
    const out: string[] = [];
    for (const child of this.#children('collections', collection)) out.push(child, ...this.#descendants(child));
    return out;
  }

  /** References must point at existing objects (or ones created in the same request). */
  #checkRefs(kind: LibraryKind, obj: Obj, batch: Obj[]): string | undefined {
    const exists = (k: LibraryKind, key: string) => !!this.get(k, key) || (k === kind && batch.some((b) => b.key === key));
    if (kind === 'items') {
      if (obj.parentItem !== undefined && !exists('items', obj.parentItem as string)) return `parent item ${obj.parentItem} not found`;
      for (const c of (obj.collections as string[] | undefined) ?? []) if (!exists('collections', c)) return `collection ${c} not found`;
    }
    if (kind === 'collections' && obj.parentCollection) {
      let p: string | false = obj.parentCollection as string;
      for (let depth = 0; p; depth++) {
        if (p === obj.key || depth > 64) return 'collections cannot contain themselves';
        const parent: Obj | undefined = this.get('collections', p) ?? batch.find((b) => b.key === p);
        if (!parent) return `parent collection ${p} not found`;
        p = parent.parentCollection as string | false;
      }
    }
    if (kind === 'annotations' && this.get('items', obj.parentItem as string)?.itemType !== 'attachment') return 'annotations belong to an attachment';
    if (kind === 'states' && this.get('items', obj.key as string)?.itemType !== 'attachment') return 'states belong to an attachment';
    return undefined;
  }
}

type Obj = Record<string, unknown>;
type Row = { key: string; version: number; data: string };

function toObject(row: Row): Obj {
  return { key: row.key, version: row.version, ...(JSON.parse(row.data) as Obj) };
}

const MAX_OBJECT_BYTES = 1024 * 1024;
const isKey = (v: unknown) => typeof v === 'string' && KEY_RE.test(v);
/** Reader annotation ids and attachment keys are Zotero keys too, but older readers made longer ones. */
const isLooseKey = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);

/** Shape checks per kind; returns the object to store (minus server fields) or an error. */
function parse(kind: LibraryKind, input: unknown, key: string | undefined): Obj | string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'expected an object';
  const o = { ...(input as Obj) };
  delete o.version;
  if (key !== undefined) o.key = key;
  if (o.key !== undefined && !(kind === 'items' || kind === 'collections' ? isKey(o.key) : isLooseKey(o.key))) return `bad key ${String(o.key)}`;
  if (JSON.stringify(o).length > MAX_OBJECT_BYTES) return 'object too large';
  const strList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const tags = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((t) => t && typeof (t as Obj).tag === 'string'));
  switch (kind) {
    case 'items':
      if (typeof o.itemType !== 'string' || !o.itemType || o.itemType.length > 64) return 'itemType is required';
      if (o.parentItem !== undefined && !isKey(o.parentItem)) return 'bad parentItem';
      if (o.creators !== undefined && !(Array.isArray(o.creators) && o.creators.every((c) => c && typeof (c as Obj).creatorType === 'string')))
        return 'creators need creatorType';
      if (o.collections !== undefined && !(strList(o.collections) && (o.collections as string[]).every(isKey))) return 'bad collections';
      if (!tags(o.tags)) return 'tags are { tag }';
      if (o.deleted !== undefined && typeof o.deleted !== 'boolean') return 'deleted is a boolean';
      delete o.fileHash;
      delete o.fileSize;
      return o;
    case 'collections':
      if (typeof o.name !== 'string' || !o.name.trim()) return 'name is required';
      if (o.parentCollection === undefined || o.parentCollection === null) o.parentCollection = false;
      if (o.parentCollection !== false && !isKey(o.parentCollection)) return 'bad parentCollection';
      return o;
    case 'annotations':
      if (!isLooseKey(o.parentItem)) return 'parentItem (the attachment) is required';
      if (typeof o.type !== 'string') return 'type is required';
      if (!o.position || typeof o.position !== 'object') return 'position is required';
      if (!tags(o.tags)) return 'tags are { tag }';
      return o;
    case 'states':
      if (o.state === undefined) return 'state is required';
      return { key: o.key, state: o.state };
  }
}

const isKind = (k: string): k is LibraryKind => (LIBRARY_KINDS as string[]).includes(k);

/** The HTTP API, mounted at /api/library (behind the same token as the rest). */
export function libraryRoutes(lib: Library) {
  const r = new Hono();
  const versioned = <T>(c: { header: (k: string, v: string) => void }, body: T) => {
    c.header('Last-Modified-Version', String(lib.version()));
    return body;
  };

  r.get('/', (c) => c.json(versioned(c, lib.changes(Number(c.req.query('since') ?? 0) || 0))));

  r.get('/items/:key/file', (c) => {
    const file = lib.getFile(c.req.param('key'));
    if (!file) return c.json({ error: 'not found' }, 404);
    return c.body(new Uint8Array(file.bytes), 200, {
      'Content-Type': String(file.item.contentType ?? 'application/octet-stream'),
      ETag: `"${String(file.item.fileHash)}"`,
    });
  });

  r.put('/items/:key/file', async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const result = lib.putFile(c.req.param('key'), bytes, c.req.header('X-Content-SHA256') ?? undefined);
    if (result === undefined) return c.json({ error: 'not found' }, 404);
    if (typeof result === 'string') return c.json({ error: result }, 400);
    return c.json(versioned(c, result));
  });

  r.get('/:kind/:key', (c) => {
    const kind = c.req.param('kind');
    if (!isKind(kind)) return c.json({ error: 'unknown kind' }, 404);
    const obj = lib.get(kind, c.req.param('key'));
    return obj ? c.json(versioned(c, obj)) : c.json({ error: 'not found' }, 404);
  });

  r.post('/:kind', async (c) => {
    const kind = c.req.param('kind');
    if (!isKind(kind) || kind === 'states') return c.json({ error: 'unknown kind' }, 404);
    const body = await c.req.json().catch(() => null);
    const result = lib.create(kind, byAgent(c.req.raw, Array.isArray(body) ? body : [body]));
    if (typeof result === 'string') return c.json({ error: result }, 400);
    return c.json(versioned(c, Array.isArray(body) ? result : result[0]), 201);
  });

  const update = (replace: boolean) => async (c: Context) => {
    const kind = c.req.param('kind') ?? '';
    const key = c.req.param('key') ?? '';
    if (!isKind(kind)) return c.json({ error: 'unknown kind' }, 404);
    const header = c.req.header('If-Unmodified-Since-Version');
    const result = lib.update(kind, key, await c.req.json().catch(() => null), header === undefined ? undefined : Number(header), replace);
    if (result === undefined) return c.json({ error: 'not found' }, 404);
    if (result === 'conflict') return c.json({ error: 'version conflict', current: lib.get(kind, key) }, 409);
    if (typeof result === 'string') return c.json({ error: result }, result.startsWith('If-Unmodified') ? 428 : 400);
    return c.json(versioned(c, result));
  };
  r.patch('/:kind/:key', update(false));
  r.put('/:kind/:key', update(true));

  r.delete('/:kind/:key', (c) => {
    const kind = c.req.param('kind');
    if (!isKind(kind)) return c.json({ error: 'unknown kind' }, 404);
    return lib.delete(kind, c.req.param('key')) ? c.body(null, 204) : c.json({ error: 'not found' }, 404);
  });

  return r;
}
