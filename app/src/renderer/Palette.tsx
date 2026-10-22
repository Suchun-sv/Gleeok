import { useEffect, useMemo, useRef, useState } from 'react';
import type { Action, Snapshot } from '../../../shared/src/ipc.ts';
import { NEW_TAB_URL, type Project } from '../../../shared/src/model.ts';
import { faviconFor } from './Panes.tsx';

interface Item {
  id: string;
  group: string;
  title: string;
  detail?: string;
  icon?: string;
  /** Actions run in order once the palette has closed and pages are back. */
  run: Action[];
}

/**
 * Command palette: one box to reach projects, links, open tabs and commands. Pages are hidden
 * behind screenshots while it is open (native page views would cover it otherwise).
 */
export function Palette({ snap, winId, onClose }: { snap: Snapshot; winId: string; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => input.current?.focus(), []);

  const items = useMemo(() => buildItems(snap), [snap]);
  const results = useMemo(() => search(items, query), [items, query]);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  function close(run: Action[] = []) {
    gleeok.dispatch({ type: 'closePalette', winId });
    for (const a of run) gleeok.dispatch(a);
    onClose();
  }

  return (
    <div className="palette-backdrop" onMouseDown={() => close()}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={query}
          placeholder="搜索项目、链接、标签、命令，或输入网址"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, results.length - 1));
            }
            if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            }
            if (e.key === 'Enter' && results[index]) close(results[index].run);
          }}
        />
        <div className="palette-list" ref={list}>
          {results.length === 0 && <div className="palette-empty">没有匹配的结果</div>}
          {results.map((it, i) => (
            <div
              key={it.id}
              className={`palette-item ${i === index ? 'active' : ''}`}
              onMouseMove={() => setIndex(i)}
              onClick={() => close(it.run)}
            >
              <span className="icon">{it.icon ? <img src={it.icon} alt="" /> : null}</span>
              <span className="title">{it.title}</span>
              {it.detail && <span className="detail">{it.detail}</span>}
              <span className="group">{it.group}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function buildItems(snap: Snapshot): Item[] {
  const items: Item[] = [];
  const current = snap.projects.find((p) => p.id === snap.state.currentProjectId);
  const session = current && snap.state.sessions[current.id];

  // Open tabs of the current project first: switching between them is the most common jump.
  if (session) {
    session.panes.forEach((pane, slot) => {
      for (const t of pane.tabs) {
        if (t.url === NEW_TAB_URL) continue;
        items.push({
          id: `tab:${t.id}`,
          group: `标签 · 第${slot + 1}栏`,
          title: t.title || t.url,
          detail: t.url,
          icon: t.favicon ?? faviconFor(t.url),
          run: [{ type: 'activateTab', slot, tabId: t.id }],
        });
      }
    });
  }

  for (const p of snap.projects) {
    items.push({
      id: `project:${p.id}`,
      group: snap.live.includes(p.id) ? '项目 · 运行中' : '项目',
      title: p.name,
      detail: p.paseo?.cwd,
      run: [{ type: 'selectProject', id: p.id }],
    });
  }
  for (const p of snap.archivedProjects) {
    items.push({
      id: `archived:${p.id}`,
      group: '已存档项目',
      title: p.name,
      detail: '取消存档并打开',
      run: [{ type: 'archiveProject', id: p.id, archived: false, open: true }],
    });
  }

  // Links: the current project's open in place; another project's switch to it first.
  const linkOwners = current ? [current, ...snap.projects.filter((p) => p !== current)] : snap.projects;
  for (const p of linkOwners) {
    for (const l of p.links) {
      items.push({
        id: `link:${p.id}:${l.id}`,
        group: p === current ? '链接' : `链接 · ${p.name}`,
        title: l.label || l.url,
        detail: l.url,
        icon: l.icon ?? faviconFor(l.url),
        run:
          p === current
            ? [{ type: 'openLink', url: l.url, newTab: true }]
            : [{ type: 'selectProject', id: p.id }, { type: 'openLink', url: l.url, newTab: true }],
      });
    }
  }

  // Password-vault entries (names and addresses only; passwords stay in main): open what was
  // saved, e.g. a pairing link, or copy a field to the clipboard.
  for (const e of snap.vault.entries) {
    for (const [i, url] of e.urls.entries()) {
      const icon = faviconFor(url);
      items.push(
        { id: `vault:${e.id}:${i}`, group: '密码库 · 打开', title: e.name, detail: url, icon, run: [{ type: 'openLink', url, newTab: true }] },
        {
          id: `vault-url:${e.id}:${i}`,
          group: '密码库 · 复制网址',
          title: e.name,
          detail: url,
          icon,
          run: [{ type: 'vaultCopy', id: e.id, what: 'url', index: i }],
        },
      );
    }
    if (e.username) {
      items.push({
        id: `vault-user:${e.id}`,
        group: '密码库 · 复制用户名',
        title: e.name,
        detail: e.username,
        run: [{ type: 'vaultCopy', id: e.id, what: 'username' }],
      });
    }
    if (e.hasPassword) {
      items.push({
        id: `vault-pw:${e.id}`,
        group: '密码库 · 复制密码',
        title: e.name,
        detail: e.username || undefined,
        run: [{ type: 'vaultCopy', id: e.id, what: 'password' }],
      });
    }
  }

  items.push(...commands(snap, current));
  return items;
}

function commands(snap: Snapshot, current?: Project): Item[] {
  const main = snap.state.windows.find((w) => w.role === 'main')!;
  const c = (id: string, title: string, run: Action[], detail?: string): Item => ({ id: `cmd:${id}`, group: '命令', title, detail, run });
  const out = [
    c('three', '三栏布局', [{ type: 'setLayoutMode', mode: 'three' }]),
    c('two', '二栏布局', [{ type: 'setLayoutMode', mode: 'two' }]),
    c('focus', main.layout.focusExpand ? '关闭焦点放大' : '打开焦点放大', [{ type: 'toggleFocusExpand' }]),
    c('sidebar', main.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏', [{ type: 'toggleSidebar' }]),
    c('detach', '把焦点栏拆到新窗口 / 合并回主窗口', [{ type: 'togglePaneWindow' }]),
    c('newtab', '在焦点栏新建标签', [{ type: 'newTab' }]),
    c('reopen', '恢复刚关闭的标签', [{ type: 'reopenTab' }]),
    c('save', '把当前页面存进项目链接', [{ type: 'openSaveLink' }]),
    c('import', '从 Paseo 导入项目', [{ type: 'setView', view: 'import' }]),
    c('vaultFill', '填写这个网站的账号密码', [{ type: 'vaultFill' }], snap.platform === 'darwin' ? '⌘⇧L' : 'Ctrl+Shift+L'),
    c('vaultSave', '把这个网站的账号存进密码库', [{ type: 'vaultSaveDialog' }]),
    ...(snap.vault.unlocked ? [c('vaultLock', '锁定密码库', [{ type: 'vaultLock' }])] : []),
  ];
  if (current) {
    const live = snap.live.includes(current.id);
    out.push(
      c('entry', `打开「${current.name}」的入口页`, [{ type: 'setView', view: 'entry' }]),
      live
        ? c('sleep', `休眠「${current.name}」`, [{ type: 'hibernate', id: current.id }])
        : c('start', `启动「${current.name}」`, [{ type: 'startProject', id: current.id }]),
      c('archive', `存档「${current.name}」`, [{ type: 'archiveProject', id: current.id, archived: true }]),
      c('adopt', `把「${current.name}」换成另一台电脑上的标签`, [{ type: 'adoptRemoteTabs', projectId: current.id }]),
    );
  }
  return out;
}

/** Every query word must appear (in order of preference: title start, title, detail, group). */
function search(items: Item[], query: string): Item[] {
  const q = query.trim();
  if (!q) return items.slice(0, 50);
  const words = q.toLowerCase().split(/\s+/);
  const scored: { it: Item; score: number }[] = [];
  for (const it of items) {
    const title = it.title.toLowerCase();
    const rest = `${it.detail ?? ''} ${it.group}`.toLowerCase();
    let score = 0;
    let ok = true;
    for (const w of words) {
      if (title.startsWith(w)) score += 4;
      else if (title.includes(w)) score += 3;
      else if (rest.includes(w)) score += 1;
      else ok = false;
    }
    if (ok) scored.push({ it, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = scored.slice(0, 50).map((s) => s.it);

  // Typed something that is not (only) a known item: offer to open or search it.
  const looksLikeUrl = /^https?:\/\//i.test(q) || /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/\S*)?$/i.test(q);
  out.push({
    id: 'go',
    group: looksLikeUrl ? '打开网址' : '搜索',
    title: looksLikeUrl ? q : `用 Google 搜索“${q}”`,
    run: [{ type: 'openLink', url: q, newTab: true }],
  });
  if (looksLikeUrl) out.unshift(out.pop()!);
  return out;
}
