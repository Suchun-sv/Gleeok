import { screen } from 'electron';
import { log } from './log.ts';

/**
 * Moving the mouse pointer, for 鼠标跟随焦点: a pane picked with a shortcut gets the pointer too,
 * so the trackpad scrolls and clicks there at once. Electron has no call for it, so koffi calls
 * the system's: CoreGraphics on macOS (no permission needed to warp the cursor), user32 on
 * Windows. Wayland lets no app move the pointer, so Linux has none.
 */
type Warp = (x: number, y: number) => void;
let warp: Warp | null | undefined;

export const canMovePointer = process.platform === 'darwin' || process.platform === 'win32';

function load(): Warp | null {
  try {
    const koffi = require('koffi') as typeof import('koffi');
    if (process.platform === 'darwin') {
      const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
      koffi.struct('CGPoint', { x: 'double', y: 'double' });
      const warpTo = cg.func('int32 CGWarpMouseCursorPosition(CGPoint point)');
      // A warp otherwise freezes the pointer for a moment (the mouse and cursor are uncoupled).
      const couple = cg.func('int32 CGAssociateMouseAndMouseCursorPosition(bool connected)');
      return (x, y) => {
        warpTo({ x, y });
        couple(true);
      };
    }
    if (process.platform === 'win32') {
      const user32 = koffi.load('user32.dll');
      const setCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
      return (x, y) => {
        const p = screen.dipToScreenPoint({ x, y });
        setCursorPos(Math.round(p.x), Math.round(p.y));
      };
    }
  } catch (e) {
    log(`pointer: ${(e as Error).message}`);
  }
  return null;
}

/** Put the pointer at a screen point (Electron's coordinates); false where it cannot be done. */
export function movePointer(x: number, y: number): boolean {
  if (!canMovePointer) return false;
  if (warp === undefined) warp = load();
  if (!warp) return false;
  try {
    warp(x, y);
    return true;
  } catch (e) {
    log(`pointer: ${(e as Error).message}`);
    return false;
  }
}
