import { existsSync } from 'node:fs';
import { join, parse } from 'node:path';
import { app, type Session } from 'electron';
import type { Download } from '../../../shared/src/ipc.ts';

/** Saves every download straight into ~/Downloads (no dialog) and reports progress. */
export class Downloads {
  list: Download[] = [];
  #onChange: () => void;

  constructor(session: Session, onChange: () => void) {
    this.#onChange = onChange;
    session.on('will-download', (_e, item) => {
      const path = uniquePath(app.getPath('downloads'), item.getFilename());
      item.setSavePath(path);
      const d: Download = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        filename: parse(path).base,
        path,
        state: 'progressing',
        received: 0,
        total: item.getTotalBytes(),
      };
      this.list = [d, ...this.list].slice(0, 20);
      this.#onChange();
      item.on('updated', (_ev, state) => {
        d.state = state === 'interrupted' ? 'interrupted' : 'progressing';
        d.received = item.getReceivedBytes();
        this.#onChange();
      });
      item.once('done', (_ev, state) => {
        d.state = state;
        d.received = item.getReceivedBytes();
        this.#onChange();
      });
    });
  }
}

function uniquePath(dir: string, filename: string) {
  const { name, ext } = parse(filename);
  let path = join(dir, filename);
  for (let i = 1; existsSync(path); i++) path = join(dir, `${name} (${i})${ext}`);
  return path;
}
