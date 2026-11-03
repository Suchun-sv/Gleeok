import { join } from 'node:path';
import {
  BrowserWindow,
  WebContentsView,
  type ContextMenuParams,
  type Input,
  type Rectangle,
  type WebContents,
} from 'electron';
import { siteOf as hostOf } from './log.ts';

export const PARTITION = 'persist:gleeok';

/** Preload for web pages (see preload/page.ts); also given to popups they open. */
const PAGE_PRELOAD = join(__dirname, 'page-preload.js');

export interface ViewHooks {
  onUpdate(tabId: string, patch: { url?: string; title?: string; favicon?: string }): void;
  onFocus(tabId: string): void;
  /** A key in a page, before the page sees it; true: Gleeok took it. */
  onInput(input: Input, tabId: string): boolean;
  onOpenTab(tabId: string, url: string): void;
  onContextMenu(tabId: string, wc: WebContents, params: ContextMenuParams): void;
  onFound(tabId: string, active: number, total: number): void;
  /** A page finished loading (its main frame). */
  onLoaded(tabId: string, wc: WebContents): void;
  /** A page wrote to its console (only Gleeok's own injected scripts' messages matter). */
  onConsole(tabId: string, message: string): void;
  /** A page failed to load (its main frame), at the address the page had (see toPage). */
  onLoadFailed(tabId: string, code: number): void;
  /**
   * The address a tab's page is loaded from, given the one the tab is known by (a code-server
   * on an SSH tunnel is loaded from localhost); fromPage is the way back, null for a page that
   * stands in while waiting (its address is not the tab's).
   */
  toPage(tabId: string, url: string): string;
  fromPage(url: string): string | null;
  /** The page's process died (crash, out of memory, killed): it stays white until rebuilt. */
  onGone(tabId: string, reason: string, exitCode: number): void;
  log(message: string): void;
}

/**
 * Owns one WebContentsView per live tab. A view is attached to at most one window;
 * views of background projects stay alive but detached.
 */
export class TabViews {
  #views = new Map<string, WebContentsView>();
  #attached = new Map<string, BrowserWindow>();
  /** The bounds each view should have, for the repaint after it is put back. */
  #bounds = new Map<string, Rectangle>();
  #hooks: ViewHooks;

  constructor(hooks: ViewHooks) {
    this.#hooks = hooks;
  }

  get(tabId: string) {
    return this.#views.get(tabId);
  }

  has(tabId: string) {
    const view = this.#views.get(tabId);
    return !!view && !view.webContents.isDestroyed();
  }

  ensure(tabId: string, url: string): WebContentsView {
    let view = this.#views.get(tabId);
    if (view && !view.webContents.isDestroyed()) return view;
    if (view) this.#forget(tabId);
    view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, preload: PAGE_PRELOAD } });
    const wc = view.webContents;
    wc.on('page-title-updated', (_e, title) => this.#hooks.onUpdate(tabId, { title }));
    const navigated = (u: string) => {
      const url = this.#hooks.fromPage(u);
      if (url !== null) this.#hooks.onUpdate(tabId, { url });
    };
    wc.on('did-navigate', (_e, u) => navigated(u));
    wc.on('did-navigate-in-page', (_e, u, isMainFrame) => isMainFrame && navigated(u));
    wc.on('page-favicon-updated', (_e, icons) => icons[0] && this.#hooks.onUpdate(tabId, { favicon: icons[0] }));
    wc.on('focus', () => this.#hooks.onFocus(tabId));
    wc.on('before-input-event', (e, input) => {
      if (this.#hooks.onInput(input, tabId)) e.preventDefault();
    });
    wc.on('context-menu', (_e, params) => this.#hooks.onContextMenu(tabId, wc, params));
    wc.on('found-in-page', (_e, r) => r.finalUpdate && this.#hooks.onFound(tabId, r.activeMatchOrdinal, r.matches));
    wc.on('render-process-gone', (_e, d) => this.#hooks.onGone(tabId, d.reason, d.exitCode));
    wc.on('did-finish-load', () => this.#hooks.onLoaded(tabId, wc));
    wc.on('console-message', (e) => this.#hooks.onConsole(tabId, (e as unknown as { message?: string }).message ?? ''));
    wc.on('unresponsive', () => this.#hooks.log(`page unresponsive: ${hostOf(wc.getURL())}`));
    wc.on('responsive', () => this.#hooks.log(`page responsive again: ${hostOf(wc.getURL())}`));
    wc.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
      // -3 is a navigation that was replaced by another one: not a failure.
      if (isMainFrame && code !== -3) {
        this.#hooks.log(`load failed: ${hostOf(failedUrl)} ${code} ${description}`);
        this.#hooks.onLoadFailed(tabId, code);
      }
    });
    wc.setWindowOpenHandler(({ url: target, disposition }) => {
      // Scripted popups (OAuth sign-in and the like) need a real window so window.opener keeps
      // working; plain link opens become tabs in the same pane.
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 720,
            autoHideMenuBar: true,
            webPreferences: { partition: PARTITION, sandbox: true, preload: PAGE_PRELOAD },
          },
        };
      }
      this.#hooks.onOpenTab(tabId, this.#hooks.fromPage(target) ?? target);
      return { action: 'deny' };
    });
    this.#views.set(tabId, view);
    wc.loadURL(this.#hooks.toPage(tabId, url)).catch(() => {});
    return view;
  }

  /** Make exactly `desired` (tabId → bounds) visible in `win`; everything else attached there is detached. */
  sync(win: BrowserWindow, desired: Map<string, { url: string; bounds: Rectangle }>) {
    if (win.isDestroyed()) return;
    for (const [tabId, owner] of this.#attached) {
      if (owner.isDestroyed()) {
        this.#attached.delete(tabId);
        continue;
      }
      if (owner === win && !desired.has(tabId)) {
        win.contentView.removeChildView(this.#views.get(tabId)!);
        this.#attached.delete(tabId);
      }
    }
    for (const [tabId, { url, bounds }] of desired) {
      const view = this.ensure(tabId, url);
      this.#bounds.set(tabId, bounds);
      view.setBounds(bounds);
      const owner = this.#attached.get(tabId);
      if (owner !== win) {
        if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(view);
        win.contentView.addChildView(view);
        this.#attached.set(tabId, win);
        this.#repaint(tabId, view);
      }
    }
  }

  /**
   * A view taken off a window and put back (palette, dialogs, dragging a divider or a tab) does
   * not always paint again until its size changes, which leaves the pane white. Change its size
   * by a pixel and back, and ask for a full repaint.
   */
  #repaint(tabId: string, view: WebContentsView) {
    const bounds = this.#bounds.get(tabId);
    if (!bounds || bounds.width < 2) return;
    view.setBounds({ ...bounds, width: bounds.width - 1 });
    setTimeout(() => {
      if (view.webContents.isDestroyed() || !this.#attached.has(tabId)) return;
      view.setBounds(this.#bounds.get(tabId) ?? bounds);
      view.webContents.invalidate();
    }, 16);
  }

  /** Take every page off a window that is about to close, so the pages outlive it. */
  detachAll(win: BrowserWindow) {
    for (const [tabId, owner] of [...this.#attached]) {
      if (owner !== win) continue;
      if (!win.isDestroyed()) win.contentView.removeChildView(this.#views.get(tabId)!);
      this.#attached.delete(tabId);
    }
  }

  #forget(tabId: string) {
    this.#views.delete(tabId);
    this.#attached.delete(tabId);
    this.#bounds.delete(tabId);
  }

  /** Whether the tab's page process has died (the view is still there, white). */
  crashed(tabId: string) {
    const view = this.#views.get(tabId);
    return !!view && !view.webContents.isDestroyed() && view.webContents.isCrashed();
  }

  attachedIn(win: BrowserWindow): WebContentsView[] {
    return [...this.#attached].filter(([, owner]) => owner === win).map(([id]) => this.#views.get(id)!);
  }

  destroy(tabId: string) {
    const view = this.#views.get(tabId);
    if (!view) return;
    this.#attached.get(tabId)?.contentView.removeChildView(view);
    this.#attached.delete(tabId);
    this.#views.delete(tabId);
    this.#bounds.delete(tabId);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
}
