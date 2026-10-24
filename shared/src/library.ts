/**
 * The 文献库 (reference library) data model, shared by the server and Gleeok. Items follow
 * Zotero's item JSON (itemType + fields, creators, collections, tags), annotations follow
 * Zotero's reader format, so both can travel to and from Zotero unchanged. See docs/library.md.
 */

/** Library objects that sync with versions. States (reading positions) are last-write-wins. */
export type LibraryKind = 'items' | 'collections' | 'annotations' | 'states';
export const LIBRARY_KINDS: LibraryKind[] = ['items', 'collections', 'annotations', 'states'];

/** Zotero's key alphabet: no 0/1/O so keys read unambiguously. */
const KEY_CHARS = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ';
export const KEY_RE = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;

/** A new object key; clients make their own so objects can be created before they sync. */
export function newLibraryKey(random: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  let key = '';
  for (let i = 0; i < 8; i++) key += KEY_CHARS[random(KEY_CHARS.length)];
  return key;
}

export interface Creator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  /** Single-field names (institutions, mononyms). */
  name?: string;
}

export interface Tag {
  tag: string;
}

interface Versioned {
  key: string;
  /** Library version of this object's last change (set by the server). */
  version: number;
}

/**
 * A regular item, note or attachment. Regular items carry Zotero's fields for their type
 * (title, date, publicationTitle, DOI, url, abstractNote...); notes have `note` (HTML) and
 * attachments `filename`/`contentType`, both with `parentItem`.
 */
export interface LibraryItem extends Versioned {
  itemType: string;
  parentItem?: string;
  creators?: Creator[];
  collections?: string[];
  tags?: Tag[];
  /** In the trash. */
  deleted?: boolean;
  /** The agent connection that created it (set by the server). */
  createdBy?: string;
  dateAdded: string;
  dateModified: string;
  /** Attachments: the stored file, once uploaded. */
  fileHash?: string;
  fileSize?: number;
  [field: string]: unknown;
}

export interface LibraryCollection extends Versioned {
  name: string;
  /** Parent collection key, or false at the top level (Zotero's convention). */
  parentCollection: string | false;
}

/** One annotation in Zotero reader format; `key` is the reader's annotation id. */
export interface LibraryAnnotation extends Versioned {
  /** The attachment (PDF) it belongs to. */
  parentItem: string;
  type: string;
  color?: string;
  sortIndex?: string;
  pageLabel?: string;
  position: unknown;
  text?: string;
  comment?: string;
  tags?: Tag[];
  dateCreated?: string;
  dateModified?: string;
  [field: string]: unknown;
}

/** Where a PDF was last read (the reader's view state); `key` is the attachment key. */
export interface LibraryState extends Versioned {
  state: unknown;
}

export interface LibraryChanges {
  /** The library version these changes bring the client up to. */
  version: number;
  items: LibraryItem[];
  collections: LibraryCollection[];
  annotations: LibraryAnnotation[];
  states: LibraryState[];
  /** Keys deleted for good since the requested version. */
  deleted: Record<LibraryKind, string[]>;
}
