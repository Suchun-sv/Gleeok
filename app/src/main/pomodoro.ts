import type { PomodoroState } from '../../../shared/src/ipc.ts';
import type { PomodoroSettings } from '../../../shared/src/model.ts';

/** A minute of pomodoro time; dev scripts shrink it to a second to run whole cycles. */
const MINUTE_MS = process.env.GLEEOK_FAST_POMODORO ? 1000 : 60_000;

interface Hooks {
  settings(): PomodoroSettings;
  changed(): void;
  /** A phase ended (or was stopped): keep a record of it. */
  record(r: { kind: 'focus' | 'short' | 'long'; start: string; end: string; completed: boolean; taskKey?: string; taskTitle?: string; blockKey?: string }): void;
  /** Time is up: tell the user and ask what comes next. */
  finished(phase: 'focus' | 'short' | 'long', state: PomodoroState): void;
}

/**
 * The pomodoro clock lives in main, so it keeps going whatever the windows show. One phase at a
 * time; when it ends nothing starts by itself: the state waits for the user to confirm the break
 * (after focus) or the next pomodoro (after a break).
 */
export class PomodoroTimer {
  state: PomodoroState = { phase: 'idle', running: false, focusDone: 0 };
  #timer: NodeJS.Timeout | undefined;
  #startedAt = 0;

  constructor(private hooks: Hooks) {}

  #minutes(phase: 'focus' | 'short' | 'long') {
    const s = this.hooks.settings();
    return phase === 'focus' ? s.focusMin : phase === 'short' ? s.shortMin : s.longMin;
  }

  start(phase: 'focus' | 'short' | 'long', task?: { key: string; title: string; blockKey?: string }) {
    this.#finishRecord(false);
    const ms = this.#minutes(phase) * MINUTE_MS;
    this.#startedAt = Date.now();
    // A break (or a pomodoro started without a task) stays with the task it follows.
    const taskInfo = task
      ? { taskKey: task.key, taskTitle: task.title, blockKey: task.blockKey }
      : { taskKey: this.state.taskKey, taskTitle: this.state.taskTitle, blockKey: this.state.blockKey };
    this.state = { phase, running: true, endsAt: Date.now() + ms, length: ms, focusDone: this.state.focusDone, ...taskInfo };
    this.#arm();
    this.hooks.changed();
  }

  pause() {
    if (!this.state.running || !this.state.endsAt) return;
    clearTimeout(this.#timer);
    this.state = { ...this.state, running: false, remaining: Math.max(0, this.state.endsAt - Date.now()), endsAt: undefined };
    this.hooks.changed();
  }

  resume() {
    if (this.state.running || this.state.remaining === undefined) return;
    this.state = { ...this.state, running: true, endsAt: Date.now() + this.state.remaining, remaining: undefined };
    this.#arm();
    this.hooks.changed();
  }

  /** End the phase now as if its time were up (a skipped focus does not count). */
  skip() {
    if (this.state.phase === 'idle' || this.state.awaiting) return;
    this.#end(false);
  }

  /** Give up: back to idle, keeping a record of the unfinished focus. */
  stop() {
    clearTimeout(this.#timer);
    this.#finishRecord(false);
    this.state = { phase: 'idle', running: false, focusDone: this.state.focusDone };
    this.hooks.changed();
  }

  /** The answer to "start the break / the next pomodoro?". */
  confirm(go: boolean) {
    const awaiting = this.state.awaiting;
    if (!awaiting) return;
    if (!go) {
      this.state = { phase: 'idle', running: false, focusDone: this.state.focusDone, taskKey: this.state.taskKey, taskTitle: this.state.taskTitle };
      this.hooks.changed();
      return;
    }
    if (awaiting === 'focus') this.start('focus', this.state.taskKey ? { key: this.state.taskKey, title: this.state.taskTitle ?? '' } : undefined);
    else this.start(awaiting);
  }

  #arm() {
    clearTimeout(this.#timer);
    const left = (this.state.endsAt ?? Date.now()) - Date.now();
    this.#timer = setTimeout(() => this.#end(true), Math.max(0, left));
  }

  #end(completed: boolean) {
    clearTimeout(this.#timer);
    const phase = this.state.phase as 'focus' | 'short' | 'long';
    this.#finishRecord(completed);
    const focusDone = this.state.focusDone + (phase === 'focus' && completed ? 1 : 0);
    this.state = {
      ...this.state,
      running: false,
      endsAt: undefined,
      remaining: undefined,
      focusDone,
      awaiting: phase === 'focus' ? (this.#breakAfter(focusDone) as 'short' | 'long') : 'focus',
    };
    this.hooks.changed();
    this.hooks.finished(phase, this.state);
  }

  #breakAfter(focusDone: number) {
    const every = Math.max(1, this.hooks.settings().longEvery);
    return focusDone > 0 && focusDone % every === 0 ? 'long' : 'short';
  }

  /** Record the phase that is ending, if one is under way and lasted more than a moment. */
  #finishRecord(completed: boolean) {
    const s = this.state;
    if (s.phase === 'idle' || s.awaiting || !this.#startedAt) return;
    const end = Date.now();
    if (!completed && end - this.#startedAt < MINUTE_MS) return;
    this.hooks.record({
      kind: s.phase,
      start: new Date(this.#startedAt).toISOString(),
      end: new Date(end).toISOString(),
      completed,
      taskKey: s.taskKey,
      taskTitle: s.taskTitle,
      blockKey: s.blockKey,
    });
    this.#startedAt = 0;
  }
}
