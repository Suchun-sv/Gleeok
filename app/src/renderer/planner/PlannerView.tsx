import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../../../shared/src/model.ts';
import { PLANNER_URL } from '../../../../shared/src/model.ts';
import { Calendar, type CalendarView } from './Calendar.tsx';
import { TaskDetail } from './TaskDetail.tsx';
import { TaskPanel, type TaskFilter } from './TaskPanel.tsx';
import { usePlanner } from './data.ts';

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

/** Below this width the calendar and the task list take turns. */
const COMPACT_WIDTH = 860;

/** The 日程: calendar | tasks | task details; in a narrow pane, calendar or tasks, details sliding over. */
export function PlannerView({ mode, projects, currentProjectId }: { mode: 'full' | 'pane'; projects: Project[]; currentProjectId: string | null }) {
  const data = usePlanner();
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [view, setView] = useState<CalendarView>(() => loadPref('view', 'day'));
  const [anchor, setAnchor] = useState(() => new Date());
  const [filter, setFilter] = useState<TaskFilter>(() => loadPref('filter', { kind: 'today' }));
  const [selected, setSelected] = useState<string | null>(null);
  const [side, setSide] = useState<'calendar' | 'tasks'>('calendar');
  const [error, setError] = useState('');

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    if (root.current) ro.observe(root.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => savePref('view', view), [view]);
  useEffect(() => savePref('filter', filter), [filter]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(''), 6000);
    return () => clearTimeout(t);
  }, [error]);

  if (!data) return <div className="planner loading">正在打开日程…</div>;
  const compact = width < COMPACT_WIDTH;
  const onError = (e: unknown) => setError(String((e as Error).message ?? e));
  const task = selected ? data.tasks.find((t) => t.key === selected) : undefined;

  const toPane =
    mode === 'full' ? (
      <button className="plan-to-pane" onClick={() => gleeok.dispatch({ type: 'newTab', url: PLANNER_URL })} title="在焦点所在的那一栏打开日程">
        在栏中打开
      </button>
    ) : null;
  const calendar = (
    <Calendar data={data} view={view} anchor={anchor} onAnchor={setAnchor} onView={setView} onSelectTask={setSelected} onError={onError} extra={toPane} />
  );
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
        if (compact) setSide('calendar');
      }}
      onError={onError}
    />
  );

  return (
    <div ref={root} className={`planner ${mode} ${compact ? 'compact' : ''}`}>
      {compact ? (
        <div className="plan-main">
          <div className="plan-switch">
            <button className={side === 'calendar' ? 'on' : ''} onClick={() => setSide('calendar')}>
              日历
            </button>
            <button className={side === 'tasks' ? 'on' : ''} onClick={() => setSide('tasks')}>
              任务
            </button>
          </div>
          {side === 'calendar' ? calendar : tasks}
        </div>
      ) : (
        <>
          <div className="plan-main">{calendar}</div>
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
