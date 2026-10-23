import { join } from 'node:path';
import { BrowserWindow, app, screen, type Input, type Rectangle } from 'electron';
import type { AppWindowState } from '../../../shared/src/model.ts';
import { niriEnabled, niriFloat, niriMoveToOutput, niriOutputNames, niriOutputOf } from './niri.ts';

export interface ShellHooks {
  onInput(input: Input, from?: Electron.WebContents): boolean;
  /** The user closed a window (not the app quitting, not a programmatic close). */
  onUserClosed(id: string): void;
  onPlacementChanged(): void;
  onFocus(id: string): void;
  /** Runs before the window goes away: move its pages somewhere safe. */
  onClosing(win: BrowserWindow): void;
  paneName(slot: number): string;
}

/** Stable per window, so niri window rules can match it (e.g. open-on-output by title). */
export function windowTitle(ws: AppWindowState, paneName: (slot: number) => string) {
  return ws.role === 'main' ? 'Gleeok' : `Gleeok · ${ws.slots.map(paneName).join(' / ')}`;
}

/**
 * One BrowserWindow per AppWindowState. The renderer in each is the same shell page, told
 * which window it is via ?win=<id>.
 */
export class Shells {
  #wins = new Map<string, BrowserWindow>();
  #closingQuietly = new Set<string>();
  #hooks: ShellHooks;
  quitting = false;

  constructor(hooks: ShellHooks) {
    this.#hooks = hooks;
  }

  get(id: string) {
    return this.#wins.get(id) ?? null;
  }

  all() {
    return [...this.#wins];
  }

  /** `over`: a new satellite opens floating in front of this window, on its screen. */
  open(ws: AppWindowState, opts: { over?: BrowserWindow | null } = {}) {
    const existing = this.#wins.get(ws.id);
    if (existing) return existing;
    const bounds = initialBounds(ws, opts.over ?? null);
    const win = new BrowserWindow({
      ...bounds,
      title: windowTitle(ws, this.#hooks.paneName),
      backgroundColor: '#16171b',
      // Taskbar/window icon on Linux and Windows; macOS takes the Dock icon instead.
      icon: join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon-512.png'),
      autoHideMenuBar: true,
      show: false,
      webPreferences: { preload: join(__dirname, 'preload.js'), sandbox: true },
    });
    this.#wins.set(ws.id, win);
    win.on('page-title-updated', (e) => e.preventDefault());
    win.webContents.on('before-input-event', (e, input) => {
      if (this.#hooks.onInput(input, win.webContents)) e.preventDefault();
    });
    win.on('focus', () => this.#hooks.onFocus(ws.id));

    let timer: NodeJS.Timeout | undefined;
    const remember = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void this.#remember(ws, win), 400);
    };
    win.on('moved', remember);
    win.on('resized', remember);
    win.on('close', () => {
      if (!niriEnabled()) this.#rememberSync(ws, win);
      // From here on the window is gone as far as syncing is concerned, so nothing re-attaches
      // pages to it between now and its destruction.
      this.#wins.delete(ws.id);
      this.#hooks.onClosing(win);
    });
    win.on('closed', () => {
      this.#wins.delete(ws.id);
      if (this.#closingQuietly.delete(ws.id) || this.quitting) return;
      this.#hooks.onUserClosed(ws.id);
    });

    win.once('ready-to-show', () => {
      win.show();
      win.focus();
      if (niriEnabled()) void this.#placeOnNiri(ws, opts.over ?? null);
    });
    void win.loadFile(join(__dirname, 'renderer/index.html'), { query: { win: ws.id } });
    return win;
  }

  /** Close without treating it as the user dismissing the window. */
  /** Pane names changed: keep titles current (niri rules and placement look windows up by title). */
  retitle(ws: AppWindowState) {
    const win = this.#wins.get(ws.id);
    if (win && !win.isDestroyed()) win.setTitle(windowTitle(ws, this.#hooks.paneName));
  }

  closeQuietly(id: string) {
    const win = this.#wins.get(id);
    if (!win) return;
    this.#closingQuietly.add(id);
    win.close();
  }

  broadcast(channel: string, payload: unknown) {
    for (const win of this.#wins.values()) win.webContents.send(channel, payload);
  }

  #rememberSync(ws: AppWindowState, win: BrowserWindow) {
    if (win.isDestroyed()) return;
    const b = win.getNormalBounds();
    ws.placement = { displayKey: String(screen.getDisplayMatching(b).id), bounds: b };
    this.#hooks.onPlacementChanged();
  }

  async #remember(ws: AppWindowState, win: BrowserWindow) {
    if (!niriEnabled()) return this.#rememberSync(ws, win);
    const output = await niriOutputOf(windowTitle(ws, this.#hooks.paneName)).catch(() => null);
    if (output && !win.isDestroyed()) {
      ws.placement = { displayKey: `niri:${output}`, bounds: win.getNormalBounds() };
      this.#hooks.onPlacementChanged();
    }
  }

  /** Restore the remembered output; a brand-new satellite floats over the main window instead. */
  async #placeOnNiri(ws: AppWindowState, over: BrowserWindow | null) {
    try {
      const title = windowTitle(ws, this.#hooks.paneName);
      const target = ws.placement?.displayKey.startsWith('niri:') ? ws.placement.displayKey.slice(5) : null;
      if (target && (await niriOutputNames()).includes(target)) await niriMoveToOutput(title, target);
      else if (over) await niriFloat(title);
    } catch {
      // niri unavailable or the window vanished; leaving it where it opened is fine.
    }
  }
}

function initialBounds(ws: AppWindowState, over: BrowserWindow | null): Partial<Rectangle> {
  const fallback = ws.role === 'main' ? { width: 1600, height: 1000 } : { width: 1000, height: 900 };
  if (niriEnabled()) return fallback;
  const displays = screen.getAllDisplays();
  const p = ws.placement;
  if (p && displays.some((d) => String(d.id) === p.displayKey)) return p.bounds;
  if (over) {
    // In front of the main window, a little smaller, centred on it; the user drags it wherever it should live.
    const b = over.getBounds();
    const width = Math.min(1100, Math.round(b.width * 0.7));
    const height = Math.round(b.height * 0.85);
    return { width, height, x: Math.round(b.x + (b.width - width) / 2), y: Math.round(b.y + (b.height - height) / 2) };
  }
  return fallback;
}
