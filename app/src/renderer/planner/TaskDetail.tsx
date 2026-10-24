import { useEffect, useRef, useState } from 'react';
import type { PlannerSnapshot } from '../../../../shared/src/ipc.ts';
import { PRIORITY_LABELS, type PlannerTask, type Subtask } from '../../../../shared/src/planner.ts';
import type { Project } from '../../../../shared/src/model.ts';
import { Icon } from '../Icons.tsx';
import { PRIORITY_COLORS, WEEKDAYS, dueDay, dueTime, hhmm, patchTask, plan } from './data.ts';

/** Everything about one task, saved as it is edited. */
export function TaskDetail({
  data,
  task,
  projects,
  onClose,
  onJump,
  onError,
}: {
  data: PlannerSnapshot;
  task: PlannerTask;
  projects: Project[];
  onClose: () => void;
  /** Show this day in the calendar. */
  onJump: (day: Date) => void;
  onError: (e: unknown) => void;
}) {
  const save = (fields: Record<string, unknown>) => void patchTask(task.key, fields).catch(onError);
  const blocks = data.blocks.filter((b) => b.taskKey === task.key).sort((a, b) => a.start.localeCompare(b.start));
  const pomodoros = data.pomodoros.filter((p) => p.taskKey === task.key && p.kind === 'focus' && p.completed);
  const day = dueDay(task) ?? '';
  const time = dueTime(task) ?? '';
  const setDue = (d: string, t: string) => save({ due: d ? (t ? `${d}T${t}` : d) : null });

  return (
    <div className="plan-detail">
      <div className="plan-detail-head">
        <button
          className="plan-check"
          style={{ borderColor: PRIORITY_COLORS[task.priority ?? 0] }}
          disabled={!!task.deleted}
          onClick={() => save(task.done ? { done: null, doneAt: null } : { done: true, doneAt: new Date().toISOString() })}
          title={task.done ? '标为未完成' : '完成'}
        >
          {task.done ? '✓' : ''}
        </button>
        <Text key={`t${task.key}`} className="plan-detail-title" value={task.title} placeholder="任务名称" onSave={(title) => save({ title })} />
        <button className="icon-btn" onClick={onClose} title="收起">
          ×
        </button>
      </div>

      <div className="plan-fields">
        <label>
          <span>截止</span>
          <input type="date" value={day} onChange={(e) => setDue(e.target.value, time)} />
          <input type="time" value={time} disabled={!day} onChange={(e) => setDue(day, e.target.value)} />
          {day && (
            <button className="icon-btn" onClick={() => setDue('', '')} title="清除截止日期">
              ×
            </button>
          )}
        </label>
        <div className="plan-field">
          <span>优先级</span>
          <div className="plan-seg">
            {PRIORITY_LABELS.map((label, p) => (
              <button
                key={p}
                className={(task.priority ?? 0) === p ? 'on' : ''}
                style={{ color: (task.priority ?? 0) === p && p ? PRIORITY_COLORS[p] : undefined }}
                onClick={() => save({ priority: p || null })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <label>
          <span>预估</span>
          <input type="number" min={0} max={99} value={task.estimate ?? 0} onChange={(e) => save({ estimate: Number(e.target.value) || null })} className="plan-num" />
          <span className="meta">个番茄（{(task.estimate ?? 0) * 25} 分钟）· 已完成 {pomodoros.length} 个</span>
        </label>
        {!task.done && !task.deleted && (
          <button className="plan-start-btn" onClick={() => gleeok.dispatch({ type: 'pomoStart', taskKey: task.key })}>
            <Icon name="play" size={12} /> 开始番茄
          </button>
        )}
        <label>
          <span>项目</span>
          <select value={task.projectId ?? ''} onChange={(e) => save({ projectId: e.target.value || null })}>
            <option value="">收件箱（不属于项目）</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <Subtasks key={`s${task.key}`} subtasks={task.subtasks ?? []} onSave={(subtasks) => save({ subtasks })} />

      <div className="plan-block-title">备注</div>
      <Text key={`n${task.key}`} className="plan-notes" value={task.notes ?? ''} placeholder="写点什么…" multiline onSave={(notes) => save({ notes: notes || null })} />

      {blocks.length > 0 && (
        <>
          <div className="plan-block-title">时间块</div>
          {blocks.map((b) => {
            const s = new Date(b.start);
            return (
              <button key={b.key} className="plan-blockref" onClick={() => onJump(s)}>
                {s.getMonth() + 1}月{s.getDate()}日 {WEEKDAYS[s.getDay()]} {hhmm(s)}–{hhmm(new Date(b.end))}
              </button>
            );
          })}
        </>
      )}

      <div className="plan-detail-foot">
        {task.deleted ? (
          <>
            <button onClick={() => save({ deleted: null })}>恢复</button>
            <button
              className="danger"
              onClick={() => confirm('彻底删除这个任务和它的时间块？') && void plan({ op: 'remove', kind: 'tasks', key: task.key }).then(onClose, onError)}
            >
              彻底删除
            </button>
          </>
        ) : (
          <button className="danger" onClick={() => (save({ deleted: true }), onClose())}>
            <Icon name="trash" size={13} /> 移到回收站
          </button>
        )}
        <span className="meta">创建于 {new Date(task.dateAdded).toLocaleDateString('zh-CN')}</span>
      </div>
    </div>
  );
}

/** An input that keeps its draft while focused and saves on blur / Enter. */
function Text({ value, onSave, placeholder, multiline, className }: { value: string; onSave: (v: string) => void; placeholder?: string; multiline?: boolean; className?: string }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const props = {
    className,
    value: draft,
    placeholder,
    onFocus: () => (focused.current = true),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => {
      focused.current = false;
      if (draft !== value) onSave(draft);
    },
  };
  return multiline ? <textarea {...props} rows={5} /> : <input {...props} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />;
}

function Subtasks({ subtasks, onSave }: { subtasks: Subtask[]; onSave: (s: Subtask[] | null) => void }) {
  const [draft, setDraft] = useState('');
  const put = (next: Subtask[]) => onSave(next.length ? next : null);
  return (
    <>
      <div className="plan-block-title">
        子任务 {subtasks.length > 0 && <span className="meta">{subtasks.filter((s) => s.done).length}/{subtasks.length}</span>}
      </div>
      {subtasks.map((s) => (
        <div key={s.id} className={`plan-subtask ${s.done ? 'done' : ''}`}>
          <input type="checkbox" checked={s.done} onChange={() => put(subtasks.map((x) => (x.id === s.id ? { ...x, done: !x.done } : x)))} />
          <Text value={s.title} onSave={(title) => put(subtasks.map((x) => (x.id === s.id ? { ...x, title } : x)))} />
          <button className="icon-btn" onClick={() => put(subtasks.filter((x) => x.id !== s.id))} title="删除">
            ×
          </button>
        </div>
      ))}
      <input
        className="plan-subtask-add"
        placeholder="+ 子任务，回车"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !draft.trim()) return;
          put([...subtasks, { id: Math.random().toString(36).slice(2, 10), title: draft.trim(), done: false }]);
          setDraft('');
        }}
      />
    </>
  );
}
