import { execFile } from 'node:child_process';

/**
 * Wayland does not let clients position their own windows, so on niri placement goes through
 * its IPC instead. Windows are found by their (stable) title plus our pid.
 */
export const niriEnabled = () => process.platform === 'linux' && !!process.env.NIRI_SOCKET;

interface NiriWindow {
  id: number;
  title: string | null;
  pid: number | null;
  workspace_id: number | null;
}
interface NiriWorkspace {
  id: number;
  output: string | null;
  is_focused: boolean;
}
interface NiriOutput {
  name: string;
}

function msg<T>(...args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile('niri', ['msg', '--json', ...args], { timeout: 3000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout) as T);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** A freshly shown window takes a moment to appear in niri's list. */
async function findWindow(title: string): Promise<NiriWindow | null> {
  for (let i = 0; i < 10; i++) {
    const windows = await msg<NiriWindow[]>('windows');
    const hit = windows.find((w) => w.title === title && (w.pid === null || w.pid === process.pid)) ??
      windows.find((w) => w.title === title);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

export async function niriOutputNames(): Promise<string[]> {
  const outputs = await msg<Record<string, NiriOutput>>('outputs');
  return Object.keys(outputs);
}

export async function niriOutputOf(title: string): Promise<string | null> {
  const w = await findWindow(title);
  if (!w) return null;
  const workspaces = await msg<NiriWorkspace[]>('workspaces');
  return workspaces.find((ws) => ws.id === w.workspace_id)?.output ?? null;
}

export async function niriMoveToOutput(title: string, output: string) {
  const w = await findWindow(title);
  if (!w) return;
  await msg('action', 'move-window-to-monitor', '--id', String(w.id), output);
}
