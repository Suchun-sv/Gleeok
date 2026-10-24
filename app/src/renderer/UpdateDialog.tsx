import { useEffect, useRef } from 'react';
import type { Snapshot } from '../../../shared/src/ipc.ts';

/** New Gleeok commits upstream: what changed, and update-and-restart. Shown over the pages. */
export function UpdateDialog({ update, winId, onClose }: { update: Snapshot['update']; winId: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  function close() {
    gleeok.dispatch({ type: 'closePalette', winId });
    onClose();
  }
  const { commits, step, error } = update;
  // Installed builds get a release: "版本 x.y.z" first, then its notes.
  const release = commits[0]?.startsWith('版本 ') ? commits[0].slice(3) : null;
  const beta = commits[0]?.startsWith('测试版 ') ? commits[0].slice(4) : null;
  const items = release || beta ? commits.slice(1) : commits;
  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div
        ref={box}
        tabIndex={0}
        className="palette vault"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          if (e.key === 'Enter' && !step) (commits.length ? gleeok.dispatch({ type: 'selfUpdate' }) : close());
        }}
      >
        <div className="vault-form update-dialog">
          <h3>
            {release
              ? `Gleeok ${release} 可以更新了`
              : beta
                ? `测试版有更新（${beta}）`
                : commits.length
                  ? `Gleeok 有 ${commits.length} 个更新`
                  : 'Gleeok 已经是最新版本'}
          </h3>
          {items.length > 0 && (
            <ul>
              {items.slice(0, 12).map((c, i) => (
                <li key={i}>{c}</li>
              ))}
              {items.length > 12 && <li className="hint">…还有 {items.length - 12} 个</li>}
            </ul>
          )}
          {step && <p className="progress">正在更新：{step}</p>}
          {error && <p className="error">更新失败：{error}</p>}
          <div className="row">
            <span className="hint">
              {commits.length
                ? '会拉取代码、安装依赖、重新构建，然后重启 Gleeok；打开的标签页会恢复。'
                : `当前版本构建于 ${new Date(__GLEEOK_BUILD__).toLocaleString('zh-CN', { hour12: false })}。`}
            </span>
            <button onClick={close}>{step ? '在后台继续' : commits.length ? '稍后' : '好'}</button>
            {commits.length > 0 && (
              <button className="primary" disabled={!!step} onClick={() => gleeok.dispatch({ type: 'selfUpdate' })}>
                {error ? '重试' : '更新并重启'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
