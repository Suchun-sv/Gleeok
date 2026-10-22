import { app, type Session, type WebContents } from 'electron';

/**
 * Google refuses sign-in from embedded Chromium ("This browser or app may not be secure"),
 * even with "Electron" stripped from the UA: the client-hint brands still give it away. It does
 * accept Firefox, so on Google's sign-in pages only, Gleeok presents itself as Firefox — both in
 * request headers (UA + no Chromium client hints) and to page scripts. Everything else keeps the
 * normal Chrome-like identity.
 */
const GOOGLE_SIGN_IN = /^https:\/\/accounts\.google\.com\//;

// Must name the real OS: pages also see navigator.platform, and a mismatch is itself a signal.
const FIREFOX_UA = {
  darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0',
  win32: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0',
}[process.platform as string] ?? 'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0';

export function setupGoogleSignIn(ses: Session) {
  const normalUa = ses.getUserAgent();

  ses.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*'] }, (details, callback) => {
    const headers = details.requestHeaders;
    headers['User-Agent'] = FIREFOX_UA;
    for (const name of Object.keys(headers)) if (/^sec-ch-ua/i.test(name)) delete headers[name];
    callback({ requestHeaders: headers });
  });

  // Page scripts read navigator.userAgent too; switch it per main-frame navigation. This covers
  // pane views and the sign-in popups that "Sign in with Google" buttons open.
  const watch = (wc: WebContents) => {
    if (wc.session !== ses) return;
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return;
      const ua = GOOGLE_SIGN_IN.test(details.url) ? FIREFOX_UA : normalUa;
      if (wc.getUserAgent() !== ua) wc.setUserAgent(ua);
    });
  };
  app.on('web-contents-created', (_e, wc) => watch(wc));
}
