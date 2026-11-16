import { useMemo, useState } from 'react';
import type { PaseoAuthFailure, Snapshot } from '../../../shared/src/ipc.ts';
import type { PaseoDaemon, PaseoProject } from '../../../shared/src/model.ts';
import { Icon } from './Icons.tsx';
import { Group, Status, Tag, ago, type Tone } from './SettingsUI.tsx';

/**
 * A daemon as this page lists it. 'paired': through a pairing link pasted here; 'local': this
 * machine's own; 'synced': only its catalog, pushed to the sync server (read-only here).
 */
interface Machine {
  serverId: string;
  host: string;
  kind: 'paired' | 'local' | 'synced';
  daemon?: PaseoDaemon;
  error?: string;
  auth?: PaseoAuthFailure;
}

/** Settings → Paseo: each machine (status, code-server, its projects to import), then pairing a new one. */
export function PaseoSettings({ snap }: { snap: Snapshot }) {
  const [open, setOpen] = useState<string | null>(null);
  const [offer, setOffer] = useState('');
  const [pairing, setPairing] = useState(false);
  const [message, setMessage] = useState('');
  // The daemon turned the link away for want of its password: ask for it.
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState('');

  const writable = new Set(snap.paseoWritable);
  const machines: Machine[] = [
    ...snap.paseo.map((d) => {
      const p = snap.paseoPairings.find((x) => x.serverId === d.serverId);
      return {
        serverId: d.serverId,
        host: d.hostname,
        kind: p ? 'paired' : writable.has(d.serverId) ? 'local' : 'synced',
        daemon: d,
        error: p?.error,
        auth: p?.auth,
      } as Machine;
    }),
    // Paired but never read: nothing to list yet, only whether it answers.
    ...snap.paseoPairings
      .filter((p) => !snap.paseo.some((d) => d.serverId === p.serverId))
      .map((p) => ({ serverId: p.serverId, host: p.serverId, kind: 'paired', error: p.error, auth: p.auth }) as Machine),
  ];

  async function pair() {
    const url = offer.trim();
    if (!url || pairing) return;
    setPairing(true);
    setMessage('');
    const { error, auth } = await gleeok.pairPaseo(url, needPassword ? password : undefined);
    setPairing(false);
    if (auth) {
      setNeedPassword(true);
      return setMessage(auth === 'incorrect_password' ? '密码错误' : '此机器设有密码');
    }
    if (error) return setMessage(`已保存，但连接失败：${error}`);
    setOffer('');
    setPassword('');
    setNeedPassword(false);
    // Also pair Gleeok's own browser, so the projects' Paseo links open.
    if (snap.state.currentProjectId) gleeok.dispatch({ type: 'openLink', url, newTab: true });
  }

  return (
    <>
      <Group title="机器" count={machines.length}>
        {machines.length === 0 && <p className="s-lead">尚未连接 Paseo。在下方粘贴配对链接。</p>}
        {machines.map((m) => (
          <MachineRow key={m.serverId} m={m} snap={snap} open={open === m.serverId} onToggle={() => setOpen(open === m.serverId ? null : m.serverId)} />
        ))}
      </Group>
      <Group
        title="添加机器"
        note={
          <>
            在目标机器运行 <code>paseo daemon pair</code> 获取链接。连接经 Paseo 加密中转，链接仅保存在本机。
          </>
        }
      >
        <div className="s-row">
          <input
            className="s-field mono grow"
            placeholder="粘贴配对链接"
            value={offer}
            onChange={(e) => {
              setOffer(e.target.value);
              setNeedPassword(false);
              setMessage('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && void pair()}
          />
          {!needPassword && (
            <button className="s-btn primary" disabled={!offer.trim() || pairing} onClick={() => void pair()}>
              {pairing ? '连接中…' : '配对'}
            </button>
          )}
        </div>
        {needPassword && (
          <div className="s-row">
            <input
              autoFocus
              type="password"
              className="s-field grow"
              placeholder="Paseo 密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && password && void pair()}
            />
            <button className="s-btn primary" disabled={!password || pairing} onClick={() => void pair()}>
              {pairing ? '连接中…' : '连接'}
            </button>
          </div>
        )}
        {message && <p className="s-note s-err">{message}</p>}
      </Group>
    </>
  );
}

function MachineRow({ m, snap, open, onToggle }: { m: Machine; snap: Snapshot; open: boolean; onToggle: () => void }) {
  const [tone, label]: [Tone, string] = m.error
    ? ['bad', '离线']
    : m.kind === 'synced'
      ? ['ro', '只读']
      : m.daemon
        ? ['ok', '已连接']
        : ['warn', '连接中'];
  return (
    <>
      <button className="s-mach" onClick={onToggle}>
        <span className="s-mach-ic">
          <Icon name={m.kind === 'local' ? 'laptop' : 'server'} size={16} />
        </span>
        <span className="s-text">
          <span className="s-t">{m.host}</span>
          <span className="s-d">{m.daemon ? `${ago(m.daemon.syncedAt)}同步` : '尚未同步'}</span>
        </span>
        {m.kind === 'local' && <Tag>本机</Tag>}
        {m.daemon && <Tag>{m.daemon.projects.length} 个项目</Tag>}
        <span className="s-mach-status">
          <Status tone={tone}>{label}</Status>
        </span>
        <Icon name="chevronRight" size={16} className={`s-chev ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className="s-mpanel">
          {m.auth && <PasswordLine serverId={m.serverId} wrong={m.auth === 'incorrect_password'} />}
          {m.error && !m.auth && (
            <div className="s-mline">
              <span className="k">错误</span>
              <span className="s-err grow">{m.error}</span>
              <button className="s-btn" onClick={() => void gleeok.syncPaseo()}>
                <Icon name="rotateCw" size={14} />
                重试
              </button>
            </div>
          )}
          {m.kind === 'synced' && (
            <div className="s-mline">
              <span className="k">权限</span>
              <span className="s-d">由同步服务器提供，只读。添加配对链接后可在此创建项目。</span>
            </div>
          )}
          {m.daemon && <CodeServerLine daemon={m.daemon} />}
          {m.daemon && <ProjectPicker daemon={m.daemon} snap={snap} />}
          {m.kind === 'paired' && (
            <div className="s-mline">
              <span className="k" />
              <button className="s-btn danger" onClick={() => void gleeok.unpairPaseo(m.serverId)}>
                移除此机器
              </button>
              <span className="s-d">已导入的项目将保留</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** A paired daemon that wants its password: enter it here and it is read again at once. */
function PasswordLine({ serverId, wrong }: { serverId: string; wrong: boolean }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    await gleeok.setPaseoPassword(serverId, password);
    setBusy(false);
    setPassword('');
  };
  return (
    <div className="s-mline">
      <span className="k">密码</span>
      <input
        type="password"
        className="s-field grow"
        placeholder={wrong ? '密码错误，请重新输入' : '此机器设有密码'}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
      />
      <button className="s-btn primary" disabled={!password || busy} onClick={() => void submit()}>
        {busy ? '连接中…' : '连接'}
      </button>
    </div>
  );
}

/**
 * code-server next to this daemon: detected by the server (tailnet name of the daemon's host), or
 * typed in to override. When there is one, every project from the daemon gets a 代码 link.
 */
function CodeServerLine({ daemon }: { daemon: PaseoDaemon }) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [detecting, setDetecting] = useState(false);

  async function save() {
    const { error } = await gleeok.setCodeServer(daemon.serverId, url);
    if (error) return setNote(error);
    setNote('');
    setEditing(false);
  }

  async function detect() {
    setDetecting(true);
    setNote('');
    const r = await gleeok.detectCodeServer(daemon.serverId);
    setDetecting(false);
    setNote(r.error ? `检测失败：${r.error}` : r.url ? '' : '未检测到 code-server');
  }

  return (
    <div className="s-mline">
      <span className="k">code-server</span>
      {editing ? (
        <>
          <input
            autoFocus
            className="s-field mono grow"
            placeholder="https://主机:端口，留空则自动检测"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
          <button className="s-btn primary" onClick={() => void save()}>
            保存
          </button>
          <button className="s-btn ghost" onClick={() => setEditing(false)}>
            取消
          </button>
        </>
      ) : (
        <>
          <span className={daemon.codeServer ? 's-mono ink' : 's-d'}>{daemon.codeServer?.replace(/^https?:\/\//, '') ?? '未检测到'}</span>
          {daemon.codeServer && <Tag>{daemon.codeServerSource === 'user' ? '手动' : '自动检测'}</Tag>}
          <span className="grow" />
          {daemon.codeServerSource !== 'user' && (
            <button className="s-link" disabled={detecting} onClick={() => void detect()}>
              {detecting ? '检测中…' : '重新检测'}
            </button>
          )}
          <button
            className="s-link"
            onClick={() => {
              setUrl(daemon.codeServerSource === 'user' ? (daemon.codeServer ?? '') : '');
              setNote('');
              setEditing(true);
            }}
          >
            编辑
          </button>
        </>
      )}
      {note && <span className="s-d s-err">{note}</span>}
    </div>
  );
}

/** The daemon's projects, most recently used first; tick some and import them. */
function ProjectPicker({ daemon, snap }: { daemon: PaseoDaemon; snap: Snapshot }) {
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  // projectId → 已导入 / 已存档; archived ones are imported too, just hidden from the sidebar.
  const imported = useMemo(
    () =>
      new Map(
        [...snap.projects, ...snap.archivedProjects]
          .filter((p) => p.paseo?.daemonId === daemon.serverId)
          .map((p) => [p.paseo!.projectId, p.archived ? '已存档' : '已导入'] as const),
      ),
    [snap.projects, snap.archivedProjects, daemon.serverId],
  );
  const q = filter.trim().toLowerCase();
  const rows = daemon.projects
    .filter((p) => !q || `${p.name} ${p.path}`.toLowerCase().includes(q))
    .sort((a, b) => (b.latest?.at ?? '').localeCompare(a.latest?.at ?? ''));

  function toggle(p: PaseoProject) {
    const next = new Set(picked);
    if (next.has(p.projectId)) next.delete(p.projectId);
    else next.add(p.projectId);
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
      setMessage(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="s-mline top">
      <span className="k">项目</span>
      <div className="s-picker">
        {daemon.projects.length > 6 && (
          <label className="s-search">
            <Icon name="search" size={15} />
            <input placeholder="筛选" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
        )}
        {rows.length === 0 ? (
          <span className="s-d">{q ? '无匹配项目' : '暂无项目'}</span>
        ) : (
          <div className="s-pj">
            {rows.map((p) => {
              const done = imported.get(p.projectId);
              const on = picked.has(p.projectId);
              return (
                <button key={p.projectId} className={`s-pj-row ${done ? 'done' : ''}`} disabled={!!done} onClick={() => toggle(p)}>
                  <span className={`s-box ${done ? 'done' : on ? 'on' : ''}`}>{(done || on) && <Icon name="check" size={11} />}</span>
                  <span className="s-pj-name">{p.name}</span>
                  <span className="s-pj-path">{p.path.replace(/^\/(home|Users)\/[^/]+/, '~')}</span>
                  <span className="s-pj-when">{done ?? (p.latest?.at ? ago(p.latest.at) : '')}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="s-foot">
          <span className="s-d">{message || '导入的项目显示在侧栏'}</span>
          <button className="s-btn primary" disabled={picked.size === 0 || busy} onClick={() => void doImport()}>
            {picked.size ? `导入 ${picked.size} 个` : '导入'}
          </button>
        </div>
      </div>
    </div>
  );
}
