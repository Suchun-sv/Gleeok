import { useSyncExternalStore } from 'react';
import type { LibraryOp, LibrarySnapshot } from '../../../../shared/src/ipc.ts';
import type { LibraryCollection, LibraryItem } from '../../../../shared/src/library.ts';
import { PUBLICATION_FIELDS } from '../../../../shared/src/library-schema.ts';
import { makeCitationKey, toBibtex } from '../../../../shared/src/bibtex.ts';
export { creatorsShort, shortName, yearOf } from '../../../../shared/src/library-format.ts';

// One subscription for every view of the library in this window.
let current: LibrarySnapshot | null = null;
const listeners = new Set<() => void>();
let started = false;

function subscribe(cb: () => void) {
  if (!started) {
    started = true;
    void gleeok.getLibrary().then((s) => {
      current ??= s;
      for (const l of listeners) l();
    });
    gleeok.onLibrary((s) => {
      current = s;
      for (const l of listeners) l();
    });
  }
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useLibrary(): LibrarySnapshot | null {
  return useSyncExternalStore(subscribe, () => current);
}

/** Run a library operation in main; throws its error message. */
export async function lib<T = unknown>(op: LibraryOp): Promise<T> {
  const r = await gleeok.library(op);
  if (r.error) throw new Error(r.error);
  return r.result as T;
}

export const isRegular = (i: LibraryItem) => i.itemType !== 'note' && i.itemType !== 'attachment' && i.itemType !== 'annotation';

export function childrenOf(snap: LibrarySnapshot, key: string, type?: 'note' | 'attachment') {
  return snap.items.filter((i) => i.parentItem === key && !i.deleted && (!type || i.itemType === type));
}

export function publicationOf(item: LibraryItem): string {
  for (const f of PUBLICATION_FIELDS) if (typeof item[f] === 'string' && item[f]) return item[f] as string;
  return '';
}

const stripHtml = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');

/** What hangs off each item, gathered in one pass so lists never scan the library per row. */
export interface ItemInfo {
  /** The first attachment with a stored file. */
  pdf?: string;
  notes: number;
  /** Lower-cased search text: the item's own fields plus its notes. */
  haystack: string;
}

export function buildIndex(snap: LibrarySnapshot): Map<string, ItemInfo> {
  const index = new Map<string, ItemInfo>();
  const noteText = new Map<string, string[]>();
  for (const c of snap.items) {
    if (!c.parentItem || c.deleted) continue;
    const info = index.get(c.parentItem) ?? { notes: 0, haystack: '' };
    if (c.itemType === 'attachment' && c.fileHash) info.pdf ??= c.key;
    if (c.itemType === 'note') {
      info.notes++;
      noteText.set(c.parentItem, [...(noteText.get(c.parentItem) ?? []), stripHtml(String(c.note ?? ''))]);
    }
    index.set(c.parentItem, info);
  }
  for (const item of snap.items) {
    if (!isRegular(item)) continue;
    const info = index.get(item.key) ?? { notes: 0, haystack: '' };
    info.haystack = [
      item.title,
      ...(item.creators ?? []).map((c) => `${c.firstName ?? ''} ${c.lastName ?? ''} ${c.name ?? ''}`),
      item.date,
      publicationOf(item),
      item.DOI,
      ...(item.tags ?? []).map((t) => t.tag),
      ...(noteText.get(item.key) ?? []),
    ]
      .join(' ')
      .toLowerCase();
    index.set(item.key, info);
  }
  return index;
}

/** Quick search: every word must appear in the title, creators, year, publication, DOI, tags or notes. */
export function matches(info: ItemInfo | undefined, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => info?.haystack.includes(w));
}

export interface CollectionNode {
  collection: LibraryCollection;
  children: CollectionNode[];
}

export function collectionTree(collections: LibraryCollection[]): CollectionNode[] {
  const byParent = new Map<string | false, LibraryCollection[]>();
  for (const c of collections) {
    const p = c.parentCollection && collections.some((x) => x.key === c.parentCollection) ? c.parentCollection : false;
    byParent.set(p, [...(byParent.get(p) ?? []), c]);
  }
  const build = (p: string | false): CollectionNode[] =>
    (byParent.get(p) ?? []).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map((c) => ({ collection: c, children: build(c.key) }));
  return build(false);
}

/** A collection and everything below it. */
export function collectionAndBelow(collections: LibraryCollection[], key: string): Set<string> {
  const out = new Set([key]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of collections) if (c.parentCollection && out.has(c.parentCollection) && !out.has(c.key)) (out.add(c.key), (grew = true));
  }
  return out;
}

export function formatSize(bytes?: number) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Citation keys for these items, giving the ones without a key a new one (saved, so it never
 * changes under a paper that already cites it).
 */
export async function citationKeys(snap: LibrarySnapshot, keys: string[]): Promise<{ item: LibraryItem; key: string }[]> {
  const taken = new Set(snap.items.map((i) => i.citationKey).filter((k): k is string => typeof k === 'string' && !!k));
  const out: { item: LibraryItem; key: string }[] = [];
  for (const k of keys) {
    const item = snap.items.find((i) => i.key === k);
    if (!item || !isRegular(item)) continue;
    let key = typeof item.citationKey === 'string' && item.citationKey ? item.citationKey : '';
    if (!key) {
      key = makeCitationKey(item, taken);
      await lib({ op: 'patch', kind: 'items', key: item.key, fields: { citationKey: key } });
    }
    taken.add(key);
    out.push({ item, key });
  }
  return out;
}

export async function bibtexOf(snap: LibrarySnapshot, keys: string[]): Promise<string> {
  return (await citationKeys(snap, keys)).map(({ item, key }) => toBibtex(item, key)).join('\n\n');
}

/** Copy for Overleaf: the BibTeX entries, or a \cite{} of their keys. Returns what was copied, for a message. */
export async function copyCitations(snap: LibrarySnapshot, keys: string[], as: 'bibtex' | 'cite'): Promise<string> {
  const text = as === 'cite' ? `\\cite{${(await citationKeys(snap, keys)).map((c) => c.key).join(',')}}` : await bibtexOf(snap, keys);
  await lib({ op: 'copyText', text });
  return as === 'cite' ? `已复制 ${text}` : `已复制 ${keys.length} 条 BibTeX`;
}
