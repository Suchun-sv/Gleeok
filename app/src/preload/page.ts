import { contextBridge, ipcRenderer } from 'electron';

// The 文献库 reader page (served by Gleeok at gleeok://reader/) gets the calls it needs to read a
// PDF and keep its annotations and reading position; no other page sees them.
if (location.protocol === 'gleeok:' && location.host === 'reader') {
  contextBridge.exposeInMainWorld('gleeokReader', {
    open: (attachment: string) => ipcRenderer.invoke('reader:open', attachment),
    saveAnnotations: (attachment: string, annotations: unknown[]) => ipcRenderer.invoke('reader:saveAnnotations', attachment, annotations),
    deleteAnnotations: (attachment: string, ids: string[]) => ipcRenderer.invoke('reader:deleteAnnotations', attachment, ids),
    saveState: (attachment: string, state: unknown) => ipcRenderer.invoke('reader:saveState', attachment, state),
    openLink: (url: string) => ipcRenderer.send('reader:openLink', url),
    onAnnotations: (cb: (change: { set: unknown[]; unset: string[] }) => void) => {
      ipcRenderer.on('reader:annotations', (_e, change: { set: unknown[]; unset: string[] }) => cb(change));
    },
  });
}

// Preload for web pages. Otherwise only acts on Google's sign-in pages, where main also presents Gleeok as
// Firefox (see main/compat.ts): remove the Chromium-only traits a Firefox would not have, before
// the page's own scripts run, so the identity is consistent.
if (location.hostname === 'accounts.google.com') {
  contextBridge.executeInMainWorld({
    func: () => {
      const hide = (target: object, key: string, value: unknown) => {
        try {
          Object.defineProperty(target, key, { get: () => value, configurable: true });
        } catch {}
      };
      hide(Navigator.prototype, 'userAgentData', undefined);
      hide(Navigator.prototype, 'vendor', '');
      hide(Navigator.prototype, 'productSub', '20100101');
      hide(window, 'chrome', undefined);
    },
  });
}
