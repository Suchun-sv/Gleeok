import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import type { Tab } from '../../../shared/src/model.ts';

type TermEvent = { tabId: string; data?: string; end?: number; exit?: number };

// One IPC subscription for every terminal in this window.
const listeners = new Map<string, (e: TermEvent) => void>();
let subscribed = false;
function listen(tabId: string, cb: (e: TermEvent) => void) {
  if (!subscribed) {
    subscribed = true;
    gleeok.onTermEvent((e) => listeners.get(e.tabId)?.(e));
  }
  listeners.set(tabId, cb);
  return () => {
    if (listeners.get(tabId) === cb) listeners.delete(tabId);
  };
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * A shell in a tab (xterm.js drawing, node-pty in main). The shell lives in main, keyed by the
 * tab id, so redrawing this view (tab switch, other window, hibernation) replays its screen.
 */
export function TerminalView({ tab, focusSeq, platform }: { tab: Tab; focusSeq: number; platform: string }) {
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const term = new Terminal({
      // Icons in prompts (starship, powerlevel10k…) always from the bundled symbols font, which only
      // covers the private-use areas and draws them one cell wide (an installed non-Mono Nerd Font,
      // such as MesloLGS NF, draws them wider and xterm cut them in half); letters from an
      // installed Nerd Font or plain monospace; Chinese from PingFang / Noto.
      fontFamily:
        '"Gleeok Symbols", "Hack Nerd Font Mono", "Hack Nerd Font", "JetBrainsMono Nerd Font Mono", "MesloLGS NF", "MesloLGS Nerd Font Mono", "FiraCode Nerd Font Mono", "JetBrains Mono", "SF Mono", Menlo, "Cascadia Mono", "DejaVu Sans Mono", "PingFang SC", "Noto Sans Mono CJK SC", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      // Icons wider than their cell (most Nerd Font icons) are squeezed into it; otherwise the next
      // cell's background (powerlevel10k's segments) covers their right half. WebGL renderer only.
      rescaleOverlappingGlyphs: true,
      theme: { background: css('--panel') || '#1e2026', foreground: css('--text') || '#d9dce3', cursor: css('--accent') || '#6aa7ff', selectionBackground: '#3a4a66' },
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Load the bundled icon font now, so a prompt's first icons do not show as boxes first.
    void document.fonts.load('13px "Gleeok Symbols"', '\uf179').catch(() => {});
    term.open(box.current!);
    // The WebGL renderer: faster, and the one that rescales overlapping glyphs. Without WebGL (or
    // when its context is lost) the terminal keeps the DOM renderer.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {}
    fit.fit();

    const mac = platform === 'darwin';
    const copy = () => {
      const sel = term.getSelection();
      if (sel) gleeok.clipboardWrite(sel);
      return !!sel;
    };
    const paste = () => void gleeok.clipboardRead().then((t) => t && term.paste(t));
    // Copy/paste the way each platform's terminals do: Cmd+C/V on macOS, Ctrl+Shift+C/V on Linux,
    // and on Windows also Ctrl+V and Ctrl+C when something is selected.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const k = e.key.toLowerCase();
      const cmd = mac ? e.metaKey && !e.ctrlKey && !e.altKey : e.ctrlKey && e.shiftKey && !e.altKey;
      if (cmd && k === 'c') return copy(), false;
      if (cmd && k === 'v') return paste(), false;
      if (!mac && platform === 'win32' && e.ctrlKey && !e.shiftKey && !e.altKey) {
        if (k === 'v') return paste(), false;
        if (k === 'c' && copy()) return false;
      }
      return true;
    });

    let ready = false;
    let attachedEnd = 0;
    let exited = false;
    const queued: TermEvent[] = [];
    const onEvent = (e: TermEvent) => {
      if (!ready) return void queued.push(e);
      if (e.data !== undefined && (e.end ?? 0) > attachedEnd) term.write(e.data);
      if (e.exit !== undefined) {
        exited = true;
        term.write(`\r\n\x1b[2m[进程已退出（${e.exit}），按回车重新打开]\x1b[0m\r\n`);
      }
    };
    const off = listen(tab.id, onEvent);
    const attach = () =>
      gleeok.termAttach(tab.id, tab.url, term.cols, term.rows).then((r) => {
        if (r.buffer) term.write(r.buffer);
        if (r.error) term.write(`\r\n\x1b[31m${r.error}\x1b[0m\r\n`);
        attachedEnd = r.end;
        ready = true;
        for (const e of queued.splice(0)) onEvent(e);
      });
    void attach();

    term.onData((d) => {
      if (exited) {
        if (d === '\r') {
          exited = false;
          term.reset();
          ready = false;
          void attach();
        }
        return;
      }
      gleeok.termInput(tab.id, d);
    });

    const resize = () => {
      if (!box.current?.offsetWidth) return;
      fit.fit();
      gleeok.termResize(tab.id, term.cols, term.rows);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(box.current!);

    const textarea = term.textarea;
    const focused = () => gleeok.termFocus(true);
    const blurred = () => gleeok.termFocus(false);
    textarea?.addEventListener('focus', focused);
    textarea?.addEventListener('blur', blurred);

    return () => {
      ro.disconnect();
      off();
      textarea?.removeEventListener('focus', focused);
      textarea?.removeEventListener('blur', blurred);
      if (document.activeElement === textarea) gleeok.termFocus(false);
      term.dispose();
      termRef.current = null;
    };
  }, [tab.id, tab.url]);

  // Focusing the pane (click, Prefix+←/→, opening the tab) puts the cursor in the shell.
  useEffect(() => {
    if (focusSeq) termRef.current?.focus();
  }, [focusSeq]);

  return <div className="terminal" ref={box} onMouseDown={() => termRef.current?.focus()} />;
}
