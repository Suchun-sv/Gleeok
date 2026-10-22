import { useMemo, useState } from 'react';
import type { Snapshot } from '../../../shared/src/ipc.ts';
import type { PaseoDaemon } from '../../../shared/src/model.ts';

export function ImportPage({ snap, toggle }: { snap: Snapshot; toggle: React.ReactNode }) {
  const [offer, setOffer] = useState('');
  return (
    <div className="entry import">
      <div className="entry-head">
        {toggle}
        <h2>从 Paseo 导入</h2>
      </div>

      <section className="card">
        <h3>配对</h3>
        <p className="hint">
          Gleeok 的内置浏览器第一次打开 Paseo 之前要配对一次（每台电脑一次）：在 Paseo 里打开 设置 → 你的主机 → Pair a
          device，复制配对链接，粘贴到这里。之后各项目的 Paseo 链接就能直接打开。
        </p>
        <div className="row">
          <input
            placeholder="https://app.paseo.sh/#offer=…"
            value={offer}
            onChange={(e) => setOffer(e.target.value)}
          />
          <button
            disabled={!offer.trim() || !snap.state.currentProjectId}
            onClick={() => gleeok.dispatch({ type: 'openLink', url: offer.trim() })}
            title={snap.state.currentProjectId ? '在当前项目的焦点栏里打开' : '先选中一个项目'}
          >
            打开
          </button>
        </div>
      </section>

      {snap.paseo.length === 0 && (
        <p className="hint">
          服务器上还没有 Paseo 数据。在运行 Paseo daemon 的机器上执行 <code>node paseo-sync/sync.mjs</code>，或安装
          deploy/ 里的定时同步。
        </p>
      )}
      {snap.paseo.map((d) => (
        <DaemonSection key={d.serverId} daemon={d} snap={snap} />
      ))}
    </div>
  );
}

function DaemonSection({ daemon, snap }: { daemon: PaseoDaemon; snap: Snapshot }) {
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  // projectId → '已导入' / '已存档'; archived ones are imported too, just hidden from the sidebar.
  const imported = useMemo(
    () =>
      new Map(
        [...snap.projects, ...snap.archivedProjects]
          .filter((p) => p.paseo?.daemonId === daemon.serverId)
          .map((p) => [p.paseo!.projectId, p.archived ? '已存档' : '已导入'] as const),
      ),
    [snap.projects, snap.archivedProjects, daemon.serverId],
  );

  // Most recently used first; projects with no workspace activity sink to the bottom.
  const rows = daemon.projects
    .filter((p) => !filter || `${p.name} ${p.path}`.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => (b.latest?.at ?? '').localeCompare(a.latest?.at ?? ''));

  function toggle(id: string) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  }

  async function doImport() {
    setBusy(true);
    setMessage('');
    try {
      const created = await gleeok.importPaseo(daemon.serverId, [...picked]);
      setMessage(`已导入 ${created.length} 个项目`);
      setPicked(new Set());
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h3>
        {daemon.hostname} <span className="meta">· {daemon.serverId} · 同步于 {ago(daemon.syncedAt)} · {daemon.projects.length} 个项目</span>
      </h3>
      <div className="row">
        <input placeholder="筛选名称或路径" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {message && <span className="meta">{message}</span>}
        <button className="primary" disabled={picked.size === 0 || busy} onClick={() => void doImport()}>
          导入选中的 {picked.size} 个
        </button>
      </div>
      <table className="paseo-table">
        <tbody>
          {rows.map((p) => {
            const done = imported.has(p.projectId);
            return (
              <tr key={p.projectId} className={done ? 'done' : ''} onClick={() => !done && toggle(p.projectId)}>
                <td>
                  <input type="checkbox" checked={done || picked.has(p.projectId)} disabled={done} readOnly />
                </td>
                <td className="name">{p.name}</td>
                <td className="path">{p.path}</td>
                <td className="num">{p.workspaceCount} 个 workspace</td>
                <td className="num">{done ? imported.get(p.projectId) : p.latest?.at ? ago(p.latest.at) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function ago(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}
