import { session, type Session } from 'electron';
import { log } from './log.ts';

/**
 * Tailnet addresses never go through the system proxy. A proxy VPN in system-proxy mode (Clash,
 * SakuraCat…) sends every page to a server abroad, which cannot reach this machine's tailnet:
 * code-server, Paseo, the sync server's phone page… all stayed white. Pages keep the system
 * proxy for everything else; *.ts.net, 100.64.0.0/10 (Tailscale's addresses) and this machine go
 * direct.
 *
 * Chromium takes bypass rules only with a fixed proxy, so the system's proxy is read from a
 * probe session that keeps the system setting and written into a PAC script; it is read again
 * every half minute, as a VPN is switched on and off or changes node. (A system proxy given as
 * a PAC of its own is reduced to the answer it gives for an overseas site.)
 */
const PROBE = 'https://www.google.com/';
const EVERY_MS = 30_000;

const pac = (proxy: string) => `function FindProxyForURL(url, host) {
  if (dnsDomainIs(host, '.ts.net') || isPlainHostName(host) || host === 'localhost') return 'DIRECT';
  if (/^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\./.test(host) || /^127\\./.test(host)) return 'DIRECT';
  return ${JSON.stringify(proxy)};
}`;

export function keepTailnetDirect(sessions: Session[]) {
  const probe = session.fromPartition('gleeok-proxy-probe');
  let applied = '';
  const apply = async () => {
    try {
      await probe.setProxy({ mode: 'system' });
      const proxy = await probe.resolveProxy(PROBE);
      if (proxy === applied) return;
      applied = proxy;
      for (const ses of sessions) {
        // No proxy at all: plain system setting, nothing to bypass.
        if (proxy === 'DIRECT') await ses.setProxy({ mode: 'system' });
        else await ses.setProxy({ mode: 'pac_script', pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac(proxy)).toString('base64')}` });
      }
      log(`proxy: system says ${proxy}; tailnet goes direct`);
    } catch (e) {
      log(`proxy: ${(e as Error).message}`);
    }
  };
  void apply();
  setInterval(() => void apply(), EVERY_MS);
}
