import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../shared/src/ipc.ts';
import {
  isCodeLink,
  isManagedLink,
  paneName,
  parseTerminalUrl,
  primaryCodeLink,
  terminalUrl,
  type Link,
  type Project,
  type TerminalTarget,
} from '../../../shared/src/model.ts';
import { faviconFor } from './Panes.tsx';

const newId = () => `l_${crypto.randomUUID().slice(0, 8)}`;
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
/** What gets saved: blank rows are still being typed, so they stay local. */
const savable = (p: Project, fallbackName: string): Project => ({
  ...p,
  name: p.name.trim() || fallbackName,
  links: p.links.filter((l) => l.url.trim()),
});
const sameContent = (a: Project, b: Project) => a.name === b.name && JSON.stringify(a.links) === JSON.stringify(b.links);

/**
 * A project's links and settings in a drawer over the pages (which show as screenshots meanwhile).
 * Every change saves itself after a short pause; a deleted link can be brought back.
 */
export function EntryDrawer({ project, snap, onClose }: { project: Project; snap: Snapshot; onClose: () => void }) {
  const [draft, setDraft] = useState<Project>(project);
  const [status, setStatus] = useState('');
  const [removed, setRemoved] = useState<{ link: Link; index: number } | null>(null);
  const saved = useRef(project);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  async function saveNow(next: Project) {
    clearTimeout(timer.current);
    const out = savable(next, saved.current.name);
    if (sameContent(out, saved.current)) return;
    setStatus('保存中…');
    try {
      saved.current = await gleeok.saveProject({ ...out, version: saved.current.version });
      setStatus('已保存');
    } catch (e) {
      const msg = String(e);
      setStatus(/已在别处被修改/.test(msg) ? '别处同时改了这个项目，已换成最新版本' : `保存失败：${msg.slice(0, 80)}`);
      void gleeok.refreshProjects();
    }
  }

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveNow(draft), 500);
    return () => clearTimeout(timer.current);
  }, [draft]);

  // Changes from elsewhere (another machine, the Paseo sync) replace the draft.
  useEffect(() => {
    if (project.version > saved.current.version) {
      saved.current = project;
      setDraft(project);
    }
  }, [project.version]);

  async function close() {
    await saveNow(draft);
    onClose();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && void close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const setLink = (id: string, patch: Partial<Link>) =>
    setDraft((d) => ({ ...d, links: d.links.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
  const add = (link: Link) => setDraft((d) => ({ ...d, links: [...d.links, link] }));
  function remove(link: Link) {
    setRemoved({ link, index: draft.links.indexOf(link) });
    setDraft((d) => ({ ...d, links: d.links.filter((l) => l.id !== link.id) }));
  }
  function undo() {
    if (!removed) return;
    setDraft((d) => {
      const links = [...d.links];
      links.splice(Math.min(removed.index, links.length), 0, removed.link);
      return { ...d, links };
    });
    setRemoved(null);
  }
  useEffect(() => {
    if (!removed) return;
    const t = setTimeout(() => setRemoved(null), 8000);
    return () => clearTimeout(t);
  }, [removed]);

  const makePrimary = (id: string) =>
    setDraft((d) => ({
      ...d,
      links: d.links.map((l) => {
        if (!isCodeLink(l)) return l;
        const { primary: _, ...rest } = l;
        return l.id === id ? { ...rest, primary: true } : rest;
      }),
    }));

  const open = (url: string) => {
    void close();
    gleeok.dispatch({ type: 'openLink', url, newTab: true });
  };

  const code = draft.links.filter(isCodeLink);
  const terms = draft.links.filter((l) => l.kind === 'terminal');
  const own = draft.links.filter((l) => !l.kind);
  const auto = draft.links.filter((l) => isManagedLink(l) && !isCodeLink(l));
  const primary = primaryCodeLink(draft);
  const daemon = snap.paseo.find((d) => d.serverId === project.paseo?.daemonId);
  const live = snap.live.includes(project.id);

  // A new terminal starts where the project's code is: over ssh on its Paseo machine (or here,
  // if that is this machine), in the latest workspace's directory.
  function addTerminal() {
    const host = daemon && daemon.hostname.split('.')[0].toLowerCase() !== snap.hostname.split('.')[0].toLowerCase() ? daemon.hostname : '';
    const source = daemon?.projects.find((p) => p.projectId === project.paseo?.projectId);
    const cwd = project.paseo ? source?.latest?.dir || project.paseo.cwd : '';
    const label = `终端 · ${host || '本机'}`;
    add({ id: newId(), label, url: terminalUrl({ host, cwd, name: label }), kind: 'terminal' });
  }
  const setTerminal = (l: Link, patch: TerminalTarget & { label?: string }) => {
    const t = { ...parseTerminalUrl(l.url), name: l.label, ...patch };
    if (patch.label !== undefined) t.name = patch.label;
    setLink(l.id, { label: patch.label ?? l.label, url: terminalUrl(t) });
  };
  const hosts = [...new Set(snap.paseo.map((d) => d.hostname))];

  const termRow = (l: Link) => {
    const t = parseTerminalUrl(l.url);
    return (
      <div key={l.id} className="link-row">
        <button className="favicon" onClick={() => open(l.url)} title="打开终端">
          <img src={faviconFor(l.url)} alt="" />
        </button>
        <div className="link-text">
          <input className="link-label" value={l.label} placeholder="名称" onChange={(e) => setTerminal(l, { label: e.target.value })} />
          <div className="term-target">
            <input
              list="gleeok-hosts"
              value={t.host ?? ''}
              placeholder="本机"
              title="ssh 的目标（主机名或 ~/.ssh/config 里的别名）；留空就是这台电脑"
              onChange={(e) => setTerminal(l, { host: e.target.value })}
            />
            <input value={t.cwd ?? ''} placeholder="~（目录）" title="打开时所在的目录" onChange={(e) => setTerminal(l, { cwd: e.target.value })} />
          </div>
        </div>
        <span className="star" />
        <select
          className="chip"
          value={l.pinnedPane ?? ''}
          onChange={(e) => setLink(l.id, { pinnedPane: e.target.value === '' ? undefined : Number(e.target.value) })}
          title="在一台电脑上第一次打开这个项目时，自动在哪一栏打开"
        >
          <option value="">不自动打开</option>
          {snap.state.paneNames.map((_, p) => (
            <option key={p} value={p}>
              {paneName(snap.state.paneNames, p)}
            </option>
          ))}
        </select>
        <button className="remove icon-btn" onClick={() => remove(l)} title="删除">
          ×
        </button>
      </div>
    );
  };

  const row = (l: Link) => {
    const managed = isManagedLink(l);
    return (
      <div key={l.id} className={`link-row ${managed ? 'managed' : ''}`}>
        <button className="favicon" onClick={() => l.url && open(l.url)} title={l.url ? `打开 ${l.url}` : ''}>
          <img src={l.icon ?? faviconFor(l.url)} alt="" />
        </button>
        <div className="link-text">
          <input className="link-label" value={l.label} placeholder={hostOf(l.url) || '名称'} onChange={(e) => setLink(l.id, { label: e.target.value })} />
          {managed ? (
            <span className="link-url" title="自动维护，不用手动改">
              {l.url}
            </span>
          ) : (
            <input
              className="link-url"
              value={l.url}
              autoFocus={!l.url}
              placeholder={l.kind === 'code' ? 'https://code-server 地址/?folder=/项目路径' : '粘贴网址'}
              onChange={(e) => setLink(l.id, { url: e.target.value })}
            />
          )}
        </div>
        {isCodeLink(l) && (
          <button className={`star ${l === primary ? 'on' : ''}`} onClick={() => makePrimary(l.id)} title={l === primary ? '主要代码链接（</> 按钮打开它）' : '设为主要代码链接'}>
            {l === primary ? '★' : '☆'}
          </button>
        )}
        <select
          className="chip"
          value={l.pinnedPane ?? ''}
          onChange={(e) => setLink(l.id, { pinnedPane: e.target.value === '' ? undefined : Number(e.target.value) })}
          title="在一台电脑上第一次打开这个项目时，自动在哪一栏打开"
        >
          <option value="">不自动打开</option>
          {snap.state.paneNames.map((_, p) => (
            <option key={p} value={p}>
              {paneName(snap.state.paneNames, p)}
            </option>
          ))}
        </select>
        {managed ? (
          <span className="remove" />
        ) : (
          <button className="remove icon-btn" onClick={() => remove(l)} title="删除">
            ×
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="drawer-backdrop" onMouseDown={() => void close()}>
      <aside className="drawer" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <input className="drawer-title" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <button className="icon-btn" onClick={() => void close()} title="关闭（Esc）">
            ×
          </button>
        </header>
        <p className="drawer-meta">
          {project.paseo ? `Paseo · ${daemon?.hostname ?? project.paseo.daemonId} · ${project.paseo.cwd}` : '手动创建'}
          {live && ` · 运行中${snap.memory[project.id] ? ` ${snap.memory[project.id]} MB` : ''}`}
        </p>

        {code.length > 0 && (
          <section>
            <h4>代码</h4>
            {code.map(row)}
          </section>
        )}
        {terms.length > 0 && (
          <section>
            <h4>终端</h4>
            {terms.map(termRow)}
            <datalist id="gleeok-hosts">
              {hosts.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
          </section>
        )}
        <section>
          <h4>链接</h4>
          {own.length === 0 && <p className="hint">还没有链接。粘贴网址添加，或者在网页上按 ☆ 存进来。</p>}
          {own.map(row)}
          <div className="drawer-add">
            <button onClick={() => add({ id: newId(), label: '', url: '' })}>+ 链接</button>
            <button onClick={() => add({ id: newId(), label: '代码', url: '', kind: 'code' })} title="code-server、vscode.dev 等网页编辑器">
              + 代码链接
            </button>
            <button onClick={addTerminal} title="本机或其他机器（ssh）上的终端，在新标签页里打开">
              + 终端
            </button>
          </div>
        </section>
        {auto.length > 0 && (
          <section>
            <h4>自动维护</h4>
            {auto.map(row)}
          </section>
        )}

        <footer>
          {removed ? (
            <span className="undo">
              已删除「{removed.link.label || hostOf(removed.link.url)}」
              <button onClick={undo}>撤销</button>
            </span>
          ) : (
            <span className="meta">{status || '改动会自动保存'}</span>
          )}
          <span className="spacer" />
          <button
            onClick={() => {
              onClose();
              gleeok.dispatch({ type: 'archiveProject', id: project.id, archived: true });
            }}
          >
            存档
          </button>
          <button
            className="danger"
            onClick={async () => {
              if (confirm(`删除项目「${project.name}」？只删除 Gleeok 里的配置，不影响 Paseo。`)) {
                onClose();
                await gleeok.deleteProject(project.id);
              }
            }}
          >
            删除项目
          </button>
        </footer>
      </aside>
    </div>
  );
}
