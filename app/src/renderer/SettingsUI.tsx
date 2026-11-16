import type { ReactNode } from 'react';

/**
 * Settings building blocks, as in the design (Claude Design 「设置」): groups of rows, each a title
 * with an optional one-line description on the left and its control on the right. Facts sit in
 * their own elements (tag, status, value), never joined into one line.
 */

export function Group({ title, count, note, children }: { title?: string; count?: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="s-group">
      {title && (
        <h2 className="s-gh">
          {title}
          {count !== undefined && <span className="cnt">{count}</span>}
        </h2>
      )}
      {children}
      {note && <p className="s-note">{note}</p>}
    </section>
  );
}

export function Row({ title, desc, children, className }: { title: ReactNode; desc?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={`s-row ${className ?? ''}`}>
      <div className="s-text">
        <span className="s-t">{title}</span>
        {desc && <span className="s-d">{desc}</span>}
      </div>
      {children}
    </div>
  );
}

export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`s-sw ${on ? 'on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  );
}

export function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="s-seg">
      {options.map(([v, label]) => (
        <button key={String(v)} className={v === value ? 'on' : ''} onClick={() => v !== value && onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export type Tone = 'ok' | 'ro' | 'warn' | 'bad';

export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="s-status">
      <span className={`s-dot ${tone}`} />
      {children}
    </span>
  );
}

export const Tag = ({ children }: { children: ReactNode }) => <span className="s-tag">{children}</span>;

export const Kbd = ({ children }: { children: ReactNode }) => <span className="s-kbd">{children}</span>;

export const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && e.currentTarget.blur();

/** 刚刚 / N 分钟前 / N 小时前 / N 天前. */
export function ago(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}
