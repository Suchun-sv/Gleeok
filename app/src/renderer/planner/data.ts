import { useSyncExternalStore } from 'react';
import type { PlannerOp, PlannerSnapshot } from '../../../../shared/src/ipc.ts';
import type { PlannerTask, Pomodoro, TimeBlock } from '../../../../shared/src/planner.ts';

// One subscription for every view of the 日程 in this window.
let current: PlannerSnapshot | null = null;
const listeners = new Set<() => void>();
let started = false;

function subscribe(cb: () => void) {
  if (!started) {
    started = true;
    void gleeok.getPlanner().then((s) => {
      current ??= s;
      for (const l of listeners) l();
    });
    gleeok.onPlanner((s) => {
      current = s;
      for (const l of listeners) l();
    });
  }
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function usePlanner(): PlannerSnapshot | null {
  return useSyncExternalStore(subscribe, () => current);
}

export async function plan<T = unknown>(op: PlannerOp): Promise<T> {
  const r = await gleeok.planner(op);
  if (r.error) throw new Error(r.error);
  return r.result as T;
}

export const patchTask = (key: string, fields: Record<string, unknown>) => plan<PlannerTask>({ op: 'patch', kind: 'tasks', key, fields });

// ---- dates (all local time) ----

const pad = (n: number) => String(n).padStart(2, '0');
/** "2026-10-24" for a local day. */
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDay = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Weeks start on Monday. */
export const startOfWeek = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The day part of a due date ("2026-10-24" or "2026-10-24T15:00"). */
export const dueDay = (t: PlannerTask) => t.due?.slice(0, 10);
export const dueTime = (t: PlannerTask) => (t.due && t.due.length > 10 ? t.due.slice(11, 16) : undefined);

export function isOverdue(t: PlannerTask, now = new Date()): boolean {
  if (!t.due || t.done) return false;
  if (t.due.length > 10) return new Date(t.due) < now;
  return t.due < dayKey(now);
}

/** "今天", "明天 15:00", "周六", "11月3日", "2027年1月5日". */
export function dueLabel(t: PlannerTask, now = new Date()): string {
  const day = dueDay(t);
  if (!day) return '';
  const time = dueTime(t);
  const d = parseDay(day);
  const diff = Math.round((d.getTime() - startOfDay(now).getTime()) / 86_400_000);
  let label: string;
  if (diff === 0) label = '今天';
  else if (diff === 1) label = '明天';
  else if (diff === -1) label = '昨天';
  else if (diff > 1 && diff < 7) label = WEEKDAYS[d.getDay()];
  else if (d.getFullYear() === now.getFullYear()) label = `${d.getMonth() + 1}月${d.getDate()}日`;
  else label = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  return time ? `${label} ${time}` : label;
}

/** Hand-sorted order first, then the oldest. */
export const byOrder = (a: PlannerTask, b: PlannerTask) => (a.order ?? 0) - (b.order ?? 0) || a.dateAdded.localeCompare(b.dateAdded);

/** Completed focus pomodoros per task. */
export function pomodoroCounts(pomodoros: Pomodoro[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of pomodoros) if (p.kind === 'focus' && p.completed && p.taskKey) out.set(p.taskKey, (out.get(p.taskKey) ?? 0) + 1);
  return out;
}

/** A block's title: its task's, or its own. */
export const blockTitle = (b: TimeBlock, tasks: Map<string, PlannerTask>) => (b.taskKey ? (tasks.get(b.taskKey)?.title ?? '（已删除的任务）') : (b.title ?? ''));

export const TASK_MIME = 'application/x-gleeok-task';
export const PRIORITY_COLORS = ['var(--muted)', '#4a9eff', '#e5a33b', '#ef6b6b'];
