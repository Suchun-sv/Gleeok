import { Hono } from 'hono';
import type { AgentScope } from '../../shared/src/agents.ts';
import { agentOf } from './agents.ts';
import type { Library } from './library.ts';
import type { Planner } from './planner.ts';
import type { Store } from './store.ts';

/**
 * MCP for agents (Streamable HTTP, stateless: every POST is a JSON-RPC message or batch,
 * answered with JSON). The tools work on the stores directly, so agents never deal with
 * versions; what they create is marked with the connection's name. See docs/agents.md.
 */

type Json = Record<string, unknown>;
interface Ctx {
  by?: string;
}
interface Tool {
  name: string;
  scope: AgentScope;
  description: string;
  inputSchema: Json;
  run(args: Json, ctx: Ctx): unknown;
}

class ToolError extends Error {}

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_PDF_BYTES = 200 * 1024 * 1024;
const NON_ITEMS = ['note', 'attachment', 'annotation'];

const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
/** Now in the server's time zone, with its offset ("2026-10-24T15:04:05+01:00"). */
export function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}
const localDay = (iso: string) => localIso(new Date(iso)).slice(0, 10);
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// Argument readers: wrong types are the agent's mistake, reported back as a tool error.
function opt<T>(args: Json, name: string, type: 'string' | 'number' | 'boolean'): T | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== type) throw new ToolError(`${name} 应该是 ${type}`);
  return v as T;
}
function req<T>(args: Json, name: string, type: 'string' | 'number' | 'boolean'): T {
  const v = opt<T>(args, name, type);
  if (v === undefined || v === '') throw new ToolError(`缺少 ${name}`);
  return v;
}
const strings = (args: Json, name: string): string[] | undefined => {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new ToolError(`${name} 应该是字符串数组`);
  return v as string[];
};

/** Change an object at whatever version it is now (retrying if it moves under us). */
function patch(store: { get(kind: never, key: string): Json | undefined; update(kind: never, key: string, body: unknown, v: number): unknown }, kind: string, key: string, fields: Json) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = store.get(kind as never, key);
    if (!current) throw new ToolError(`找不到 ${key}`);
    const result = store.update(kind as never, key, fields, Number(current.version));
    if (result === 'conflict') continue;
    if (result === undefined) throw new ToolError(`找不到 ${key}`);
    if (typeof result === 'string') throw new ToolError(result);
    return result as Json;
  }
  throw new ToolError('这个对象一直在被别处修改，稍后再试');
}

function created(result: Json[] | string): Json {
  if (typeof result === 'string') throw new ToolError(result);
  return result[0];
}

const S = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra });
const N = (description: string, extra: Json = {}) => ({ type: 'number', description, ...extra });
const B = (description: string) => ({ type: 'boolean', description });
const schema = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

function plannerTools(planner: Planner, store: Store): Tool[] {
  const projects = () => new Map(store.list().map((p) => [p.id, p.name]));
  const all = () => planner.changes(0) as unknown as { tasks: Json[]; blocks: Json[] };
  const compact = (t: Json, names: Map<string, string>) => ({
    key: t.key,
    title: t.title,
    due: t.due,
    priority: t.priority,
    done: t.done ?? false,
    doneAt: t.doneAt,
    deleted: t.deleted,
    projectId: t.projectId,
    project: t.projectId ? names.get(t.projectId as string) : undefined,
    estimate: t.estimate,
    subtasks: t.subtasks,
    notes: typeof t.notes === 'string' && t.notes.length > 400 ? `${t.notes.slice(0, 400)}…` : t.notes,
    createdBy: t.createdBy,
  });
  const checkProject = (id: string | undefined) => {
    if (id && !store.get(id)) throw new ToolError(`没有 id 为 ${id} 的项目，用 planner_list_projects 查`);
  };
  const subtasks = (v: unknown) => {
    if (v === undefined || v === null) return v;
    if (!Array.isArray(v)) throw new ToolError('subtasks 应该是数组');
    return v.map((s) => {
      const o = (typeof s === 'string' ? { title: s } : s) as Json;
      if (typeof o?.title !== 'string') throw new ToolError('子任务需要 title');
      return { id: typeof o.id === 'string' ? o.id : Math.random().toString(36).slice(2, 10), title: o.title, done: o.done === true };
    });
  };
  const blockOut = (b: Json, tasks: Map<string, string>) => ({ key: b.key, start: b.start, end: b.end, title: b.title, taskKey: b.taskKey, task: b.taskKey ? tasks.get(b.taskKey as string) : undefined });

  const due = { due: S('截止："YYYY-MM-DD" 或 "YYYY-MM-DDTHH:mm"（用户时区的本地时间）；null 清除', { type: ['string', 'null'] }) };
  const taskFields = {
    title: S('标题'),
    notes: S('备注；null 清除', { type: ['string', 'null'] }),
    ...due,
    priority: N('0 无、1 低、2 中、3 高', { minimum: 0, maximum: 3 }),
    estimate: N('预估番茄数（一个 25 分钟）', { minimum: 0, maximum: 99 }),
    project_id: S('Gleeok 项目 id（planner_list_projects）；null 移回收件箱', { type: ['string', 'null'] }),
  };
  return [
    {
      name: 'planner_list_tasks',
      scope: 'planner',
      description: '列出任务。默认只列未完成的；可以按截止日期范围、项目、关键字筛选。结果里有服务器当前时间和时区。',
      inputSchema: schema({
        status: S('open（默认）、done、trash 或 all', { enum: ['open', 'done', 'trash', 'all'] }),
        due_from: S('截止日期不早于（YYYY-MM-DD）'),
        due_to: S('截止日期不晚于（YYYY-MM-DD）；"今天及以前" 就是今天的日期'),
        project_id: S('只看这个项目'),
        query: S('标题或备注里包含这些词'),
        limit: N('最多返回多少条（默认 100）'),
      }),
      run(args) {
        const status = opt<string>(args, 'status', 'string') ?? 'open';
        const from = opt<string>(args, 'due_from', 'string');
        const to = opt<string>(args, 'due_to', 'string');
        const project = opt<string>(args, 'project_id', 'string');
        const words = (opt<string>(args, 'query', 'string') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const names = projects();
        const tasks = all().tasks.filter((t) => {
          if (status === 'open' && (t.done || t.deleted)) return false;
          if (status === 'done' && (!t.done || t.deleted)) return false;
          if (status === 'trash' && !t.deleted) return false;
          const day = typeof t.due === 'string' ? t.due.slice(0, 10) : '';
          if ((from || to) && !day) return false;
          if (from && day < from) return false;
          if (to && day > to) return false;
          if (project && t.projectId !== project) return false;
          const text = `${t.title} ${t.notes ?? ''}`.toLowerCase();
          return words.every((w) => text.includes(w));
        });
        tasks.sort((a, b) =>
          status === 'done'
            ? String(b.doneAt ?? '').localeCompare(String(a.doneAt ?? ''))
            : String(a.due ?? '9').localeCompare(String(b.due ?? '9')) || Number(b.priority ?? 0) - Number(a.priority ?? 0),
        );
        const limit = opt<number>(args, 'limit', 'number') ?? 100;
        return { now: localIso(), timeZone: timeZone(), count: tasks.length, tasks: tasks.slice(0, limit).map((t) => compact(t, names)) };
      },
    },
    {
      name: 'planner_get_task',
      scope: 'planner',
      description: '一个任务的全部内容，以及它在日历上的时间块。',
      inputSchema: schema({ key: S('任务 key') }, ['key']),
      run(args) {
        const key = req<string>(args, 'key', 'string');
        const t = planner.get('tasks', key);
        if (!t) throw new ToolError(`找不到任务 ${key}`);
        const blocks = planner.children('blocks', key).map((k) => planner.get('blocks', k)!);
        return { ...compact(t, projects()), notes: t.notes, dateAdded: t.dateAdded, blocks: blocks.map((b) => blockOut(b, new Map())) };
      },
    },
    {
      name: 'planner_create_task',
      scope: 'planner',
      description: '新建任务（放在列表最上面）。',
      inputSchema: schema({ ...taskFields, subtasks: { type: 'array', items: { type: 'string' }, description: '子任务标题' } }, ['title']),
      run(args, ctx) {
        const title = req<string>(args, 'title', 'string');
        const projectId = opt<string>(args, 'project_id', 'string');
        checkProject(projectId);
        const top = Math.min(0, ...all().tasks.map((t) => Number(t.order ?? 0))) - 1;
        const obj: Json = {
          title,
          notes: opt<string>(args, 'notes', 'string'),
          due: opt<string>(args, 'due', 'string'),
          priority: opt<number>(args, 'priority', 'number') || undefined,
          estimate: opt<number>(args, 'estimate', 'number') || undefined,
          projectId,
          subtasks: subtasks(args.subtasks),
          order: top,
          createdBy: ctx.by,
        };
        for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
        return compact(created(planner.create('tasks', [obj])), projects());
      },
    },
    {
      name: 'planner_update_task',
      scope: 'planner',
      description: '修改任务：只改给出的字段。done=true 勾选完成，done=false 取消完成。subtasks 会整体替换（[{id?, title, done?}]）。',
      inputSchema: schema(
        {
          key: S('任务 key'),
          ...taskFields,
          done: B('勾选完成 / 取消完成'),
          subtasks: { type: 'array', description: '整体替换子任务', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, done: { type: 'boolean' } }, required: ['title'] } },
        },
        ['key'],
      ),
      run(args) {
        const key = req<string>(args, 'key', 'string');
        const fields: Json = {};
        const map: [string, string, 'string' | 'number'][] = [
          ['title', 'title', 'string'],
          ['notes', 'notes', 'string'],
          ['due', 'due', 'string'],
          ['priority', 'priority', 'number'],
          ['estimate', 'estimate', 'number'],
          ['project_id', 'projectId', 'string'],
        ];
        for (const [arg, field, type] of map) {
          if (!(arg in args)) continue;
          fields[field] = args[arg] === null || args[arg] === '' || args[arg] === 0 ? null : (opt(args, arg, type) ?? null);
        }
        if (fields.title === null) throw new ToolError('标题不能为空');
        if (typeof fields.projectId === 'string') checkProject(fields.projectId);
        if ('subtasks' in args) fields.subtasks = subtasks(args.subtasks) ?? null;
        const done = opt<boolean>(args, 'done', 'boolean');
        if (done === true) Object.assign(fields, { done: true, doneAt: new Date().toISOString() });
        if (done === false) Object.assign(fields, { done: null, doneAt: null });
        return compact(patch(planner as never, 'tasks', key, fields), projects());
      },
    },
    {
      name: 'planner_trash_task',
      scope: 'planner',
      description: '把任务放进回收站（restore=true 拿回来）。不会彻底删除。',
      inputSchema: schema({ key: S('任务 key'), restore: B('从回收站恢复') }, ['key']),
      run(args) {
        const restore = opt<boolean>(args, 'restore', 'boolean');
        return compact(patch(planner as never, 'tasks', req<string>(args, 'key', 'string'), { deleted: restore ? null : true }), projects());
      },
    },
    {
      name: 'planner_list_blocks',
      scope: 'planner',
      description: '日历上的时间块（某段时间做某个任务，或「午饭」这类）。默认今天起 7 天。',
      inputSchema: schema({ from: S('起始日期 YYYY-MM-DD（含）'), to: S('结束日期 YYYY-MM-DD（含）') }),
      run(args) {
        const today = localIso().slice(0, 10);
        const from = opt<string>(args, 'from', 'string') ?? today;
        const to = opt<string>(args, 'to', 'string') ?? localIso(new Date(Date.now() + 6 * 86_400_000)).slice(0, 10);
        const data = all();
        const titles = new Map(data.tasks.map((t) => [t.key as string, t.title as string]));
        const blocks = data.blocks.filter((b) => localDay(b.start as string) >= from && localDay(b.start as string) <= to).sort((a, b) => String(a.start).localeCompare(String(b.start)));
        return { now: localIso(), timeZone: timeZone(), blocks: blocks.map((b) => blockOut(b, titles)) };
      },
    },
    {
      name: 'planner_create_block',
      scope: 'planner',
      description: '在日历上占一段时间：给 task_key 就是为这个任务留的时间，否则要给 title。',
      inputSchema: schema({ start: S('开始，ISO 时间带时区偏移'), end: S('结束，ISO 时间带时区偏移'), task_key: S('任务 key'), title: S('不对应任务时的标题') }, ['start', 'end']),
      run(args) {
        const obj: Json = { start: req<string>(args, 'start', 'string'), end: req<string>(args, 'end', 'string') };
        const taskKey = opt<string>(args, 'task_key', 'string');
        const title = opt<string>(args, 'title', 'string');
        if (taskKey) obj.taskKey = taskKey;
        if (title) obj.title = title;
        return created(planner.create('blocks', [obj]));
      },
    },
    {
      name: 'planner_update_block',
      scope: 'planner',
      description: '移动或改时间块。',
      inputSchema: schema({ key: S('时间块 key'), start: S('新的开始'), end: S('新的结束'), title: S('标题') }, ['key']),
      run(args) {
        const fields: Json = {};
        for (const k of ['start', 'end', 'title']) if (opt<string>(args, k, 'string') !== undefined) fields[k] = args[k];
        return patch(planner as never, 'blocks', req<string>(args, 'key', 'string'), fields);
      },
    },
    {
      name: 'planner_delete_block',
      scope: 'planner',
      description: '删掉一个时间块（只是日历上的占位，任务不受影响）。',
      inputSchema: schema({ key: S('时间块 key') }, ['key']),
      run(args) {
        const key = req<string>(args, 'key', 'string');
        if (!planner.delete('blocks', key)) throw new ToolError(`找不到时间块 ${key}`);
        return { deleted: key };
      },
    },
    {
      name: 'planner_list_projects',
      scope: 'planner',
      description: '用户的 Gleeok 项目（任务可以属于某个项目）。',
      inputSchema: schema({}),
      run: () => store.list().filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name })),
    },
  ];
}

function libraryTools(library: Library): Tool[] {
  const all = () => library.changes(0) as unknown as { items: Json[]; collections: Json[]; annotations: Json[] };
  const isItem = (i: Json) => !NON_ITEMS.includes(i.itemType as string);
  const authors = (i: Json) => {
    const cs = ((i.creators as Json[] | undefined) ?? []).map((c) => (c.lastName as string) || (c.name as string) || '').filter(Boolean);
    return cs.length > 3 ? `${cs.slice(0, 3).join(', ')} et al.` : cs.join(', ');
  };
  const year = (i: Json) => /\b(1[5-9]\d\d|20\d\d)\b/.exec(String(i.date ?? ''))?.[1];
  const compact = (i: Json, data: { items: Json[]; collections: Json[] }) => {
    const colNames = new Map(data.collections.map((c) => [c.key as string, c.name as string]));
    return {
      key: i.key,
      itemType: i.itemType,
      title: i.title,
      creators: authors(i),
      year: year(i),
      venue: i.publicationTitle ?? i.proceedingsTitle ?? i.conferenceName ?? i.repository,
      tags: ((i.tags as Json[] | undefined) ?? []).map((t) => t.tag),
      collections: ((i.collections as string[] | undefined) ?? []).map((c) => colNames.get(c) ?? c),
      hasPdf: data.items.some((a) => a.parentItem === i.key && a.itemType === 'attachment' && a.fileHash),
      citationKey: i.citationKey,
      readStatus: i.readStatus,
      deleted: i.deleted,
      createdBy: i.createdBy,
    };
  };
  const creators = (v: unknown) => {
    if (v === undefined || v === null) return v;
    if (!Array.isArray(v)) throw new ToolError('creators 应该是数组');
    return v.map((c) => {
      if (typeof c === 'string') {
        const parts = c.trim().split(/\s+/);
        return parts.length > 1 ? { creatorType: 'author', firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) } : { creatorType: 'author', name: c.trim() };
      }
      const o = c as Json;
      if (!o.lastName && !o.name) throw new ToolError('作者需要 lastName（或 name）');
      return { creatorType: 'author', ...o };
    });
  };
  const tags = (v: string[] | undefined) => v?.map((tag) => ({ tag }));
  const checkCollections = (keys: string[] | undefined) => {
    for (const k of keys ?? []) if (!library.get('collections', k)) throw new ToolError(`没有 key 为 ${k} 的分类，用 library_list_collections 查`);
  };

  async function attachPdf(parentItem: string, url: string, by?: string) {
    if (!library.get('items', parentItem)) throw new ToolError(`找不到条目 ${parentItem}`);
    const pdfUrl = url.replace(/^https?:\/\/(www\.)?arxiv\.org\/abs\//, 'https://arxiv.org/pdf/');
    let res: Response;
    try {
      res = await fetch(pdfUrl, { redirect: 'follow', signal: AbortSignal.timeout(120_000), headers: { 'user-agent': 'Gleeok (reference library)' } });
    } catch (e) {
      throw new ToolError(`下载失败：${(e as Error).message}`);
    }
    if (!res.ok) throw new ToolError(`下载失败：HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > MAX_PDF_BYTES) throw new ToolError('文件太大（超过 200 MB）');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_PDF_BYTES) throw new ToolError('文件太大（超过 200 MB）');
    if (!Buffer.from(bytes.subarray(0, 1024)).toString('latin1').includes('%PDF')) throw new ToolError('这个网址返回的不是 PDF');
    const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(res.headers.get('content-disposition') ?? '')?.[1];
    const last = decodeURIComponent(new URL(res.url || pdfUrl).pathname.split('/').pop() || 'paper');
    const filename = (fromHeader ? decodeURIComponent(fromHeader) : last).replace(/[/\\]/g, '_').replace(/(\.pdf)?$/i, '.pdf');
    const attachment = created(
      library.create('items', [{ itemType: 'attachment', parentItem, title: 'PDF', filename, contentType: 'application/pdf', linkMode: 'imported_file', ...(by ? { createdBy: by } : {}) }]),
    );
    const stored = library.putFile(attachment.key as string, bytes);
    if (!stored || typeof stored === 'string') throw new ToolError(`保存文件失败：${stored ?? 'not found'}`);
    return { key: attachment.key, filename, bytes: bytes.length };
  }

  const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const noteHtml = (text: string) =>
    text
      .split(/\n\s*\n/)
      .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
      .join('');

  return [
    {
      name: 'library_search',
      scope: 'library',
      description: '在文献库里找论文：关键字匹配标题、作者、年份、期刊/会议、DOI、摘要、标签、引用键（所有词都要出现）。可以按分类、标签、类型筛选。',
      inputSchema: schema({
        query: S('关键字'),
        collection: S('分类 key'),
        tag: S('标签'),
        item_type: S('条目类型，例如 conferencePaper'),
        include_trash: B('也搜回收站'),
        limit: N('最多返回多少条（默认 50）'),
      }),
      run(args) {
        const data = all();
        const words = (opt<string>(args, 'query', 'string') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const collection = opt<string>(args, 'collection', 'string');
        const tag = opt<string>(args, 'tag', 'string');
        const type = opt<string>(args, 'item_type', 'string');
        const trash = opt<boolean>(args, 'include_trash', 'boolean');
        const hits = data.items.filter((i) => {
          if (!isItem(i) || (i.deleted && !trash)) return false;
          if (collection && !((i.collections as string[] | undefined) ?? []).includes(collection)) return false;
          if (tag && !((i.tags as Json[] | undefined) ?? []).some((t) => t.tag === tag)) return false;
          if (type && i.itemType !== type) return false;
          const text = [
            i.title,
            ((i.creators as Json[] | undefined) ?? []).map((c) => `${c.firstName ?? ''} ${c.lastName ?? ''} ${c.name ?? ''}`).join(' '),
            i.date,
            i.publicationTitle,
            i.proceedingsTitle,
            i.conferenceName,
            i.DOI,
            i.abstractNote,
            i.citationKey,
            ((i.tags as Json[] | undefined) ?? []).map((t) => t.tag).join(' '),
          ]
            .join(' ')
            .toLowerCase();
          return words.every((w) => text.includes(w));
        });
        hits.sort((a, b) => String(b.dateModified ?? '').localeCompare(String(a.dateModified ?? '')));
        const limit = opt<number>(args, 'limit', 'number') ?? 50;
        return { count: hits.length, items: hits.slice(0, limit).map((i) => compact(i, data)) };
      },
    },
    {
      name: 'library_get_item',
      scope: 'library',
      description: '一个条目的全部字段，以及它的笔记、附件和批注数。',
      inputSchema: schema({ key: S('条目 key') }, ['key']),
      run(args) {
        const key = req<string>(args, 'key', 'string');
        const data = all();
        const item = data.items.find((i) => i.key === key);
        if (!item) throw new ToolError(`找不到条目 ${key}`);
        const children = data.items.filter((i) => i.parentItem === key);
        const attachments = children.filter((c) => c.itemType === 'attachment');
        return {
          ...item,
          summary: compact(item, data),
          notes: children.filter((c) => c.itemType === 'note').map((n) => ({ key: n.key, note: n.note, createdBy: n.createdBy })),
          attachments: attachments.map((a) => ({
            key: a.key,
            filename: a.filename,
            contentType: a.contentType,
            hasFile: !!a.fileHash,
            annotations: data.annotations.filter((x) => x.parentItem === a.key).length,
          })),
        };
      },
    },
    {
      name: 'library_get_annotations',
      scope: 'library',
      description: '用户在 PDF 里的高亮和批注（原文 + 评论），按页序。给条目 key 或附件 key 都行。',
      inputSchema: schema({ key: S('条目或附件 key') }, ['key']),
      run(args) {
        const key = req<string>(args, 'key', 'string');
        const data = all();
        const item = data.items.find((i) => i.key === key);
        if (!item) throw new ToolError(`找不到 ${key}`);
        const attachments = item.itemType === 'attachment' ? [key] : data.items.filter((i) => i.parentItem === key && i.itemType === 'attachment').map((a) => a.key as string);
        return data.annotations
          .filter((a) => attachments.includes(a.parentItem as string))
          .sort((a, b) => String(a.sortIndex ?? '').localeCompare(String(b.sortIndex ?? '')))
          .map((a) => ({ key: a.key, attachment: a.parentItem, type: a.type, page: a.pageLabel, text: a.text, comment: a.comment, color: a.color, tags: ((a.tags as Json[] | undefined) ?? []).map((t) => t.tag) }));
      },
    },
    {
      name: 'library_list_collections',
      scope: 'library',
      description: '全部分类（含上级分类和条目数）。',
      inputSchema: schema({}),
      run() {
        const data = all();
        return data.collections.map((c) => ({
          key: c.key,
          name: c.name,
          parent: c.parentCollection || undefined,
          items: data.items.filter((i) => isItem(i) && !i.deleted && ((i.collections as string[] | undefined) ?? []).includes(c.key as string)).length,
        }));
      },
    },
    {
      name: 'library_create_item',
      scope: 'library',
      description: '新建条目。字段名用 Zotero 的（fields 里放 DOI、url、publicationTitle、proceedingsTitle、abstractNote 等）。给 pdf_url（PDF 链接或 arXiv abs 页）会顺便下载 PDF 挂上去。',
      inputSchema: schema(
        {
          item_type: S('journalArticle、conferencePaper、preprint、book、bookSection、thesis、report、webpage…'),
          title: S('标题'),
          creators: { type: 'array', description: '作者："First Last" 字符串，或 {firstName, lastName, creatorType?}', items: {} },
          date: S('日期或年份'),
          fields: { type: 'object', description: '其他 Zotero 字段', additionalProperties: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          collections: { type: 'array', items: { type: 'string' }, description: '分类 key' },
          pdf_url: S('PDF 的网址'),
        },
        ['item_type', 'title'],
      ),
      async run(args, ctx) {
        const extra = (args.fields ?? {}) as Json;
        if (typeof extra !== 'object' || Array.isArray(extra)) throw new ToolError('fields 应该是对象');
        for (const k of ['key', 'version', 'itemType', 'parentItem', 'fileHash', 'fileSize', 'deleted']) delete extra[k];
        const cols = strings(args, 'collections');
        checkCollections(cols);
        const obj: Json = {
          ...extra,
          itemType: req<string>(args, 'item_type', 'string'),
          title: req<string>(args, 'title', 'string'),
          creators: creators(args.creators),
          date: opt<string>(args, 'date', 'string'),
          tags: tags(strings(args, 'tags')),
          collections: cols,
          createdBy: ctx.by,
        };
        for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
        const item = created(library.create('items', [obj]));
        const pdfUrl = opt<string>(args, 'pdf_url', 'string');
        if (!pdfUrl) return compact(item, all());
        try {
          const pdf = await attachPdf(item.key as string, pdfUrl, ctx.by);
          return { ...compact(library.get('items', item.key as string)!, all()), pdf };
        } catch (e) {
          return { ...compact(item, all()), pdfError: (e as Error).message };
        }
      },
    },
    {
      name: 'library_update_item',
      scope: 'library',
      description: '修改条目：fields 里给要改的 Zotero 字段（null 删除）；tags / collections 整体替换，或用 add_/remove_ 增减。',
      inputSchema: schema(
        {
          key: S('条目 key'),
          fields: { type: 'object', description: '要改的字段，例如 {"title": "...", "DOI": "..."}', additionalProperties: { type: ['string', 'null'] } },
          creators: { type: 'array', items: {}, description: '整体替换作者' },
          tags: { type: 'array', items: { type: 'string' } },
          add_tags: { type: 'array', items: { type: 'string' } },
          remove_tags: { type: 'array', items: { type: 'string' } },
          collections: { type: 'array', items: { type: 'string' } },
          add_to_collections: { type: 'array', items: { type: 'string' } },
          remove_from_collections: { type: 'array', items: { type: 'string' } },
          read_status: S('unread、reading 或 read', { enum: ['unread', 'reading', 'read'] }),
        },
        ['key'],
      ),
      run(args) {
        const key = req<string>(args, 'key', 'string');
        const item = library.get('items', key);
        if (!item) throw new ToolError(`找不到条目 ${key}`);
        const fields: Json = { ...((args.fields ?? {}) as Json) };
        for (const k of ['key', 'version', 'parentItem', 'fileHash', 'fileSize']) delete fields[k];
        if ('creators' in args) fields.creators = creators(args.creators);
        let tagList = ((item.tags as Json[] | undefined) ?? []).map((t) => t.tag as string);
        const setTags = strings(args, 'tags');
        if (setTags) tagList = setTags;
        tagList = [...new Set([...tagList, ...(strings(args, 'add_tags') ?? [])])].filter((t) => !(strings(args, 'remove_tags') ?? []).includes(t));
        if (setTags || args.add_tags || args.remove_tags) fields.tags = tags(tagList);
        let cols = (item.collections as string[] | undefined) ?? [];
        const setCols = strings(args, 'collections');
        if (setCols) cols = setCols;
        cols = [...new Set([...cols, ...(strings(args, 'add_to_collections') ?? [])])].filter((c) => !(strings(args, 'remove_from_collections') ?? []).includes(c));
        if (setCols || args.add_to_collections || args.remove_from_collections) {
          checkCollections(cols);
          fields.collections = cols;
        }
        const read = opt<string>(args, 'read_status', 'string');
        if (read) fields.readStatus = read;
        return compact(patch(library as never, 'items', key, fields), all());
      },
    },
    {
      name: 'library_add_note',
      scope: 'library',
      description: '给条目加一条笔记（不给 parent_key 就是独立笔记）。text 是纯文本，空行分段；或者直接给 html。',
      inputSchema: schema({ parent_key: S('条目 key'), text: S('笔记内容（纯文本）'), html: S('笔记内容（HTML），给了就不用 text') }),
      run(args, ctx) {
        const parent = opt<string>(args, 'parent_key', 'string');
        if (parent && !library.get('items', parent)) throw new ToolError(`找不到条目 ${parent}`);
        const html = opt<string>(args, 'html', 'string') ?? noteHtml(req<string>(args, 'text', 'string'));
        const note = created(library.create('items', [{ itemType: 'note', note: html, ...(parent ? { parentItem: parent } : {}), ...(ctx.by ? { createdBy: ctx.by } : {}) }]));
        return { key: note.key, parentItem: parent };
      },
    },
    {
      name: 'library_create_collection',
      scope: 'library',
      description: '新建分类（可以放在某个分类下面）。',
      inputSchema: schema({ name: S('名字'), parent_key: S('上级分类 key') }, ['name']),
      run(args, ctx) {
        const parent = opt<string>(args, 'parent_key', 'string');
        return created(library.create('collections', [{ name: req<string>(args, 'name', 'string'), parentCollection: parent ?? false, ...(ctx.by ? { createdBy: ctx.by } : {}) }]));
      },
    },
    {
      name: 'library_trash_item',
      scope: 'library',
      description: '把条目放进回收站（restore=true 拿回来）。不会彻底删除。',
      inputSchema: schema({ key: S('条目 key'), restore: B('从回收站恢复') }, ['key']),
      run(args) {
        const restore = opt<boolean>(args, 'restore', 'boolean');
        return compact(patch(library as never, 'items', req<string>(args, 'key', 'string'), { deleted: restore ? null : true }), all());
      },
    },
    {
      name: 'library_attach_pdf',
      scope: 'library',
      description: '从网址下载 PDF（PDF 链接或 arXiv abs 页）挂到已有条目上。',
      inputSchema: schema({ key: S('条目 key'), url: S('PDF 的网址') }, ['key', 'url']),
      run: (args, ctx) => attachPdf(req<string>(args, 'key', 'string'), req<string>(args, 'url', 'string'), ctx.by),
    },
  ];
}

const INSTRUCTIONS =
  'Gleeok 是用户的工作台：日程（任务、日历上的时间块）和文献库（Zotero 式的论文库）。改之前先读最新数据；' +
  '删除只放回收站；做完告诉用户改了什么。时间按工具返回的 timeZone 理解。';

export function mcpRoutes(deps: { planner?: Planner; library?: Library; store: Store }) {
  const tools = [...(deps.planner ? plannerTools(deps.planner, deps.store) : []), ...(deps.library ? libraryTools(deps.library) : [])];
  const r = new Hono();

  r.post('/', async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as unknown;
    if (body === undefined) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    const agent = agentOf(c.req.raw);
    const visible = tools.filter((t) => !agent || agent.scopes.includes(t.scope));
    const ctx: Ctx = { by: agent?.name };

    const handle = async (m: unknown): Promise<Json | null> => {
      const msg = m as { jsonrpc?: string; id?: unknown; method?: unknown; params?: Json } | null;
      const isRequest = !!msg && typeof msg === 'object' && 'id' in msg;
      if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        return isRequest ? { jsonrpc: '2.0', id: msg!.id ?? null, error: { code: -32600, message: 'Invalid Request' } } : null;
      }
      if (!isRequest) return null; // notifications (initialized, cancelled…) need no answer
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
      const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
      switch (msg.method) {
        case 'initialize': {
          const asked = msg.params?.protocolVersion;
          return ok({
            protocolVersion: typeof asked === 'string' && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'gleeok', version: '1.0.0' },
            instructions: INSTRUCTIONS,
          });
        }
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({ tools: visible.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case 'tools/call': {
          const tool = visible.find((t) => t.name === msg.params?.name);
          if (!tool) return fail(-32602, `unknown tool ${String(msg.params?.name)}`);
          const args = (msg.params?.arguments ?? {}) as Json;
          try {
            const out = await tool.run(args && typeof args === 'object' ? args : {}, ctx);
            return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
          } catch (e) {
            return ok({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
          }
        }
        default:
          return fail(-32601, `method not found: ${msg.method}`);
      }
    };

    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handle))).filter(Boolean);
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const out = await handle(body);
    return out ? c.json(out) : c.body(null, 202);
  });
  // No server-to-client stream: everything is answered in the POST.
  r.get('/', (c) => c.body(null, 405, { Allow: 'POST' }));
  r.delete('/', (c) => c.body(null, 405, { Allow: 'POST' }));
  return r;
}
