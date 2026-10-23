import { useEffect, useMemo, useRef, useState } from 'react';
import type { Action, LibrarySnapshot, Snapshot } from '../../../shared/src/ipc.ts';
import { LIBRARY_URL, NEW_TAB_URL, codeLinks, isCodeLink, paneName, primaryCodeLink, type Project } from '../../../shared/src/model.ts';
import { faviconFor } from './Panes.tsx';
import { creatorsShort, isRegular, publicationOf, useLibrary, yearOf } from './library/data.ts';

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

  const library = useLibrary();
  const items = useMemo(() => [...buildItems(snap), ...libraryItems(library)], [snap, library]);
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

/** 文献库 papers: Enter reads the PDF (or opens the library when there is none). */
function libraryItems(lib: LibrarySnapshot | null): Item[] {
  if (!lib) return [];
  const pdfOf = new Map<string, string>();
  for (const a of lib.items) if (a.itemType === 'attachment' && a.parentItem && a.fileHash && !pdfOf.has(a.parentItem)) pdfOf.set(a.parentItem, a.key);
  return lib.items
    .filter((i) => isRegular(i) && !i.deleted)
    .map((i) => {
      const pdf = pdfOf.get(i.key);
      return {
        id: `lib:${i.key}`,
        group: '文献库',
        title: String(i.title || '（无标题）'),
        detail: [creatorsShort(i), yearOf(i), publicationOf(i), pdf ? '' : '没有 PDF'].filter(Boolean).join(' · '),
        run: pdf ? [{ type: 'openReader', attachment: pdf }] : [{ type: 'setView', view: 'library' }],
      };
    });
}

function buildItems(snap: Snapshot): Item[] {
  const items: Item[] = [];
  const current = snap.projects.find((p) => p.id === snap.state.currentProjectId);
  const session = current && snap.state.sessions[current.id];

  // Open tabs of the current project first: switching between them is the most common jump.
  if (session) {
    session.panes.forEach((pane, slot) => {
      if (slot >= snap.state.paneNames.length) return;
      for (const t of pane.tabs) {
        if (t.url === NEW_TAB_URL) continue;
        items.push({
          id: `tab:${t.id}`,
          group: `标签 · ${paneName(snap.state.paneNames, slot)}`,
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
    const primary = primaryCodeLink(p);
    for (const l of p.links) {
      if (isCodeLink(l)) {
        items.push({
          id: `code:${p.id}:${l.id}`,
          group: p === current ? '代码' : `代码 · ${p.name}`,
          title: `${l === primary ? '★ ' : ''}${l.label || l.url}`,
          detail: l.url,
          icon: l.icon ?? faviconFor(l.url),
          run: [{ type: 'openCode', projectId: p.id, linkId: l.id }],
        });
        continue;
      }
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
    ...Array.from({ length: Math.max(0, main.slots.length - 1) }, (_, i) => i + 2).map((n) =>
      c(`panes${n}`, `${n} 栏布局`, [{ type: 'setVisiblePanes', count: n }]),
    ),
    c('panes', '设置栏数和栏名', [{ type: 'setView', view: 'settings' }]),
    c('library', snap.state.view === 'library' ? '关闭文献库' : '打开文献库', [{ type: 'toggleLibrary' }]),
    c('libraryPane', '在焦点栏打开文献库', [{ type: 'newTab', url: LIBRARY_URL }]),
    c('focus', main.layout.focusExpand ? '关闭焦点放大' : '打开焦点放大', [{ type: 'toggleFocusExpand' }]),
    c('sidebar', main.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏', [{ type: 'toggleSidebar' }]),
    c('detach', '把焦点栏拆到新窗口 / 合并回主窗口', [{ type: 'togglePaneWindow' }]),
    c('newtab', '在焦点栏新建标签', [{ type: 'newTab' }]),
    c('reopen', '恢复刚关闭的标签', [{ type: 'reopenTab' }]),
    c('save', '把当前页面存进项目链接', [{ type: 'openSaveLink' }]),
    c('settings', '设置（Paseo 导入、同步、密码库）', [{ type: 'setView', view: 'settings' }]),
    c('import', '从 Paseo 导入项目', [{ type: 'setView', view: 'settings' }]),
    ...(snap.canSelfUpdate
      ? [
          c('update', '更新 Gleeok（拉取最新代码、构建并重启）', [{ type: 'selfUpdate' }]),
          c('checkUpdate', '检查 Gleeok 有没有更新', [{ type: 'checkUpdate' }]),
        ]
      : []),
    c('vaultFill', '填写这个网站的账号密码', [{ type: 'vaultFill' }], snap.platform === 'darwin' ? '⌘⇧L' : 'Ctrl+Shift+L'),
    c('vaultSave', '把这个网站的账号存进密码库', [{ type: 'vaultSaveDialog' }]),
    ...(snap.vault.unlocked ? [c('vaultLock', '锁定密码库', [{ type: 'vaultLock' }])] : []),
  ];
  if (current) {
    const live = snap.live.includes(current.id);
    out.push(
      c('entry', `打开「${current.name}」的项目设置`, [{ type: 'toggleEntry' }]),
      live
        ? c('sleep', `休眠「${current.name}」`, [{ type: 'hibernate', id: current.id }])
        : c('start', `启动「${current.name}」`, [{ type: 'startProject', id: current.id }]),
      c('archive', `存档「${current.name}」`, [{ type: 'archiveProject', id: current.id, archived: true }]),
      c('adopt', `把「${current.name}」换成另一台电脑上的标签`, [{ type: 'adoptRemoteTabs', projectId: current.id }]),
    );
    const primary = primaryCodeLink(current);
    if (primary) {
      out.push(c('code', `打开「${current.name}」的代码`, [{ type: 'openCode' }], snap.platform === 'darwin' ? '⌘⌥C' : 'Ctrl+Alt+C'));
      for (const l of codeLinks(current).filter((x) => x !== primary)) {
        out.push(c(`primary:${l.id}`, `把「${l.label || l.url}」设为主要代码链接`, [{ type: 'setPrimaryCode', projectId: current.id, linkId: l.id }]));
      }
    }
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
