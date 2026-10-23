import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, clipboard, type BrowserWindow } from 'electron';
import type { Action, Snapshot } from '../../../shared/src/ipc.ts';
import type { GlobalState } from '../../../shared/src/model.ts';
import type { TabViews } from './views.ts';

type Step =
  | { action: Action }
  | { wait: number }
  | { capture: string }
  | { moveActiveTab: { from: number; to: number } }
  | { closeSatellites: true }
  | { evalMain: string }
  | { fillFocused: { username: string; password: string } }
  | { readFocused: true }
  | { pageText: { click?: string } }
  /** Run JS in the focused page (e.g. the 文献库 reader) and log what it returns. */
  | { evalPage: string }
  /** Log what is on the clipboard. */
  | { clipboard: true }
  | { pressKey: string }
  /** A real key press in the main window's shell (goes through before-input-event), e.g. into a terminal. */
  | { shellKey: { key: string; modifiers?: ('control' | 'shift' | 'alt' | 'meta')[] } }
  /** Real mouse input to the main window's shell (e.g. dragging a pane divider): press, move in steps, release. */
  | { mouseDrag: { selector: string; index?: number; dx: number; dy?: number; steps?: number } };

export interface DevHooks {
  fillFocused(username: string, password: string): Promise<boolean>;
  readFocused(): Promise<unknown>;
  /** Optionally click a selector in the focused page, then return its URL and visible text. */
  pageText(click?: string): Promise<unknown>;
  evalPage(js: string): Promise<unknown>;
  /** A real key press in the focused page (trusted input), e.g. "Enter". */
  pressKey(key: string): Promise<void>;
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

  for (const step of steps) {
    if ('action' in step) dispatch(resolve(step.action));
    if ('moveActiveTab' in step) {
      const s = getState();
      const pane = s.sessions[s.currentProjectId ?? '']?.panes[step.moveActiveTab.from];
      if (pane) dispatch({ type: 'moveTab', tabId: pane.activeTabId, toSlot: step.moveActiveTab.to });
    }
    if ('closeSatellites' in step) {
      // Like the user clicking a satellite's close button.
      for (const [winId, win] of getWindows()) if (winId !== 'main') win.close();
    }
    if ('evalMain' in step) {
      // Run JS in the main window's shell, e.g. to fire synthetic DOM events.
      const main = getWindows().find(([id]) => id === 'main')?.[1];
      const r = await main?.webContents.executeJavaScript(step.evalMain).catch((e) => `eval failed: ${e}`);
      if (typeof r === 'string') console.log('[devscript] eval ->', r.slice(0, 1500));
    }
    if ('fillFocused' in step) {
      console.log('[devscript] fill ->', await hooks.fillFocused(step.fillFocused.username, step.fillFocused.password));
    }
    if ('readFocused' in step) console.log('[devscript] read ->', JSON.stringify(await hooks.readFocused()));
    if ('pressKey' in step) await hooks.pressKey(step.pressKey);
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
