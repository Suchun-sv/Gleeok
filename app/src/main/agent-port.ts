import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { AGENT_TOKEN_PREFIX } from '../../../shared/src/agents.ts';

/** Where agents reach Gleeok in local mode (no sync server). */
export const AGENT_PORT = Number(process.env.GLEEOK_AGENT_PORT ?? 7421);

/** This machine's address for other machines: the tailnet one (100.64.0.0/10) if there is one. */
export function lanAddress(): string | undefined {
  const all = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
  return all.find((ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) ?? all[0];
}

/**
 * In local mode the API runs inside Gleeok and nothing listens; agents get this port instead.
 * It answers agent tokens only (their scopes are checked by the app as on the server), and is
 * open only while there are agent connections. 127.0.0.1 unless other machines are allowed.
 */
export class AgentPort {
  status: { listening: boolean; url?: string; error?: string } = { listening: false };
  #server: Server | undefined;
  #host = '';

  constructor(private handle: (req: Request) => Promise<Response>) {}

  async update(want: boolean, lan: boolean) {
    const host = lan ? '0.0.0.0' : '127.0.0.1';
    if (want && this.#server && this.#host === host) return;
    await this.stop();
    if (!want) return;
    const server = createServer((req, res) => void this.#serve(req, res));
    await new Promise<void>((resolve) => {
      server.once('error', (e) => {
        this.status = { listening: false, error: `端口 ${AGENT_PORT} 打不开：${e.message}` };
        resolve();
      });
      server.listen(AGENT_PORT, host, () => {
        this.#server = server;
        this.#host = host;
        this.status = { listening: true, url: `http://${lan ? (lanAddress() ?? '127.0.0.1') : '127.0.0.1'}:${AGENT_PORT}` };
        resolve();
      });
    });
  }

  async stop() {
    const server = this.#server;
    this.#server = undefined;
    this.status = { listening: false };
    if (server) await new Promise((resolve) => server.close(resolve));
  }

  async #serve(req: IncomingMessage, res: ServerResponse) {
    const auth = req.headers.authorization ?? '';
    if (!new RegExp(`^Bearer\\s+${AGENT_TOKEN_PREFIX}`, 'i').test(auth)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"an agent token is required"}');
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const response = await this.handle(
        new Request(new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`), { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String((e as Error).message ?? e) }));
    }
  }
}
