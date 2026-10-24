import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Agents } from '../src/agents.ts';
import { createApp } from '../src/app.ts';
import { Library } from '../src/library.ts';
import { Planner } from '../src/planner.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'gleeok-agents-'));
const store = new Store(join(dir, 'gleeok.db'));
const app = createApp(store, { token: 't0ken', planner: new Planner(dir), library: new Library(dir), agents: new Agents(join(dir, 'gleeok.db')) });

// A PDF to "download" for library_create_item / library_attach_pdf.
const pdf = readFileSync(new URL('../../dev/fixtures/sample.pdf', import.meta.url));
const files = createServer((req, res) => {
  if (req.url === '/paper.pdf') res.writeHead(200, { 'content-type': 'application/pdf' }).end(pdf);
  else res.writeHead(200, { 'content-type': 'text/html' }).end('<html>not a pdf</html>');
});
let filesUrl = '';
before(() => new Promise<void>((done) => files.listen(0, '127.0.0.1', () => ((filesUrl = `http://127.0.0.1:${(files.address() as AddressInfo).port}`), done()))));
after(() => {
  files.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.fetch(
    new Request(`http://x${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

let plannerToken = '';
let bothToken = '';
let bothId = '';

test('the server token manages connections; tokens are shown once', async () => {
  assert.equal((await call('t0ken', 'POST', '/api/agents', { name: '', scopes: ['planner'] })).status, 400);
  assert.equal((await call('t0ken', 'POST', '/api/agents', { name: 'x', scopes: ['vault'] })).status, 400);
  const a = await call('t0ken', 'POST', '/api/agents', { name: '邮件助手', scopes: ['planner'] });
  assert.equal(a.status, 201);
  assert.match(a.body.token, /^gleeok_agent_/);
  plannerToken = a.body.token;
  const b = await call('t0ken', 'POST', '/api/agents', { name: '读论文', scopes: ['planner', 'library'] });
  bothToken = b.body.token;
  bothId = b.body.agent.id;
  const list = await call('t0ken', 'GET', '/api/agents');
  assert.deepEqual(list.body.map((x: any) => x.name), ['邮件助手', '读论文']);
  assert.ok(!JSON.stringify(list.body).includes('gleeok_agent_'));
});

test('agent tokens reach only their scopes', async () => {
  assert.equal((await call(plannerToken, 'GET', '/api/planner')).status, 200);
  assert.equal((await call(plannerToken, 'GET', '/api/agent/projects')).status, 200);
  assert.equal((await call(plannerToken, 'GET', '/api/library')).status, 403);
  assert.equal((await call(plannerToken, 'GET', '/api/projects')).status, 403);
  assert.equal((await call(plannerToken, 'GET', '/api/agents')).status, 403);
  assert.equal((await call(plannerToken, 'GET', '/api/translate/settings')).status, 403);
  assert.equal((await call(bothToken, 'GET', '/api/library')).status, 200);
  assert.equal((await call('gleeok_agent_nope', 'GET', '/api/planner')).status, 401);
  assert.equal((await call('wrong', 'GET', '/api/planner')).status, 401);
  const guide = await call(plannerToken, 'GET', '/api/agent/guide');
  assert.match(guide.body, /邮件助手/);
  assert.doesNotMatch(guide.body, /## 文献库/);
});

test('what agents create over REST is marked', async () => {
  const t = await call(plannerToken, 'POST', '/api/planner/tasks', { title: '回导师邮件', due: '2026-10-25' });
  assert.equal(t.status, 201);
  assert.equal(t.body.createdBy, '邮件助手');
  const mine = await call('t0ken', 'POST', '/api/planner/tasks', { title: '自己加的' });
  assert.equal(mine.body.createdBy, undefined);
  const i = await call(bothToken, 'POST', '/api/library/items', { itemType: 'preprint', title: 'X' });
  assert.equal(i.body.createdBy, '读论文');
});

async function mcp(token: string, method: string, params?: unknown, id: number | null = 1) {
  const msg = id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
  return call(token, 'POST', '/mcp', msg, { accept: 'application/json, text/event-stream' });
}
const tool = async (token: string, name: string, args: unknown) => {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  const text = r.body.result.content[0].text;
  return { error: !!r.body.result.isError, text, data: r.body.result.isError ? null : JSON.parse(text) };
};

test('MCP: handshake and tools by scope', async () => {
  const init = await mcp(plannerToken, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.ok(init.body.result.capabilities.tools);
  assert.equal((await mcp(plannerToken, 'notifications/initialized', undefined, null)).status, 202);
  const names = (await mcp(plannerToken, 'tools/list')).body.result.tools.map((t: any) => t.name);
  assert.ok(names.includes('planner_create_task'));
  assert.ok(!names.some((n: string) => n.startsWith('library_')));
  const all = (await mcp(bothToken, 'tools/list')).body.result.tools.map((t: any) => t.name);
  assert.ok(all.includes('library_search'));
  assert.equal((await mcp(plannerToken, 'tools/call', { name: 'library_search', arguments: {} })).body.error.code, -32602);
  assert.equal((await mcp(plannerToken, 'nope')).body.error.code, -32601);
  assert.equal((await call('wrong', 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
});

test('MCP: tasks, ticking, trash, blocks', async () => {
  const created = await tool(plannerToken, 'planner_create_task', { title: '交报销单', due: '2026-10-26T17:00', priority: 2, subtasks: ['找发票', '签字'] });
  assert.equal(created.error, false);
  assert.equal(created.data.createdBy, '邮件助手');
  assert.equal(created.data.subtasks.length, 2);
  const key = created.data.key;
  const done = await tool(plannerToken, 'planner_update_task', { key, done: true, priority: 0 });
  assert.equal(done.data.done, true);
  assert.ok(done.data.doneAt);
  assert.equal(done.data.priority, undefined);
  const open = await tool(plannerToken, 'planner_list_tasks', {});
  assert.ok(open.data.timeZone);
  assert.ok(!open.data.tasks.some((t: any) => t.key === key));
  assert.ok((await tool(plannerToken, 'planner_list_tasks', { status: 'done' })).data.tasks.some((t: any) => t.key === key));
  assert.ok((await tool(plannerToken, 'planner_list_tasks', { due_to: '2026-10-25' })).data.tasks.every((t: any) => t.due <= '2026-10-25'));
  await tool(plannerToken, 'planner_trash_task', { key });
  assert.ok((await tool(plannerToken, 'planner_list_tasks', { status: 'trash' })).data.tasks.some((t: any) => t.key === key));
  const block = await tool(plannerToken, 'planner_create_block', { start: '2026-10-26T14:00:00+00:00', end: '2026-10-26T15:00:00+00:00', task_key: key });
  assert.equal(block.error, false);
  const blocks = await tool(plannerToken, 'planner_list_blocks', { from: '2026-10-26', to: '2026-10-26' });
  assert.equal(blocks.data.blocks[0].task, '交报销单');
  assert.equal((await tool(plannerToken, 'planner_get_task', { key })).data.blocks.length, 1);
  const bad = await tool(plannerToken, 'planner_create_task', { title: 'x', project_id: 'p_missing' });
  assert.equal(bad.error, true);
  assert.match(bad.text, /planner_list_projects/);
  assert.equal((await tool(plannerToken, 'planner_create_task', {})).error, true);
});

test('MCP: library search, notes, collections, PDFs', async () => {
  const col = await tool(bothToken, 'library_create_collection', { name: 'RAG' });
  const item = await tool(bothToken, 'library_create_item', {
    item_type: 'conferencePaper',
    title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',
    creators: ['Patrick Lewis', { firstName: 'Ethan', lastName: 'Perez' }],
    date: '2020',
    fields: { proceedingsTitle: 'NeurIPS', DOI: '10.5555/rag' },
    tags: ['rag'],
    collections: [col.data.key],
    pdf_url: `${filesUrl}/paper.pdf`,
  });
  assert.equal(item.error, false, item.text);
  assert.equal(item.data.pdf.filename, 'paper.pdf');
  assert.equal(item.data.hasPdf, true);
  assert.equal(item.data.creators, 'Lewis, Perez');
  const found = await tool(bothToken, 'library_search', { query: 'lewis 2020 neurips' });
  assert.equal(found.data.items[0].key, item.data.key);
  assert.deepEqual(found.data.items[0].collections, ['RAG']);
  assert.equal((await tool(bothToken, 'library_search', { collection: col.data.key })).data.count, 1);
  const updated = await tool(bothToken, 'library_update_item', { key: item.data.key, add_tags: ['survey'], remove_tags: ['rag'], read_status: 'read', fields: { DOI: null } });
  assert.deepEqual(updated.data.tags, ['survey']);
  assert.equal(updated.data.readStatus, 'read');
  const note = await tool(bothToken, 'library_add_note', { parent_key: item.data.key, text: '要点：\n检索 + 生成\n\n<b>不是 HTML</b>' });
  const full = await tool(bothToken, 'library_get_item', { key: item.data.key });
  assert.equal(full.data.DOI, undefined);
  assert.equal(full.data.notes[0].key, note.data.key);
  assert.equal(full.data.notes[0].note, '<p>要点：<br>检索 + 生成</p><p>&lt;b&gt;不是 HTML&lt;/b&gt;</p>');
  assert.equal(full.data.attachments[0].hasFile, true);
  const notPdf = await tool(bothToken, 'library_attach_pdf', { key: item.data.key, url: `${filesUrl}/page` });
  assert.equal(notPdf.error, true);
  assert.match(notPdf.text, /不是 PDF/);
  await tool(bothToken, 'library_trash_item', { key: item.data.key });
  assert.equal((await tool(bothToken, 'library_search', { query: 'lewis' })).data.count, 0);
  assert.equal((await tool(bothToken, 'library_search', { query: 'lewis', include_trash: true })).data.count, 1);
});

test('rotating and revoking', async () => {
  const r = await call('t0ken', 'POST', `/api/agents/${bothId}/rotate`);
  assert.notEqual(r.body.token, bothToken);
  assert.equal((await call(bothToken, 'GET', '/api/library')).status, 401);
  assert.equal((await call(r.body.token, 'GET', '/api/library')).status, 200);
  assert.equal((await call('t0ken', 'DELETE', `/api/agents/${bothId}`)).status, 204);
  assert.equal((await call(r.body.token, 'GET', '/api/library')).status, 401);
});
