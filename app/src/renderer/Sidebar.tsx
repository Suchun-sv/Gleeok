import { useState } from 'react';
import type { Snapshot } from '../../../shared/src/ipc.ts';
import { primaryCodeLink } from '../../../shared/src/model.ts';
import icon from '../../assets/icon-64.png';
import { IconButton } from './Icons.tsx';

/** Same glyph as Paseo's sidebar toggle: lucide "panel-left". */
export function SidebarToggle({ platform }: { platform: string }) {
  const keys = platform === 'darwin' ? '⌘⌥B' : 'Ctrl+Alt+B';
  return (
    <button className="sidebar-toggle" onClick={() => gleeok.dispatch({ type: 'toggleSidebar' })} title={`切换侧边栏 (${keys})`}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M9 3v18" />
      </svg>
    </button>
  );
}

export function Sidebar({ snap }: { snap: Snapshot }) {
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState('');
  const { state, server } = snap;
  const mod = snap.platform === 'darwin' ? '⌘⌥' : 'Ctrl+Alt+';

  async function create() {
    if (!name.trim()) return;
    await gleeok.createProject(name.trim());
    setName('');
    setAdding(false);
  }

  return (
    <aside className="sidebar">
      <header>
        <span className="brand">
          <img src={icon} alt="" />
          Gleeok
        </span>
        <span className="spacer" />
        <span
          className={`dot ${server.status}`}
          title={
            server.status === 'local'
              ? '本地模式：数据只存在这台电脑上（配置 ~/.config/gleeok/client.json 可连接同步服务器）'
              : `${server.status}${server.url ? ` · ${server.url}` : ''}${server.error ? `\n${server.error}` : ''}`
          }
          onClick={() => void gleeok.refreshProjects()}
        />
        <button
          className="sidebar-toggle"
          onClick={() => gleeok.dispatch({ type: 'openPalette' })}
          title={`命令面板（${snap.platform === 'darwin' ? '⌘⇧K' : 'Ctrl+Shift+K'}）`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-4-4" />
          </svg>
        </button>
        <SidebarToggle platform={snap.platform} />
      </header>

      <nav>
        {snap.projects.map((p, i) => {
          const live = snap.live.includes(p.id);
          const mb = snap.memory[p.id];
          const code = primaryCodeLink(p);
          const menu = (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            gleeok.dispatch({ type: 'projectMenu', id: p.id });
          };
          return (
            <div
              key={p.id}
              role="button"
              className={`project ${p.id === state.currentProjectId ? 'active' : ''}`}
              onClick={() => gleeok.dispatch({ type: 'selectProject', id: p.id })}
              onDoubleClick={() => gleeok.dispatch({ type: 'toggleEntry' })}
              onContextMenu={menu}
              title={`${p.name}\n${live ? `运行中${mb ? ` · ${mb} MB` : ''}` : '已休眠'}\n双击打开入口页，右键更多操作`}
            >
              <span className="status">{live && <span className="dot-live" />}</span>
              <span className="name">{p.name}</span>
              {live && mb ? <span className="mem">{mb} MB</span> : null}
              {code && (
                <button
                  className="code-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    gleeok.dispatch({ type: 'openCode', projectId: p.id });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    gleeok.dispatch({ type: 'codeMenu', projectId: p.id });
                  }}
                  title={`在草稿区打开代码：${code.label || code.url}（${mod}C）\n右键：其他代码链接、设为主要`}
                >
                  {'</>'}
                </button>
              )}
              <button className="kebab" onClick={menu} title="更多操作">
                ⋯
              </button>
              {i < 9 && <kbd>{i + 1}</kbd>}
            </div>
          );
        })}
        {adding ? (
          <input
            autoFocus
            className="new-project"
            placeholder="项目名，回车创建"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
              if (e.key === 'Escape') setAdding(false);
            }}
            onBlur={() => setAdding(false)}
          />
        ) : (
          <button className="project add" onClick={() => setAdding(true)} disabled={server.status !== 'ok'}>
            + 新项目
          </button>
        )}
        {snap.archivedProjects.length > 0 && (
          <div className="archived">
            <button className="archived-toggle" onClick={() => setShowArchived(!showArchived)}>
              {showArchived ? '▾' : '▸'} 已存档 {snap.archivedProjects.length}
            </button>
            {showArchived &&
              snap.archivedProjects.map((p) => {
                const menu = (e: React.MouseEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  gleeok.dispatch({ type: 'projectMenu', id: p.id });
                };
                return (
                  <div key={p.id} role="button" className="project is-archived" onClick={menu} onContextMenu={menu} title="点击：取消存档 / 删除">
                    <span className="status" />
                    <span className="name">{p.name}</span>
                    <button className="kebab" onClick={menu}>
                      ⋯
                    </button>
                  </div>
                );
              })}
          </div>
        )}
      </nav>

      {snap.downloads.length > 0 && (
        <div className="downloads">
          {snap.downloads.slice(0, 3).map((d) => (
            <button
              key={d.id}
              className={`download ${d.state}`}
              onClick={() => gleeok.dispatch({ type: 'showDownload', id: d.id })}
              title={d.path}
            >
              <span className="name">{d.filename}</span>
              <span className="meta">
                {d.state === 'completed'
                  ? '完成'
                  : d.state === 'progressing'
                    ? d.total
                      ? `${Math.round((d.received / d.total) * 100)}%`
                      : '下载中'
                    : '失败'}
              </span>
            </button>
          ))}
        </div>
      )}

      <footer>
        {(snap.update.commits.length > 0 || snap.update.step || snap.update.error) && (
          <button className="update-available" onClick={() => gleeok.dispatch({ type: 'openUpdate' })}>
            {snap.update.step
              ? `正在更新：${snap.update.step}`
              : snap.update.error
                ? '更新失败，点此查看'
                : `⬆ 更新 Gleeok（${snap.update.commits.length} 个更新）`}
          </button>
        )}
        <div className="footer-row">
          <IconButton
            icon="grid"
            title={state.currentProjectId ? `入口页：项目的链接和设置（${mod}E）` : '入口页（先选中一个项目）'}
            onClick={() => state.currentProjectId && gleeok.dispatch({ type: 'toggleEntry' })}
          />
          <IconButton
            icon="settings"
            on={state.view === 'settings'}
            title="设置：Paseo 导入、同步、密码库"
            onClick={() => gleeok.dispatch({ type: 'setView', view: state.view === 'settings' ? 'panes' : 'settings' })}
          />
          <span className="spacer" />
          <span className="build" title={__GLEEOK_BUILD__}>
            {new Date(__GLEEOK_BUILD__).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
          {snap.canSelfUpdate && (
            <IconButton icon="refresh" size={13} title="检查 Gleeok 有没有更新" onClick={() => gleeok.dispatch({ type: 'checkUpdate' })} />
          )}
        </div>
      </footer>
    </aside>
  );
}
