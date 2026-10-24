import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Project } from '../../../../shared/src/model.ts';
import { PLANNER_URL } from '../../../../shared/src/model.ts';
import { Calendar, type CalendarView } from './Calendar.tsx';
import { TaskDetail } from './TaskDetail.tsx';
import { TaskPanel, type TaskFilter } from './TaskPanel.tsx';
import { usePlanner } from './data.ts';
import { AgentButton } from '../AgentConnections.tsx';

const loadPref = <T,>(name: string, fallback: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(`gleeok.planner.${name}`) ?? 'null') as T) ?? fallback;
  } catch {
    return fallback;
  }
};
const savePref = (name: string, value: unknown) => localStorage.setItem(`gleeok.planner.${name}`, JSON.stringify(value));

/** Show a project's tasks next time the 日程 opens (from the project's settings drawer). */
export const showProjectTasks = (projectId: string) => savePref('filter', { kind: 'project', id: projectId });

/** Open the 日程 on this task next time (the new-tab page's tile). */
export const showTask = (key: string) => sessionStorage.setItem('gleeok.planner.open', key);

/** Below this width the task list sits above the calendar instead of beside it. */
const COMPACT_WIDTH = 860;
/** The stacked task list: height limits (px). */
const MIN_TASKS = 70;
const MIN_GRID = 160;

/** The 日程: calendar | tasks | task details; in a narrow pane, calendar or tasks, details sliding over. */
export function PlannerView({ mode, projects, currentProjectId }: { mode: 'full' | 'pane'; projects: Project[]; currentProjectId: string | null }) {
  const data = usePlanner();
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [view, setView] = useState<CalendarView>(() => loadPref('view', 'day'));
  const [anchor, setAnchor] = useState(() => new Date());
  const [filter, setFilter] = useState<TaskFilter>(() => loadPref('filter', { kind: 'today' }));
  const [selected, setSelected] = useState<string | null>(() => {
    const asked = sessionStorage.getItem('gleeok.planner.open');
    sessionStorage.removeItem('gleeok.planner.open');
    return asked;
  });
  const [split, setSplit] = useState<number>(() => loadPref('split', 220));
  const [tasksOpen, setTasksOpen] = useState<boolean>(() => loadPref('tasksOpen', true));
  const [error, setError] = useState('');

  // Measured before the first paint, so a pane never flashes the wide layout.
  useLayoutEffect(() => {
    if (!root.current) return;
    setWidth(root.current.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(root.current);
    return () => ro.disconnect();
  }, [!!data]);
  useEffect(() => savePref('split', split), [split]);
  useEffect(() => savePref('tasksOpen', tasksOpen), [tasksOpen]);
  useEffect(() => savePref('view', view), [view]);
  useEffect(() => savePref('filter', filter), [filter]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(''), 6000);
    return () => clearTimeout(t);
  }, [error]);

  if (!data) return <div className="planner loading">正在打开日程…</div>;
  const compact = width > 0 && width < COMPACT_WIDTH;
  const onError = (e: unknown) => setError(String((e as Error).message ?? e));
  const task = selected ? data.tasks.find((t) => t.key === selected) : undefined;

  const toPane = (
    <>
      {/* In a narrow pane the header has no room for the label. */}
      <AgentButton scope="planner" iconOnly={compact} />
      {mode === 'full' && (
        <button className="plan-to-pane" onClick={() => gleeok.dispatch({ type: 'newTab', url: PLANNER_URL })} title="在焦点所在的那一栏打开日程">
          在栏中打开
        </button>
      )}
    </>
  );
  const calendar = (between?: React.ReactNode) => (
    <Calendar
      data={data}
      view={view}
      anchor={anchor}
      onAnchor={setAnchor}
      onView={setView}
      onSelectTask={setSelected}
      onError={onError}
      extra={toPane}
      between={between}
      compact={compact}
    />
  );
  const openCount = data.tasks.filter((t) => !t.done && !t.deleted).length;

  /** Drag the line under the task list to give it more or less of the pane. */
  const startSplit = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = split;
    const max = (root.current?.getBoundingClientRect().height ?? 600) - MIN_GRID;
    const move = (ev: MouseEvent) => setSplit(Math.round(Math.min(max, Math.max(MIN_TASKS, startH + ev.clientY - startY))));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-rows');
    };
    document.body.classList.add('resizing-rows');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const tasks = (
    <TaskPanel
      data={data}
      projects={projects}
      currentProjectId={currentProjectId}
      filter={filter}
      setFilter={setFilter}
      selected={selected}
      onSelect={setSelected}
      onError={onError}
    />
  );
  const detail = task && (
    <TaskDetail
      key={task.key}
      data={data}
      task={task}
      projects={projects}
      onClose={() => setSelected(null)}
      onJump={(d) => {
        setAnchor(d);
        if (view === 'month') setView('day');
      }}
      onError={onError}
    />
  );

  return (
    <div ref={root} className={`planner ${mode} ${compact ? 'compact' : ''}`}>
      {compact ? (
        <div className="plan-main stacked">
          {calendar(
            <>
              {tasksOpen && (
                <div className="plan-stack-tasks" style={{ height: split }}>
                  {tasks}
                </div>
              )}
              <div className={`plan-stack-bar ${tasksOpen ? 'open' : ''}`} onMouseDown={tasksOpen ? startSplit : undefined} title={tasksOpen ? '拖动调整任务列表的高度' : undefined}>
                <button onClick={() => setTasksOpen(!tasksOpen)}>{tasksOpen ? '收起任务 ▴' : `任务 ${openCount} ▾`}</button>
              </div>
            </>,
          )}
        </div>
      ) : (
        <>
          <div className="plan-main">{calendar()}</div>
          <div className="plan-side">{tasks}</div>
        </>
      )}
      {detail && <div className={compact ? 'plan-drawer' : 'plan-side detail'}>{detail}</div>}
      {(error || data.status === 'offline' || data.status === 'unavailable') && (
        <div className="plan-status">{error || (data.status === 'offline' ? '离线：显示的是本机缓存，修改暂时无法保存' : (data.error ?? '日程不可用'))}</div>
      )}
    </div>
  );
}
