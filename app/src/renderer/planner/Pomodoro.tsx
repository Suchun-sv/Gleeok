import { useEffect, useRef, useState } from 'react';
import type { PomodoroState } from '../../../../shared/src/ipc.ts';
import type { PomodoroSettings } from '../../../../shared/src/model.ts';

export const PHASE_NAMES = { idle: '', focus: '专注', short: '短休息', long: '长休息' } as const;

/** Milliseconds left in the phase. */
export const remaining = (p: PomodoroState, now: number) => (p.running && p.endsAt ? Math.max(0, p.endsAt - now) : (p.remaining ?? 0));

export const mmss = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Re-render every second while the clock runs; read the time with Date.now() when drawing. */
export function useTick(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

/** "Start the break / the next pomodoro?" when a phase ends; nothing starts without a yes. */
export function PomodoroDialog({ state, settings, winId, onClose }: { state: PomodoroState; settings: PomodoroSettings; winId: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  const close = (go?: boolean) => {
    if (go !== undefined) gleeok.dispatch({ type: 'pomoConfirm', go });
    gleeok.dispatch({ type: 'closePalette', winId });
    onClose();
  };
  const next = state.awaiting;
  if (!next) {
    // Already answered (here or in another window).
    return null;
  }
  const minutes = next === 'focus' ? settings.focusMin : next === 'short' ? settings.shortMin : settings.longMin;
  const focusEnded = next !== 'focus';
  return (
    <div className="palette-backdrop" onMouseDown={() => close()}>
      <div
        ref={box}
        tabIndex={0}
        className="palette vault"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') close(true);
          if (e.key === 'Escape') close(false);
        }}
      >
        <div className="vault-form pomo-dialog">
          <h3>{focusEnded ? '🍅 番茄完成' : '休息结束'}</h3>
          {state.taskTitle && <p className="pomo-task">{state.taskTitle}</p>}
          <p className="hint">
            {focusEnded
              ? `今天这一轮已完成 ${state.focusDone} 个番茄。${next === 'long' ? '该好好休息一下了。' : ''}`
              : '准备好就开始下一个番茄。'}
          </p>
          <div className="row">
            <span className="spacer" />
            <button onClick={() => close(false)}>{focusEnded ? '先不休息' : '结束'}</button>
            <button className="primary" onClick={() => close(true)}>
              {focusEnded ? `开始${PHASE_NAMES[next]}（${minutes} 分钟）` : `开始下一个番茄（${minutes} 分钟）`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
