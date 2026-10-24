import { readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { AGENT_TOKEN_PREFIX, agentGuide } from '../../shared/src/agents.ts';
import { type Agents, agentMayUse, agentOf, agentRoutes, markAgent } from './agents.ts';
import { detectCodeServer } from './codeserver.ts';
import { type Library, libraryRoutes } from './library.ts';
import { mcpRoutes } from './mcp.ts';
import type { Planner } from './planner.ts';
import { syncedRoutes } from './synced.ts';
import { type Translator, translateRoutes } from './translate.ts';
import { type Store, parseDaemon, parseProjectInput, parseSession } from './store.ts';

export interface AppOptions {
  /** Required for the network server; omitted when the app runs inside Gleeok (local mode). */
  token?: string;
  /** Password vault (Vaultwarden/Bitwarden) the clients of this server should use by default. */
  vaultUrl?: string;
  /** In-process (local mode): a code-server on localhost is reachable by the only client there is. */
  local?: boolean;
  /** The 文献库; its API lives under /api/library. */
  library?: Library;
  /** The 日程; its API lives under /api/planner. */
  planner?: Planner;
  /** 划词翻译 (settings, keys, cache); its API lives under /api/translate. */
  translator?: Translator;
  /** Agent connections: tokens limited to the 日程 / 文献库 (REST and /mcp). */
  agents?: Agents;
  /** Directory with the phone page (server/public), served at /m/. */
  publicDir?: string;
  /** Where phones open it (e.g. an HTTPS tailnet address ending in /m/), for clients to hand out. */
  mobileUrl?: string;
}

const DETECT_EVERY_MS = 10 * 60_000;

/**
 * The whole API. The standalone server serves it over HTTP; Gleeok's local mode calls
 * `app.fetch()` in-process, so both modes share every rule (versions, Paseo links, sessions).
 */
export function createApp(store: Store, opts: AppOptions = {}) {
  const app = new Hono();

  // Look for a code-server next to each daemon when its catalog arrives, at most every 10 minutes.
  const lastDetect = new Map<string, number>();
  const detect = async (serverId: string, hostname: string) => {
    lastDetect.set(serverId, Date.now());
    const url = await detectCodeServer(hostname, { allowLocalhost: opts.local });
    return store.setDetectedCodeServer(serverId, url);
  };

  app.get('/health', (c) => c.json({ ok: true }));

  // The server's own token opens everything; an agent token only what its scopes allow. In local
  // mode (no token) in-process calls pass; the port Gleeok opens for agents admits agent tokens only.
  const digest = (s: string) => createHash('sha256').update(s).digest();
  const isServerToken = (t: string) => !!opts.token && timingSafeEqual(digest(t), digest(opts.token));
  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (!path.startsWith('/api/') && path !== '/mcp') return next();
    const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]?.trim() ?? '';
    if (bearer.startsWith(AGENT_TOKEN_PREFIX)) {
      const agent = opts.agents?.check(bearer);
      if (!agent) return c.json({ error: 'unknown or revoked agent token' }, 401);
      if (!agentMayUse(agent, c.req.method, path)) return c.json({ error: `this connection may use: ${agent.scopes.join(', ')}` }, 403);
      markAgent(c.req.raw, agent);
      return next();
    }
    if (opts.token && !isServerToken(bearer)) return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
    return next();
  });

  app.get('/api/client-config', (c) => c.json({ vaultUrl: opts.vaultUrl ?? null, mobileUrl: opts.mobileUrl ?? null }));

  // The 日程 phone page: static files, no data (it signs in with the token like any client).
  if (opts.publicDir) {
    const root = join(opts.publicDir, 'm');
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.png': 'image/png',
      '.webmanifest': 'application/manifest+json',
    };
    app.get('/m', (c) => c.redirect('/m/'));
    app.get('/m/*', (c) => {
      const rel = decodeURIComponent(new URL(c.req.url).pathname.slice(3)) || 'index.html';
      const file = normalize(join(root, rel));
      if (!file.startsWith(root + sep)) return c.text('not found', 404);
      try {
        return c.body(readFileSync(file), 200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      } catch {
        return c.text('not found', 404);
      }
    });
  }

  if (opts.agents) app.route('/api/agents', agentRoutes(opts.agents));
  app.route('/mcp', mcpRoutes({ planner: opts.planner, library: opts.library, store }));

  // For agents: this guide (with their name and scopes), and the projects tasks can belong to.
  app.get('/api/agent/guide', (c) => {
    const agent = agentOf(c.req.raw);
    const url = new URL(c.req.url);
    const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '');
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? url.host;
    const text = agentGuide({
      url: `${proto}://${host}`,
      token: '<你的令牌>',
      name: agent?.name ?? 'agent',
      scopes: agent?.scopes ?? ['planner', 'library'],
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    return c.text(text, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  });
  app.get('/api/agent/projects', (c) => c.json(store.list().filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name }))));

  if (opts.library) app.route('/api/library', libraryRoutes(opts.library));
  if (opts.planner) app.route('/api/planner', syncedRoutes(opts.planner));
  if (opts.translator) app.route('/api/translate', translateRoutes(opts.translator));

  app.get('/api/projects', (c) => c.json(store.list()));

  app.get('/api/projects/:id', (c) => {
    const p = store.get(c.req.param('id'));
    return p ? c.json(p) : c.json({ error: 'not found' }, 404);
  });

  app.post('/api/projects', async (c) => {
    const input = parseProjectInput(await c.req.json().catch(() => null));
    if (typeof input === 'string') return c.json({ error: input }, 400);
    return c.json(store.create(input), 201);
  });

  app.put('/api/projects/:id', async (c) => {
    const body = await c.req.json().catch(() => null);
    const input = parseProjectInput(body);
    if (typeof input === 'string') return c.json({ error: input }, 400);
    const version = (body as { version?: unknown }).version;
    if (typeof version !== 'number') return c.json({ error: 'version is required' }, 400);
    const result = store.update(c.req.param('id'), input, version);
    if (result === undefined) return c.json({ error: 'not found' }, 404);
    if (result === 'conflict') return c.json({ error: 'version conflict', current: store.get(c.req.param('id')) }, 409);
    return c.json(result);
  });

  app.delete('/api/projects/:id', (c) =>
    store.delete(c.req.param('id')) ? c.body(null, 204) : c.json({ error: 'not found' }, 404),
  );

  app.get('/api/projects/:id/sessions', (c) => c.json(store.listSessions(c.req.param('id'))));

  app.put('/api/projects/:id/sessions/:deviceId', async (c) => {
    if (!store.get(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    const session = parseSession(c.req.param('deviceId'), await c.req.json().catch(() => null));
    if (typeof session === 'string') return c.json({ error: session }, 400);
    store.putSession(c.req.param('id'), session);
    return c.json({ ok: true });
  });

  app.get('/api/paseo/daemons', (c) => c.json(store.listDaemons()));

  app.put('/api/paseo/daemons/:serverId', async (c) => {
    const daemon = parseDaemon(c.req.param('serverId'), await c.req.json().catch(() => null));
    if (typeof daemon === 'string') return c.json({ error: daemon }, 400);
    const linksUpdated = store.putDaemon(daemon);
    if (Date.now() - (lastDetect.get(daemon.serverId) ?? 0) > DETECT_EVERY_MS) void detect(daemon.serverId, daemon.hostname).catch(() => {});
    return c.json({ ok: true, projects: daemon.projects.length, linksUpdated });
  });

  // The user's code-server address for a daemon (the sync never sends one); empty/null = detect.
  app.put('/api/paseo/daemons/:serverId/settings', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { codeServer?: unknown } | null;
    const raw = body?.codeServer;
    if (raw !== null && raw !== undefined && typeof raw !== 'string') return c.json({ error: 'codeServer must be a URL or null' }, 400);
    const codeServer = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
    if (codeServer && !/^https?:\/\/[^/\s]+/.test(codeServer)) return c.json({ error: 'codeServer must start with http:// or https://' }, 400);
    const updated = store.setCodeServer(c.req.param('serverId'), codeServer || null);
    if (updated === undefined) return c.json({ error: 'unknown daemon' }, 404);
    return c.json({ ok: true, linksUpdated: updated });
  });

  // Probe now (after installing code-server, say) instead of waiting for the next round.
  app.post('/api/paseo/daemons/:serverId/detect', async (c) => {
    const daemon = store.listDaemons().find((d) => d.serverId === c.req.param('serverId'));
    if (!daemon) return c.json({ error: 'unknown daemon' }, 404);
    const linksUpdated = await detect(daemon.serverId, daemon.hostname);
    const after = store.listDaemons().find((d) => d.serverId === daemon.serverId)!;
    return c.json({ ok: true, codeServer: after.codeServer ?? null, source: after.codeServerSource ?? null, linksUpdated });
  });

  app.post('/api/paseo/import', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { serverId?: unknown; projectIds?: unknown } | null;
    if (typeof body?.serverId !== 'string' || !Array.isArray(body.projectIds)) {
      return c.json({ error: 'expected { serverId, projectIds[] }' }, 400);
    }
    return c.json(store.importPaseo(body.serverId, body.projectIds.filter((x): x is string => typeof x === 'string')));
  });

  return app;
}
