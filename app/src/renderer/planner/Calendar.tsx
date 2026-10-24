import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PlannerSnapshot } from '../../../../shared/src/ipc.ts';
import type { PlannerTask, TimeBlock } from '../../../../shared/src/planner.ts';
import { Icon } from '../Icons.tsx';
import { PRIORITY_COLORS, TASK_MIME, WEEKDAYS, addDays, blockTitle, dayKey, dueDay, dueTime, hhmm, isOverdue, patchTask, plan, startOfDay, startOfWeek } from './data.ts';

export type CalendarView = 'day' | '3day' | 'week' | 'month';
export const VIEW_DAYS: Record<Exclude<CalendarView, 'month'>, number> = { day: 1, '3day': 3, week: 7 };

/** Pixels per hour in the time grid. */
const HOUR = 44;
const SNAP = 15;
const MINUTE = 60_000;

const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();
const atMinutes = (day: Date, minutes: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
const snap = (m: number) => Math.round(m / SNAP) * SNAP;

/** First day shown for an anchor date. */
export function viewStart(view: CalendarView, anchor: Date): Date {
  if (view === 'week') return startOfWeek(anchor);
  if (view === 'month') return startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  return startOfDay(anchor);
}

/** The anchor after ‹ or ›. */
export function stepAnchor(view: CalendarView, anchor: Date, dir: number): Date {
  if (view === 'month') return new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
  return addDays(anchor, dir * VIEW_DAYS[view]);
}

export function viewTitle(view: CalendarView, anchor: Date): string {
  if (view === 'month') return `${anchor.getFullYear()}年${anchor.getMonth() + 1}月`;
  const first = viewStart(view, anchor);
  const last = addDays(first, VIEW_DAYS[view] - 1);
  const md = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;
  return view === 'day' ? `${first.getFullYear()}年${md(first)} ${WEEKDAYS[first.getDay()]}` : `${md(first)} – ${md(last)}`;
}

interface Placed {
  block: TimeBlock;
  /** Minutes from the start of this day (clipped to it). */
  top: number;
  bottom: number;
  col: number;
  cols: number;
}

/** Blocks that share time sit side by side: each overlapping cluster splits its width. */
function layout(blocks: TimeBlock[], day: Date): Placed[] {
  const start = day.getTime();
  const end = addDays(day, 1).getTime();
  const items = blocks
    .map((b) => ({ block: b, s: Math.max(Date.parse(b.start), start), e: Math.min(Date.parse(b.end), end) }))
    .filter((x) => x.e > x.s)
    .sort((a, b) => a.s - b.s || b.e - a.e);
  const out: Placed[] = [];
  let cluster: (Placed & { e: number })[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    for (const c of cluster) out.push({ ...c, cols });
    cluster = [];
  };
  for (const x of items) {
    if (x.s >= clusterEnd) {
      flush();
      clusterEnd = -Infinity;
    }
    const taken = new Set(cluster.filter((c) => c.e > x.s).map((c) => c.col));
    let col = 0;
    while (taken.has(col)) col++;
    cluster.push({ block: x.block, top: (x.s - start) / MINUTE, bottom: (x.e - start) / MINUTE, col, cols: 1, e: x.e });
    clusterEnd = Math.max(clusterEnd, x.e);
  }
  flush();
  return out;
}

export function Calendar({
  data,
  view,
  anchor,
  onAnchor,
  onView,
  onSelectTask,
  onError,
  extra,
}: {
  data: PlannerSnapshot;
  view: CalendarView;
  anchor: Date;
  /** Shown at the right end of the header. */
  extra?: React.ReactNode;
  onAnchor: (d: Date) => void;
  onView: (v: CalendarView) => void;
  onSelectTask: (key: string) => void;
  onError: (e: unknown) => void;
}) {
  const tasks = useMemo(() => new Map(data.tasks.map((t) => [t.key, t])), [data.tasks]);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  // Blocks of trashed tasks are hidden with them.
  const blocks = data.blocks.filter((b) => !b.taskKey || !tasks.get(b.taskKey)?.deleted);

  return (
    <div className="plan-cal">
      <div className="plan-cal-head">
        <button className="icon-btn" onClick={() => onAnchor(stepAnchor(view, anchor, -1))} title="上一段">
          <Icon name="chevronLeft" size={15} />
        </button>
        <button className="plan-today" onClick={() => onAnchor(new Date())}>
          今天
        </button>
        <button className="icon-btn" onClick={() => onAnchor(stepAnchor(view, anchor, 1))} title="下一段">
          <Icon name="chevronRight" size={15} />
        </button>
        <span className="plan-cal-title">{viewTitle(view, anchor)}</span>
        <div className="plan-seg">
          {(
            [
              ['day', '日'],
              ['3day', '3日'],
              ['week', '周'],
              ['month', '月'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => onView(v)}>
              {label}
            </button>
          ))}
        </div>
        {extra}
      </div>
      {view === 'month' ? (
        <Month data={data} tasks={tasks} blocks={blocks} anchor={anchor} now={now} onOpenDay={(d) => (onAnchor(d), onView('day'))} onSelectTask={onSelectTask} onError={onError} />
      ) : (
        <TimeGrid
          days={Array.from({ length: VIEW_DAYS[view] }, (_, i) => addDays(viewStart(view, anchor), i))}
          tasks={tasks}
          blocks={blocks}
          data={data}
          now={now}
          view={view}
          onSelectTask={onSelectTask}
          onError={onError}
        />
      )}
    </div>
  );
}

function TimeGrid({
  days,
  tasks,
  blocks,
  data,
  now,
  view,
  onSelectTask,
  onError,
}: {
  days: Date[];
  tasks: Map<string, PlannerTask>;
  blocks: TimeBlock[];
  data: PlannerSnapshot;
  now: Date;
  view: CalendarView;
  onSelectTask: (key: string) => void;
  onError: (e: unknown) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const columns = useRef<HTMLDivElement>(null);
  // While a block is dragged or resized: where it would land.
  const [moving, setMoving] = useState<{ key: string; start: Date; end: Date } | null>(null);
  const [popover, setPopover] = useState<{ key: string; x: number; y: number; edit?: boolean } | null>(null);
  const [hover, setHover] = useState<{ day: number; minutes: number } | null>(null);
  const today = dayKey(now);

  // Open near now (or the morning), once per view.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = Math.max(0, ((days.some((d) => dayKey(d) === today) ? minutesOf(now) : 8 * 60) / 60 - 2) * HOUR);
  }, [view, dayKey(days[0])]);

  useEffect(() => {
    if (!popover) return;
    const close = () => setPopover(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [popover]);

  /** The day column and minute under a point. */
  const pointAt = (x: number, y: number) => {
    const r = columns.current!.getBoundingClientRect();
    const day = Math.min(days.length - 1, Math.max(0, Math.floor(((x - r.left) / r.width) * days.length)));
    const minutes = Math.min(24 * 60, Math.max(0, ((y - r.top) / HOUR) * 60));
    return { day, minutes };
  };

  const createBlock = async (fields: Record<string, unknown>) => {
    try {
      const [b] = await plan<TimeBlock[]>({ op: 'create', kind: 'blocks', objects: [fields] });
      return b;
    } catch (e) {
      onError(e);
      return null;
    }
  };

  /** Dragging an existing block (move) or its bottom edge (resize). */
  const startDrag = (e: React.PointerEvent, b: TimeBlock, mode: 'move' | 'resize') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const s0 = new Date(b.start);
    const e0 = new Date(b.end);
    const p0 = pointAt(e.clientX, e.clientY);
    let latest: { start: Date; end: Date } | null = null;
    const move = (ev: PointerEvent) => {
      const p = pointAt(ev.clientX, ev.clientY);
      const dm = snap(p.minutes - p0.minutes);
      if (mode === 'resize') {
        const end = new Date(Math.max(e0.getTime() + dm * MINUTE, s0.getTime() + SNAP * MINUTE));
        latest = { start: s0, end };
      } else {
        const shift = (p.day - p0.day) * 86_400_000 + dm * MINUTE;
        latest = { start: new Date(s0.getTime() + shift), end: new Date(e0.getTime() + shift) };
      }
      setMoving({ key: b.key, ...latest });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      const moved = latest && (latest.start.getTime() !== s0.getTime() || latest.end.getTime() !== e0.getTime());
      if (moved) {
        void plan({ op: 'patch', kind: 'blocks', key: b.key, fields: { start: latest!.start.toISOString(), end: latest!.end.toISOString() } })
          .catch(onError)
          .finally(() => setMoving(null));
      } else {
        setMoving(null);
        setPopover({ key: b.key, x: ev.clientX, y: ev.clientY });
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const shown = (b: TimeBlock): TimeBlock => (moving?.key === b.key ? { ...b, start: moving.start.toISOString(), end: moving.end.toISOString() } : b);
  const pop = popover && blocks.find((b) => b.key === popover.key);
  const dueOn = (day: Date) => data.tasks.filter((t) => !t.deleted && !t.done && dueDay(t) === dayKey(day));

  return (
    <div className="plan-grid-wrap">
      <div className="plan-days-head" style={{ gridTemplateColumns: `52px repeat(${days.length}, 1fr)` }}>
        <div />
        {days.map((d) => (
          <div
            key={dayKey(d)}
            className={`plan-day-head ${dayKey(d) === today ? 'today' : ''}`}
            onDragOver={(e) => e.dataTransfer.types.includes(TASK_MIME) && e.preventDefault()}
            onDrop={(e) => {
              // Onto the day's header: due that day (keeping a time it had).
              const key = e.dataTransfer.getData(TASK_MIME);
              const t = tasks.get(key);
              if (t) void patchTask(key, { due: dayKey(d) + (dueTime(t) ? `T${dueTime(t)}` : '') }).catch(onError);
            }}
            title="把任务拖到这里：截止日期设为这一天"
          >
            <span className="plan-dow">{WEEKDAYS[d.getDay()]}</span>
            <span className="plan-dom">{d.getDate()}</span>
            <div className="plan-due-chips">
              {dueOn(d).map((t) => (
                <button
                  key={t.key}
                  className="plan-due-chip"
                  style={{ borderLeftColor: PRIORITY_COLORS[t.priority ?? 0] }}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData(TASK_MIME, t.key)}
                  onClick={() => onSelectTask(t.key)}
                  title={`${t.title}（这天到期，拖进下面的时间里排时间）`}
                >
                  {dueTime(t) && <span className="meta">{dueTime(t)} </span>}
                  {t.title}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div ref={scroller} className="plan-grid-scroll">
        <div className="plan-grid" style={{ height: 24 * HOUR, gridTemplateColumns: `52px 1fr` }}>
          <div className="plan-gutter">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="plan-hour-label" style={{ top: h * HOUR }}>
                {h ? `${String(h).padStart(2, '0')}:00` : ''}
              </div>
            ))}
          </div>
          <div ref={columns} className="plan-columns" style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}>
            {days.map((d, di) => {
              const placed = layout(blocks.map(shown), d);
              const isToday = dayKey(d) === today;
              return (
                <div
                  key={dayKey(d)}
                  className={`plan-col ${isToday ? 'today' : ''}`}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes(TASK_MIME)) return;
                    e.preventDefault();
                    setHover({ day: di, minutes: snap(pointAt(e.clientX, e.clientY).minutes) });
                  }}
                  onDragLeave={() => setHover(null)}
                  onDrop={(e) => {
                    setHover(null);
                    const key = e.dataTransfer.getData(TASK_MIME);
                    const t = tasks.get(key);
                    if (!t) return;
                    // Its estimate in pomodoros sets the length (25 minutes each), at least half an hour.
                    const start = atMinutes(d, Math.min(snap(pointAt(e.clientX, e.clientY).minutes), 24 * 60 - SNAP));
                    const length = Math.max(30, (t.estimate ?? 0) * 25);
                    void createBlock({ taskKey: key, start: start.toISOString(), end: new Date(start.getTime() + length * MINUTE).toISOString() });
                  }}
                  onDoubleClick={async (e) => {
                    if (e.target !== e.currentTarget) return;
                    const start = atMinutes(d, Math.min(snap(pointAt(e.clientX, e.clientY).minutes - 15), 24 * 60 - 30));
                    const b = await createBlock({ title: '新时间块', start: start.toISOString(), end: new Date(start.getTime() + 30 * MINUTE).toISOString() });
                    if (b) setPopover({ key: b.key, x: e.clientX, y: e.clientY, edit: true });
                  }}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="plan-hour-line" style={{ top: h * HOUR }} />
                  ))}
                  {hover?.day === di && <div className="plan-drop-mark" style={{ top: (hover.minutes / 60) * HOUR }} />}
                  {placed.map((p) => {
                    const t = p.block.taskKey ? tasks.get(p.block.taskKey) : undefined;
                    const s = new Date(p.block.start);
                    const short = p.bottom - p.top < 40;
                    return (
                      <div
                        key={p.block.key}
                        className={`plan-block ${t ? '' : 'free'} ${t?.done ? 'done' : ''} ${moving?.key === p.block.key ? 'moving' : ''}`}
                        style={{
                          top: (p.top / 60) * HOUR,
                          height: Math.max(14, ((p.bottom - p.top) / 60) * HOUR - 2),
                          left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
                          width: `calc(${100 / p.cols}% - 4px)`,
                          borderLeftColor: t ? PRIORITY_COLORS[t.priority ?? 0] : undefined,
                        }}
                        onPointerDown={(e) => startDrag(e, p.block, 'move')}
                        onDoubleClick={(e) => e.stopPropagation()}
                        title={`${blockTitle(p.block, tasks)}  ${hhmm(s)}–${hhmm(new Date(p.block.end))}`}
                      >
                        <span className="plan-block-name">{blockTitle(p.block, tasks)}</span>
                        {!short && (
                          <span className="plan-block-time">
                            {hhmm(s)}–{hhmm(new Date(p.block.end))}
                          </span>
                        )}
                        <div className="plan-resize" onPointerDown={(e) => startDrag(e, p.block, 'resize')} />
                      </div>
                    );
                  })}
                  {isToday && (
                    <div className="plan-now" style={{ top: (minutesOf(now) / 60) * HOUR }}>
                      <span>{hhmm(now)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {pop && popover && (
        <BlockPopover
          block={pop}
          task={pop.taskKey ? tasks.get(pop.taskKey) : undefined}
          x={popover.x}
          y={popover.y}
          editTitle={!!popover.edit}
          onClose={() => setPopover(null)}
          onSelectTask={onSelectTask}
          onError={onError}
        />
      )}
    </div>
  );
}

function BlockPopover({
  block,
  task,
  x,
  y,
  editTitle,
  onClose,
  onSelectTask,
  onError,
}: {
  block: TimeBlock;
  task?: PlannerTask;
  x: number;
  y: number;
  editTitle: boolean;
  onClose: () => void;
  onSelectTask: (key: string) => void;
  onError: (e: unknown) => void;
}) {
  const s = new Date(block.start);
  const e = new Date(block.end);
  const minutes = Math.round((e.getTime() - s.getTime()) / MINUTE);
  const [title, setTitle] = useState(block.title ?? '');
  const saveTitle = () => title.trim() && title !== block.title && void plan({ op: 'patch', kind: 'blocks', key: block.key, fields: { title: title.trim() } }).catch(onError);
  return (
    <div className="plan-popover" style={{ left: Math.min(x, window.innerWidth - 280), top: Math.min(y, window.innerHeight - 180) }} onMouseDown={(ev) => ev.stopPropagation()}>
      {task ? (
        <div className="plan-pop-title">{task.title}</div>
      ) : (
        <input
          className="plan-pop-title"
          autoFocus={editTitle}
          value={title}
          onChange={(ev) => setTitle(ev.target.value)}
          onBlur={saveTitle}
          onKeyDown={(ev) => ev.key === 'Enter' && (saveTitle(), onClose())}
        />
      )}
      <div className="meta">
        {s.getMonth() + 1}月{s.getDate()}日 {WEEKDAYS[s.getDay()]} {hhmm(s)}–{hhmm(e)}（{minutes} 分钟）
        {task && isOverdue(task) ? ' · 已过期' : ''}
      </div>
      <div className="plan-pop-actions">
        {task && (
          <button
            onClick={() => {
              onSelectTask(task.key);
              onClose();
            }}
          >
            打开任务
          </button>
        )}
        <button className="danger" onClick={() => void plan({ op: 'remove', kind: 'blocks', key: block.key }).then(onClose, onError)}>
          删除时间块
        </button>
      </div>
    </div>
  );
}

function Month({
  data,
  tasks,
  blocks,
  anchor,
  now,
  onOpenDay,
  onSelectTask,
  onError,
}: {
  data: PlannerSnapshot;
  tasks: Map<string, PlannerTask>;
  blocks: TimeBlock[];
  anchor: Date;
  now: Date;
  onOpenDay: (d: Date) => void;
  onSelectTask: (key: string) => void;
  onError: (e: unknown) => void;
}) {
  const first = viewStart('month', anchor);
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  const [target, setTarget] = useState<string | null>(null);
  const byDay = useMemo(() => {
    const m = new Map<string, TimeBlock[]>();
    for (const b of blocks) {
      const k = dayKey(new Date(b.start));
      m.set(k, [...(m.get(k) ?? []), b]);
    }
    for (const list of m.values()) list.sort((a, b) => a.start.localeCompare(b.start));
    return m;
  }, [blocks]);
  return (
    <div className="plan-month">
      {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((w) => (
        <div key={w} className="plan-month-dow">
          {w}
        </div>
      ))}
      {days.map((d) => {
        const k = dayKey(d);
        const items = byDay.get(k) ?? [];
        const due = data.tasks.filter((t) => !t.deleted && !t.done && dueDay(t) === k);
        return (
          <div
            key={k}
            className={`plan-month-cell ${d.getMonth() !== anchor.getMonth() ? 'other' : ''} ${k === dayKey(now) ? 'today' : ''} ${target === k ? 'drop' : ''}`}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(TASK_MIME)) return;
              e.preventDefault();
              setTarget(k);
            }}
            onDragLeave={() => setTarget(null)}
            onDrop={(e) => {
              setTarget(null);
              const key = e.dataTransfer.getData(TASK_MIME);
              const t = tasks.get(key);
              if (t) void patchTask(key, { due: k + (dueTime(t) ? `T${dueTime(t)}` : '') }).catch(onError);
            }}
          >
            <button className="plan-month-date" onClick={() => onOpenDay(d)} title="看这一天">
              {d.getDate()}
            </button>
            {items.slice(0, 3).map((b) => (
              <button key={b.key} className="plan-month-item" onClick={() => (b.taskKey ? onSelectTask(b.taskKey) : onOpenDay(d))}>
                <span className="meta">{hhmm(new Date(b.start))}</span> {blockTitle(b, tasks)}
              </button>
            ))}
            {due.slice(0, Math.max(0, 3 - Math.min(3, items.length))).map((t) => (
              <button
                key={t.key}
                className="plan-month-item due"
                style={{ borderLeftColor: PRIORITY_COLORS[t.priority ?? 0] }}
                draggable
                onDragStart={(e) => e.dataTransfer.setData(TASK_MIME, t.key)}
                onClick={() => onSelectTask(t.key)}
              >
                {t.title}
              </button>
            ))}
            {items.length + due.length > 3 && <span className="meta plan-more">还有 {items.length + due.length - 3} 项</span>}
          </div>
        );
      })}
    </div>
  );
}
