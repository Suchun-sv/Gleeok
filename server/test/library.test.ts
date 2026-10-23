import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { Library } from '../src/library.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'gleeok-library-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const app = createApp(new Store(join(dir, 'gleeok.db')), { token: 't0ken', library: new Library(dir) });

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const raw = body instanceof Uint8Array;
  const res = await app.fetch(
    new Request(`http://x/api/library${path}`, {
      method,
      headers: { authorization: 'Bearer t0ken', ...(body === undefined || raw ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
    }),
  );
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, version: Number(res.headers.get('Last-Modified-Version')), body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) } as {
    status: number;
    version: number;
    body: any;
  };
}
const patch = (kind: string, key: string, version: number, body: unknown) =>
  call('PATCH', `/${kind}/${key}`, body, { 'If-Unmodified-Since-Version': String(version) });

test('requires the token', async () => {
  const res = await app.fetch(new Request('http://x/api/library'));
  assert.equal(res.status, 401);
});

test('starts empty at version 0', async () => {
  const r = await call('GET', '');
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 0);
  assert.deepEqual(r.body.items, []);
});

let collection: any;
let child: any;
let item: any;

test('creates collections and items; every write bumps the library version', async () => {
  const c = await call('POST', '/collections', { name: '论文 A' });
  assert.equal(c.status, 201);
  collection = c.body;
  assert.match(collection.key, /^[2-9A-Z]{8}$/);
  assert.equal(collection.parentCollection, false);
  assert.equal(collection.version, 1);

  const sub = await call('POST', '/collections', { name: '相关工作', parentCollection: collection.key });
  child = sub.body;
  assert.equal(child.version, 2);

  const i = await call('POST', '/items', {
    itemType: 'conferencePaper',
    title: 'Attention Is All You Need',
    creators: [{ creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' }],
    date: '2017',
    collections: [child.key],
    tags: [{ tag: 'transformer' }],
  });
  assert.equal(i.status, 201);
  item = i.body;
  assert.equal(item.version, 3);
  assert.ok(item.dateAdded && item.dateModified);

  const all = await call('GET', '');
  assert.equal(all.body.version, 3);
  assert.equal(all.body.collections.length, 2);
  assert.equal(all.body.items.length, 1);
  const since = await call('GET', '?since=2');
  assert.deepEqual(since.body.items.map((x: any) => x.key), [item.key]);
  assert.equal(since.body.collections.length, 0);
});

test('rejects bad input', async () => {
  assert.equal((await call('POST', '/items', { title: 'no type' })).status, 400);
  assert.equal((await call('POST', '/items', { itemType: 'book', collections: ['NOPE2345'] })).status, 400);
  assert.equal((await call('POST', '/items', { itemType: 'note', parentItem: 'ZZZZZZZZ' })).status, 400);
  assert.equal((await call('POST', '/items', { key: item.key, itemType: 'book' })).status, 400, 'duplicate key');
  // A collection cannot end up inside itself.
  assert.equal((await patch('collections', collection.key, 99, { parentCollection: child.key })).status, 400);
});

test('PATCH checks the version, merges fields and removes nulls', async () => {
  assert.equal((await call('PATCH', `/items/${item.key}`, { title: 'x' })).status, 428, 'version header required');
  const stale = await patch('items', item.key, item.version - 1, { title: 'stale' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.title, 'Attention Is All You Need');

  const ok = await patch('items', item.key, item.version, { publicationTitle: 'NeurIPS', date: null, fileHash: 'forged' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.title, 'Attention Is All You Need');
  assert.equal(ok.body.publicationTitle, 'NeurIPS');
  assert.equal(ok.body.date, undefined);
  assert.equal(ok.body.fileHash, undefined, 'clients cannot set file fields');
  assert.ok(ok.body.version > item.version);
  item = ok.body;

  const trash = await patch('items', item.key, item.version, { deleted: true });
  assert.equal(trash.body.deleted, true);
  item = (await patch('items', item.key, trash.body.version, { deleted: null })).body;
  assert.equal(item.deleted, undefined);
});

let attachment: any;

test('attachments store files with checksums', async () => {
  const note = await call('POST', '/items', { itemType: 'note', parentItem: item.key, note: '<p>读后感</p>' });
  assert.equal(note.status, 201);
  attachment = (await call('POST', '/items', { itemType: 'attachment', parentItem: item.key, contentType: 'application/pdf', filename: 'vaswani.pdf', linkMode: 'imported_file' })).body;

  const pdf = new TextEncoder().encode('%PDF-1.4 fake pdf bytes');
  const sha = createHash('sha256').update(pdf).digest('hex');
  assert.equal((await call('PUT', `/items/${attachment.key}/file`, pdf, { 'X-Content-SHA256': '0'.repeat(64) })).status, 400);
  assert.equal((await call('PUT', `/items/${item.key}/file`, pdf)).status, 400, 'only attachments hold files');
  const up = await call('PUT', `/items/${attachment.key}/file`, pdf, { 'X-Content-SHA256': sha });
  assert.equal(up.status, 200);
  assert.equal(up.body.fileHash, sha);
  assert.equal(up.body.fileSize, pdf.length);
  attachment = up.body;

  const down = await call('GET', `/items/${attachment.key}/file`);
  assert.equal(down.status, 200);
  assert.deepEqual(down.body, pdf);
  // Editing the attachment's metadata keeps its file fields.
  attachment = (await patch('items', attachment.key, attachment.version, { title: 'PDF' })).body;
  assert.equal(attachment.fileHash, sha);
});

test('annotations and reading states belong to attachments', async () => {
  const ann = { key: 'AC4PRD7A', parentItem: attachment.key, type: 'highlight', color: '#ffd400', position: { pageIndex: 0, rects: [[1, 2, 3, 4]] }, text: 'attention', comment: '' };
  assert.equal((await call('POST', '/annotations', ann)).status, 201);
  assert.equal((await call('POST', '/annotations', { ...ann, key: 'B', parentItem: item.key })).status, 400, 'not an attachment');

  const s1 = await call('PUT', `/states/${attachment.key}`, { state: { pageIndex: 3, scale: 'page-width' } });
  assert.equal(s1.status, 200, 'first write creates it, no version needed');
  const s2 = await call('PUT', `/states/${attachment.key}`, { state: { pageIndex: 7 } });
  assert.deepEqual(s2.body.state, { pageIndex: 7 });
  assert.equal((await call('PUT', `/states/${item.key}`, { state: {} })).status, 400);
});

test('deleting a collection takes its subcollections; items just leave it', async () => {
  const before = (await call('GET', '')).body.version;
  assert.equal((await call('DELETE', `/collections/${collection.key}`)).status, 204);
  const changes = (await call('GET', `?since=${before}`)).body;
  assert.deepEqual(changes.deleted.collections.sort(), [collection.key, child.key].sort());
  const it = changes.items.find((x: any) => x.key === item.key);
  assert.deepEqual(it.collections, []);
});

test('deleting an item takes its notes, attachments, annotations, states and files', async () => {
  const before = (await call('GET', '')).body.version;
  assert.equal((await call('DELETE', `/items/${item.key}`)).status, 204);
  const changes = (await call('GET', `?since=${before}`)).body;
  assert.equal(changes.deleted.items.length, 3);
  assert.deepEqual(changes.deleted.annotations, ['AC4PRD7A']);
  assert.deepEqual(changes.deleted.states, [attachment.key]);
  assert.equal((await call('GET', `/items/${attachment.key}/file`)).status, 404);
  assert.equal((await call('GET', '')).body.items.length, 0);
  assert.equal((await call('DELETE', `/items/${item.key}`)).status, 404);
});
