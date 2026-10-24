// Gleeok 日程 on the phone: today's time blocks and tasks, quick add, ticking, task details.
// Talks to the same /api/planner as Gleeok (see docs/planner.md); no build step, no framework.

const TOKEN_KEY = 'gleeok.token';
const app = document.getElementById('app');

// A link from Gleeok's settings carries the token in its fragment: keep it, then drop it from the URL.
const fromLink = new URLSearchParams(location.hash.slice(1)).get('token');
if (fromLink) {
  localStorage.setItem(TOKEN_KEY, fromLink);
  history.replaceState(null, '', location.pathname);
}

let token = localStorage.getItem(TOKEN_KEY) ?? '';
let version = 0;
const tasks = new Map();
const blocks = new Map();
const projects = new Map();
let tab = localStorage.getItem('gleeok.tab') ?? 'today';
let openTask = null;
let error = '';

// ---- server ----

async function api(method, path, body, headers = {}) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    token = '';
    localStorage.removeItem(TOKEN_KEY);
    render();
    throw new Error('令牌不对，请重新输入');
  }
  return res;
}

async function sync() {
  try {
    const res = await api('GET', `/api/planner?since=${version}`);
    if (!res.ok) throw new Error(`同步失败（${res.status}）`);
    const c = await res.json();
    for (const t of c.tasks) tasks.set(t.key, t);
    for (const b of c.blocks) blocks.set(b.key, b);
    for (const k of c.deleted.tasks) tasks.delete(k);
    for (const k of c.deleted.blocks) blocks.delete(k);
    version = Math.max(version, c.version);
    if (projects.size === 0) {
      const p = await api('GET', '/api/projects');
      if (p.ok) for (const x of await p.json()) projects.set(x.id, x.name);
    }
    error = '';
  } catch (e) {
    error = String(e.message ?? e);
  }
  render();
}

async function create(fields) {
  const res = await api('POST', '/api/planner/tasks', fields);
  if (!res.ok) throw new Error((await res.json()).error ?? '保存失败');
  const t = await res.json();
  tasks.set(t.key, t);
  return t;
}

/** Set fields; a conflict re-applies them to the newer copy once. */
async function patch(key, fields) {
  for (let attempt = 0; ; attempt++) {
    const current = tasks.get(key);
    const res = await api('PATCH', `/api/planner/tasks/${key}`, fields, { 'If-Unmodified-Since-Version': String(current?.version ?? 0) });
    if (res.status === 409 && attempt === 0) {
      tasks.set(key, (await res.json()).current);
      continue;
    }
    if (!res.ok) throw new Error((await res.json()).error ?? '保存失败');
    const t = await res.json();
    tasks.set(key, t);
    return t;
  }
}

const run = (p) => p.then(render, (e) => ((error = String(e.message ?? e)), render()));

// ---- dates ----

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function dueLabel(t) {
  if (!t.due) return '';
  const [y, m, d] = t.due.slice(0, 10).split('-').map(Number);
  const day = new Date(y, m - 1, d);
  const now = new Date();
  const diff = Math.round((day - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  const label = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === -1 ? '昨天' : diff > 1 && diff < 7 ? WEEKDAYS[day.getDay()] : `${m}月${d}日`;
  return t.due.length > 10 ? `${label} ${t.due.slice(11, 16)}` : label;
}

const isOverdue = (t) => !!t.due && !t.done && (t.due.length > 10 ? new Date(t.due) < new Date() : t.due < dayKey(new Date()));
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.dateAdded.localeCompare(b.dateAdded);
const PRIORITY = ['var(--muted)', '#4a9eff', '#e5a33b', '#ef6b6b'];

// ---- view ----

/** Element helper: h('div', { class: 'x', onclick }, ...children). */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

function login() {
  const input = h('input', { type: 'password', placeholder: '同步服务器的访问令牌（GLEEOK_TOKEN）', autocomplete: 'off' });
  const go = () => {
    token = input.value.trim();
    if (!token) return;
    localStorage.setItem(TOKEN_KEY, token);
    void sync();
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  return h(
    'div',
    { class: 'login' },
    h('img', { src: 'icon-192.png', alt: '' }),
    h('h1', {}, 'Gleeok 日程'),
    h('p', { class: 'muted' }, '在电脑上的 Gleeok「设置 → 日程」里复制手机登录链接，在这里打开即可；也可以直接输入令牌。'),
    input,
    h('button', { class: 'primary', onclick: go }, '登录'),
    error && h('p', { class: 'error' }, error),
  );
}

function taskRow(t) {
  const subs = t.subtasks ?? [];
  return h(
    'div',
    { class: `task ${t.done ? 'done' : ''}`, onclick: () => ((openTask = t.key), render()) },
    h(
      'button',
      {
        class: 'check',
        style: `border-color:${PRIORITY[t.priority ?? 0]}`,
        onclick: (e) => {
          e.stopPropagation();
          run(patch(t.key, t.done ? { done: null, doneAt: null } : { done: true, doneAt: new Date().toISOString() }));
        },
      },
      t.done ? '✓' : '',
    ),
    h('span', { class: 'title' }, t.title || '（无标题）'),
    subs.length > 0 && h('span', { class: 'muted small' }, `${subs.filter((s) => s.done).length}/${subs.length}`),
    t.projectId && h('span', { class: 'chip' }, projects.get(t.projectId) ?? '项目'),
    t.due && h('span', { class: `due ${isOverdue(t) ? 'late' : ''}` }, dueLabel(t)),
  );
}

function agenda() {
  const today = dayKey(new Date());
  const list = [...blocks.values()].filter((b) => dayKey(new Date(b.start)) === today).sort((a, b) => a.start.localeCompare(b.start));
  if (list.length === 0) return null;
  const now = Date.now();
  const rows = [];
  let marked = false;
  for (const b of list) {
    if (!marked && Date.parse(b.start) > now) {
      rows.push(h('div', { class: 'now' }, h('span', {}, hhmm(new Date()))));
      marked = true;
    }
    const t = b.taskKey ? tasks.get(b.taskKey) : null;
    const live = Date.parse(b.start) <= now && Date.parse(b.end) > now;
    rows.push(
      h(
        'div',
        { class: `block ${live ? 'live' : ''} ${t ? '' : 'free'} ${t?.done ? 'done' : ''}`, onclick: () => t && ((openTask = t.key), render()) },
        h('span', { class: 'time' }, `${hhmm(new Date(b.start))}–${hhmm(new Date(b.end))}`),
        h('span', { class: 'title' }, t ? t.title : (b.title ?? '')),
      ),
    );
  }
  if (!marked) rows.push(h('div', { class: 'now' }, h('span', {}, hhmm(new Date()))));
  return h('section', {}, h('h2', {}, '今天的安排'), ...rows);
}

function sections() {
  const live = [...tasks.values()].filter((t) => !t.deleted);
  const open = live.filter((t) => !t.done).sort(byOrder);
  const today = dayKey(new Date());
  const tomorrow = dayKey(new Date(Date.now() + 86400000));
  const day = (t) => t.due?.slice(0, 10);
  if (tab === 'today') {
    const scheduled = new Set([...blocks.values()].filter((b) => b.taskKey && dayKey(new Date(b.start)) === today).map((b) => b.taskKey));
    const mine = open.filter((t) => (day(t) ?? '9') <= today || scheduled.has(t.key));
    return [
      ['已过期', mine.filter((t) => day(t) && day(t) < today)],
      ['今天', mine.filter((t) => !(day(t) && day(t) < today))],
    ];
  }
  if (tab === 'inbox') return [['', open.filter((t) => !t.projectId)]];
  if (tab === 'all')
    return [
      ['已过期', open.filter((t) => day(t) && day(t) < today)],
      ['今天', open.filter((t) => day(t) === today)],
      ['明天', open.filter((t) => day(t) === tomorrow)],
      ['之后', open.filter((t) => day(t) && day(t) > tomorrow)],
      ['没有日期', open.filter((t) => !day(t))],
    ];
  return [['', live.filter((t) => t.done).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '')).slice(0, 100)]];
}

function detail(t) {
  const field = (label, ...control) => h('label', { class: 'field' }, h('span', {}, label), ...control);
  const day = t.due?.slice(0, 10) ?? '';
  const time = t.due && t.due.length > 10 ? t.due.slice(11, 16) : '';
  const setDue = (d, tm) => run(patch(t.key, { due: d ? (tm ? `${d}T${tm}` : d) : null }));
  const title = h('input', { class: 'detail-title', value: t.title });
  title.addEventListener('change', () => run(patch(t.key, { title: title.value })));
  const date = h('input', { type: 'date', value: day });
  date.addEventListener('change', () => setDue(date.value, time));
  const clock = h('input', { type: 'time', value: time, disabled: !day });
  clock.addEventListener('change', () => setDue(day, clock.value));
  const notes = h('textarea', { rows: 5, placeholder: '备注' });
  notes.value = t.notes ?? '';
  notes.addEventListener('change', () => run(patch(t.key, { notes: notes.value || null })));
  const subs = t.subtasks ?? [];
  const addSub = h('input', { placeholder: '+ 子任务' });
  addSub.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !addSub.value.trim()) return;
    run(patch(t.key, { subtasks: [...subs, { id: Math.random().toString(36).slice(2, 10), title: addSub.value.trim(), done: false }] }));
  });
  return h(
    'div',
    { class: 'sheet-bg', onclick: (e) => e.target === e.currentTarget && ((openTask = null), render()) },
    h(
      'div',
      { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('button', { class: 'link', onclick: () => ((openTask = null), render()) }, '完成编辑')),
      title,
      field(
        '状态',
        h(
          'button',
          { class: t.done ? '' : 'primary', onclick: () => run(patch(t.key, t.done ? { done: null, doneAt: null } : { done: true, doneAt: new Date().toISOString() })) },
          t.done ? '标为未完成' : '完成',
        ),
      ),
      field('截止', date, clock),
      field(
        '优先级',
        h(
          'div',
          { class: 'seg' },
          ['无', '低', '中', '高'].map((label, p) =>
            h('button', { class: (t.priority ?? 0) === p ? 'on' : '', style: (t.priority ?? 0) === p && p ? `color:${PRIORITY[p]}` : '', onclick: () => run(patch(t.key, { priority: p || null })) }, label),
          ),
        ),
      ),
      t.projectId && field('项目', h('span', {}, projects.get(t.projectId) ?? '项目')),
      h('h3', {}, '子任务'),
      ...subs.map((s) =>
        h(
          'label',
          { class: `sub ${s.done ? 'done' : ''}` },
          h('input', {
            type: 'checkbox',
            checked: s.done,
            onchange: () => run(patch(t.key, { subtasks: subs.map((x) => (x.id === s.id ? { ...x, done: !x.done } : x)) })),
          }),
          s.title,
        ),
      ),
      addSub,
      h('h3', {}, '备注'),
      notes,
      h('button', { class: 'danger', onclick: () => ((openTask = null), run(patch(t.key, { deleted: true }))) }, '移到回收站'),
    ),
  );
}

function render() {
  app.replaceChildren();
  if (!token) return app.append(login());
  const now = new Date();
  const tabs = [
    ['today', '今天'],
    ['inbox', '收件箱'],
    ['all', '全部'],
    ['done', '已完成'],
  ];
  const quick = h('input', { class: 'quick', placeholder: tab === 'today' ? '+ 添加今天的任务' : '+ 添加任务', enterkeyhint: 'done' });
  quick.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !quick.value.trim()) return;
    const top = Math.min(0, ...[...tasks.values()].map((t) => t.order ?? 0)) - 1;
    run(create({ title: quick.value.trim(), order: top, ...(tab === 'today' ? { due: dayKey(new Date()) } : {}) }));
  });
  app.append(
    h(
      'header',
      {},
      h('div', { class: 'date' }, h('strong', {}, `${now.getMonth() + 1}月${now.getDate()}日`), ` ${WEEKDAYS[now.getDay()]}`),
      h(
        'nav',
        {},
        tabs.map(([id, label]) => h('button', { class: tab === id ? 'on' : '', onclick: () => ((tab = id), localStorage.setItem('gleeok.tab', id), render()) }, label)),
      ),
    ),
    h(
      'main',
      {},
      error && h('p', { class: 'error' }, error),
      tab === 'today' && agenda(),
      ...sections()
        .filter(([, list]) => list.length)
        .map(([title, list]) => h('section', {}, title && h('h2', {}, `${title} `, h('span', { class: 'muted' }, list.length)), ...list.map(taskRow))),
      sections().every(([, list]) => list.length === 0) && h('p', { class: 'empty muted' }, '没有任务'),
    ),
    tab !== 'done' && h('footer', {}, quick),
  );
  const t = openTask && tasks.get(openTask);
  if (t) app.append(detail(t));
}

render();
if (token) void sync();
setInterval(() => token && !openTask && void sync(), 30_000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && token && void sync());
