import type { Input } from 'electron';
import type { Action } from '../../../shared/src/ipc.ts';

/**
 * App-level keys use one prefix (Ctrl+Alt on Linux, Cmd+Opt on macOS) so they don't collide
 * with web apps. Tab keys follow ordinary browser conventions. Panes by number are Cmd+1..9 on
 * macOS; on Linux Super belongs to the compositor (niri binds Mod+1..9 and Mod+[ ]), so there
 * they are prefix+1..9. Projects step with Cmd+[ ] (macOS) or prefix+↑↓ (Linux). Matching uses
 * `code`, because with Opt held macOS reports a composed character in `key`.
 */
export function matchShortcut(input: Input, platform: string): Action | null {
  if (input.type !== 'keyDown') return null;
  const mac = platform === 'darwin';
  const prefix = mac ? input.meta && input.alt && !input.control : input.control && input.alt && !input.meta;
  const primary = mac ? input.meta && !input.alt && !input.control : input.control && !input.alt && !input.meta;
  const code = input.code;

  const digit = /^Digit([1-9])$/.exec(code);
  if (mac && primary && !input.shift) {
    if (digit) return { type: 'focusPaneIndex', index: Number(digit[1]) - 1, follow: true };
    if (code === 'BracketLeft') return { type: 'selectProjectDelta', delta: -1 };
    if (code === 'BracketRight') return { type: 'selectProjectDelta', delta: 1 };
  }

  if (prefix) {
    if (digit && input.shift) {
      return { type: 'setVisiblePanes', count: Number(digit[1]) };
    }
    if (mac && code === 'BracketLeft') return { type: 'history', op: 'back' };
    if (mac && code === 'BracketRight') return { type: 'history', op: 'forward' };
    if (!mac && digit) return { type: 'focusPaneIndex', index: Number(digit[1]) - 1, follow: true };
    if (!mac && (code === 'ArrowUp' || code === 'KeyK')) return { type: 'selectProjectDelta', delta: -1 };
    if (!mac && (code === 'ArrowDown' || code === 'KeyJ')) return { type: 'selectProjectDelta', delta: 1 };
    if (code === 'ArrowLeft' || code === 'KeyH') return { type: 'focusPaneDelta', delta: -1, follow: true };
    if (code === 'ArrowRight' || code === 'KeyL') return { type: 'focusPaneDelta', delta: 1, follow: true };
    if (code === 'KeyE') return { type: 'toggleEntry' };
    if (code === 'KeyP') return { type: 'toggleLibrary' };
    if (code === 'KeyA') return { type: 'togglePlanner' };
    if (code === 'KeyC') return { type: 'openCode' };
    if (code === 'KeyF') return { type: 'toggleFocusExpand' };
    // As tmux's prefix z zooms a pane.
    if (code === 'KeyZ') return { type: 'toggleMaximize' };
    if (code === 'KeyB') return { type: 'toggleSidebar' };
    if (code === 'KeyD') return { type: 'togglePaneWindow' };
    return null;
  }

  if (input.control && code === 'Tab') return { type: 'cycleTab', delta: input.shift ? -1 : 1 };

  if (primary && input.shift && code === 'KeyT') return { type: 'reopenTab' };
  // Cmd/Ctrl+K belongs to web apps (Notion: insert link, Slack/GitHub: their own search).
  if (primary && input.shift && code === 'KeyK') return { type: 'openPalette' };
  if (primary && input.shift && code === 'KeyL') return { type: 'vaultFill' };
  if (primary && !input.shift) {
    if (code === 'KeyF') return { type: 'openFind' };
    if (code === 'KeyD') return { type: 'openSaveLink' };
    if (code === 'Equal' || code === 'NumpadAdd') return { type: 'zoom', delta: 1 };
    if (code === 'Minus' || code === 'NumpadSubtract') return { type: 'zoom', delta: -1 };
    if (code === 'Digit0' || code === 'Numpad0') return { type: 'zoom', delta: 0 };
    if (code === 'KeyT') return { type: 'newTab' };
    if (code === 'KeyW') return { type: 'closeTab' };
    if (code === 'KeyL') return { type: 'focusAddress' };
    if (code === 'KeyR') return { type: 'history', op: 'reload' };
  }
  if (!mac && input.alt && !input.control && !input.meta && !input.shift) {
    if (code === 'ArrowLeft') return { type: 'history', op: 'back' };
    if (code === 'ArrowRight') return { type: 'history', op: 'forward' };
  }
  return null;
}
