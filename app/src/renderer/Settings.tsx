import { useEffect, useState } from 'react';
import type { Snapshot } from '../../../shared/src/ipc.ts';
import { PaseoSettings } from './PaseoSettings.tsx';

const TABS = [
  { id: 'paseo', label: 'Paseo' },
  { id: 'sync', label: '同步' },
  { id: 'vault', label: '密码库' },
  { id: 'about', label: '关于' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const close = () => gleeok.dispatch({ type: 'setView', view: 'panes' });

/** Global settings, in place of the panes: a tab list on the left like Paseo's settings. */
export function SettingsPage({ snap, toggle }: { snap: Snapshot; toggle: React.ReactNode }) {
  const [tab, setTab] = useState<Tab>('paseo');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target instanceof HTMLInputElement) && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-title">
          {toggle}
          <h2>设置</h2>
        </div>
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        <button className="settings-close icon-btn" onClick={close} title="关闭（Esc）">
          ×
        </button>
        {tab === 'paseo' && <PaseoSettings snap={snap} />}
        {tab === 'sync' && <SyncSettings snap={snap} />}
        {tab === 'vault' && <VaultSettings snap={snap} />}
        {tab === 'about' && <About snap={snap} />}
      </div>
    </div>
  );
}

function SyncSettings({ snap }: { snap: Snapshot }) {
  const { server } = snap;
  const [busy, setBusy] = useState(false);
  const label = { ok: '已连接', offline: '连不上', unconfigured: '配置有误', local: '本地模式' }[server.status];
  return (
    <section className="card">
      <h3>同步服务器</h3>
      <dl className="facts">
        <dt>状态</dt>
        <dd>
          <span className={`dot ${server.status}`} /> {label}
          {server.error && <span className="error"> · {server.error}</span>}
        </dd>
        {server.url && (
          <>
            <dt>地址</dt>
            <dd>
              <code>{server.url}</code>
            </dd>
          </>
        )}
      </dl>
      <p className="hint">
        {server.status === 'local'
          ? '项目、链接和标签都只存在这台电脑上。想在几台电脑之间同步，部署一个 Gleeok 服务器，再在 ~/.config/gleeok/client.json 里写上它的地址和 token。'
          : '项目、链接和各台电脑的标签都存在这个服务器上；连不上时用本地缓存，能看不能改。服务器地址和 token 在 ~/.config/gleeok/client.json 里。'}
      </p>
      <div className="row">
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void gleeok.refreshProjects().finally(() => setBusy(false));
          }}
        >
          {busy ? '正在连接…' : '重新连接'}
        </button>
      </div>
    </section>
  );
}

function VaultSettings({ snap }: { snap: Snapshot }) {
  const { vault } = snap;
  const keys = snap.platform === 'darwin' ? '⌘⇧L' : 'Ctrl+Shift+L';
  return (
    <section className="card">
      <h3>密码库</h3>
      <dl className="facts">
        <dt>状态</dt>
        <dd>{vault.unlocked ? `已解锁 · ${vault.entries.length} 条` : '已锁定'}</dd>
        <dt>服务器</dt>
        <dd>
          <code>{vault.serverUrl}</code>
        </dd>
        {vault.email && (
          <>
            <dt>账号</dt>
            <dd>{vault.email}</dd>
          </>
        )}
      </dl>
      <p className="hint">
        Bitwarden / Vaultwarden 密码库。在登录页按 {keys} 填写账号密码；命令面板里能搜到每条记录，打开或复制网址、用户名、密码。主密码只在解锁时用一次，不保存；电脑锁屏或退出
        Gleeok 时自动锁定。
      </p>
      <div className="row">
        {vault.unlocked ? (
          <button onClick={() => gleeok.dispatch({ type: 'vaultLock' })}>锁定</button>
        ) : (
          <button className="primary" onClick={() => gleeok.dispatch({ type: 'vaultUnlock' })}>
            解锁
          </button>
        )}
      </div>
    </section>
  );
}

function About({ snap }: { snap: Snapshot }) {
  const built = new Date(__GLEEOK_BUILD__).toLocaleString('zh-CN', { hour12: false });
  const { update } = snap;
  return (
    <section className="card">
      <h3>Gleeok</h3>
      <dl className="facts">
        <dt>构建时间</dt>
        <dd>{built}</dd>
        <dt>更新</dt>
        <dd>
          {!snap.canSelfUpdate
            ? '不是从 git 代码目录运行，不能自动更新'
            : update.step
              ? `正在更新：${update.step}`
              : update.error
                ? <span className="error">{update.error}</span>
                : update.commits.length > 0
                  ? `有 ${update.commits.length} 个更新`
                  : '没发现新版本'}
        </dd>
      </dl>
      <div className="row">
        {snap.canSelfUpdate && update.commits.length > 0 && (
          <button className="primary" onClick={() => gleeok.dispatch({ type: 'openUpdate' })}>
            查看并更新
          </button>
        )}
        {snap.canSelfUpdate && <button onClick={() => gleeok.dispatch({ type: 'checkUpdate' })}>检查更新</button>}
        <button onClick={() => gleeok.dispatch({ type: 'openLink', url: 'https://github.com/Suchun-sv/Gleeok', newTab: true })}>GitHub</button>
      </div>
      <p className="hint">Apache-2.0</p>
    </section>
  );
}
