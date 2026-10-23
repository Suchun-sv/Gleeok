import { useEffect, useState } from 'react';
import type { Snapshot } from '../../../shared/src/ipc.ts';
import { DEFAULT_PANE_NAMES, DEFAULT_SUGGESTIONS, MAX_PANES, librarySettings, paneName, type LibrarySettings, type Suggestion } from '../../../shared/src/model.ts';
import { lib, useLibrary } from './library/data.ts';
import { faviconFor } from './Panes.tsx';
import { PaseoSettings } from './PaseoSettings.tsx';

const TABS = [
  { id: 'panes', label: '栏' },
  { id: 'suggestions', label: '常用' },
  { id: 'library', label: '文献库' },
  { id: 'paseo', label: 'Paseo' },
  { id: 'sync', label: '同步' },
  { id: 'vault', label: '密码库' },
  { id: 'about', label: '关于' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const close = () => gleeok.dispatch({ type: 'setView', view: 'panes' });

/** Global settings, in place of the panes: a tab list on the left like Paseo's settings. */
export function SettingsPage({ snap, toggle }: { snap: Snapshot; toggle: React.ReactNode }) {
  const [tab, setTab] = useState<Tab>('panes');

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
        {tab === 'panes' && <PaneSettings snap={snap} />}
        {tab === 'suggestions' && <SuggestionSettings snap={snap} />}
        {tab === 'library' && <LibrarySettingsCard snap={snap} />}
        {tab === 'paseo' && <PaseoSettings snap={snap} />}
        {tab === 'sync' && <SyncSettings snap={snap} />}
        {tab === 'vault' && <VaultSettings snap={snap} />}
        {tab === 'about' && <About snap={snap} />}
      </div>
    </div>
  );
}

/** How many panes each project has and what they are called. Widths are set by dragging the dividers. */
function PaneSettings({ snap }: { snap: Snapshot }) {
  const saved = snap.state.paneNames;
  // Names are edited here and saved on Enter / leaving the field, so trimming never fights the typing.
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved.join('\n')]);
  const save = (names: string[]) => gleeok.dispatch({ type: 'setPanes', names });
  const setCount = (n: number) =>
    save(Array.from({ length: n }, (_, i) => (i < saved.length ? saved[i] : (DEFAULT_PANE_NAMES[i] ?? ''))));
  return (
    <section className="card">
      <h3>栏</h3>
      <div className="row">
        <span className="meta">每个项目</span>
        <div className="seg">
          {Array.from({ length: MAX_PANES }, (_, i) => i + 1).map((n) => (
            <button key={n} className={saved.length === n ? 'on' : ''} onClick={() => setCount(n)}>
              {n} 栏
            </button>
          ))}
        </div>
      </div>
      {draft.map((name, i) => (
        <div className="row" key={i}>
          <span className="meta pane-index">第 {i + 1} 栏</span>
          <input
            value={name}
            placeholder={`第${i + 1}栏`}
            maxLength={24}
            onChange={(e) => setDraft(draft.map((d, j) => (j === i ? e.target.value : d)))}
            onBlur={() => draft[i] !== saved[i] && save(draft)}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </div>
      ))}
      <p className="hint">
        栏名显示在每栏标签条的最左边，也用在右键菜单、命令面板和拆出去的窗口标题里（{draft.map((_, i) => paneName(draft, i)).join(' / ')}）。
        减少栏数时，多出来那几栏的标签页会保留，再加回来就还在。拖动两栏之间的分隔线可以调宽度，双击分隔线恢复等宽。
        主窗口显示其中几栏用标签条右侧的布局按钮切换（{snap.platform === 'darwin' ? '⌘⌥' : 'Ctrl+Alt+'}Shift+数字）。
      </p>
    </section>
  );
}

/** The 常用 tiles under every new-tab page: edited here, saved on leaving a field. */
function SuggestionSettings({ snap }: { snap: Snapshot }) {
  const saved = snap.state.suggestions ?? DEFAULT_SUGGESTIONS;
  const [draft, setDraft] = useState(saved);
  const savedJson = JSON.stringify(saved);
  useEffect(() => setDraft(saved), [savedJson]);
  const save = (list: Suggestion[]) => {
    setDraft(list);
    // A bare host gets https://; gleeok:// (the terminal) and other schemes stay as typed.
    const clean = list
      .map((t) => ({ ...t, url: t.url.trim() && !/^[a-z][a-z0-9+.-]*:/i.test(t.url.trim()) ? `https://${t.url.trim()}` : t.url.trim() }))
      .filter((t) => t.url);
    if (JSON.stringify(clean) !== savedJson) gleeok.dispatch({ type: 'setSuggestions', suggestions: clean });
  };
  const set = (i: number, patch: Partial<Suggestion>) => setDraft(draft.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const move = (i: number, d: number) => {
    const next = [...draft];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    save(next);
  };
  return (
    <section className="card">
      <h3>常用</h3>
      <p className="hint">每个新标签页里项目链接下面的那一组。按回车或离开输入框就保存，只存在这台电脑上。</p>
      <div className="suggestion-list">
        {draft.map((t, i) => (
          <div className="suggestion-row" key={i}>
            <img src={t.url ? faviconFor(t.url) : ''} alt="" />
            <input value={t.label} placeholder="用途，如 读论文" maxLength={24} onChange={(e) => set(i, { label: e.target.value })} onBlur={() => save(draft)} onKeyDown={blurOnEnter} />
            <input value={t.name} placeholder="名称，如 alphaXiv" maxLength={40} onChange={(e) => set(i, { name: e.target.value })} onBlur={() => save(draft)} onKeyDown={blurOnEnter} />
            <input className="url" value={t.url} placeholder="网址" onChange={(e) => set(i, { url: e.target.value })} onBlur={() => save(draft)} onKeyDown={blurOnEnter} />
            <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="上移">
              ↑
            </button>
            <button className="icon-btn" disabled={i === draft.length - 1} onClick={() => move(i, 1)} title="下移">
              ↓
            </button>
            <button className="icon-btn" onClick={() => save(draft.filter((_, j) => j !== i))} title="删除">
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="row">
        <button onClick={() => setDraft([...draft, { label: '', name: '', url: '' }])}>+ 添加</button>
        <span className="spacer" />
        <button onClick={() => gleeok.dispatch({ type: 'setSuggestions', suggestions: null })} disabled={!snap.state.suggestions}>
          恢复默认
        </button>
      </div>
    </section>
  );
}

/** 文献库 preferences (this machine) and the local copies of PDFs. */
function LibrarySettingsCard({ snap }: { snap: Snapshot }) {
  const s = librarySettings(snap.state);
  const library = useLibrary();
  const [cache, setCache] = useState<{ bytes: number; files: number } | null>(null);
  const refresh = () => void lib<{ bytes: number; files: number }>({ op: 'cacheInfo' }).then(setCache, () => setCache(null));
  useEffect(refresh, []);
  const set = (settings: Partial<LibrarySettings>) => gleeok.dispatch({ type: 'setLibrarySettings', settings });
  const gb = (bytes: number) =>
    bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${Math.ceil(bytes / 1024)} KB`;
  const status = { loading: '正在连接', ok: '已同步', offline: '离线（显示本机缓存）', unavailable: '不可用' }[library?.status ?? 'loading'];
  return (
    <section className="card">
      <h3>文献库</h3>
      <dl className="facts">
        <dt>状态</dt>
        <dd>
          {status}
          {library?.error && library.status !== 'ok' ? ` · ${library.error}` : ''}
        </dd>
        <dt>条目</dt>
        <dd>{library ? library.items.filter((i) => i.itemType !== 'note' && i.itemType !== 'attachment' && !i.deleted).length : '—'} 篇</dd>
      </dl>
      <div className="row">
        <span className="meta lib-setting-label">PDF 在哪一栏打开</span>
        <select value={s.readerPane} onChange={(e) => set({ readerPane: Number(e.target.value) })}>
          {snap.state.paneNames.map((_, i) => (
            <option key={i} value={i}>
              {paneName(snap.state.paneNames, i)}
            </option>
          ))}
        </select>
        <span className="hint">这一栏没有显示时，用最右边那一栏</span>
      </div>
      <div className="row">
        <span className="meta lib-setting-label">阅读器主题</span>
        <select value={s.readerTheme} onChange={(e) => set({ readerTheme: e.target.value as LibrarySettings['readerTheme'] })}>
          <option value="auto">跟随系统</option>
          <option value="dark">深色</option>
          <option value="light">浅色</option>
        </select>
      </div>
      <div className="row">
        <span className="meta lib-setting-label">第一次打开时</span>
        <select value={s.readerZoom} onChange={(e) => set({ readerZoom: e.target.value as LibrarySettings['readerZoom'] })}>
          <option value="page-width">适合宽度</option>
          <option value="page-fit">适合整页</option>
          <option value="auto">自动</option>
        </select>
        <span className="hint">之后都回到上次看到的位置和大小</span>
      </div>
      <div className="row">
        <span className="meta lib-setting-label">回收站</span>
        <select value={s.trashDays} onChange={(e) => set({ trashDays: Number(e.target.value) })}>
          {[7, 30, 90, 365, 0].map((d) => (
            <option key={d} value={d}>
              {d ? `${d} 天后彻底删除` : '不自动删除'}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <span className="meta lib-setting-label">本机 PDF 缓存</span>
        <select value={s.cacheGB} onChange={(e) => set({ cacheGB: Number(e.target.value) })}>
          {[1, 2, 5, 10, 20, 50].map((g) => (
            <option key={g} value={g}>
              最多 {g} GB
            </option>
          ))}
        </select>
        <span className="hint">{cache ? `已用 ${gb(cache.bytes)}（${cache.files} 个文件）` : ''}</span>
        <button disabled={!cache?.files} onClick={() => void lib({ op: 'clearCache' }).then(refresh)}>
          清空缓存
        </button>
      </div>
      <p className="hint">
        PDF 存在同步服务器上，打开过的会在这台电脑上留一份副本，下次秒开、离线也能读；超过上限时先删最久没打开的。这些设置只对这台电脑生效。
      </p>
    </section>
  );
}

const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && e.currentTarget.blur();

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
