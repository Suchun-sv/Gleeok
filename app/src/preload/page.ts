import { contextBridge } from 'electron';

// Preload for web pages. Only acts on Google's sign-in pages, where main also presents Gleeok as
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
