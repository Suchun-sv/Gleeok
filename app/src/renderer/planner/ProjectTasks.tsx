import { useState } from 'react';
import type { PlannerTask } from '../../../../shared/src/planner.ts';
import { PRIORITY_COLORS, byOrder, dueLabel, isOverdue, patchTask, plan, usePlanner } from './data.ts';
import { showProjectTasks } from './PlannerView.tsx';

/** A project's open tasks in its settings drawer: tick, add, or jump to them in the 日程. */
export function ProjectTasks({ projectId, onOpenPlanner }: { projectId: string; onOpenPlanner: () => void }) {
  const data = usePlanner();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const tasks = (data?.tasks ?? []).filter((t) => t.projectId === projectId && !t.done && !t.deleted).sort(byOrder);
  const add = () => {
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    const top = Math.min(0, ...(data?.tasks ?? []).map((t) => t.order ?? 0)) - 1;
    void plan<PlannerTask[]>({ op: 'create', kind: 'tasks', objects: [{ title, projectId, order: top }] }).catch((e) => setError(String(e.message ?? e)));
  };
  return (
    <section>
      <h4>
        任务
        <button
          className="drawer-h4-link"
          onClick={() => {
            showProjectTasks(projectId);
            onOpenPlanner();
          }}
        >
          在日程中查看
        </button>
      </h4>
      {tasks.length === 0 && <p className="hint">这个项目没有未完成的任务。</p>}
      {tasks.map((t) => (
        <div key={t.key} className="drawer-task">
          <button
            className="plan-check"
            style={{ borderColor: PRIORITY_COLORS[t.priority ?? 0] }}
            onClick={() => void patchTask(t.key, { done: true, doneAt: new Date().toISOString() }).catch((e) => setError(String(e.message ?? e)))}
            title="完成"
          />
          <span className="plan-title">{t.title}</span>
          {t.due && <span className={`plan-due ${isOverdue(t) ? 'late' : ''}`}>{dueLabel(t)}</span>}
        </div>
      ))}
      <input className="plan-add" placeholder="+ 添加任务，回车" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
      {error && <p className="error">{error}</p>}
    </section>
  );
}
