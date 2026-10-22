/**
 * Bitwarden's default URI match ("base domain"): accounts.google.com matches a login saved for
 * google.com, but not one for google.co.uk. Common two-part public suffixes are handled; this is
 * not the full public-suffix list.
 */
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'ac.uk', 'org.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'nhs.uk',
  'com.cn', 'net.cn', 'org.cn', 'edu.cn', 'gov.cn', 'ac.cn',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.hk', 'edu.hk', 'org.hk', 'gov.hk', 'com.tw', 'edu.tw', 'org.tw',
  'co.nz', 'co.kr', 'co.in', 'com.sg', 'edu.sg', 'com.br', 'com.mx',
  'github.io', 'workers.dev', 'pages.dev', 'vercel.app', 'netlify.app', 'herokuapp.com', 'ts.net',
]);

export function baseDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.')) return h; // IP, IPv6, localhost
  const labels = h.split('.');
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join('.');
  return lastTwo;
}

function hostOf(uri: string): string | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : `https://${uri}`).hostname;
  } catch {
    return null;
  }
}

/** Whether a login saved for `uri` should be offered on `pageUrl`. */
export function uriMatches(uri: string, pageUrl: string): boolean {
  const a = hostOf(uri);
  const b = hostOf(pageUrl);
  return !!a && !!b && baseDomain(a) === baseDomain(b);
}
