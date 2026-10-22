import { useMemo, useState } from 'react';
import type { Snapshot } from '../../../shared/src/ipc.ts';
import type { PaseoDaemon } from '../../../shared/src/model.ts';

export function ImportPage({ snap, toggle }: { snap: Snapshot; toggle: React.ReactNode }) {
  const [offer, setOffer] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function pair() {
    const url = offer.trim();
    setBusy(true);
    setMessage('正在通过 Paseo 中转连接…');
    const { error } = await gleeok.pairPaseo(url);
    setBusy(false);
    if (error) return setMessage(`已记住，但这次没连上：${error}`);
    setMessage('已接入');
    setOffer('');
    // Also pair Gleeok's own browser, so the projects' Paseo links open.
    if (snap.state.currentProjectId) gleeok.dispatch({ type: 'openLink', url, newTab: true });
  }

  const hostOf = (serverId: string) => snap.paseo.find((d) => d.serverId === serverId)?.hostname ?? serverId;

  return (
    <div className="entry import">
      <div className="entry-head">
        {toggle}
        <h2>从 Paseo 导入</h2>
      </div>

      <section className="card">
        <h3>配对</h3>
        <p className="hint">
          在 Paseo 里打开 设置 → 你的主机 → Pair a device（或在那台机器上运行 <code>paseo daemon pair</code>），复制配对链接粘贴到这里。
          Gleeok 会记住它，每 2 分钟通过 Paseo 的加密中转读一次那个 daemon 的项目（那台机器不用开端口），同时给内置浏览器配对，
          各项目的 Paseo 链接就能直接打开。每个 daemon、每台电脑各一次。配对链接等于那个 daemon 的完全控制权，只存在这台电脑上。
        </p>
        <div className="row">
          <input
            placeholder="https://app.paseo.sh/#offer=…"
            value={offer}
            onChange={(e) => setOffer(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && offer.trim() && !busy && void pair()}
          />
          <button className="primary" disabled={!offer.trim() || busy} onClick={() => void pair()}>
            配对并接入
          </button>
        </div>
        {message && <p className="meta">{message}</p>}
        {snap.paseoPairings.length > 0 && (
          <table className="paseo-table">
            <tbody>
              {snap.paseoPairings.map((p) => (
                <tr key={p.serverId}>
                  <td className="name">{hostOf(p.serverId)}</td>
                  <td className="path">{p.serverId}</td>
                  <td className="num">{p.error ? `连接失败：${p.error}` : p.at ? `读取于 ${ago(p.at)}` : '等待读取'}</td>
                  <td className="num">
                    <button onClick={() => void gleeok.unpairPaseo(p.serverId)} title="不再从这台电脑读取这个 daemon（已导入的项目保留）">
                      忘记
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {snap.paseo.length === 0 && <p className="hint">还没有 Paseo 数据：在上面粘贴一个 daemon 的配对链接。</p>}
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
        <CodeServerSetting daemon={daemon} />
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

/**
 * code-server next to this daemon: detected by the server (tailnet name of the daemon's host), or
 * typed in to override. When there is one, every project from the daemon gets a 代码 link.
 */
function CodeServerSetting({ daemon }: { daemon: PaseoDaemon }) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');

  async function save() {
    const { error } = await gleeok.setCodeServer(daemon.serverId, url);
    if (error) return setNote(error);
    setNote('');
    setEditing(false);
  }

  async function detect() {
    setNote('正在检测…');
    const r = await gleeok.detectCodeServer(daemon.serverId);
    setNote(r.error ? `检测失败：${r.error}` : r.url ? '' : `没在 ${daemon.hostname} 上找到 code-server`);
  }

  if (editing) {
    return (
      <span className="code-server-edit">
        <input
          autoFocus
          placeholder="https://主机:端口（留空 = 自动检测）"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <button onClick={() => void save()}>保存</button>
        <button onClick={() => setEditing(false)}>取消</button>
        {note && <span className="error">{note}</span>}
      </span>
    );
  }
  const shown = daemon.codeServer?.replace(/^https?:\/\//, '');
  return (
    <span className="code-server-edit">
      <button
        className={daemon.codeServer ? 'code-server set' : 'code-server'}
        onClick={() => {
          setUrl(daemon.codeServerSource === 'user' ? (daemon.codeServer ?? '') : '');
          setNote('');
          setEditing(true);
        }}
        title={
          daemon.codeServer
            ? `这个 daemon 的项目都有一条「代码」链接，打开最近 workspace 的目录。点击可以手动指定地址`
            : `在 ${daemon.hostname} 上没检测到 code-server。点击可以手动指定地址`
        }
      >
        {daemon.codeServer
          ? `</> ${shown}${daemon.codeServerSource === 'user' ? '（手动）' : '（自动检测）'}`
          : '</> 没有 code-server'}
      </button>
      {daemon.codeServerSource !== 'user' && (
        <button className="link" onClick={() => void detect()} title="装好 code-server 后不用等，马上检测">
          重新检测
        </button>
      )}
      {note && <span className="meta">{note}</span>}
    </span>
  );
}

function ago(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}
