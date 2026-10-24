import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { AGENT_SCOPES, AGENT_TOKEN_PREFIX, type AgentCreated, type AgentInfo, type AgentScope } from '../../shared/src/agents.ts';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => AGENT_TOKEN_PREFIX + randomBytes(24).toString('base64url');
/** Writing "last used" on every request would be a write per call; once a minute is plenty. */
const TOUCH_EVERY_MS = 60_000;

/** The agent a request came from (set by the auth check in app.ts). */
const requests = new WeakMap<Request, AgentInfo>();
export const agentOf = (req: Request) => requests.get(req);
export const markAgent = (req: Request, agent: AgentInfo) => requests.set(req, agent);

/** What an agent with these scopes may call. */
export function agentMayUse(agent: AgentInfo, method: string, path: string): boolean {
  if (path === '/mcp' || path === '/api/agent/guide') return true;
  if (path === '/api/agent/projects') return method === 'GET' && agent.scopes.includes('planner');
  if (path === '/api/planner' || path.startsWith('/api/planner/')) return agent.scopes.includes('planner');
  if (path === '/api/library' || path.startsWith('/api/library/')) return agent.scopes.includes('library');
  return false;
}

/**
 * Agent connections, in the main database (so backups keep them): a name, scopes, and the
 * SHA-256 of the token — the token itself is shown once, when it is made.
 */
export class Agents {
  #db: DatabaseSync;
  #touched = new Map<string, number>();

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    `);
  }

  list(): AgentInfo[] {
    const rows = this.#db.prepare('SELECT data FROM agents').all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as AgentInfo).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  #get(id: string) {
    const row = this.#db.prepare('SELECT data FROM agents WHERE id = ?').get(id) as { data: string } | undefined;
    return row && (JSON.parse(row.data) as AgentInfo);
  }

  #write(agent: AgentInfo, tokenHash?: string) {
    if (tokenHash) {
      this.#db
        .prepare('INSERT INTO agents (id, token_hash, data) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET token_hash = excluded.token_hash, data = excluded.data')
        .run(agent.id, tokenHash, JSON.stringify(agent));
    } else {
      this.#db.prepare('UPDATE agents SET data = ? WHERE id = ?').run(JSON.stringify(agent), agent.id);
    }
  }

  create(input: unknown): AgentCreated | string {
    const i = input as { name?: unknown; scopes?: unknown } | null;
    const name = typeof i?.name === 'string' ? i.name.trim() : '';
    if (!name || name.length > 40) return 'name is 1-40 characters';
    const scopes = Array.isArray(i?.scopes) ? [...new Set(i.scopes)] : [];
    if (!scopes.length || !scopes.every((s) => AGENT_SCOPES.some((x) => x.id === s))) return 'scopes are planner and/or library';
    const agent: AgentInfo = { id: `a_${randomUUID().slice(0, 8)}`, name, scopes: scopes as AgentScope[], createdAt: new Date().toISOString() };
    const token = newToken();
    this.#write(agent, hash(token));
    return { agent, token };
  }

  /** A new token for a connection; the old one stops working. */
  rotate(id: string): AgentCreated | undefined {
    const agent = this.#get(id);
    if (!agent) return undefined;
    const token = newToken();
    this.#write(agent, hash(token));
    return { agent, token };
  }

  revoke(id: string): boolean {
    return this.#db.prepare('DELETE FROM agents WHERE id = ?').run(id).changes > 0;
  }

  /** The connection a token belongs to, noting that it was used. */
  check(token: string): AgentInfo | undefined {
    const row = this.#db.prepare('SELECT data FROM agents WHERE token_hash = ?').get(hash(token)) as { data: string } | undefined;
    if (!row) return undefined;
    const agent = JSON.parse(row.data) as AgentInfo;
    const now = Date.now();
    if (now - (this.#touched.get(agent.id) ?? 0) > TOUCH_EVERY_MS) {
      this.#touched.set(agent.id, now);
      agent.lastUsedAt = new Date(now).toISOString();
      this.#write(agent);
    }
    return agent;
  }
}

/** Managing connections (the server's own token only; agents never reach these). */
export function agentRoutes(agents: Agents) {
  const r = new Hono();
  r.get('/', (c) => c.json(agents.list()));
  r.post('/', async (c) => {
    const result = agents.create(await c.req.json().catch(() => null));
    return typeof result === 'string' ? c.json({ error: result }, 400) : c.json(result, 201);
  });
  r.post('/:id/rotate', (c) => {
    const result = agents.rotate(c.req.param('id'));
    return result ? c.json(result) : c.json({ error: 'not found' }, 404);
  });
  r.delete('/:id', (c) => (agents.revoke(c.req.param('id')) ? c.body(null, 204) : c.json({ error: 'not found' }, 404)));
  return r;
}
