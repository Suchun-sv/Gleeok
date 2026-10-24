import { useMemo, useState } from 'react';
import type { PlannerSnapshot } from '../../../../shared/src/ipc.ts';
import type { PlannerTask } from '../../../../shared/src/planner.ts';
import type { Project } from '../../../../shared/src/model.ts';
import { Icon } from '../Icons.tsx';
import { PRIORITY_COLORS, TASK_MIME, byOrder, dayKey, dueDay, dueLabel, isOverdue, patchTask, plan, pomodoroCounts } from './data.ts';

export type TaskFilter = { kind: 'today' | 'inbox' | 'all' | 'done' | 'trash' } | { kind: 'project'; id: string };

const sameFilter = (a: TaskFilter, b: TaskFilter) => a.kind === b.kind && (a.kind !== 'project' || (b.kind === 'project' && a.id === b.id));

interface Section {
  title?: string;
  tasks: PlannerTask[];
  /** Folded until opened (the done tasks under a project). */
  folded?: boolean;
}

/** The task list: quick add, filters, rows to tick, open, reorder or drag onto the calendar. */
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
  const [openFolded, setOpenFolded] = useState(false);
  const [dropAt, setDropAt] = useState<{ key: string; after: boolean } | null>(null);
  const today = dayKey(new Date());
  const counts = useMemo(() => pomodoroCounts(data.pomodoros), [data.pomodoros]);
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const blockedToday = useMemo(
    () => new Set(data.blocks.filter((b) => b.taskKey && dayKey(new Date(b.start)) === today).map((b) => b.taskKey!)),
    [data.blocks, today],
  );

  const sections = useMemo((): Section[] => {
    const live = data.tasks.filter((t) => !t.deleted);
    const open = live.filter((t) => !t.done).sort(byOrder);
    switch (filter.kind) {
      case 'today': {
        const mine = open.filter((t) => (dueDay(t) ?? '9') <= today || blockedToday.has(t.key));
        return [
          { title: '已过期', tasks: mine.filter((t) => isOverdue(t) && dueDay(t)! < today) },
          { title: '今天', tasks: mine.filter((t) => !(isOverdue(t) && dueDay(t)! < today)) },
        ];
      }
      case 'inbox':
        return [{ tasks: open.filter((t) => !t.projectId) }];
      case 'all': {
        const tomorrow = dayKey(new Date(Date.now() + 86_400_000));
        return [
          { title: '已过期', tasks: open.filter((t) => dueDay(t) && dueDay(t)! < today) },
          { title: '今天', tasks: open.filter((t) => dueDay(t) === today) },
          { title: '明天', tasks: open.filter((t) => dueDay(t) === tomorrow) },
          { title: '之后', tasks: open.filter((t) => dueDay(t) && dueDay(t)! > tomorrow) },
          { title: '没有日期', tasks: open.filter((t) => !dueDay(t)) },
        ];
      }
      case 'project':
        return [
          { tasks: open.filter((t) => t.projectId === filter.id) },
          { title: '已完成', tasks: live.filter((t) => t.done && t.projectId === filter.id).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '')), folded: true },
        ];
      case 'done':
        return [{ tasks: live.filter((t) => t.done).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '')) }];
      case 'trash':
        return [{ tasks: data.tasks.filter((t) => t.deleted).sort((a, b) => b.dateModified.localeCompare(a.dateModified)) }];
    }
  }, [data.tasks, filter, today, blockedToday]);

  /** New tasks go on top, into whatever the list shows (today, a project). */
  const add = async () => {
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    const top = Math.min(0, ...data.tasks.map((t) => t.order ?? 0)) - 1;
    try {
      const [t] = await plan<PlannerTask[]>({
        op: 'create',
        kind: 'tasks',
        objects: [
          {
            title,
            order: top,
            ...(filter.kind === 'today' ? { due: today } : {}),
            ...(filter.kind === 'project' ? { projectId: filter.id } : {}),
          },
        ],
      });
      onSelect(t.key);
    } catch (e) {
      onError(e);
    }
  };

  const toggle = (t: PlannerTask) =>
    void patchTask(t.key, t.done ? { done: null, doneAt: null } : { done: true, doneAt: new Date().toISOString() }).catch(onError);

  /** Dropped between rows: an order halfway between its new neighbours. */
  const reorder = (moved: string, target: PlannerTask, after: boolean, list: PlannerTask[]) => {
    if (moved === target.key) return;
    const rest = list.filter((t) => t.key !== moved);
    const i = rest.findIndex((t) => t.key === target.key) + (after ? 1 : 0);
    const before = rest[i - 1]?.order ?? (rest[i]?.order ?? 0) - 2;
    const next = rest[i]?.order ?? before + 2;
    void patchTask(moved, { order: (before + next) / 2 }).catch(onError);
  };

  const filters: [TaskFilter, string][] = [
    [{ kind: 'today' }, '今天'],
    [{ kind: 'inbox' }, '收件箱'],
    [{ kind: 'all' }, '全部'],
    [{ kind: 'done' }, '已完成'],
  ];
  const projectFilter = filter.kind === 'project' ? filter.id : '';
  const canAdd = filter.kind !== 'done' && filter.kind !== 'trash';

  return (
    <div className="plan-tasks">
      <div className="plan-filters">
        {filters.map(([f, label]) => (
          <button key={label} className={sameFilter(f, filter) ? 'on' : ''} onClick={() => setFilter(f)}>
            {label}
          </button>
        ))}
        <select
          className={projectFilter ? 'on' : ''}
          value={projectFilter}
          onChange={(e) => setFilter(e.target.value ? { kind: 'project', id: e.target.value } : { kind: 'all' })}
          title="只看某个项目的任务"
        >
          <option value="">项目…</option>
          {currentProjectId && <option value={currentProjectId}>当前项目：{projectName.get(currentProjectId)}</option>}
          {projects
            .filter((p) => p.id !== currentProjectId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        <button className={`icon-btn ${filter.kind === 'trash' ? 'on' : ''}`} onClick={() => setFilter({ kind: 'trash' })} title="回收站">
          <Icon name="trash" size={13} />
        </button>
      </div>
      {canAdd && (
        <input
          className="plan-add"
          placeholder={filter.kind === 'today' ? '+ 添加今天的任务，回车' : filter.kind === 'project' ? `+ 添加到「${projectName.get(filter.id) ?? '项目'}」，回车` : '+ 添加任务，回车'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
      )}
      <TodayFocus data={data} />
      <div className="plan-list">
        {sections.every((s) => s.tasks.length === 0) && <p className="plan-empty">{filter.kind === 'trash' ? '回收站是空的' : '这里没有任务'}</p>}
        {sections
          .filter((s) => s.tasks.length)
          .map((s, si) => (
            <div key={si}>
              {s.title && (
                <button className="plan-section" onClick={() => s.folded && setOpenFolded(!openFolded)}>
                  {s.folded && <span>{openFolded ? '▾' : '▸'}</span>}
                  {s.title} <span className="meta">{s.tasks.length}</span>
                </button>
              )}
              {(!s.folded || openFolded) &&
                s.tasks.map((t) => {
                  const subs = t.subtasks ?? [];
                  const done = counts.get(t.key) ?? 0;
                  return (
                    <div
                      key={t.key}
                      className={`plan-task ${selected === t.key ? 'on' : ''} ${t.done ? 'done' : ''} ${dropAt?.key === t.key ? (dropAt.after ? 'drop-after' : 'drop-before') : ''}`}
                      draggable={!t.deleted}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(TASK_MIME, t.key);
                        e.dataTransfer.effectAllowed = 'copyMove';
                      }}
                      onDragOver={(e) => {
                        if (!e.dataTransfer.types.includes(TASK_MIME) || filter.kind === 'done' || filter.kind === 'trash') return;
                        e.preventDefault();
                        const r = e.currentTarget.getBoundingClientRect();
                        setDropAt({ key: t.key, after: e.clientY > r.top + r.height / 2 });
                      }}
                      onDragLeave={() => setDropAt(null)}
                      onDrop={(e) => {
                        const moved = e.dataTransfer.getData(TASK_MIME);
                        setDropAt(null);
                        if (moved) reorder(moved, t, e.clientY > e.currentTarget.getBoundingClientRect().top + e.currentTarget.offsetHeight / 2, s.tasks);
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
                      {t.projectId && filter.kind !== 'project' && <span className="plan-chip">{projectName.get(t.projectId) ?? '项目'}</span>}
                      {t.due && <span className={`plan-due ${isOverdue(t) ? 'late' : ''}`}>{dueLabel(t)}</span>}
                    </div>
                  );
                })}
            </div>
          ))}
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
