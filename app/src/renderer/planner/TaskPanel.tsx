import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlannerSnapshot } from '../../../../shared/src/ipc.ts';
import type { PlannerTask } from '../../../../shared/src/planner.ts';
import type { Project } from '../../../../shared/src/model.ts';
import { Icon } from '../Icons.tsx';
import { PRIORITY_COLORS, TASK_MIME, byOrder, dayKey, dueDay, dueLabel, isOverdue, patchTask, plan, pomodoroCounts } from './data.ts';

/** Which tasks (one time range) from which projects ('' is the inbox; none chosen: all of them). */
export interface TaskFilter {
  time: 'today' | 'all' | 'done' | 'trash';
  projects: string[];
}

export const DEFAULT_FILTER: TaskFilter = { time: 'today', projects: [] };

/** A saved filter, including the { kind } ones older versions saved. */
export function readFilter(saved: unknown): TaskFilter {
  const f = saved as (Partial<TaskFilter> & { kind?: string; id?: string }) | null;
  if (f && typeof f.time === 'string' && Array.isArray(f.projects)) return { time: f.time, projects: f.projects };
  switch (f?.kind) {
    case 'inbox':
      return { time: 'all', projects: [''] };
    case 'project':
      return { time: 'all', projects: [f.id ?? ''] };
    case 'all':
    case 'done':
    case 'trash':
      return { time: f.kind, projects: [] };
    default:
      return DEFAULT_FILTER;
  }
}

interface Group {
  /** The project, '' for the inbox. */
  id: string;
  name: string;
  tasks: PlannerTask[];
}

/** For 全部: overdue, today, tomorrow, later, no date; hand order within each. */
function dueRank(t: PlannerTask, today: string, tomorrow: string) {
  const d = dueDay(t);
  if (!d) return 4;
  return d < today ? 0 : d === today ? 1 : d === tomorrow ? 2 : 3;
}

/** The task list: a time range, the projects to show, one group per project with its own +. */
export function TaskPanel({
  data,
  projects,
  currentProjectId,
  filter,
  setFilter,
  selected,
  onSelect,
  onError,
}: {
  data: PlannerSnapshot;
  projects: Project[];
  currentProjectId: string | null;
  filter: TaskFilter;
  setFilter: (f: TaskFilter) => void;
  selected: string | null;
  onSelect: (key: string | null) => void;
  onError: (e: unknown) => void;
}) {
  const [draft, setDraft] = useState('');
  /** The group whose + was pressed: its input is open. */
  const [adding, setAdding] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState('');
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [dropAt, setDropAt] = useState<{ key: string; after: boolean } | null>(null);
  const [dropGroup, setDropGroup] = useState<string | null>(null);
  /** The task just added, to bring into view once it is in the list. */
  const [added, setAdded] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const today = dayKey(new Date());
  const tomorrow = dayKey(new Date(Date.now() + 86_400_000));
  const counts = useMemo(() => pomodoroCounts(data.pomodoros), [data.pomodoros]);
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const nameOf = (id: string) => (id ? (projectName.get(id) ?? '已存档的项目') : '收件箱');
  const chosen = new Set(filter.projects);
  const blockedToday = useMemo(
    () => new Set(data.blocks.filter((b) => b.taskKey && dayKey(new Date(b.start)) === today).map((b) => b.taskKey!)),
    [data.blocks, today],
  );

  const groups = useMemo((): Group[] => {
    const live = data.tasks.filter((t) => !t.deleted);
    const late = (t: PlannerTask) => Number(isOverdue(t) && dueDay(t)! < today);
    let pool: PlannerTask[];
    switch (filter.time) {
      case 'today':
        pool = live.filter((t) => !t.done && ((dueDay(t) ?? '9') <= today || blockedToday.has(t.key))).sort((a, b) => late(b) - late(a) || byOrder(a, b));
        break;
      case 'all':
        pool = live.filter((t) => !t.done).sort((a, b) => dueRank(a, today, tomorrow) - dueRank(b, today, tomorrow) || byOrder(a, b));
        break;
      case 'done':
        pool = live.filter((t) => t.done).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
        break;
      case 'trash':
        return [{ id: '', name: '回收站', tasks: data.tasks.filter((t) => t.deleted).sort((a, b) => b.dateModified.localeCompare(a.dateModified)) }];
    }
    // The inbox, the sidebar's projects in order, then projects that are no longer listed.
    const ids = ['', ...projects.map((p) => p.id)];
    for (const t of pool) if (t.projectId && !ids.includes(t.projectId)) ids.push(t.projectId);
    const all = ids
      .filter((id) => chosen.size === 0 || chosen.has(id))
      .map((id) => ({ id, name: nameOf(id), tasks: pool.filter((t) => (t.projectId ?? '') === id) }));
    // Empty groups only where a + is wanted: chosen ones, the inbox and the current project. They
    // keep their place, so the list does not reshuffle when one gets its first task.
    const keepEmpty = (id: string) => filter.time !== 'done' && (chosen.has(id) || id === '' || id === currentProjectId);
    return all.filter((g) => g.tasks.length || keepEmpty(g.id));
  }, [data.tasks, filter, today, tomorrow, blockedToday, projects, currentProjectId]);

  /**
   * New tasks go on top of their group; due today when only today is shown. The details do not
   * open (that squeezed the calendar, or covered the list in a pane): the input keeps the focus
   * for the next one, and the new row is brought into view.
   */
  const create = async (title: string, projectId: string) => {
    const top = Math.min(0, ...data.tasks.map((t) => t.order ?? 0)) - 1;
    try {
      const [t] = await plan<PlannerTask[]>({
        op: 'create',
        kind: 'tasks',
        objects: [{ title, order: top, ...(filter.time === 'today' ? { due: today } : {}), ...(projectId ? { projectId } : {}) }],
      });
      setAdded(t.key);
    } catch (e) {
      onError(e);
    }
  };
  useEffect(() => {
    if (!added) return;
    const row = list.current?.querySelector(`[data-key="${added}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    setAdded(null);
  }, [added, groups]);
  /** The top input: into the one project chosen, else the inbox. */
  const topProject = filter.projects.length === 1 ? filter.projects[0] : '';

  const toggle = (t: PlannerTask) =>
    void patchTask(t.key, t.done ? { done: null, doneAt: null } : { done: true, doneAt: new Date().toISOString() }).catch(onError);

  /** Dropped between rows: an order halfway between its new neighbours, and that group's project. */
  const reorder = (moved: string, target: PlannerTask, after: boolean, group: Group) => {
    if (moved === target.key) return;
    const rest = group.tasks.filter((t) => t.key !== moved);
    const i = rest.findIndex((t) => t.key === target.key) + (after ? 1 : 0);
    const before = rest[i - 1]?.order ?? (rest[i]?.order ?? 0) - 2;
    const next = rest[i]?.order ?? before + 2;
    const task = data.tasks.find((t) => t.key === moved);
    const project = (task?.projectId ?? '') === group.id ? {} : { projectId: group.id || null };
    void patchTask(moved, { order: (before + next) / 2, ...project }).catch(onError);
  };

  /** Dropped on a group's header: into that project. */
  const moveTo = (moved: string, group: string) => {
    const task = data.tasks.find((t) => t.key === moved);
    if (task && (task.projectId ?? '') !== group) void patchTask(moved, { projectId: group || null }).catch(onError);
  };

  const times: [TaskFilter['time'], string][] = [
    ['today', '今天'],
    ['all', '全部'],
    ['done', '已完成'],
  ];
  const setTime = (time: TaskFilter['time']) => setFilter({ ...filter, time });
  const toggleProject = (id: string) =>
    setFilter({ ...filter, projects: chosen.has(id) ? filter.projects.filter((p) => p !== id) : [...filter.projects, id] });
  const canAdd = filter.time === 'today' || filter.time === 'all';
  const chips = ['', ...(currentProjectId ? [currentProjectId] : []), ...projects.map((p) => p.id).filter((id) => id !== currentProjectId)];
  const fold = (id: string) => setFolded((f) => (f.has(id) ? new Set([...f].filter((x) => x !== id)) : new Set([...f, id])));

  return (
    <div className="plan-tasks">
      <div className="plan-filters">
        {times.map(([t, label]) => (
          <button key={t} className={filter.time === t ? 'on' : ''} onClick={() => setTime(t)}>
            {label}
          </button>
        ))}
        <span className="spacer" />
        <button className={`icon-btn ${filter.time === 'trash' ? 'on' : ''}`} onClick={() => setTime(filter.time === 'trash' ? 'today' : 'trash')} title="回收站">
          <Icon name="trash" size={13} />
        </button>
      </div>
      {filter.time !== 'trash' && (
        <div className="plan-chips" title="只看这些项目（可以选几个；都不选就是全部）">
          <button className={chosen.size === 0 ? 'on' : ''} onClick={() => setFilter({ ...filter, projects: [] })}>
            全部项目
          </button>
          {chips.map((id) => (
            <button key={id || 'inbox'} className={chosen.has(id) ? 'on' : ''} onClick={() => toggleProject(id)} title={id === currentProjectId ? '当前项目' : undefined}>
              {nameOf(id)}
              {id === currentProjectId && <span className="dot" />}
            </button>
          ))}
        </div>
      )}
      {canAdd && (
        <input
          className="plan-add"
          placeholder={`+ 添加${filter.time === 'today' ? '今天的' : ''}任务到「${nameOf(topProject)}」，回车`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !draft.trim()) return;
            void create(draft.trim(), topProject);
            setDraft('');
          }}
        />
      )}
      <TodayFocus data={data} />
      <div className="plan-list" ref={list}>
        {groups.every((g) => g.tasks.length === 0) && filter.time !== 'today' && filter.time !== 'all' && (
          <p className="plan-empty">{filter.time === 'trash' ? '回收站是空的' : '这里没有任务'}</p>
        )}
        {groups.map((g) => {
          const isFolded = folded.has(g.id);
          return (
            <div key={g.id || 'inbox'} className="plan-group">
              {filter.time !== 'trash' && (
                <div
                  className={`plan-group-head ${dropGroup === g.id ? 'drop' : ''}`}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes(TASK_MIME) || !canAdd) return;
                    e.preventDefault();
                    setDropGroup(g.id);
                  }}
                  onDragLeave={() => setDropGroup(null)}
                  onDrop={(e) => {
                    setDropGroup(null);
                    const moved = e.dataTransfer.getData(TASK_MIME);
                    if (moved) moveTo(moved, g.id);
                  }}
                >
                  <button className="plan-group-name" onClick={() => fold(g.id)} title={isFolded ? '展开' : '收起'}>
                    <span className="fold">{isFolded ? '▸' : '▾'}</span>
                    <span className="name">{g.name}</span>
                    <span className="meta">{g.tasks.length}</span>
                  </button>
                  {canAdd && (
                    <button
                      className="icon-btn plan-group-add"
                      onClick={() => {
                        setAdding(g.id);
                        setAddDraft('');
                        setFolded((f) => new Set([...f].filter((x) => x !== g.id)));
                      }}
                      title={`添加任务到「${g.name}」`}
                    >
                      +
                    </button>
                  )}
                </div>
              )}
              {adding === g.id && !isFolded && (
                <input
                  className="plan-add inline"
                  autoFocus
                  placeholder={`添加到「${g.name}」，回车；Esc 取消`}
                  value={addDraft}
                  onChange={(e) => setAddDraft(e.target.value)}
                  onBlur={() => !addDraft.trim() && setAdding(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setAdding(null);
                    if (e.key !== 'Enter' || !addDraft.trim()) return;
                    void create(addDraft.trim(), g.id);
                    setAddDraft('');
                  }}
                />
              )}
              {!isFolded &&
                g.tasks.map((t) => {
                  const subs = t.subtasks ?? [];
                  const done = counts.get(t.key) ?? 0;
                  return (
                    <div
                      key={t.key}
                      data-key={t.key}
                      className={`plan-task ${selected === t.key ? 'on' : ''} ${t.done ? 'done' : ''} ${dropAt?.key === t.key ? (dropAt.after ? 'drop-after' : 'drop-before') : ''}`}
                      draggable={!t.deleted}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(TASK_MIME, t.key);
                        e.dataTransfer.effectAllowed = 'copyMove';
                      }}
                      onDragOver={(e) => {
                        if (!e.dataTransfer.types.includes(TASK_MIME) || !canAdd) return;
                        e.preventDefault();
                        const r = e.currentTarget.getBoundingClientRect();
                        setDropAt({ key: t.key, after: e.clientY > r.top + r.height / 2 });
                      }}
                      onDragLeave={() => setDropAt(null)}
                      onDrop={(e) => {
                        const moved = e.dataTransfer.getData(TASK_MIME);
                        setDropAt(null);
                        if (moved) reorder(moved, t, e.clientY > e.currentTarget.getBoundingClientRect().top + e.currentTarget.offsetHeight / 2, g);
                      }}
                      onClick={() => onSelect(t.key)}
                    >
                      <button
                        className="plan-check"
                        style={{ borderColor: PRIORITY_COLORS[t.priority ?? 0] }}
                        disabled={!!t.deleted}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(t);
                        }}
                        title={t.done ? '标为未完成' : '完成'}
                      >
                        {t.done ? '✓' : ''}
                      </button>
                      <span className="plan-title">{t.title || <span className="meta">（无标题）</span>}</span>
                      {subs.length > 0 && (
                        <span className="meta">
                          {subs.filter((x) => x.done).length}/{subs.length}
                        </span>
                      )}
                      {(t.estimate || done > 0) && (
                        <span className="plan-pomo meta" title="完成的番茄 / 预估">
                          <Icon name="timer" size={11} />
                          {done}/{t.estimate ?? 0}
                        </span>
                      )}
                      {!t.done && !t.deleted && (
                        <button
                          className="plan-start"
                          onClick={(e) => {
                            e.stopPropagation();
                            gleeok.dispatch({ type: 'pomoStart', taskKey: t.key });
                          }}
                          title="开始番茄"
                        >
                          <Icon name="play" size={11} />
                        </button>
                      )}
                      {t.createdBy && (
                        <span className="plan-agent" title={`由 ${t.createdBy} 创建`}>
                          <Icon name="bot" size={12} />
                        </span>
                      )}
                      {filter.time === 'trash' && t.projectId && <span className="plan-chip">{nameOf(t.projectId)}</span>}
                      {t.due && <span className={`plan-due ${isOverdue(t) ? 'late' : ''}`}>{dueLabel(t)}</span>}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** "今天专注 3 个番茄 · 75 分钟". */
function TodayFocus({ data }: { data: PlannerSnapshot }) {
  const today = dayKey(new Date());
  const done = data.pomodoros.filter((p) => p.kind === 'focus' && p.completed && dayKey(new Date(p.start)) === today);
  if (done.length === 0) return null;
  const minutes = Math.round(done.reduce((n, p) => n + (Date.parse(p.end) - Date.parse(p.start)), 0) / 60_000);
  return (
    <div className="plan-focus-today">
      <Icon name="timer" size={12} /> 今天专注 {done.length} 个番茄 · {minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`}
    </div>
  );
}
