import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { Planner } from '../src/planner.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'gleeok-planner-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const app = createApp(new Store(join(dir, 'gleeok.db')), { token: 't0ken', planner: new Planner(dir) });

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.fetch(
    new Request(`http://x/api/planner${path}`, {
      method,
      headers: { authorization: 'Bearer t0ken', 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as any) };
}
const patch = (kind: string, key: string, version: number, body: unknown) =>
  call('PATCH', `/${kind}/${key}`, body, { 'If-Unmodified-Since-Version': String(version) });

test('requires the token', async () => {
  assert.equal((await app.fetch(new Request('http://x/api/planner'))).status, 401);
});

let task: any;
let block: any;

test('creates tasks, blocks and pomodoros; changes come by version', async () => {
  assert.equal((await call('GET', '')).body.version, 0);
  task = (
    await call('POST', '/tasks', {
      title: '改 DS4D 讲义第 3 节',
      due: '2026-10-24',
      priority: 3,
      estimate: 3,
      projectId: 'p_ds4d',
      subtasks: [{ id: 's1', title: '图', done: false }],
    })
  ).body;
  assert.match(task.key, /^[2-9A-Z]{8}$/);
  assert.ok(task.dateAdded && task.dateModified);
  block = (await call('POST', '/blocks', { taskKey: task.key, start: '2026-10-24T09:00:00+01:00', end: '2026-10-24T10:15:00+01:00' })).body;
  const free = (await call('POST', '/blocks', { title: '午饭', start: '2026-10-24T12:00:00+01:00', end: '2026-10-24T13:00:00+01:00' })).body;
  assert.equal(free.title, '午饭');
  const pomo = await call('POST', '/pomodoros', { taskKey: task.key, taskTitle: task.title, blockKey: block.key, kind: 'focus', start: '2026-10-24T09:00:00+01:00', end: '2026-10-24T09:25:00+01:00', completed: true });
  assert.equal(pomo.status, 201);
  const all = (await call('GET', '')).body;
  assert.equal(all.version, 4);
  assert.equal(all.tasks.length, 1);
  assert.equal(all.blocks.length, 2);
  assert.equal(all.pomodoros.length, 1);
  assert.equal((await call('GET', '?since=3')).body.pomodoros.length, 1);
  assert.equal((await call('GET', '?since=3')).body.tasks.length, 0);
});

test('rejects bad input', async () => {
  assert.equal((await call('POST', '/tasks', { notes: 'no title' })).status, 400);
  assert.equal((await call('POST', '/tasks', { title: 'x', due: 'tomorrow' })).status, 400);
  assert.equal((await call('POST', '/tasks', { title: 'x', priority: 5 })).status, 400);
  assert.equal((await call('POST', '/blocks', { title: 'x', start: '2026-10-24T10:00:00Z', end: '2026-10-24T09:00:00Z' })).status, 400, 'ends before it starts');
  assert.equal((await call('POST', '/blocks', { start: '2026-10-24T09:00:00Z', end: '2026-10-24T10:00:00Z' })).status, 400, 'needs a task or a title');
  assert.equal((await call('POST', '/blocks', { taskKey: 'NOPE2345', start: '2026-10-24T09:00:00Z', end: '2026-10-24T10:00:00Z' })).status, 400);
  assert.equal((await call('POST', '/pomodoros', { kind: 'nap', start: '2026-10-24T09:00:00Z', end: '2026-10-24T10:00:00Z', completed: true })).status, 400);
});

test('ticking a task done is a versioned patch; blocks never complete it', async () => {
  assert.equal((await patch('tasks', task.key, task.version - 1, { done: true })).status, 409);
  const done = await patch('tasks', task.key, task.version, { done: true, doneAt: '2026-10-24T10:20:00Z' });
  assert.equal(done.status, 200);
  assert.equal(done.body.done, true);
  assert.equal(done.body.dateAdded, task.dateAdded);
  // Moving a block leaves the task as it is.
  const moved = await patch('blocks', block.key, block.version, { start: '2026-10-24T14:00:00+01:00', end: '2026-10-24T15:00:00+01:00' });
  assert.equal(moved.status, 200);
  task = done.body;
});

test('deleting a task for good takes its blocks and keeps its pomodoros', async () => {
  const before = (await call('GET', '')).body.version;
  assert.equal((await call('DELETE', `/tasks/${task.key}`)).status, 204);
  const changes = (await call('GET', `?since=${before}`)).body;
  assert.deepEqual(changes.deleted.tasks, [task.key]);
  assert.deepEqual(changes.deleted.blocks, [block.key]);
  const all = (await call('GET', '')).body;
  assert.equal(all.blocks.length, 1, 'the free block stays');
  assert.equal(all.pomodoros.length, 1);
  assert.equal(all.pomodoros[0].taskTitle, '改 DS4D 讲义第 3 节');
});
