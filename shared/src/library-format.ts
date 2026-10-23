import type { Creator, LibraryItem } from './library.ts';

/** How items are named in lists and tab titles (shared by Gleeok's main process and the 文献库 view). */

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

/** "Vaswani 2017" for tab titles. */
export const shortName = (item: LibraryItem) => [creatorsShort(item).replace(/ 等$/, ''), yearOf(item)].filter(Boolean).join(' ') || String(item.title ?? '未命名');

