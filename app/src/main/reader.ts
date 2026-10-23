import { readFileSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, ipcMain, net, protocol, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron';
import type { LibraryAnnotation, LibraryItem } from '../../../shared/src/library.ts';
import { shortName } from '../../../shared/src/library-format.ts';
import { READER_ORIGIN } from '../../../shared/src/model.ts';
import type { LibraryClient } from './library.ts';

/**
 * The 文献库 reader: Zotero's reader (app/vendor/zotero-reader) served at gleeok://reader/ in the
 * pages' session, so a PDF opens in a pane like any site. The page gets a small bridge (see
 * preload/page.ts) to read its PDF and to save annotations and the reading position; annotations
 * that arrive from other devices are pushed to the pages that show their PDF.
 */

/** Before app ready: gleeok:// behaves like https (origin, fetch, workers) for the reader's files. */
export function registerReaderScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'gleeok', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
  ]);
}

const vendorDir = () => join(app.getAppPath(), 'vendor', 'zotero-reader');

export function serveReader(ses: Session) {
  // The vendor page, plus the glue that starts the reader once reader.js has defined it.
  const page = readFileSync(join(vendorDir(), 'reader.html'), 'utf8')
    .replace('<html lang="en"', '<html lang="zh-CN"')
    .replace('</head>', '<script defer="defer" src="glue.js"></script></head>');
  ses.protocol.handle('gleeok', (req) => {
    const url = new URL(req.url);
    if (url.host !== 'reader') return new Response('not found', { status: 404 });
    const path = decodeURIComponent(url.pathname);
    if (path === '/' || path === '/index.html') return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const file = path === '/glue.js' ? join(__dirname, 'reader-glue.js') : normalize(join(vendorDir(), path));
    if (path !== '/glue.js' && !file.startsWith(vendorDir() + sep)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

/** Zotero reader annotations carry `id`; the library keys them by it, under their attachment. */
function toReader(a: LibraryAnnotation) {
  const { key, version: _v, parentItem: _p, ...rest } = a;
  return { ...rest, id: key };
}

function fromReader(attachment: string, a: Record<string, unknown>) {
  const { id, ...rest } = a;
  return { ...rest, key: String(id), parentItem: attachment };
}

export class ReaderBridge {
  /** Open reader pages per attachment, and the annotation versions each was last given. */
  #open = new Map<string, Map<WebContents, Map<string, number>>>();
  /** Saves for one annotation run in order: each needs the version the previous one produced. */
  #queues = new Map<string, Promise<unknown>>();

  constructor(
    private library: LibraryClient,
    private hooks: { authorName: () => string; openLink: (url: string, from: WebContents) => void },
  ) {
    const fromReaderPage = (e: IpcMainInvokeEvent) => {
      if (!e.senderFrame?.url.startsWith(`${READER_ORIGIN}/`)) throw new Error('not the reader page');
    };
    ipcMain.handle('reader:open', async (e, attachment: string) => {
      fromReaderPage(e);
      return this.#openPdf(e.sender, attachment);
    });
    ipcMain.handle('reader:saveAnnotations', async (e, attachment: string, annotations: Record<string, unknown>[]) => {
      fromReaderPage(e);
      await Promise.all(annotations.map((a) => this.#save(e.sender, attachment, a)));
    });
    ipcMain.handle('reader:deleteAnnotations', async (e, attachment: string, ids: string[]) => {
      fromReaderPage(e);
      for (const id of ids) this.#seen(e.sender, attachment)?.delete(id);
      await Promise.all(ids.map((id) => this.#queue(id, () => library.remove('annotations', id))));
    });
    ipcMain.handle('reader:saveState', async (e, attachment: string, state: unknown) => {
      fromReaderPage(e);
      await library.patch('states', attachment, { state });
    });
    ipcMain.on('reader:openLink', (e, url: string) => {
      if (e.senderFrame?.url.startsWith(`${READER_ORIGIN}/`) && /^https?:\/\//.test(url)) hooks.openLink(url, e.sender);
    });
  }

  async #openPdf(wc: WebContents, attachment: string) {
    const item = this.library.item(attachment);
    if (!item || item.itemType !== 'attachment') throw new Error('这个附件已经不在文献库里了');
    if (!item.fileHash) throw new Error('这个附件的文件还没上传');
    const buf = await this.library.file(attachment);
    const parent = item.parentItem ? this.library.item(item.parentItem) : undefined;
    const annotations = this.library.annotationsOf(attachment);
    const pages = this.#open.get(attachment) ?? new Map<WebContents, Map<string, number>>();
    pages.set(wc, new Map(annotations.map((a) => [a.key, a.version])));
    this.#open.set(attachment, pages);
    wc.once('destroyed', () => pages.delete(wc));
    if (parent) void this.#markRead(parent);
    const locales = join(vendorDir(), 'locales');
    const ftl = ['en-US/zotero.ftl', 'en-US/reader.ftl', 'en-US/brand.ftl', 'zh-CN/zotero.ftl', 'zh-CN/reader.ftl'].map((f) => readFileSync(join(locales, f), 'utf8'));
    return {
      buf: new Uint8Array(buf),
      annotations: annotations.map(toReader),
      state: this.library.stateOf(attachment)?.state ?? null,
      title: parent ? shortName(parent) : String(item.filename ?? 'PDF'),
      authorName: this.hooks.authorName(),
      ftl,
    };
  }

  /** Opening a paper puts it under 最近阅读, and an unread one becomes 在读. */
  async #markRead(item: LibraryItem) {
    await this.library
      .patch('items', item.key, { lastReadAt: new Date().toISOString(), ...(item.readStatus ? {} : { readStatus: 'reading' }) })
      .catch(() => {});
  }

  #seen(wc: WebContents, attachment: string) {
    return this.#open.get(attachment)?.get(wc);
  }

  #queue<T>(key: string, run: () => Promise<T>): Promise<T> {
    const next = (this.#queues.get(key) ?? Promise.resolve()).then(run, run);
    this.#queues.set(key, next.catch(() => {}));
    return next;
  }

  #save(wc: WebContents, attachment: string, a: Record<string, unknown>) {
    const obj = fromReader(attachment, a);
    return this.#queue(obj.key, async () => {
      const exists = !!this.library.annotationsOf(attachment).find((x) => x.key === obj.key);
      const { key: _k, ...fields } = obj;
      const saved = exists
        ? await this.library.patch<LibraryAnnotation>('annotations', obj.key, fields)
        : (await this.library.create<LibraryAnnotation>('annotations', [obj]))[0];
      // The page already shows this version: do not echo it back.
      this.#seen(wc, attachment)?.set(saved.key, saved.version);
    });
  }

  /** After a library change: hand each open reader the annotations it has not seen. */
  push() {
    for (const [attachment, pages] of this.#open) {
      const current = this.library.annotationsOf(attachment);
      for (const [wc, seen] of pages) {
        if (wc.isDestroyed()) continue;
        const set = current.filter((a) => (seen.get(a.key) ?? -1) < a.version);
        const unset = [...seen.keys()].filter((k) => !current.some((a) => a.key === k));
        if (!set.length && !unset.length) continue;
        for (const a of set) seen.set(a.key, a.version);
        for (const k of unset) seen.delete(k);
        wc.send('reader:annotations', { set: set.map(toReader), unset });
      }
    }
  }
}
