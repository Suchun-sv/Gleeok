import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  TRANSLATE_TARGETS,
  type TranslateEngine,
  type TranslateResult,
  type TranslateSettingsInput,
  type TranslateSettingsView,
} from '../../shared/src/translate.ts';

interface Settings {
  engine: TranslateEngine | null;
  target: string;
  deeplKey?: string;
  openaiBaseUrl?: string;
  openaiModel?: string;
  openaiKey?: string;
}

const MAX_CHARS = 5000;
const CACHE_ROWS = 20_000;
const TIMEOUT_MS = 60_000;
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export class TranslateError extends Error {
  status: ContentfulStatusCode;
  constructor(message: string, status: ContentfulStatusCode = 502) {
    super(message);
    this.status = status;
  }
}

const hint = (key?: string) => (key ? `…${key.slice(-4)}` : null);

/**
 * Text selected in a PDF: lines joined back into sentences (words split by a line-end hyphen
 * joined up, Chinese lines joined without a space).
 */
export function tidy(text: string) {
  return text
    .replace(/([　-鿿＀-￯])[ \t]*\r?\n\s*(?=[　-鿿＀-￯])/g, '$1')
    .replace(/([a-z])-[ \t]*\r?\n\s*(?=[a-z])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 划词翻译 (translate.db next to the other stores): the engine settings, API keys included, and
 * a cache so the same passage is only paid for once.
 */
export class Translator {
  #db: DatabaseSync;
  #fetch: typeof fetch;

  constructor(dir: string, opts: { fetch?: typeof fetch } = {}) {
    this.#db = new DatabaseSync(join(dir, 'translate.db'));
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cache (hash TEXT PRIMARY KEY, result TEXT NOT NULL, used INTEGER NOT NULL);
    `);
    this.#fetch = opts.fetch ?? fetch;
  }

  settings(): Settings {
    const row = this.#db.prepare('SELECT json FROM settings WHERE id = 1').get() as { json: string } | undefined;
    return { engine: null, target: 'zh-CN', ...(row ? (JSON.parse(row.json) as Partial<Settings>) : {}) };
  }

  /** Engines that can run: DeepL needs a key; an OpenAI-compatible server a model (local ones need no key). */
  #engines(s: Settings) {
    return [
      ...(s.deeplKey ? [{ id: 'deepl' as const, label: 'DeepL' }] : []),
      ...(s.openaiModel ? [{ id: 'openai' as const, label: s.openaiModel }] : []),
    ];
  }

  view(): TranslateSettingsView {
    const s = this.settings();
    return {
      engine: s.engine,
      target: s.target,
      engines: this.#engines(s),
      deepl: { key: hint(s.deeplKey) },
      openai: { baseUrl: s.openaiBaseUrl ?? '', model: s.openaiModel ?? '', key: hint(s.openaiKey) },
    };
  }

  update(input: unknown): TranslateSettingsView | string {
    if (!input || typeof input !== 'object') return 'expected an object';
    const i = input as TranslateSettingsInput;
    const next = this.settings();
    if (i.engine !== undefined) {
      if (i.engine !== null && i.engine !== 'deepl' && i.engine !== 'openai') return 'engine is deepl, openai or null';
      next.engine = i.engine;
    }
    if (i.target !== undefined) {
      if (!TRANSLATE_TARGETS.some((t) => t.id === i.target)) return 'unknown target language';
      next.target = i.target;
    }
    for (const field of ['deeplKey', 'openaiBaseUrl', 'openaiModel', 'openaiKey'] as const) {
      const v = i[field];
      if (v === undefined) continue;
      if (typeof v !== 'string') return `${field} is a string`;
      const value = field === 'openaiBaseUrl' ? v.trim().replace(/\/+$/, '') : v.trim();
      if (field === 'openaiBaseUrl' && value && !/^https?:\/\/[^/\s]+/.test(value)) return 'the base URL starts with http:// or https://';
      if (value) next[field] = value;
      else delete next[field];
    }
    this.#db.prepare('INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json').run(JSON.stringify(next));
    return this.view();
  }

  /** Translate with the chosen engine (or the one asked for); answers come from the cache when they can. */
  async translate(raw: string, asked?: TranslateEngine): Promise<TranslateResult> {
    const s = this.settings();
    const engines = this.#engines(s);
    const engine = asked ?? s.engine;
    if (!engine) return { off: true, engines };
    const text = tidy(raw);
    if (!text) throw new TranslateError('没有要翻译的文字', 400);
    if (text.length > MAX_CHARS) throw new TranslateError(`一次最多翻译 ${MAX_CHARS} 个字符`, 400);
    const ready = engines.find((e) => e.id === engine);
    if (!ready) throw new TranslateError(engine === 'deepl' ? 'DeepL 还没有填 API key（设置 → 文献库 → 划词翻译）' : 'OpenAI 接口还没有填模型（设置 → 文献库 → 划词翻译）', 400);
    const target = TRANSLATE_TARGETS.find((t) => t.id === s.target) ?? TRANSLATE_TARGETS[0];
    const base = s.openaiBaseUrl || OPENAI_BASE_URL;
    const hash = createHash('sha256')
      .update(JSON.stringify([engine, engine === 'openai' ? `${base} ${s.openaiModel}` : '', target.id, text]))
      .digest('hex');
    const hit = this.#db.prepare('SELECT result FROM cache WHERE hash = ?').get(hash) as { result: string } | undefined;
    if (hit) {
      this.#db.prepare('UPDATE cache SET used = ? WHERE hash = ?').run(Date.now(), hash);
      return { text: hit.result, engine, label: ready.label, cached: true, engines };
    }
    const result = engine === 'deepl' ? await this.#deepl(s.deeplKey!, target.deepl, text) : await this.#openai(base, s.openaiKey, s.openaiModel!, target.prompt, text);
    this.#db.prepare('INSERT OR REPLACE INTO cache (hash, result, used) VALUES (?, ?, ?)').run(hash, result, Date.now());
    this.#db.prepare('DELETE FROM cache WHERE hash IN (SELECT hash FROM cache ORDER BY used DESC LIMIT -1 OFFSET ?)').run(CACHE_ROWS);
    return { text: result, engine, label: ready.label, cached: false, engines };
  }

  async #post(url: string, headers: Record<string, string>, body: unknown) {
    try {
      return await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new TranslateError(`连不上 ${new URL(url).host}：${(e as Error).message}`);
    }
  }

  async #deepl(key: string, target: string, text: string) {
    // Free-plan keys end in ":fx" and have their own host.
    const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const res = await this.#post(`${host}/v2/translate`, { authorization: `DeepL-Auth-Key ${key}` }, { text: [text], target_lang: target });
    const body = (await res.json().catch(() => null)) as { translations?: { text: string }[]; message?: string } | null;
    if (res.ok && body?.translations?.[0]) return body.translations[0].text;
    if (res.status === 403) throw new TranslateError('DeepL 拒绝了这个 API key');
    if (res.status === 456) throw new TranslateError('DeepL 本月的额度用完了');
    if (res.status === 429) throw new TranslateError('DeepL：请求太频繁，稍后再试');
    throw new TranslateError(`DeepL ${res.status}：${body?.message ?? '没有返回译文'}`);
  }

  async #openai(base: string, key: string | undefined, model: string, target: string, text: string) {
    const res = await this.#post(`${base}/chat/completions`, key ? { authorization: `Bearer ${key}` } : {}, {
      model,
      messages: [
        {
          role: 'system',
          content:
            `You translate passages from academic papers into ${target}. Keep technical terms accurate (add the original term in parentheses ` +
            'when it is not commonly translated), keep formulas, symbols, citations and numbers unchanged, and reply with the translation only.',
        },
        { role: 'user', content: text },
      ],
    });
    const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } | string } | null;
    const out = body?.choices?.[0]?.message?.content;
    // Reasoning models served by some compatible servers put their thinking in the reply.
    if (res.ok && typeof out === 'string') return out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const detail = typeof body?.error === 'string' ? body.error : body?.error?.message;
    if (res.status === 401) throw new TranslateError(`API key 无效${detail ? `：${detail}` : ''}`);
    if (res.status === 404) throw new TranslateError(`找不到这个模型或地址，检查 baseURL 和模型名${detail ? `：${detail}` : ''}`);
    if (res.status === 429) throw new TranslateError(`请求太频繁或额度不足${detail ? `：${detail}` : ''}`);
    throw new TranslateError(`${res.status}：${detail ?? '没有返回译文'}`);
  }
}

export function translateRoutes(t: Translator) {
  const r = new Hono();
  r.get('/settings', (c) => c.json(t.view()));
  r.put('/settings', async (c) => {
    const v = t.update(await c.req.json().catch(() => null));
    return typeof v === 'string' ? c.json({ error: v }, 400) : c.json(v);
  });
  r.post('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; engine?: unknown } | null;
    if (typeof body?.text !== 'string') return c.json({ error: 'text is required' }, 400);
    if (body.engine !== undefined && body.engine !== 'deepl' && body.engine !== 'openai') return c.json({ error: 'engine is deepl or openai' }, 400);
    try {
      return c.json(await t.translate(body.text, body.engine as TranslateEngine | undefined));
    } catch (e) {
      if (e instanceof TranslateError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });
  return r;
}
