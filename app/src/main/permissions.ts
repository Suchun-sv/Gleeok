import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, app, dialog, type Session } from 'electron';

// Electron grants every permission by default. Harmless ones stay granted; anything touching
// devices, location or notifications is asked once per site and remembered.
const ALWAYS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'window-management']);
const LABELS: Record<string, string> = {
  media: '使用摄像头/麦克风',
  notifications: '发送通知',
  geolocation: '获取你的位置',
  'clipboard-read': '读取剪贴板',
  midi: '访问 MIDI 设备',
  midiSysex: '访问 MIDI 设备',
  'display-capture': '录制屏幕',
  openExternal: '打开外部应用',
};

export function setupPermissions(session: Session, getWindow: () => BrowserWindow | null) {
  const path = join(app.getPath('userData'), 'permissions.json');
  let remembered: Record<string, boolean> = {};
  try {
    remembered = JSON.parse(readFileSync(path, 'utf8'));
  } catch {}
  const key = (origin: string, permission: string) => `${origin} ${permission}`;

  session.setPermissionCheckHandler((_wc, permission, origin) => {
    if (ALWAYS.has(permission)) return true;
    return remembered[key(origin, permission)] ?? false;
  });

  session.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (ALWAYS.has(permission)) return callback(true);
    const origin = new URL(details.requestingUrl || wc.getURL()).origin;
    const k = key(origin, permission);
    if (k in remembered) return callback(remembered[k]);
    const win = getWindow();
    const options = {
      type: 'question' as const,
      buttons: ['允许', '拒绝'],
      defaultId: 1,
      cancelId: 1,
      message: `${origin} 想要${LABELS[permission] ?? `使用 ${permission}`}`,
      checkboxLabel: '记住这个选择',
      checkboxChecked: true,
    };
    const { response, checkboxChecked } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    const allow = response === 0;
    if (checkboxChecked) {
      remembered[k] = allow;
      writeFileSync(path, JSON.stringify(remembered, null, 1));
    }
    callback(allow);
  });
}
