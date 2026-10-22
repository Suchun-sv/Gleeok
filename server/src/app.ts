import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { type Store, parseDaemon, parseProjectInput, parseSession } from './store.ts';

export interface AppOptions {
  /** Required for the network server; omitted when the app runs inside Gleeok (local mode). */
  token?: string;
  /** Password vault (Vaultwarden/Bitwarden) the clients of this server should use by default. */
  vaultUrl?: string;
}

/**
 * The whole API. The standalone server serves it over HTTP; Gleeok's local mode calls
 * `app.fetch()` in-process, so both modes share every rule (versions, Paseo links, sessions).
 */
export function createApp(store: Store, opts: AppOptions = {}) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));
  if (opts.token) app.use('/api/*', bearerAuth({ token: opts.token }));

  app.get('/api/client-config', (c) => c.json({ vaultUrl: opts.vaultUrl ?? null }));

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
    return c.json({ ok: true, projects: daemon.projects.length, linksUpdated: store.putDaemon(daemon) });
  });

  // Per-daemon settings the user chooses (the sync never sends these).
  app.put('/api/paseo/daemons/:serverId/settings', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { codeServer?: unknown } | null;
    const raw = body?.codeServer;
    if (raw !== null && raw !== undefined && typeof raw !== 'string') return c.json({ error: 'codeServer must be a URL or null' }, 400);
    const codeServer = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
    if (codeServer && !/^https?:\/\/[^/\s]+/.test(codeServer)) return c.json({ error: 'codeServer must start with http:// or https://' }, 400);
    const updated = store.setDaemonSettings(c.req.param('serverId'), codeServer ? { codeServer } : {});
    if (updated === undefined) return c.json({ error: 'unknown daemon' }, 404);
    return c.json({ ok: true, linksUpdated: updated });
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
