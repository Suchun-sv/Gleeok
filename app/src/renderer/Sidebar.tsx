import { useState } from 'react';
import type { Snapshot } from '../../../shared/src/ipc.ts';
import { primaryCodeLink } from '../../../shared/src/model.ts';
import icon from '../../assets/icon-64.png';
import { Icon, IconButton } from './Icons.tsx';
import { useLibrary } from './library/data.ts';
import { dayKey, usePlanner } from './planner/data.ts';
import { PHASE_NAMES, mmss, remaining, useTick } from './planner/Pomodoro.tsx';

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
              title={`${p.name}\n${live ? `运行中${mb ? ` · ${mb} MB` : ''}` : '已休眠'}\n双击打开项目设置，右键更多操作`}
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
          <button
            className="project add"
            onClick={() => setAdding(true)}
            // Local mode stores projects on this machine; only an unreachable sync server blocks creating.
            disabled={server.status !== 'ok' && server.status !== 'local'}
            title={server.status === 'ok' || server.status === 'local' ? undefined : '连不上同步服务器，暂时不能新建项目（点顶部的圆点重试）'}
          >
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

      <PlannerEntry active={state.view === 'planner'} platform={snap.platform} pomodoro={snap.pomodoro} />
      <LibraryEntry active={state.view === 'library'} platform={snap.platform} />
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
            icon="settings"
            on={state.view === 'settings'}
            title="设置：Paseo 导入、同步、密码库"
            onClick={() => gleeok.dispatch({ type: 'setView', view: state.view === 'settings' ? 'panes' : 'settings' })}
          />
          <span className="build" title={memoryTitle(snap)}>
            {snap.memoryTotal.gleeok > 0 && <span className="mem">内存占用 {gb(snap.memoryTotal.gleeok)} · </span>}
            {new Date(__GLEEOK_BUILD__).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
          {snap.canSelfUpdate ? (
            <IconButton icon="refresh" size={13} title="检查 Gleeok 有没有更新" onClick={() => gleeok.dispatch({ type: 'checkUpdate' })} />
          ) : (
            <span />
          )}
        </div>
      </footer>
    </aside>
  );
}

const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

/** Footer tooltip: where the memory goes (running projects' pages, the rest of Gleeok) and the build. */
function memoryTitle(snap: Snapshot) {
  const { gleeok, systemUsed, systemTotal } = snap.memoryTotal;
  const byProject = snap.projects
    .filter((p) => snap.memory[p.id])
    .sort((a, b) => snap.memory[b.id] - snap.memory[a.id])
    .map((p) => `  ${p.name}：${gb(snap.memory[p.id])}`);
  const pages = Object.values(snap.memory).reduce((n, m) => n + m, 0);
  return [
    `Gleeok 占用内存约 ${gb(gleeok)}（每 10 秒更新）`,
    ...(byProject.length ? ['运行中项目的网页：', ...byProject] : []),
    `  其余（窗口、GPU 等）：${gb(Math.max(0, gleeok - pages))}`,
    `这台电脑：已用 ${gb(systemUsed)} / 共 ${gb(systemTotal)}`,
    '休眠不用的项目（项目右键 → 休眠）可以释放它的网页内存。',
    `build ${__GLEEOK_BUILD__}`,
  ].join('\n');
}

/** The 文献库 entry, pinned just above the footer: a top-level place, not a project. */
function LibraryEntry({ active, platform }: { active: boolean; platform: string }) {
  const lib = useLibrary();
  const count = lib?.items.filter((i) => i.itemType !== 'note' && i.itemType !== 'attachment' && i.itemType !== 'annotation' && !i.deleted).length;
  return (
    <div
      role="button"
      className={`project library-entry ${active ? 'active' : ''}`}
      onClick={() => gleeok.dispatch({ type: 'toggleLibrary' })}
      title={`文献库（${platform === 'darwin' ? '⌘⌥' : 'Ctrl+Alt+'}P）`}
    >
      <span className="status">
        <Icon name="libraryBig" size={13} />
      </span>
      <span className="name">文献库</span>
      {count ? <kbd>{count}</kbd> : null}
    </div>
  );
}

/** The 日程 entry, with how many tasks are open for today (overdue included). */
function PlannerEntry({ active, platform, pomodoro }: { active: boolean; platform: string; pomodoro: Snapshot['pomodoro'] }) {
  const planner = usePlanner();
  const today = dayKey(new Date());
  const count = planner?.tasks.filter((t) => !t.done && !t.deleted && t.due && t.due.slice(0, 10) <= today).length;
  useTick(pomodoro.running);
  const busy = pomodoro.phase !== 'idle';
  const stop = (e: React.MouseEvent, action: Parameters<typeof gleeok.dispatch>[0]) => {
    e.stopPropagation();
    gleeok.dispatch(action);
  };
  // While a pomodoro runs, the row is its clock: phase, time left, pause / stop.
  const label = !busy
    ? '日程'
    : pomodoro.awaiting
      ? pomodoro.awaiting === 'focus'
        ? '休息结束'
        : '番茄完成'
      : `${PHASE_NAMES[pomodoro.phase]} ${mmss(remaining(pomodoro, Date.now()))}${pomodoro.running ? '' : ' 已暂停'}`;
  return (
    <div
      role="button"
      className={`project library-entry ${active ? 'active' : ''} ${busy ? 'pomo' : ''} ${pomodoro.phase === 'focus' ? 'focus' : ''}`}
      onClick={() => gleeok.dispatch({ type: 'togglePlanner' })}
      title={`日程（${platform === 'darwin' ? '⌘⌥' : 'Ctrl+Alt+'}A）${pomodoro.taskTitle && busy ? `\n${pomodoro.taskTitle}` : count ? `\n今天还有 ${count} 个任务` : ''}`}
    >
      <span className="status">
        <Icon name={busy ? 'timer' : 'calendarCheck'} size={13} />
      </span>
      <span className="name">{label}</span>
      {busy ? (
        pomodoro.awaiting ? (
          <>
            <button className="pomo-btn" onClick={(e) => stop(e, { type: 'pomoConfirm', go: true })} title={pomodoro.awaiting === 'focus' ? '开始下一个番茄' : '开始休息'}>
              <Icon name="play" size={11} />
            </button>
            <button className="pomo-btn" onClick={(e) => stop(e, { type: 'pomoConfirm', go: false })} title="不用了">
              <Icon name="stop" size={11} />
            </button>
          </>
        ) : (
          <>
            <button className="pomo-btn" onClick={(e) => stop(e, { type: pomodoro.running ? 'pomoPause' : 'pomoResume' })} title={pomodoro.running ? '暂停' : '继续'}>
              <Icon name={pomodoro.running ? 'pause' : 'play'} size={11} />
            </button>
            <button className="pomo-btn" onClick={(e) => stop(e, { type: 'pomoSkip' })} title="提前结束这一段">
              <Icon name="skip" size={11} />
            </button>
            <button className="pomo-btn" onClick={(e) => stop(e, { type: 'pomoStop' })} title="停止">
              <Icon name="stop" size={11} />
            </button>
          </>
        )
      ) : count ? (
        <kbd>{count}</kbd>
      ) : null}
    </div>
  );
}
