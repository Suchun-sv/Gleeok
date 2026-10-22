import { join } from 'node:path';
import { BrowserWindow, screen, type Input, type Rectangle } from 'electron';
import { type AppWindowState, paneName } from '../../../shared/src/model.ts';
import { niriEnabled, niriMoveToOutput, niriOutputNames, niriOutputOf } from './niri.ts';

export interface ShellHooks {
  onInput(input: Input): boolean;
  /** The user closed a window (not the app quitting, not a programmatic close). */
  onUserClosed(id: string): void;
  onPlacementChanged(): void;
  onFocus(id: string): void;
  /** Runs before the window goes away: move its pages somewhere safe. */
  onClosing(win: BrowserWindow): void;
}

/** Stable per window, so niri window rules can match it (e.g. open-on-output by title). */
export function windowTitle(ws: AppWindowState) {
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

  open(ws: AppWindowState, opts: { awayFrom?: BrowserWindow | null } = {}) {
    const existing = this.#wins.get(ws.id);
    if (existing) return existing;
    const bounds = initialBounds(ws, opts.awayFrom ?? null);
    const win = new BrowserWindow({
      ...bounds,
      title: windowTitle(ws),
      backgroundColor: '#16171b',
      autoHideMenuBar: true,
      show: false,
      webPreferences: { preload: join(__dirname, 'preload.js'), sandbox: true },
    });
    this.#wins.set(ws.id, win);
    win.on('page-title-updated', (e) => e.preventDefault());
    win.webContents.on('before-input-event', (e, input) => {
      if (this.#hooks.onInput(input)) e.preventDefault();
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
      if (niriEnabled()) void this.#placeOnNiri(ws, opts.awayFrom ?? null);
    });
    void win.loadFile(join(__dirname, 'renderer/index.html'), { query: { win: ws.id } });
    return win;
  }

  /** Close without treating it as the user dismissing the window. */
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
    const output = await niriOutputOf(windowTitle(ws)).catch(() => null);
    if (output && !win.isDestroyed()) {
      ws.placement = { displayKey: `niri:${output}`, bounds: win.getNormalBounds() };
      this.#hooks.onPlacementChanged();
    }
  }

  /** Restore the remembered output; a brand-new satellite goes to an output other than the main window's. */
  async #placeOnNiri(ws: AppWindowState, awayFrom: BrowserWindow | null) {
    try {
      const outputs = await niriOutputNames();
      let target = ws.placement?.displayKey.startsWith('niri:') ? ws.placement.displayKey.slice(5) : null;
      if (!target && awayFrom) {
        const mainOutput = await niriOutputOf(awayFrom.getTitle());
        target = outputs.find((o) => o !== mainOutput) ?? null;
      }
      if (target && outputs.includes(target)) await niriMoveToOutput(windowTitle(ws), target);
    } catch {
      // niri unavailable or the window vanished; leaving it where it opened is fine.
    }
  }
}

function initialBounds(ws: AppWindowState, awayFrom: BrowserWindow | null): Partial<Rectangle> {
  const fallback = ws.role === 'main' ? { width: 1600, height: 1000 } : { width: 1000, height: 900 };
  if (niriEnabled()) return fallback;
  const displays = screen.getAllDisplays();
  const p = ws.placement;
  if (p && displays.some((d) => String(d.id) === p.displayKey)) return p.bounds;
  if (awayFrom) {
    // A detached pane most likely wants the other monitor: fill it.
    const here = screen.getDisplayMatching(awayFrom.getBounds());
    const other = displays.find((d) => d.id !== here.id);
    if (other) return other.workArea;
  }
  return fallback;
}
