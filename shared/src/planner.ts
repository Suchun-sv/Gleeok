/**
 * The 日程 (planner) data model, shared by the server, Gleeok and the phone page: tasks, time
 * blocks on the calendar, and pomodoro records. Blocks only say "this time is for that"; a task is
 * done when it is ticked, never because its blocks passed. See docs/planner.md.
 */

export type PlannerKind = 'tasks' | 'blocks' | 'pomodoros';
export const PLANNER_KINDS: PlannerKind[] = ['tasks', 'blocks', 'pomodoros'];

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

interface Versioned {
  key: string;
  /** Planner version of this object's last change (set by the server). */
  version: number;
}

export interface PlannerTask extends Versioned {
  title: string;
  notes?: string;
  /** "2026-10-24", or with a time "2026-10-24T15:00" (local time). */
  due?: string;
  /** 0 none, 1 low, 2 medium, 3 high. */
  priority?: number;
  subtasks?: Subtask[];
  /** Estimated pomodoros. */
  estimate?: number;
  /** The Gleeok project it belongs to; none is the inbox. */
  projectId?: string;
  done?: boolean;
  doneAt?: string;
  /** Position in hand-sorted lists (smaller first). */
  order?: number;
  /** In the trash. */
  deleted?: boolean;
  dateAdded: string;
  dateModified: string;
}

export interface TimeBlock extends Versioned {
  /** The task this time is for; free blocks ("午饭") have a title instead. */
  taskKey?: string;
  title?: string;
  /** ISO times with offset. */
  start: string;
  end: string;
}

export interface Pomodoro extends Versioned {
  taskKey?: string;
  /** Kept so the record still reads well after its task is deleted. */
  taskTitle?: string;
  blockKey?: string;
  kind: 'focus' | 'short' | 'long';
  start: string;
  end: string;
  /** Ran to the end (a stopped one is kept but does not count). */
  completed: boolean;
}

export interface PlannerChanges {
  version: number;
  tasks: PlannerTask[];
  blocks: TimeBlock[];
  pomodoros: Pomodoro[];
  deleted: Record<PlannerKind, string[]>;
}

export const PRIORITY_LABELS = ['无', '低', '中', '高'];
