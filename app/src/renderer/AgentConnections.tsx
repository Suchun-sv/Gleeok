import { useEffect, useRef, useState } from 'react';
import { AGENT_SCOPES, type AgentScope } from '../../../shared/src/agents.ts';
import type { AgentNew, AgentOp, AgentPanel } from '../../../shared/src/ipc.ts';
import { Icon } from './Icons.tsx';
import { lib } from './library/data.ts';

/** sessionStorage key: the Settings tab to open on. */
export const SETTINGS_TAB_KEY = 'gleeok.settings.tab';

async function agentCall<T>(op: AgentOp): Promise<T> {
  const r = await gleeok.agents(op);
  if (r.error) throw new Error(r.error);
  return r.result as T;
}

const ago = (iso?: string) => {
  if (!iso) return '还没用过';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 2) return '刚刚用过';
  if (min < 60) return `${min} 分钟前用过`;
  if (min < 48 * 60) return `${Math.round(min / 60)} 小时前用过`;
  return `${new Date(iso).toLocaleDateString('zh-CN')} 用过`;
};

/**
 * Agent connections: a token per agent, limited to the 日程 / 文献库, handed over as text to paste.
 * In Settings with the address card; in the 日程 and 文献库 as a popover (compact).
 */
export function AgentConnections({
  defaultScopes = ['planner', 'library'],
  compact = false,
  onPanel,
}: {
  defaultScopes?: AgentScope[];
  compact?: boolean;
  /** Told whenever the connections change (Settings keeps its address card in step). */
  onPanel?: (panel: AgentPanel) => void;
}) {
  const [panel, setPanelState] = useState<AgentPanel | null>(null);
  const setPanel = (p: AgentPanel) => {
    setPanelState(p);
    onPanel?.(p);
  };
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<AgentScope[]>(defaultScopes);
  const [fresh, setFresh] = useState<AgentNew | null>(null);
  const [copied, setCopied] = useState('');
  const fail = (e: Error) => setError(e.message);
  useEffect(() => void agentCall<AgentPanel>({ op: 'list' }).then(setPanel, fail), []);
  const handOver = (r: AgentNew) => {
    setPanel(r.panel);
    setFresh(r);
    setCopied('');
    setError('');
  };
  const create = () => {
    if (!name.trim() || !scopes.length) return;
    void agentCall<AgentNew>({ op: 'create', name: name.trim(), scopes }).then((r) => {
      handOver(r);
      setName('');
    }, fail);
  };
  const copy = (label: string, text: string) => void lib({ op: 'copyText', text }).then(() => setCopied(label));
  const scopeLabel = (s: AgentScope) => AGENT_SCOPES.find((x) => x.id === s)?.label ?? s;
  return (
    <section className={compact ? 'agent-compact' : 'card'}>
        <h3>Agent 连接</h3>
        {compact ? (
          <p className="hint">新建一个连接，把说明或 MCP 命令复制给你的 agent，它就能管这里的东西。</p>
        ) : (
          <p className="hint">
            给你自己的 agent（Claude Code、Codex、Paseo 里的助手……）一个只能管日程 / 文献库的令牌：把说明复制给它，或者把 MCP
            加进它的配置。它能新建、修改、勾选完成、放进回收站，新建的东西会标上它的名字。随时可以吊销。
          </p>
        )}
        {error && <p className="hint error">{error}</p>}
        {fresh && (
          <div className="agent-handoff">
            <div>
              <b>「{fresh.created.agent.name}」</b>的令牌只在这里出现这一次，复制完再关掉。地址：{fresh.handoff.url}
            </div>
            <div className="row">
              <button className="primary" onClick={() => copy('guide', fresh.handoff.guide)}>
                {copied === 'guide' ? '已复制说明' : '复制说明（Markdown）'}
              </button>
              <button onClick={() => copy('claude', fresh.handoff.claude)}>{copied === 'claude' ? '已复制' : '复制 Claude Code 命令'}</button>
              <button onClick={() => copy('codex', fresh.handoff.codex)}>{copied === 'codex' ? '已复制' : '复制 Codex 配置'}</button>
              <span className="spacer" />
              <button onClick={() => setFresh(null)}>完成</button>
            </div>
            <p className="hint">
              说明直接贴给 agent（或存成它的 skill / CLAUDE.md）；Claude Code 命令在终端里运行一次；Codex 配置追加到 ~/.codex/config.toml。
            </p>
          </div>
        )}
        {panel && (
          <div className="agent-list">
            {panel.agents.length === 0 && <p className="hint">还没有连接。</p>}
            {panel.agents.map((a) => (
              <div key={a.id} className="agent-row">
                <span className="name">{a.name}</span>
                <span className="meta">{a.scopes.map(scopeLabel).join(' · ')}</span>
                <span className="meta grow">{ago(a.lastUsedAt)}</span>
                <button onClick={() => void agentCall<AgentNew>({ op: 'rotate', id: a.id }).then(handOver, fail)} title="旧令牌立即失效">
                  换新令牌
                </button>
                <button
                  className="danger"
                  onClick={() => confirm(`吊销「${a.name}」？它的令牌会立即失效。`) && void agentCall<AgentPanel>({ op: 'revoke', id: a.id }).then(setPanel, fail)}
                >
                  吊销
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="row">
          <input value={name} placeholder="名字，例如：邮件助手" maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
          {AGENT_SCOPES.map((s) => (
            <label key={s.id} className="lib-check">
              <input type="checkbox" checked={scopes.includes(s.id)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s.id] : scopes.filter((x) => x !== s.id))} />
              {s.label}
            </label>
          ))}
          <button className="primary" disabled={!name.trim() || !scopes.length} onClick={create}>
            新建连接
          </button>
        </div>
      </section>
  );
}

/** Settings → Agent: the connections, and where agents reach Gleeok. */
export function AgentSettings() {
  const [panel, setPanel] = useState<AgentPanel | null>(null);
  const [error, setError] = useState('');
  useEffect(() => void agentCall<AgentPanel>({ op: 'list' }).then(setPanel, (e: Error) => setError(e.message)), []);
  const fail = (e: Error) => setError(e.message);
  return (
    <>
      <AgentConnections onPanel={setPanel} />
      {error && <p className="hint error">{error}</p>}
      {panel?.mode === 'server' && (
        <section className="card">
          <h3>地址</h3>
          <p className="hint">
            agent 连的是同步服务器 <code>{panel.url}</code>（REST 和 <code>/mcp</code>），它所在的机器要能访问这个地址（比如在同一个 tailnet 里）。
          </p>
        </section>
      )}
      {panel?.mode === 'local' && (
        <section className="card">
          <h3>本机接口</h3>
          <p className="hint">
            没有同步服务器时，Gleeok 自己开一个端口给 agent，只认 agent 令牌，只在有连接、Gleeok 开着的时候监听。
          </p>
          <dl className="facts">
            <dt>状态</dt>
            <dd>{panel.port?.listening ? `监听 ${panel.url}` : panel.port?.error ?? '没有连接，未开启'}</dd>
          </dl>
          <div className="row">
            <label className="lib-check">
              <input type="checkbox" checked={!!panel.port?.lan} onChange={(e) => void agentCall<AgentPanel>({ op: 'setLan', lan: e.target.checked }).then(setPanel, fail)} />
              允许其他电脑连接（tailnet / 局域网）
            </label>
          </div>
          <p className="hint">默认只有这台电脑上的 agent 能连。打开后改变的是地址，已经发给 agent 的说明要用「换新令牌」重新复制。</p>
        </section>
      )}
    </>
  );
}

/** Open Settings on the Agent tab (from the 日程 / 文献库). */
export function openAgentSettings() {
  sessionStorage.setItem(SETTINGS_TAB_KEY, 'agent');
  gleeok.dispatch({ type: 'setView', view: 'settings' });
}

/** A robot button for a toolbar: the connections in a popover, scoped to this part of Gleeok. */
export function AgentButton({ scope }: { scope: AgentScope }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="agent-anchor" ref={box}>
      <button className={`agent-btn ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="交给 agent：复制连接说明或 MCP 命令">
        <Icon name="bot" size={13} />
        Agent 连接
      </button>
      {open && (
        <div className="agent-pop">
          <AgentConnections defaultScopes={[scope]} compact />
          <button className="link" onClick={openAgentSettings}>
            在设置里管理全部连接 →
          </button>
        </div>
      )}
    </div>
  );
}
