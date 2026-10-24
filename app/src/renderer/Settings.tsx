import { useEffect, useState } from 'react';
import type { Snapshot } from '../../../shared/src/ipc.ts';
import { describeWeather, type WeatherPlace } from '../../../shared/src/weather.ts';
import { AgentSettings, SETTINGS_TAB_KEY } from './AgentConnections.tsx';
import {
  DEFAULT_PANE_NAMES,
  DEFAULT_SUGGESTIONS,
  MAX_PANES,
  librarySettings,
  paneName,
  pomodoroSettings,
  type LibrarySettings,
  type PomodoroSettings,
  type Suggestion,
} from '../../../shared/src/model.ts';
import { TRANSLATE_TARGETS, type TranslateEngine, type TranslateResult, type TranslateSettingsInput, type TranslateSettingsView } from '../../../shared/src/translate.ts';
import { lib, useLibrary } from './library/data.ts';
import { faviconFor } from './Panes.tsx';
import { PaseoSettings } from './PaseoSettings.tsx';

const TABS = [
  { id: 'panes', label: '栏' },
  { id: 'suggestions', label: '常用' },
  { id: 'today', label: '天气与时间' },
  { id: 'library', label: '文献库' },
  { id: 'planner', label: '日程' },
  { id: 'agent', label: 'Agent' },
  { id: 'paseo', label: 'Paseo' },
  { id: 'sync', label: '同步' },
  { id: 'vault', label: '密码库' },
  { id: 'about', label: '关于' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const close = () => gleeok.dispatch({ type: 'setView', view: 'panes' });

/** Global settings, in place of the panes: a tab list on the left like Paseo's settings. */
export function SettingsPage({ snap, toggle }: { snap: Snapshot; toggle: React.ReactNode }) {
  // Another view can ask for a tab (the 日程's and 文献库's agent buttons open 'agent').
  const [tab, setTab] = useState<Tab>(() => {
    const asked = sessionStorage.getItem(SETTINGS_TAB_KEY) as Tab | null;
    sessionStorage.removeItem(SETTINGS_TAB_KEY);
    return asked && TABS.some((t) => t.id === asked) ? asked : 'panes';
  });

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
        {tab === 'today' && <TodaySettings snap={snap} />}
        {tab === 'library' && (
          <>
            <LibrarySettingsCard snap={snap} />
            <TranslateCard />
          </>
        )}
        {tab === 'planner' && (
          <>
            <PlannerSettings snap={snap} />
            <MobileCard snap={snap} />
          </>
        )}
        {tab === 'agent' && <AgentSettings />}
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

/** The phone page: copy a sign-in link to open on the phone. */
function MobileCard({ snap }: { snap: Snapshot }) {
  const [link, setLink] = useState<string | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void gleeok.mobileLink().then(setLink);
  }, [snap.server.status]);
  const url = link?.split('#')[0];
  return (
    <section className="card">
      <h3>手机网页版</h3>
      {snap.server.status === 'local' ? (
        <p className="hint">本地模式下没有手机网页版：它由同步服务器提供。</p>
      ) : link === null ? (
        <p className="hint">同步服务器还没设置手机网页的地址（server.env 里的 GLEEOK_MOBILE_URL）。</p>
      ) : (
        <>
          <dl className="facts">
            <dt>地址</dt>
            <dd>{url ?? '…'}</dd>
          </dl>
          <div className="row">
            <button
              disabled={!link}
              onClick={() =>
                link &&
                void gleeok.library({ op: 'copyText', text: link }).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 3000);
                })
              }
            >
              {copied ? '已复制' : '复制手机登录链接'}
            </button>
          </div>
          <p className="hint">
            把链接发到手机上（比如用隔空投送或备忘录），在 Safari 里打开，再点「分享 → 添加到主屏幕」，就能像 App
            一样用。链接里带着同步服务器的访问令牌，只发给你自己的设备；手机需要连着 Tailscale。
          </p>
        </>
      )}
    </section>
  );
}

/** Pomodoro lengths (this machine). */
function PlannerSettings({ snap }: { snap: Snapshot }) {
  const s = pomodoroSettings(snap.state);
  const set = (settings: Partial<PomodoroSettings>) => gleeok.dispatch({ type: 'setPomodoroSettings', settings });
  const field = (key: keyof PomodoroSettings, label: string, unit: string, choices: number[]) => (
    <div className="row">
      <span className="meta lib-setting-label">{label}</span>
      <select value={s[key]} onChange={(e) => set({ [key]: Number(e.target.value) })}>
        {[...new Set([...choices, s[key]])]
          .sort((a, b) => a - b)
          .map((n) => (
            <option key={n} value={n}>
              {n} {unit}
            </option>
          ))}
      </select>
    </div>
  );
  return (
    <section className="card">
      <h3>番茄钟</h3>
      {field('focusMin', '专注', '分钟', [15, 20, 25, 30, 40, 45, 50, 60, 90])}
      {field('shortMin', '短休息', '分钟', [3, 5, 10, 15])}
      {field('longMin', '长休息', '分钟', [10, 15, 20, 25, 30])}
      {field('longEvery', '长休息间隔', '个番茄', [2, 3, 4, 5, 6])}
      <p className="hint">
        一段结束时会发系统通知，并在 Gleeok 里弹出确认：开不开始休息、开不开始下一个番茄，都由你决定。计时在后台进行，切换项目或关掉日程都不会中断；
        侧边栏的「日程」那一行会显示剩余时间。这些设置只对这台电脑生效。
      </p>
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
        <span className="meta lib-setting-label">DBLP</span>
        <label className="lib-check">
          <input type="checkbox" checked={s.autoDblp} onChange={(e) => set({ autoDblp: e.target.checked })} />
          添加 PDF 时自动从 DBLP 补全（标题完全一致时）
        </label>
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

/** The sidebar's weather place and clock (this machine). */
function TodaySettings({ snap }: { snap: Snapshot }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<WeatherPlace[] | null>(null);
  const [error, setError] = useState('');
  const place = snap.state.weatherPlace;
  const search = () => {
    if (!q.trim()) return;
    setError('');
    void gleeok.weatherSearch(q).then((r) => (r.error ? setError(r.error) : setFound(r.result ?? [])));
  };
  const pick = (p: WeatherPlace | 'auto' | 'off') => {
    gleeok.dispatch({ type: 'setWeatherPlace', place: p });
    setFound(null);
    setQ('');
  };
  return (
    <>
      <section className="card">
        <h3>天气</h3>
        <dl className="facts">
          <dt>地点</dt>
          <dd>
            {place === null
              ? '不显示天气'
              : place
                ? `${place.name}${place.detail ? `（${place.detail}）` : ''}`
                : `按 IP 自动定位${snap.weather?.place ? `：现在是 ${snap.weather.place}` : ''}`}
          </dd>
          {snap.weather?.current && (
            <>
              <dt>现在</dt>
              <dd>
                {snap.weather.current.temp}°，{describeWeather(snap.weather.current.code, snap.weather.current.isDay).label}
              </dd>
            </>
          )}
          {snap.weather?.error && (
            <>
              <dt>问题</dt>
              <dd className="error">{snap.weather.error}</dd>
            </>
          )}
        </dl>
        <div className="row">
          <input value={q} placeholder="搜索城市，例如 爱丁堡 / Edinburgh / 上海" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
          <button onClick={search}>搜索</button>
          <button disabled={place === undefined} onClick={() => pick('auto')}>
            按 IP 自动定位
          </button>
          <button disabled={place === null} onClick={() => pick('off')}>
            不显示
          </button>
        </div>
        {error && <p className="hint error">{error}</p>}
        {found && (
          <div className="place-results">
            {found.length === 0 && <p className="hint">没找到这个地方</p>}
            {found.map((p) => (
              <button key={`${p.latitude},${p.longitude}`} onClick={() => pick(p)}>
                <b>{p.name}</b> <span className="meta">{p.detail}</span>
              </button>
            ))}
          </div>
        )}
        <p className="hint">
          天气数据来自 Open-Meteo（免费，不需要账号），每半小时更新。自动定位按这台电脑的 IP 地址估计所在城市（用 VPN 时可能不准），每 3
          小时和唤醒后重新定位；选了城市就一直用它。只对这台电脑生效。
        </p>
      </section>
      <section className="card">
        <h3>时间</h3>
        <div className="row">
          <span className="meta lib-setting-label">显示时钟</span>
          <select value={snap.state.clock ?? 'fullscreen'} onChange={(e) => gleeok.dispatch({ type: 'setClock', mode: e.target.value as 'fullscreen' | 'always' | 'never' })}>
            <option value="fullscreen">窗口全屏时</option>
            <option value="always">总是</option>
            <option value="never">不显示</option>
          </select>
        </div>
        <p className="hint">时钟在侧边栏的天气上面；侧边栏收起时，显示在最右边一栏标签条的右端。全屏会挡住系统的时钟，所以默认只在全屏时显示。</p>
      </section>
    </>
  );
}

/** 划词翻译: the engine and its keys, kept on the sync server for every device. */
function TranslateCard() {
  const [v, setV] = useState<TranslateSettingsView | null>(null);
  const [error, setError] = useState('');
  const [base, setBase] = useState('');
  const [model, setModel] = useState('');
  const [test, setTest] = useState('');
  const show = (next: TranslateSettingsView) => {
    setV(next);
    setBase(next.openai.baseUrl);
    setModel(next.openai.model);
    setError('');
  };
  useEffect(() => void lib<TranslateSettingsView>({ op: 'translateSettings' }).then(show, (e: Error) => setError(e.message)), []);
  const save = (settings: TranslateSettingsInput) => void lib<TranslateSettingsView>({ op: 'setTranslateSettings', settings }).then(show, (e: Error) => setError(e.message));
  const runTest = (engine?: TranslateEngine) => {
    setTest('翻译中…');
    void lib<TranslateResult>({ op: 'translate', text: 'Attention is all you need: the Transformer relies entirely on self-attention.', engine }).then(
      (r) => setTest(r.off ? '划词翻译是关闭的' : `${r.label}：${r.text}`),
      (e: Error) => setTest(`失败：${e.message}`),
    );
  };
  return (
    <section className="card">
      <h3>划词翻译</h3>
      {error && <p className="hint error">{error}</p>}
      {v && (
        <>
          <div className="row">
            <span className="meta lib-setting-label">翻译服务</span>
            <select value={v.engine ?? ''} onChange={(e) => save({ engine: (e.target.value || null) as TranslateEngine | null })}>
              <option value="">关闭</option>
              <option value="deepl">DeepL</option>
              <option value="openai">OpenAI 兼容接口</option>
            </select>
            <span className="meta lib-setting-label">译成</span>
            <select value={v.target} onChange={(e) => save({ target: e.target.value })}>
              {TRANSLATE_TARGETS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <span className="meta lib-setting-label">DeepL key</span>
            <KeyInput saved={v.deepl.key} placeholder="DeepL API key（免费版以 :fx 结尾）" onSave={(deeplKey) => save({ deeplKey })} />
          </div>
          <div className="row">
            <span className="meta lib-setting-label">OpenAI baseURL</span>
            <input value={base} placeholder="https://api.openai.com/v1" onChange={(e) => setBase(e.target.value)} onBlur={() => base !== v.openai.baseUrl && save({ openaiBaseUrl: base })} onKeyDown={blurOnEnter} />
          </div>
          <div className="row">
            <span className="meta lib-setting-label">模型</span>
            <input value={model} placeholder="例如 gpt-4.1-mini、deepseek-chat" onChange={(e) => setModel(e.target.value)} onBlur={() => model !== v.openai.model && save({ openaiModel: model })} onKeyDown={blurOnEnter} />
          </div>
          <div className="row">
            <span className="meta lib-setting-label">OpenAI key</span>
            <KeyInput saved={v.openai.key} placeholder="API key（本地模型可以不填）" onSave={(openaiKey) => save({ openaiKey })} />
          </div>
          <div className="row">
            <span className="meta lib-setting-label">试一下</span>
            {v.engines.map((e) => (
              <button key={e.id} onClick={() => runTest(e.id)}>
                {e.label}
              </button>
            ))}
            {v.engines.length === 0 && <span className="hint">先填 DeepL key，或 OpenAI 接口的模型</span>}
            <span className="hint">{test}</span>
          </div>
        </>
      )}
      <p className="hint">
        在文献库的阅读器里选中文字，弹出的小窗下面就是译文，可以复制、换另一个服务再翻，或者「存为批注」（高亮这段，译文写进评论）。
        设置和 key 存在同步服务器上，所有设备共用，保存后只显示最后几位；同一段文字只请求一次。
      </p>
    </section>
  );
}

/** A secret: shows only that one is saved; typing replaces it, 清除 removes it. */
function KeyInput({ saved, placeholder, onSave }: { saved: string | null; placeholder: string; onSave: (key: string) => void }) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    if (!draft.trim()) return;
    onSave(draft.trim());
    setDraft('');
  };
  return (
    <>
      <input type="password" value={draft} placeholder={saved ? `已保存（${saved}），输入新的替换` : placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={blurOnEnter} />
      {saved && <button onClick={() => onSave('')}>清除</button>}
    </>
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
        <dt>版本</dt>
        <dd>
          {snap.build.version}
          {snap.build.commit !== 'unknown' && <span className="meta"> · {snap.build.commit.slice(0, 7)}</span>}
          {snap.build.hot && <span className="meta">（测试版热更新）</span>}
        </dd>
        <dt>构建时间</dt>
        <dd>{built}</dd>
        <dt>更新通道</dt>
        <dd>
          {snap.build.updates === 'release' ? (
            <>
              <select value={snap.state.updateChannel ?? 'stable'} onChange={(e) => gleeok.dispatch({ type: 'setUpdateChannel', channel: e.target.value as 'stable' | 'beta' })}>
                <option value="stable">正式版：只装发布的版本</option>
                <option value="beta">测试版：main 上每次改动都热更新</option>
              </select>
              {snap.build.betaNeedsInstaller && <span className="hint"> · 最新的测试版换了 Electron，要等下一个正式版的安装包</span>}
            </>
          ) : snap.build.updates === 'git' ? (
            '代码目录：跟着 main 分支（git pull 后重新构建）'
          ) : (
            '这个安装方式不能自动更新'
          )}
        </dd>
        <dt>DRM</dt>
        <dd>
          {snap.drm.widevine ? `Widevine ${snap.drm.widevine}` : 'Widevine 还没就绪（第一次启动要下载，稍后再看）'}
          {snap.drm.vmp === 'signed' && ' · 已有正式 VMP 签名'}
          {snap.drm.vmp === 'none' && (
            <span className="hint"> · 只有开发签名：Apple Music 等可能报错，在终端运行 deploy/macos-vmp-sign.sh</span>
          )}
          {snap.drm.vmp === 'stale' && <span className="error"> · Electron 更新后签名失效：在终端运行 deploy/macos-vmp-sign.sh</span>}
        </dd>
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
        <button onClick={() => gleeok.dispatch({ type: 'openLog' })} title="网页崩溃、加载失败、进程退出的记录">
          打开日志
        </button>
      </div>
      <p className="hint">Apache-2.0</p>
    </section>
  );
}
