import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, clipboard, type BrowserWindow } from 'electron';
import type { Action, Snapshot } from '../../../shared/src/ipc.ts';
import type { GlobalState } from '../../../shared/src/model.ts';
import type { TabViews } from './views.ts';

/** Where real input goes and what a recording captures: the main window, or the page in a pane. */
type Target = 'main' | { slot: number };

type Step =
  | { action: Action }
  | { wait: number }
  | { capture: string }
  | { moveActiveTab: { from: number; to: number } }
  | { closeSatellites: true }
  /** Give every satellite these bounds, e.g. the size of a second screen for a demo recording. */
  | { satelliteBounds: { x: number; y: number; width: number; height: number } }
  | { evalMain: string }
  /** Like evalMain, in another window: 'satellite' is the first one that is not the main window. */
  | { evalIn: { win: 'main' | 'satellite'; js: string } }
  | { fillFocused: { username: string; password: string } }
  | { readFocused: true }
  | { pageText: { click?: string } }
  /** Run JS in the focused page (e.g. the 文献库 reader) and log what it returns. */
  | { evalPage: string }
  /** Log what is on the clipboard. */
  | { clipboard: true }
  | { pressKey: string }
  /** Kill the focused page's process, as a crash or the system running out of memory would. */
  | { crashPage: true }
  /** A real key press in the main window's shell (goes through before-input-event), e.g. into a terminal. */
  | { shellKey: { key: string; modifiers?: ('control' | 'shift' | 'alt' | 'meta')[] } }
  /** Real mouse input to the main window's shell (e.g. dragging a pane divider): press, move in steps, release. */
  | { mouseDrag: { selector: string; index?: number; dx: number; dy?: number; steps?: number } }
  /**
   * Capture `target` over and over into <out>/<name>/ until stopRecord: PNG frames and frames.json
   * (time, pointer, and for the main window its pages as layers with their bounds, to composite).
   */
  | { record: { name: string; target?: Target; fps?: number } }
  | { stopRecord: true }
  /** Note a caption (e.g. the shortcut just pressed) in the running recording, to draw over it. */
  | { label: string }
  /**
   * Real pointer input to `target`: glide from where the pointer was to `to`, or to the [x, y] that
   * `js` returns when run in the target, then press, release or click. Recordings note the pointer.
   */
  | { pointer: { target?: Target; to?: [number, number]; js?: string; ms?: number; press?: 'down' | 'up' | 'click' } }
  /** Real typing into `target`, one character at a time, then an optional key such as "Enter". */
  | { type: { target?: Target; text?: string; key?: string } };

export interface DevHooks {
  fillFocused(username: string, password: string): Promise<boolean>;
  readFocused(): Promise<unknown>;
  /** Optionally click a selector in the focused page, then return its URL and visible text. */
  pageText(click?: string): Promise<unknown>;
  evalPage(js: string): Promise<unknown>;
  /** A real key press in the focused page (trusted input), e.g. "Enter". */
  pressKey(key: string): Promise<void>;
  crashPage(): void;
}

/**
 * Dev-only: replay GLEEOK_DEV_SCRIPT (a JSON list of steps) and write captures to GLEEOK_DEV_OUT.
 * Each capture is the shell plus one PNG per attached view and a JSON of their bounds, so it can
 * be composited outside the app; this works under --ozone-platform=headless with no display.
 */
export async function runDevScript(
  getWindows: () => [string, BrowserWindow][],
  views: TabViews,
  dispatch: (a: Action) => void,
  getState: () => GlobalState,
  getSnapshot: () => Snapshot,
  hooks: DevHooks,
) {
  const scriptPath = process.env.GLEEOK_DEV_SCRIPT;
  if (!scriptPath) return;
  const out = process.env.GLEEOK_DEV_OUT ?? join(app.getPath('temp'), 'gleeok-captures');
  mkdirSync(out, { recursive: true });
  const steps = JSON.parse(readFileSync(scriptPath, 'utf8')) as Step[];

  // "$project:N" in an action stands for the N-th project in the sidebar, so scripts work on any data.
  const resolve = (action: Action): Action =>
    JSON.parse(
      JSON.stringify(action).replace(/"\$project:(\d+)"/g, (_m, n) => JSON.stringify(getSnapshot().projects[Number(n)]?.id ?? '')),
    ) as Action;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const targetWc = (t: Target = 'main') => {
    if (t === 'main') return getWindows().find(([id]) => id === 'main')?.[1].webContents;
    const s = getState();
    const tabId = s.sessions[s.currentProjectId ?? '']?.panes[t.slot]?.activeTabId;
    return tabId ? views.get(tabId)?.webContents : undefined;
  };
  const pointer = { target: '', x: 0, y: 0, down: false };
  let recording: { stop: boolean; done: Promise<void>; label: (text: string) => void } | null = null;

  const record = (name: string, target: Target, fps: number) => {
    const dir = join(out, name);
    mkdirSync(dir, { recursive: true });
    const key = JSON.stringify(target);
    type Layer = { file: string; x: number; y: number };
    const frames: { file: string; t: number; cursor: { x: number; y: number; down: boolean } | null; layers: Layer[] }[] = [];
    const labels: { t: number; text: string }[] = [];
    const t0 = Date.now();
    const rec = { stop: false, done: Promise.resolve(), label: (text: string) => labels.push({ t: Date.now() - t0, text }) };
    rec.done = (async () => {
      while (!rec.stop) {
        const started = Date.now();
        const wc = targetWc(target);
        const img = wc && !wc.isDestroyed() ? await wc.capturePage().catch(() => null) : null;
        if (img && !img.isEmpty()) {
          const n = String(frames.length).padStart(5, '0');
          writeFileSync(join(dir, `${n}.png`), img.toPNG());
          const layers: Layer[] = [];
          const win = target === 'main' ? getWindows().find(([id]) => id === 'main')?.[1] : undefined;
          for (const [i, view] of (win ? views.attachedIn(win) : []).entries()) {
            const page = await view.webContents.capturePage().catch(() => null);
            if (!page || page.isEmpty()) continue;
            const b = view.getBounds();
            layers.push({ file: `${n}-v${i}.png`, x: b.x, y: b.y });
            writeFileSync(join(dir, `${n}-v${i}.png`), page.toPNG());
          }
          frames.push({ file: `${n}.png`, t: started - t0, cursor: pointer.target === key ? { x: pointer.x, y: pointer.y, down: pointer.down } : null, layers });
        }
        await sleep(Math.max(0, 1000 / fps - (Date.now() - started)));
      }
      writeFileSync(join(dir, 'frames.json'), JSON.stringify({ frames, labels }));
      console.log(`[devscript] recorded ${name}: ${frames.length} frames`);
    })();
    return rec;
  };

  for (const step of steps) {
    if ('action' in step) dispatch(resolve(step.action));
    if ('record' in step) recording = record(step.record.name, step.record.target ?? 'main', step.record.fps ?? 15);
    if ('label' in step) recording?.label(step.label);
    if ('stopRecord' in step && recording) {
      recording.stop = true;
      await recording.done;
      recording = null;
    }
    if ('pointer' in step) {
      const { target = 'main', js, ms = 500, press } = step.pointer;
      const wc = targetWc(target);
      const to = js ? ((await wc?.executeJavaScript(js).catch(() => null)) as [number, number] | null) : step.pointer.to;
      if (!wc || !to) console.log('[devscript] pointer: no target or point', JSON.stringify(step.pointer).slice(0, 200));
      else {
        const key = JSON.stringify(target);
        const from = pointer.target === key ? [pointer.x, pointer.y] : to;
        const n = Math.max(1, Math.round(ms / 16));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
          Object.assign(pointer, { target: key, x: Math.round(from[0] + (to[0] - from[0]) * e), y: Math.round(from[1] + (to[1] - from[1]) * e) });
          wc.sendInputEvent({ type: 'mouseMove', x: pointer.x, y: pointer.y, ...(pointer.down ? { button: 'left' as const, modifiers: ['leftbuttondown'] } : {}) });
          if (n > 1) await sleep(16);
        }
        const at = { x: pointer.x, y: pointer.y, button: 'left' as const, clickCount: 1 };
        if (press === 'down' || press === 'click') {
          wc.sendInputEvent({ type: 'mouseDown', ...at });
          pointer.down = true;
        }
        if (press === 'click') await sleep(90);
        if (press === 'up' || press === 'click') {
          wc.sendInputEvent({ type: 'mouseUp', ...at });
          pointer.down = false;
        }
      }
    }
    if ('type' in step) {
      const wc = targetWc(step.type.target);
      // Keys go where keyboard focus is, as for a person: into this page, not one beside it.
      wc?.focus();
      for (const ch of step.type.text ?? '') {
        wc?.sendInputEvent({ type: 'char', keyCode: ch });
        await sleep(70);
      }
      if (step.type.key) {
        wc?.sendInputEvent({ type: 'keyDown', keyCode: step.type.key });
        wc?.sendInputEvent({ type: 'keyUp', keyCode: step.type.key });
      }
    }
    if ('moveActiveTab' in step) {
      const s = getState();
      const pane = s.sessions[s.currentProjectId ?? '']?.panes[step.moveActiveTab.from];
      if (pane) dispatch({ type: 'moveTab', tabId: pane.activeTabId, toSlot: step.moveActiveTab.to });
    }
    if ('closeSatellites' in step) {
      // Like the user clicking a satellite's close button.
      for (const [winId, win] of getWindows()) if (winId !== 'main') win.close();
    }
    if ('satelliteBounds' in step) {
      for (const [winId, win] of getWindows()) if (winId !== 'main' && !win.isDestroyed()) win.setBounds(step.satelliteBounds);
    }
    if ('evalMain' in step) {
      // Run JS in the main window's shell, e.g. to fire synthetic DOM events.
      const main = getWindows().find(([id]) => id === 'main')?.[1];
      const r = await main?.webContents.executeJavaScript(step.evalMain).catch((e) => `eval failed: ${e}`);
      if (typeof r === 'string') console.log('[devscript] eval ->', r.slice(0, 1500));
    }
    if ('evalIn' in step) {
      const { win, js } = step.evalIn;
      const target = getWindows().find(([id]) => (win === 'main' ? id === 'main' : id !== 'main'))?.[1];
      const r = await target?.webContents.executeJavaScript(js).catch((e) => `eval failed: ${e}`);
      if (typeof r === 'string') console.log(`[devscript] eval ${win} ->`, r.slice(0, 1500));
    }
    if ('fillFocused' in step) {
      console.log('[devscript] fill ->', await hooks.fillFocused(step.fillFocused.username, step.fillFocused.password));
    }
    if ('readFocused' in step) console.log('[devscript] read ->', JSON.stringify(await hooks.readFocused()));
    if ('pressKey' in step) await hooks.pressKey(step.pressKey);
    if ('crashPage' in step) hooks.crashPage();
    if ('shellKey' in step) {
      const wc = getWindows().find(([id]) => id === 'main')?.[1].webContents;
      const { key, modifiers = [] } = step.shellKey;
      wc?.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
      if (modifiers.length === 0 || (modifiers.length === 1 && modifiers[0] === 'shift')) wc?.sendInputEvent({ type: 'char', keyCode: key === 'Enter' ? '\r' : key, modifiers });
      wc?.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
    }
    if ('pageText' in step) console.log('[devscript] page ->', JSON.stringify(await hooks.pageText(step.pageText.click)));
    if ('clipboard' in step) console.log('[devscript] clipboard ->', (await clipboard.readText()).split('\n').join(' ¶ ').slice(0, 1500));
    if ('evalPage' in step) console.log('[devscript] page eval ->', String(await hooks.evalPage(step.evalPage)).slice(0, 500));
    if ('mouseDrag' in step) {
      const wc = getWindows().find(([id]) => id === 'main')?.[1].webContents;
      const { selector, index = 0, dx, dy = 0, steps = 10 } = step.mouseDrag;
      // Start from the middle of the matching element.
      const from = (await wc?.executeJavaScript(
        `(() => { const r = document.querySelectorAll(${JSON.stringify(selector)})[${index}]?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null; })()`,
      )) as [number, number] | null;
      if (!from) console.log('[devscript] mouseDrag: nothing matches', selector);
      const at = (t: number) => ({ x: Math.round((from?.[0] ?? 0) + dx * t), y: Math.round((from?.[1] ?? 0) + dy * t) });
      wc?.sendInputEvent({ type: 'mouseMove', ...at(0) });
      wc?.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at(0) });
      for (let i = 1; i <= steps; i++) {
        await new Promise((r) => setTimeout(r, 60));
        wc?.sendInputEvent({ type: 'mouseMove', button: 'left', ...at(i / steps), modifiers: ['leftbuttondown'] });
      }
      await new Promise((r) => setTimeout(r, 200));
      wc?.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...at(1) });
    }
    if ('wait' in step) await new Promise((r) => setTimeout(r, step.wait));
    if ('capture' in step) {
      // One composite per window: <name>__<windowId>.png
      for (const [winId, win] of getWindows()) {
        if (win.isDestroyed()) continue;
        const name = `${step.capture}__${winId}`;
        const layers = [{ file: `${name}-shell.png`, x: 0, y: 0 }];
        writeFileSync(join(out, layers[0].file), (await win.webContents.capturePage()).toPNG());
        for (const [i, view] of views.attachedIn(win).entries()) {
          const b = view.getBounds();
          const file = `${name}-v${i}.png`;
          writeFileSync(join(out, file), (await view.webContents.capturePage()).toPNG());
          layers.push({ file, x: b.x, y: b.y });
        }
        writeFileSync(join(out, `${name}.json`), JSON.stringify(layers));
      }
      const { live, memory } = getSnapshot();
      writeFileSync(join(out, `${step.capture}.snapshot.txt`), JSON.stringify({ live, memory, windows: getState().windows }));
      console.log(`[devscript] captured ${step.capture}`);
    }
  }
  app.quit();
}
