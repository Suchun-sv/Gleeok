import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { Store } from '../src/store.ts';
import { Translator, tidy } from '../src/translate.ts';

const dir = mkdtempSync(join(tmpdir(), 'gleeok-translate-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** What the engines were asked, and what they answer. */
const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
let reply: (url: string) => Response = (url) =>
  url.includes('deepl')
    ? Response.json({ translations: [{ text: '注意力就是你所需要的一切' }] })
    : Response.json({ choices: [{ message: { content: '<think>hmm</think>注意力机制' } }] });
const fakeFetch = (async (url: string, init: RequestInit) => {
  calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
  return reply(url);
}) as typeof fetch;

const app = createApp(new Store(join(dir, 'gleeok.db')), { token: 't0ken', translator: new Translator(dir, { fetch: fakeFetch }) });
async function call(method: string, path: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`http://x/api/translate${path}`, {
      method,
      headers: { authorization: 'Bearer t0ken', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as any };
}

test('tidy joins the lines of a PDF selection', () => {
  assert.equal(tidy('Attention is all you\nneed. A multi-\nlayer net-\nwork.'), 'Attention is all you need. A multilayer network.');
  assert.equal(tidy('注意力\n机制 and\nmore'), '注意力机制 and more');
});

test('requires the token', async () => {
  assert.equal((await app.fetch(new Request('http://x/api/translate/settings'))).status, 401);
});

test('off until an engine is chosen', async () => {
  const r = await call('POST', '', { text: 'hello' });
  assert.equal(r.status, 200);
  assert.equal(r.body.off, true);
  assert.equal(calls.length, 0);
});

test('keys are kept on the server and only hinted at', async () => {
  const r = await call('PUT', '/settings', { engine: 'deepl', deeplKey: 'abcd-1234:fx', openaiBaseUrl: 'http://127.0.0.1:11434/v1/', openaiModel: 'qwen3' });
  assert.equal(r.status, 200);
  assert.equal(r.body.deepl.key, '…4:fx');
  assert.equal(r.body.openai.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(r.body.openai.key, null);
  assert.deepEqual(r.body.engines.map((e: any) => e.id), ['deepl', 'openai']);
  assert.ok(!JSON.stringify((await call('GET', '/settings')).body).includes('abcd'));
  // Left out: unchanged; empty: cleared.
  assert.equal((await call('PUT', '/settings', { target: 'zh-CN' })).body.deepl.key, '…4:fx');
  assert.equal((await call('PUT', '/settings', { openaiBaseUrl: 'ftp://x' })).status, 400);
  assert.equal((await call('PUT', '/settings', { engine: 'google' })).status, 400);
});

test('DeepL: free keys go to api-free, the answer is cached', async () => {
  const r = await call('POST', '', { text: 'Attention is all\nyou need' });
  assert.equal(r.body.text, '注意力就是你所需要的一切');
  assert.equal(r.body.cached, false);
  assert.equal(calls.at(-1)!.url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(calls.at(-1)!.headers.authorization, 'DeepL-Auth-Key abcd-1234:fx');
  assert.deepEqual(calls.at(-1)!.body, { text: ['Attention is all you need'], target_lang: 'ZH-HANS' });
  const n = calls.length;
  const again = await call('POST', '', { text: 'Attention is all you need' });
  assert.equal(again.body.cached, true);
  assert.equal(calls.length, n);
});

test('OpenAI-compatible: base URL, no key needed, thinking removed', async () => {
  const r = await call('POST', '', { text: 'attention', engine: 'openai' });
  assert.equal(r.body.text, '注意力机制');
  assert.equal(r.body.label, 'qwen3');
  assert.equal(calls.at(-1)!.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(calls.at(-1)!.headers.authorization, undefined);
  assert.equal(calls.at(-1)!.body.model, 'qwen3');
  await call('PUT', '/settings', { openaiKey: 'sk-secret' });
  await call('POST', '', { text: 'attention heads', engine: 'openai' });
  assert.equal(calls.at(-1)!.headers.authorization, 'Bearer sk-secret');
});

test('engine errors come back readable', async () => {
  reply = () => new Response('{"message":"Forbidden"}', { status: 403 });
  const r = await call('POST', '', { text: 'something new' });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /DeepL 拒绝/);
  reply = () => Response.json({ error: { message: 'model not found' } }, { status: 404 });
  assert.match((await call('POST', '', { text: 'something new', engine: 'openai' })).body.error, /找不到这个模型.*model not found/);
  await call('PUT', '/settings', { deeplKey: '' });
  const off = await call('POST', '', { text: 'x y z' });
  assert.equal(off.status, 400);
  assert.match(off.body.error, /API key/);
});
