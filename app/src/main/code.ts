import { WebContentsView, type BrowserWindow, type Input, type Rectangle, type WebContents } from 'electron';
import { PAGE_PRELOAD, PARTITION } from './views.ts';

/**
 * 代码侧边栏: a project's code-server split in two. Its page (the workbench) sits in a native
 * sidebar on the right of the main window, showing only VS Code's views (Explorer, Search, Git)
 * in its secondary side bar, maximized; its editors live in an auxiliary editor window, which
 * VS Code opens with window.open('about:blank') and draws from the page, and which is taken into
 * the main window's rightmost pane. Both are one VS Code: a file opened in the sidebar lands in
 * the page's own (hidden) editor area, and is moved at once into the pane's editor group.
 *
 * It relies on the user's code-server having (Settings → 代码 shows them):
 *   "workbench.secondarySideBar.forceMaximized": true  (no editors in the page: views fill it)
 *   ctrl+alt+shift+f7 → workbench.action.newEmptyEditorWindow
 *   ctrl+alt+shift+f9 → workbench.action.moveEditorToLastGroup
 *   ctrl+alt+shift+f4 → workbench.action.maximizeAuxiliaryBar
 * and Explorer / Search / Source Control dragged into the secondary side bar once.
 */

/** The page announces an editor opened in its own area (see WATCH). */
const MOVE_SIGNAL = '[gleeok-code] move';

/** Injected into the workbench page: say when its own editor area gets an editor. */
const WATCH = `(() => {
  if (window.__gleeokCode) return 'already';
  window.__gleeokCode = true;
  let queued = false;
  const check = () => {
    queued = false;
    const part = document.querySelector('.monaco-workbench > .monaco-grid-view .part.editor, .monaco-workbench .part.editor');
    if (part && part.querySelector('.tabs-container .tab, .editor-instance')) console.log(${JSON.stringify(MOVE_SIGNAL)});
  };
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(check); } }).observe(document.body, { childList: true, subtree: true });
  return 'watching';
})()`;

interface Surface {
  url: string;
  side: WebContentsView;
  editor: WebContentsView | null;
  /** The window both are shown in, while they are. */
  win: BrowserWindow | null;
  /** Where the editor goes in that window (the rightmost pane's box), so a late one lands there. */
  editorRect: Rectangle | null;
  lastMove: number;
  ensureTimer?: NodeJS.Timeout;
}

export interface CodeHooks {
  /** Shortcuts typed in the code views are Gleeok's first, as in pages. */
  onInput(input: Input): boolean;
  /** A link the code views open elsewhere (not VS Code's own editor window): a tab. */
  openLink(url: string): void;
  log(message: string): void;
}

export class CodeSurfaces {
  #byProject = new Map<string, Surface>();

  constructor(private hooks: CodeHooks) {}

  has(projectId: string) {
    return this.#byProject.has(projectId);
  }

  /** A project's workbench page (for dev scripts). */
  sideOf(projectId: string) {
    const s = this.#byProject.get(projectId);
    return s && !s.side.webContents.isDestroyed() ? s.side.webContents : null;
  }

  /** The surface of a project, made (and its page loaded) on first use. */
  ensure(projectId: string, url: string): Surface {
    const known = this.#byProject.get(projectId);
    if (known && known.url === url && !known.side.webContents.isDestroyed()) return known;
    if (known) this.destroy(projectId);
    const side = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, preload: PAGE_PRELOAD } });
    const s: Surface = { url, side, editor: null, win: null, editorRect: null, lastMove: 0 };
    const wc = side.webContents;
    this.#guard(wc);
    wc.setWindowOpenHandler(({ url: target, disposition }) => {
      // VS Code's auxiliary editor window: a blank popup it fills itself. It becomes the pane's editor.
      if (target === 'about:blank' && disposition === 'new-window' && !s.editor) {
        return {
          action: 'allow',
          createWindow: (options) => {
            // Electron passes the popup's own webContents (not in its typings): adopting it keeps the
            // opener's hold on the window, which VS Code draws into.
            const popup = (options as { webContents?: WebContents }).webContents;
            const editor = new WebContentsView({ webContents: popup } as Electron.WebContentsViewConstructorOptions);
            s.editor = editor;
            this.#guard(editor.webContents);
            editor.webContents.setWindowOpenHandler(({ url: u }) => (this.hooks.openLink(u), { action: 'deny' }));
            editor.webContents.once('destroyed', () => {
              if (s.editor !== editor) return;
              s.editor = null;
              // VS Code closes the window with its last editor: open an empty one again.
              this.#ensureEditor(s, 600);
            });
            this.#place(s);
            return editor.webContents;
          },
        };
      }
      if (target !== 'about:blank') this.hooks.openLink(target);
      return { action: 'deny' };
    });
    wc.on('console-message', (e) => {
      const message = (e as unknown as { message?: string }).message ?? '';
      if (message === MOVE_SIGNAL) this.#moveToEditor(s);
    });
    wc.on('did-finish-load', () => {
      void wc.executeJavaScript(WATCH).catch(() => {});
      // A split restored by VS Code reopens its editor window by itself; else one is opened.
      this.#ensureEditor(s, 6000);
      setTimeout(() => this.#key(wc, 'F4'), 2000);
    });
    void wc.loadURL(url).catch(() => {});
    this.#byProject.set(projectId, s);
    return s;
  }

  /**
   * Show `projectId`'s surface in `win` (side in `sideRect`, editor in `editorRect`), and every
   * other one nowhere. Null hides them all.
   */
  show(win: BrowserWindow, projectId: string | null, url: string | null, sideRect: Rectangle | null, editorRect: Rectangle | null) {
    for (const [id, s] of this.#byProject) if (id !== projectId) this.#detach(s);
    if (!projectId || !url || !sideRect) {
      const s = projectId && this.#byProject.get(projectId);
      if (s) this.#detach(s);
      return;
    }
    const s = this.ensure(projectId, url);
    if (s.win && s.win !== win) this.#detach(s);
    s.win = win;
    this.#attach(win, s.side, sideRect);
    s.side.setVisible(true);
    if (s.editor) {
      if (editorRect) {
        this.#attach(win, s.editor, editorRect);
        s.editor.setVisible(true);
      } else this.#remove(win, s.editor);
    }
    s.editorRect = editorRect;
  }

  /** A hibernated or deleted project lets its code-server page go. */
  destroy(projectId: string) {
    const s = this.#byProject.get(projectId);
    if (!s) return;
    clearTimeout(s.ensureTimer);
    this.#detach(s);
    if (!s.side.webContents.isDestroyed()) s.side.webContents.close();
    this.#byProject.delete(projectId);
  }

  #place(s: Surface) {
    if (s.win && s.editor && s.editorRect) this.#attach(s.win, s.editor, s.editorRect);
  }

  #ensureEditor(s: Surface, delay: number) {
    clearTimeout(s.ensureTimer);
    s.ensureTimer = setTimeout(() => {
      if (!s.editor && !s.side.webContents.isDestroyed()) this.#key(s.side.webContents, 'F7');
    }, delay);
  }

  /** An editor opened in the page's own area: into the pane's group (the last one). */
  #moveToEditor(s: Surface) {
    if (!s.editor) return this.#ensureEditor(s, 0);
    if (Date.now() - s.lastMove < 250) return;
    s.lastMove = Date.now();
    this.#key(s.side.webContents, 'F9');
  }

  #key(wc: WebContents, keyCode: string) {
    if (wc.isDestroyed()) return;
    const modifiers: ('control' | 'alt' | 'shift')[] = ['control', 'alt', 'shift'];
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }

  #guard(wc: WebContents) {
    wc.on('before-input-event', (e, input) => {
      if (this.hooks.onInput(input)) e.preventDefault();
    });
    wc.on('render-process-gone', (_e, d) => this.hooks.log(`code view gone: ${d.reason}`));
  }

  #attach(win: BrowserWindow, view: WebContentsView, rect: Rectangle) {
    if (win.isDestroyed()) return;
    // Added last, so it is on top of the panes' pages.
    if (!win.contentView.children.includes(view)) win.contentView.addChildView(view);
    view.setBounds(rect);
  }

  #remove(win: BrowserWindow, view: WebContentsView) {
    if (!win.isDestroyed() && win.contentView.children.includes(view)) win.contentView.removeChildView(view);
  }

  #detach(s: Surface) {
    if (!s.win) return;
    this.#remove(s.win, s.side);
    if (s.editor) this.#remove(s.win, s.editor);
    s.win = null;
  }
}
