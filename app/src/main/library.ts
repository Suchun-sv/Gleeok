import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { app } from 'electron';
import {
  newLibraryKey,
  type LibraryAnnotation,
  type LibraryChanges,
  type LibraryCollection,
  type LibraryItem,
  type LibraryKind,
  type LibraryState,
} from '../../../shared/src/library.ts';
import type { LibrarySnapshot } from '../../../shared/src/ipc.ts';
import type { ConfigClient } from './config.ts';

type Obj = LibraryItem | LibraryCollection | LibraryAnnotation | LibraryState;

/**
 * This machine's side of the 文献库: a cached copy of the library (so it opens instantly and can
 * be browsed offline), kept current with "changes since version N", and writes that retry once
 * on a version conflict by re-applying their fields to the newer copy.
 */
export class LibraryClient {
  #version = 0;
  #objects: Record<LibraryKind, Map<string, Obj>> = { items: new Map(), collections: new Map(), annotations: new Map(), states: new Map() };
  #syncing: Promise<void> | null = null;
  #saveTimer: NodeJS.Timeout | undefined;
  status: LibrarySnapshot['status'] = 'loading';
  error: string | undefined;
  onChange: () => void = () => {};

  constructor(private config: ConfigClient) {}

  get #cachePath() {
    return join(app.getPath('userData'), 'library-cache.json');
  }

  load() {
    try {
      const c = JSON.parse(readFileSync(this.#cachePath, 'utf8')) as { version: number; objects: Record<LibraryKind, Obj[]> };
      this.#version = c.version;
      for (const kind of Object.keys(this.#objects) as LibraryKind[]) {
        for (const o of c.objects[kind] ?? []) this.#objects[kind].set(o.key, o);
      }
    } catch {
      // First run on this machine: the first sync fills it.
    }
  }

  snapshot(): LibrarySnapshot {
    return {
      status: this.status,
      error: this.error,
      version: this.#version,
      items: [...this.#objects.items.values()] as LibraryItem[],
      collections: [...this.#objects.collections.values()] as LibraryCollection[],
    };
  }

  item(key: string) {
    return this.#objects.items.get(key) as LibraryItem | undefined;
  }

  annotationsOf(attachmentKey: string): LibraryAnnotation[] {
    return ([...this.#objects.annotations.values()] as LibraryAnnotation[]).filter((a) => a.parentItem === attachmentKey);
  }

  stateOf(attachmentKey: string): LibraryState | undefined {
    return this.#objects.states.get(attachmentKey) as LibraryState | undefined;
  }

  /** Pull everything that changed since the cached version; concurrent calls share one request. */
  sync(): Promise<void> {
    this.#syncing ??= (async () => {
      try {
        const res = await this.config.fetchRaw('GET', `/api/library?since=${this.#version}`);
        if (res.status === 404) {
          this.status = 'unavailable';
          this.error = '同步服务器还没有文献库功能，请更新服务器';
          return;
        }
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        this.#apply((await res.json()) as LibraryChanges);
        this.status = 'ok';
        this.error = undefined;
      } catch (e) {
        // Offline: the cached copy stays usable.
        this.status = this.#version > 0 ? 'offline' : 'unavailable';
        this.error = String((e as Error).message ?? e);
      } finally {
        this.#syncing = null;
        this.onChange();
      }
    })();
    return this.#syncing;
  }

  async create<T extends Obj>(kind: LibraryKind, objects: Partial<T>[]): Promise<T[]> {
    const res = await this.config.fetchRaw('POST', `/api/library/${kind}`, { body: JSON.stringify(objects), headers: { 'content-type': 'application/json' } });
    if (!res.ok) throw new Error(await errorText(res));
    const created = (await res.json()) as T[];
    for (const o of created) this.#store(kind, o);
    this.#changed();
    return created;
  }

  /** Set fields (null removes one). A conflict re-applies the same fields to the newer copy, once. */
  async patch<T extends Obj>(kind: LibraryKind, key: string, fields: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const current = this.#objects[kind].get(key);
      const res = await this.config.fetchRaw(kind === 'states' ? 'PUT' : 'PATCH', `/api/library/${kind}/${key}`, {
        body: JSON.stringify(fields),
        headers: { 'content-type': 'application/json', ...(current && kind !== 'states' ? { 'If-Unmodified-Since-Version': String(current.version) } : {}) },
      });
      if (res.status === 409 && attempt === 0) {
        const { current: newer } = (await res.json()) as { current: Obj };
        this.#store(kind, newer);
        continue;
      }
      if (!res.ok) throw new Error(await errorText(res));
      const saved = (await res.json()) as T;
      this.#store(kind, saved);
      this.#changed();
      return saved;
    }
  }

  async remove(kind: LibraryKind, key: string) {
    const res = await this.config.fetchRaw('DELETE', `/api/library/${kind}/${key}`);
    if (!res.ok && res.status !== 404) throw new Error(await errorText(res));
    // The server also removed whatever hung off it (notes, attachments, annotations...).
    await this.sync();
  }

  /**
   * Each PDF becomes an item (titled from the PDF, else the file name) with the file attached;
   * with `parentItem`, the PDFs are attached to that item instead.
   */
  async addFiles(paths: string[], collection?: string, parentItem?: string): Promise<LibraryItem[]> {
    const added: LibraryItem[] = [];
    for (const path of paths) {
      const bytes = readFileSync(path);
      const filename = basename(path);
      const parentKey = parentItem ?? newLibraryKey();
      const attachmentKey = newLibraryKey();
      const attachment = { key: attachmentKey, itemType: 'attachment', parentItem: parentKey, title: 'PDF', filename, contentType: 'application/pdf', linkMode: 'imported_file' };
      const created = await this.create<LibraryItem>(
        'items',
        parentItem
          ? [attachment]
          : [
              {
                key: parentKey,
                itemType: 'document',
                title: pdfTitle(bytes) ?? filename.replace(/\.pdf$/i, ''),
                ...(collection ? { collections: [collection] } : {}),
              },
              attachment,
            ],
      );
      const parent = parentItem ? this.item(parentItem)! : created[0];
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const res = await this.config.fetchRaw('PUT', `/api/library/items/${attachmentKey}/file`, {
        body: new Uint8Array(bytes),
        headers: { 'content-type': 'application/pdf', 'X-Content-SHA256': sha256 },
        timeoutMs: 120_000,
      });
      if (!res.ok) throw new Error(`上传 ${filename} 失败：${await errorText(res)}`);
      this.#store('items', (await res.json()) as LibraryItem);
      this.#changed();
      added.push(parent);
    }
    return added;
  }

  /** An attachment's file, from this machine's cache when it matches the library's hash. */
  async file(key: string): Promise<Buffer> {
    const item = this.item(key);
    const dir = join(app.getPath('userData'), 'library-files');
    const path = join(dir, key);
    if (item?.fileHash) {
      try {
        const cached = readFileSync(path);
        if (createHash('sha256').update(cached).digest('hex') === item.fileHash) return cached;
      } catch {
        // Not cached yet.
      }
    }
    const res = await this.config.fetchRaw('GET', `/api/library/items/${key}/file`, { timeoutMs: 120_000 });
    if (!res.ok) throw new Error(await errorText(res));
    const bytes = Buffer.from(await res.arrayBuffer());
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, bytes);
    return bytes;
  }

  #apply(c: LibraryChanges) {
    for (const kind of Object.keys(this.#objects) as LibraryKind[]) {
      for (const o of c[kind] as Obj[]) this.#store(kind, o);
      for (const key of c.deleted[kind]) this.#objects[kind].delete(key);
    }
    this.#version = Math.max(this.#version, c.version);
    this.#changed();
  }

  #store(kind: LibraryKind, o: Obj) {
    const prev = this.#objects[kind].get(o.key);
    if (!prev || prev.version <= o.version) this.#objects[kind].set(o.key, o);
  }

  #changed() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      const objects = Object.fromEntries(Object.entries(this.#objects).map(([k, m]) => [k, [...m.values()]]));
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

/**
 * The title in a PDF's document info dictionary, found through the trailer's /Info reference
 * (embedded figures carry info dictionaries of their own), when it is worth showing.
 */
function pdfTitle(bytes: Buffer): string | null {
  const text = bytes.toString('latin1');
  const refs = [...text.matchAll(/\/Info\s+(\d+)\s+(\d+)\s+R/g)];
  const ref = refs[refs.length - 1];
  if (!ref) return null;
  const start = text.search(new RegExp(`(^|[^0-9])${ref[1]}\\s+${ref[2]}\\s+obj\\b`));
  if (start < 0) return null;
  const end = text.indexOf('endobj', start);
  const info = text.slice(start, end < 0 ? start + 4096 : end);
  const m = /\/Title\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)/.exec(info);
  if (!m) return null;
  const title = decodePdfString(m[1]).trim();
  // Skip generator junk like "untitled" or "Microsoft Word - x.docx".
  if (title.length < 4 || /^(untitled|microsoft word|slide \d)/i.test(title) || /[\x00-\x08]/.test(title)) return null;
  return title;
}

/** A PDF string literal "(...)" or hex string "<...>", UTF-16BE when it starts with a BOM. */
function decodePdfString(raw: string): string {
  let bytes: number[];
  if (raw.startsWith('<')) {
    const hex = raw.slice(1, -1).replace(/\s/g, '');
    bytes = (hex.match(/../g) ?? []).map((h) => parseInt(h, 16));
  } else {
    const body = raw.slice(1, -1).replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_m, e: string) =>
      /^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e,
    );
    bytes = [...body].map((c) => c.charCodeAt(0) & 0xff);
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  // PDF 2.0 allows UTF-8 with a BOM; everything else is (close enough to) Latin-1.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return Buffer.from(bytes.slice(3)).toString('utf8');
  return Buffer.from(bytes).toString('latin1');
}
