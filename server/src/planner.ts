import { join } from 'node:path';
import { PLANNER_KINDS, type PlannerKind } from '../../shared/src/planner.ts';
import { SyncedStore, type Obj } from './synced.ts';

/**
 * The 日程 store (planner.db): tasks, time blocks and pomodoro records, synced like the 文献库.
 * Deleting a task for good takes its time blocks; pomodoro records stay (they keep the title).
 */
export class Planner extends SyncedStore<PlannerKind> {
  constructor(dir: string) {
    super(join(dir, 'planner.db'), PLANNER_KINDS);
  }

  protected parse(kind: PlannerKind, o: Obj): Obj | string {
    const isTime = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
    const optString = (v: unknown) => v === undefined || typeof v === 'string';
    switch (kind) {
      case 'tasks': {
        if (typeof o.title !== 'string') return 'title is required';
        if (!optString(o.notes)) return 'notes is a string';
        if (o.due !== undefined && !(typeof o.due === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(o.due))) return 'due is YYYY-MM-DD or YYYY-MM-DDTHH:mm';
        if (o.priority !== undefined && !(Number.isInteger(o.priority) && (o.priority as number) >= 0 && (o.priority as number) <= 3)) return 'priority is 0-3';
        if (
          o.subtasks !== undefined &&
          !(Array.isArray(o.subtasks) && o.subtasks.every((s) => s && typeof (s as Obj).id === 'string' && typeof (s as Obj).title === 'string' && typeof (s as Obj).done === 'boolean'))
        )
          return 'subtasks are { id, title, done }';
        if (o.estimate !== undefined && !(Number.isInteger(o.estimate) && (o.estimate as number) >= 0 && (o.estimate as number) <= 99)) return 'estimate is 0-99';
        if (!optString(o.projectId)) return 'projectId is a string';
        if (o.done !== undefined && typeof o.done !== 'boolean') return 'done is a boolean';
        if (o.doneAt !== undefined && !isTime(o.doneAt)) return 'doneAt is a time';
        if (o.order !== undefined && typeof o.order !== 'number') return 'order is a number';
        if (o.deleted !== undefined && typeof o.deleted !== 'boolean') return 'deleted is a boolean';
        return o;
      }
      case 'blocks':
        if (!isTime(o.start) || !isTime(o.end)) return 'start and end are times';
        if (Date.parse(o.end as string) <= Date.parse(o.start as string)) return 'end is after start';
        if (!optString(o.taskKey) || !optString(o.title)) return 'taskKey and title are strings';
        if (!o.taskKey && !o.title) return 'a block needs a task or a title';
        return o;
      case 'pomodoros':
        if (o.kind !== 'focus' && o.kind !== 'short' && o.kind !== 'long') return 'kind is focus, short or long';
        if (!isTime(o.start) || !isTime(o.end)) return 'start and end are times';
        if (typeof o.completed !== 'boolean') return 'completed is a boolean';
        if (!optString(o.taskKey) || !optString(o.taskTitle) || !optString(o.blockKey)) return 'taskKey, taskTitle and blockKey are strings';
        return o;
    }
  }

  protected checkRefs(kind: PlannerKind, o: Obj, batch: Obj[]): string | undefined {
    if (kind === 'blocks' && o.taskKey && !this.get('tasks', o.taskKey as string) && !batch.some((b) => b.key === o.taskKey)) return `task ${o.taskKey} not found`;
    return undefined;
  }

  protected parentOf(kind: PlannerKind, o: Obj): string | null {
    return kind === 'blocks' ? ((o.taskKey as string | undefined) ?? null) : null;
  }

  protected stamp(kind: PlannerKind, o: Obj, previous: Obj | undefined) {
    if (kind !== 'tasks') return;
    const now = new Date().toISOString();
    o.dateAdded = previous?.dateAdded ?? o.dateAdded ?? now;
    o.dateModified = now;
  }

  protected cascade(kind: PlannerKind, key: string, version: number) {
    if (kind === 'tasks') for (const b of this.children('blocks', key)) this.remove('blocks', b, version);
  }
}
