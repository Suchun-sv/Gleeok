import { useSyncExternalStore } from 'react';
import type { LibraryOp, LibrarySnapshot } from '../../../../shared/src/ipc.ts';
import type { Creator, LibraryCollection, LibraryItem } from '../../../../shared/src/library.ts';
import { PUBLICATION_FIELDS } from '../../../../shared/src/library-schema.ts';

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

const lastName = (c: Creator) => c.lastName || c.name || c.firstName || '';

/** "Vaswani", "Vaswani 和 Shazeer", "Vaswani 等" (authors first, like Zotero's creator column). */
export function creatorsShort(item: LibraryItem): string {
  const all = item.creators ?? [];
  const authors = all.filter((c) => c.creatorType === 'author' || c.creatorType === 'presenter');
  const list = authors.length ? authors : all;
  if (list.length === 0) return '';
  if (list.length === 1) return lastName(list[0]);
  if (list.length === 2) return `${lastName(list[0])} 和 ${lastName(list[1])}`;
  return `${lastName(list[0])} 等`;
}

export const yearOf = (item: LibraryItem) => /\b(1[5-9]\d\d|20\d\d|21\d\d)\b/.exec(String(item.date ?? ''))?.[1] ?? '';

export function publicationOf(item: LibraryItem): string {
  for (const f of PUBLICATION_FIELDS) if (typeof item[f] === 'string' && item[f]) return item[f] as string;
  return '';
}

/** "Vaswani 2017" for tab titles. */
export const shortName = (item: LibraryItem) => [creatorsShort(item).replace(/ 等$/, ''), yearOf(item)].filter(Boolean).join(' ') || String(item.title ?? '未命名');

const stripHtml = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');

/** Quick search: every word must appear in the title, creators, year, publication, DOI, tags or notes. */
export function matches(snap: LibrarySnapshot, item: LibraryItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [
    item.title,
    ...(item.creators ?? []).map((c) => `${c.firstName ?? ''} ${c.lastName ?? ''} ${c.name ?? ''}`),
    item.date,
    publicationOf(item),
    item.DOI,
    ...(item.tags ?? []).map((t) => t.tag),
    ...childrenOf(snap, item.key, 'note').map((n) => stripHtml(String(n.note ?? ''))),
  ]
    .join(' ')
    .toLowerCase();
  return words.every((w) => hay.includes(w));
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
