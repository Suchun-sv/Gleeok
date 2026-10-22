import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';

export interface Device {
  id: string;
  name: string;
}

/** A stable id per installation (kept in userData), named after the machine for display. */
export function loadDevice(): Device {
  const path = join(app.getPath('userData'), 'device.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Device;
  } catch {
    const device = { id: `d_${randomUUID().slice(0, 8)}`, name: hostname().replace(/\.local$/, '') };
    // Runs at load time, before Electron has created userData on a fresh install.
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(path, JSON.stringify(device));
    return device;
  }
}
