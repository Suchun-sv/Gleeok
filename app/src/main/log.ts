import { appendFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/** gleeok.log in userData: what went wrong with pages and processes, to look at after the fact. */
export const logPath = () => join(app.getPath('userData'), 'gleeok.log');

const MAX_BYTES = 1024 * 1024;

export function log(message: string) {
  console.log('[gleeok]', message);
  try {
    const path = logPath();
    // One old file is kept, so the log never grows past ~2 MB.
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(path, `${path}.old`);
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

/** Only the site, so the log does not collect full addresses. */
export const siteOf = (url: string) => {
  try {
    return new URL(url).host || url.slice(0, 40);
  } catch {
    return url.slice(0, 40);
  }
};
