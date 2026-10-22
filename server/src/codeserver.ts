import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, hostname as localHostname } from 'node:os';
import { join } from 'node:path';

/**
 * Find a code-server on the machine a Paseo daemon runs on, by its hostname: through the tailnet
 * (tailscale serve on 8443 or 443, or a port bound beyond localhost), and, when the daemon is on
 * this very machine and the caller can use localhost addresses, on the address in code-server's
 * own config. A candidate counts only if /healthz answers the way code-server does.
 */
export async function detectCodeServer(daemonHost: string, opts: { allowLocalhost?: boolean } = {}): Promise<string | null> {
  const candidates: string[] = [];
  const dns = await tailnetName(daemonHost);
  if (dns) candidates.push(`https://${dns}:8443`, `https://${dns}`, `http://${dns}:8080`);
  if (opts.allowLocalhost && sameHost(daemonHost, localHostname())) candidates.push(localAddress());
  const results = await Promise.all(candidates.map(isCodeServer));
  return candidates.find((_, i) => results[i]) ?? null;
}

async function isCodeServer(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(4000), redirect: 'manual' });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: unknown; lastHeartbeat?: unknown };
    return (body.status === 'alive' || body.status === 'expired') && 'lastHeartbeat' in body;
  } catch {
    return false;
  }
}

const sameHost = (a: string, b: string) => a.split('.')[0].toLowerCase() === b.split('.')[0].toLowerCase();

/** MagicDNS name of the tailnet node with this hostname, via the local tailscale CLI if there is one. */
async function tailnetName(host: string): Promise<string | null> {
  for (const bin of ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    const out = await new Promise<string | null>((resolve) =>
      execFile(bin, ['status', '--json'], { timeout: 5000, maxBuffer: 8 << 20 }, (err, stdout) => resolve(err ? null : stdout)),
    );
    if (out === null) continue;
    try {
      const s = JSON.parse(out) as { Self?: Node; Peer?: Record<string, Node> };
      const node = [s.Self, ...Object.values(s.Peer ?? {})].find((n) => n && sameHost(n.HostName ?? '', host));
      return node?.DNSName ? node.DNSName.replace(/\.$/, '') : null;
    } catch {
      return null;
    }
  }
  return null;
}

interface Node {
  HostName?: string;
  DNSName?: string;
}

function localAddress(): string {
  try {
    const conf = readFileSync(join(homedir(), '.config/code-server/config.yaml'), 'utf8');
    const bind = /^bind-addr:\s*(\S+)/m.exec(conf)?.[1];
    if (bind) return `http://${bind.replace(/^0\.0\.0\.0/, '127.0.0.1')}`;
  } catch {}
  return 'http://127.0.0.1:8080';
}
