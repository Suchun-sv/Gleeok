import { Fragment, useEffect, useState } from 'react';
import type { Snapshot } from '../../../shared/src/ipc.ts';
import icon from '../../assets/icon-64.png';
import { describeWeather, type WeatherPlace } from '../../../shared/src/weather.ts';
import { AgentSettings, SETTINGS_TAB_KEY } from './AgentConnections.tsx';
import {
  DEFAULT_PANE_NAMES,
  codeHost,
  codeIdleMinutes,
  codeServers,
  type CodeTunnel,
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
import { Icon, type IconName } from './Icons.tsx';
import { lib, useLibrary } from './library/data.ts';
import { faviconFor } from './Panes.tsx';
import { PaseoSettings } from './PaseoSettings.tsx';
import { Group, Kbd, Row, Seg, Status, Switch, Tag, blurOnEnter } from './SettingsUI.tsx';
import { zoneTime } from './TodayCard.tsx';

// `sep`: a divider above, between 界面 / 功能 / 连接 / 关于.
const TABS: { id: string; label: string; icon: IconName; sep?: boolean }[] = [
  { id: 'panes', label: '栏', icon: 'columns3' },
  { id: 'appearance', label: '外观', icon: 'palette' },
  { id: 'suggestions', label: '常用', icon: 'star' },
  { id: 'today', label: '天气与时间', icon: 'cloudSun' },
  { id: 'library', label: '文献库', icon: 'libraryBig', sep: true },
  { id: 'planner', label: '日程', icon: 'calendarCheck' },
  { id: 'agent', label: 'Agent', icon: 'bot' },
  { id: 'paseo', label: 'Paseo', icon: 'server', sep: true },
  { id: 'code', label: '代码', icon: 'code' },
  { id: 'sync', label: '同步', icon: 'refresh' },
  { id: 'vault', label: '密码库', icon: 'keyRound' },
  { id: 'about', label: '关于', icon: 'info', sep: true },
];

const close = () => gleeok.dispatch({ type: 'setView', view: 'panes' });

/** Global settings, in place of the panes: a tab list on the left like Paseo's settings. */
export function SettingsPage({ snap, toggle }: { snap: Snapshot; toggle: React.ReactNode }) {
  // Another view can ask for a tab (the 日程's and 文献库's agent buttons open 'agent').
  const [tab, setTab] = useState(() => {
    const asked = sessionStorage.getItem(SETTINGS_TAB_KEY);
    sessionStorage.removeItem(SETTINGS_TAB_KEY);
    return asked && TABS.some((t) => t.id === asked) ? asked : 'panes';
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target instanceof HTMLInputElement) && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const title = TABS.find((t) => t.id === tab)?.label ?? '';
  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-title">
          {toggle}
          <h2>设置</h2>
        </div>
        {TABS.map((t) => (
          <Fragment key={t.id}>
            {t.sep && <div className="settings-sep" />}
            <button className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} size={15} />
              {t.label}
            </button>
          </Fragment>
        ))}
      </nav>
      <div className="settings-body">
        <button className="settings-close" onClick={close} title="关闭（Esc）">
          <Icon name="x" size={16} />
        </button>
        <div className="s-page">
          <h1 className="s-h">{title}</h1>
          {tab === 'panes' && <PaneSettings snap={snap} />}
          {tab === 'appearance' && <AppearanceSettings snap={snap} onLibrary={() => setTab('library')} />}
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
          {tab === 'code' && (
            <>
              <CodeIdleSettings snap={snap} />
              <CodeTunnelSettings snap={snap} />
            </>
          )}
          {tab === 'sync' && <SyncSettings snap={snap} />}
          {tab === 'vault' && <VaultSettings snap={snap} />}
          {tab === 'about' && <About snap={snap} />}
        </div>
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
  const mac = snap.platform === 'darwin';
  // Wayland does not let a program move the pointer.
  const canMovePointer = mac || snap.platform === 'win32';
  return (
    <>
      <Group note="栏名显示在标签栏左侧。减少栏数不会删除标签页。">
        <Row title="栏数">
          <Seg
            value={saved.length}
            options={Array.from({ length: MAX_PANES }, (_, i) => [i + 1, String(i + 1)] as [number, string])}
            onChange={setCount}
          />
        </Row>
        {draft.map((name, i) => (
          <Row key={i} title={`第 ${i + 1} 栏`}>
            <input
              className="s-field w-160"
              value={name}
              placeholder={paneName([], i)}
              maxLength={24}
              onChange={(e) => setDraft(draft.map((d, j) => (j === i ? e.target.value : d)))}
              onBlur={() => draft[i] !== saved[i] && save(draft)}
              onKeyDown={blurOnEnter}
            />
          </Row>
        ))}
      </Group>
      <Group title="切换">
        <Row title="指针跟随" desc={canMovePointer ? '用快捷键切换栏时同时移动指针' : 'Wayland 下不可用'}>
          <Switch
            on={canMovePointer && snap.state.pointerFollows !== false}
            disabled={!canMovePointer}
            onChange={(on) => gleeok.dispatch({ type: 'setPointerFollows', on })}
          />
        </Row>
        <Row title="始终显示地址栏" desc="关闭时仅焦点栏显示">
          <Switch on={!!snap.state.toolbarAll} onChange={(on) => gleeok.dispatch({ type: 'setToolbarAll', on })} />
        </Row>
      </Group>
      <Group title="快捷键">
        <Row title="切换到第 N 栏">
          {[1, 2, 3].map((n) => (
            <Kbd key={n}>{mac ? `⌘${n}` : `Ctrl+Alt+${n}`}</Kbd>
          ))}
        </Row>
        <Row title="切换到相邻栏">
          <Kbd>{mac ? '⌘⌥←' : 'Ctrl+Alt+←'}</Kbd>
          <Kbd>{mac ? '⌘⌥→' : 'Ctrl+Alt+→'}</Kbd>
        </Row>
        <Row title="切换布局">
          {[1, 2, 3].map((n) => (
            <Kbd key={n}>{mac ? `⌘⌥⇧${n}` : `Ctrl+Alt+Shift+${n}`}</Kbd>
          ))}
        </Row>
        <Row title="调整栏宽" desc="拖动分隔线，双击恢复等宽" />
      </Group>
    </>
  );
}

/** Light or dark (this machine). */
function AppearanceSettings({ snap, onLibrary }: { snap: Snapshot; onLibrary: () => void }) {
  return (
    <Group>
      <Row title="主题" desc="同时应用于支持深色模式的网页">
        <Seg
          value={snap.state.theme ?? 'system'}
          options={[
            ['system', '跟随系统'],
            ['light', '浅色'],
            ['dark', '深色'],
          ]}
          onChange={(theme) => gleeok.dispatch({ type: 'setTheme', theme })}
        />
      </Row>
      <Row title="PDF 阅读器" desc="默认跟随主题">
        <button className="s-link" onClick={onLibrary}>
          前往文献库设置
        </button>
      </Row>
    </Group>
  );
}

/** The 常用 tiles under every new-tab page: edited in place, saved on leaving a field, dragged to reorder. */
function SuggestionSettings({ snap }: { snap: Snapshot }) {
  const saved = snap.state.suggestions ?? DEFAULT_SUGGESTIONS;
  const [draft, setDraft] = useState(saved);
  const [dragging, setDragging] = useState<number | null>(null);
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
  const drop = (to: number) => {
    if (dragging === null || dragging === to) return setDragging(null);
    const next = [...draft];
    const [moved] = next.splice(dragging, 1);
    next.splice(to, 0, moved);
    setDragging(null);
    save(next);
  };
  return (
    <Group>
      <p className="s-lead">显示在新标签页中。</p>
      {draft.map((t, i) => (
        <div
          className={`s-item ${dragging === i ? 'dragging' : ''}`}
          key={i}
          onDragOver={(e) => dragging !== null && e.preventDefault()}
          onDrop={() => drop(i)}
        >
          <span className="s-grip" draggable onDragStart={() => setDragging(i)} onDragEnd={() => setDragging(null)} title="拖动排序">
            <Icon name="gripVertical" size={14} />
          </span>
          <img className="s-fav" src={t.url ? faviconFor(t.url) : ''} alt="" />
          <div className="s-text">
            <input className="s-inline" value={t.label} placeholder="用途" maxLength={24} onChange={(e) => set(i, { label: e.target.value })} onBlur={() => save(draft)} onKeyDown={blurOnEnter} />
            <span className="s-inline-row">
              <input className="s-inline sm w-120" value={t.name} placeholder="名称" maxLength={40} onChange={(e) => set(i, { name: e.target.value })} onBlur={() => save(draft)} onKeyDown={blurOnEnter} />
              <input className="s-inline mono" value={t.url} placeholder="网址" onChange={(e) => set(i, { url: e.target.value })} onBlur={() => save(draft)} onKeyDown={blurOnEnter} />
            </span>
          </div>
          <button className="s-icon s-hover" onClick={() => save(draft.filter((_, j) => j !== i))} title="删除">
            <Icon name="x" size={15} />
          </button>
        </div>
      ))}
      <div className="s-foot">
        <button className="s-add" onClick={() => setDraft([...draft, { label: '', name: '', url: '' }])}>
          <Icon name="plus" size={15} />
          添加
        </button>
        {snap.state.suggestions && (
          <button className="s-btn ghost" onClick={() => gleeok.dispatch({ type: 'setSuggestions', suggestions: null })}>
            恢复默认
          </button>
        )}
      </div>
    </Group>
  );
}

/** The sidebar's weather place and clock (this machine). */
function TodaySettings({ snap }: { snap: Snapshot }) {
  const place = snap.state.weatherPlace;
  const mode = place === null ? 'off' : place ? 'city' : 'auto';
  // 指定城市 shows the search; the place changes only once a city is picked.
  const [choosing, setChoosing] = useState(false);
  const pick = (p: WeatherPlace | 'auto' | 'off') => {
    gleeok.dispatch({ type: 'setWeatherPlace', place: p });
    setChoosing(false);
  };
  const source = { system: '系统定位', ip: 'IP 定位', zone: '时区估计' }[snap.weather?.source ?? 'ip'];
  const desc =
    mode === 'off'
      ? '不显示天气'
      : mode === 'city' && place
        ? `${place.name}${place.detail ? `（${place.detail}）` : ''}`
        : snap.weather?.place
          ? `${snap.weather.place}（${source}）`
          : '正在定位';
  const current = snap.weather?.current;
  return (
    <>
      <Group title="天气" note="数据来自 Open-Meteo，每 30 分钟更新。">
        <Row title="位置" desc={desc}>
          <Seg
            value={choosing ? 'city' : mode}
            options={[
              ['auto', '自动'],
              ['city', '指定城市'],
              ['off', '关闭'],
            ]}
            onChange={(m) => (m === 'city' ? setChoosing(true) : pick(m))}
          />
        </Row>
        {(choosing || mode === 'city') && (
          <div className="s-sub">
            <PlaceSearch placeholder="搜索城市" onPick={pick} />
          </div>
        )}
        {snap.weather?.error ? (
          <Row title="当前天气" desc={<span className="s-err">{snap.weather.error}</span>} />
        ) : (
          current &&
          mode !== 'off' && (
            <Row title="当前天气">
              <span className="s-val">{current.temp}°</span>
              <span className="s-val">{describeWeather(current.code, current.isDay).label}</span>
            </Row>
          )
        )}
      </Group>
      <Group title="时钟">
        <Row title="显示时钟" desc="位于侧栏天气上方">
          <select
            className="s-select"
            value={snap.state.clock ?? 'fullscreen'}
            onChange={(e) => gleeok.dispatch({ type: 'setClock', mode: e.target.value as 'fullscreen' | 'always' | 'never' })}
          >
            <option value="fullscreen">全屏时</option>
            <option value="always">始终</option>
            <option value="never">从不</option>
          </select>
        </Row>
      </Group>
      <ZoneSettings snap={snap} />
    </>
  );
}

/** A city search (Enter), its results as rows; `zoned` keeps only places with a time zone. */
function PlaceSearch({ placeholder, onPick, zoned }: { placeholder: string; onPick: (p: WeatherPlace) => void; zoned?: boolean }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<WeatherPlace[] | null>(null);
  const [error, setError] = useState('');
  const search = () => {
    if (!q.trim()) return;
    setError('');
    void gleeok.weatherSearch(q).then((r) => (r.error ? setError(r.error) : setFound((r.result ?? []).filter((p) => !zoned || p.timezone))));
  };
  return (
    <>
      <label className="s-search">
        <Icon name="search" size={15} />
        <input autoFocus value={q} placeholder={placeholder} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
      </label>
      {error && <p className="s-note s-err">{error}</p>}
      {found && found.length === 0 && <p className="s-note">未找到该地点</p>}
      {found && found.length > 0 && (
        <div className="s-results">
          {found.map((p) => (
            <button
              key={`${p.latitude},${p.longitude}`}
              onClick={() => {
                onPick(p);
                setFound(null);
                setQ('');
              }}
            >
              <Icon name={zoned ? 'globe' : 'mapPin'} size={14} />
              {p.name}
              <span className="s-d">{p.detail}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Other time zones in the sidebar: picked by city (the geocoder knows each one's zone). */
function ZoneSettings({ snap }: { snap: Snapshot }) {
  const zones = snap.state.zones ?? [];
  const [adding, setAdding] = useState(false);
  const now = new Date();
  const set = (next: typeof zones) => gleeok.dispatch({ type: 'setZones', zones: next });
  return (
    <Group title="其他地点" count={`${zones.length}/3`}>
      {zones.map((z, i) => {
        const t = zoneTime(now, z.timezone);
        return (
          <Row key={z.timezone + z.name} title={z.name} desc={z.latitude === undefined ? '无天气数据，请移除后重新添加' : t.offset}>
            {t.day && <Tag>{t.day}</Tag>}
            <span className="s-val">{t.time}</span>
            <button className="s-icon s-hover" onClick={() => set(zones.filter((_, j) => j !== i))} title="移除">
              <Icon name="x" size={15} />
            </button>
          </Row>
        );
      })}
      {zones.length < 3 &&
        (adding ? (
          <div className="s-sub">
            <PlaceSearch
              zoned
              placeholder="搜索城市"
              onPick={(p) => {
                set([...zones, { name: p.name, timezone: p.timezone!, latitude: p.latitude, longitude: p.longitude, detail: p.detail }]);
                setAdding(false);
              }}
            />
          </div>
        ) : (
          <button className="s-add" onClick={() => setAdding(true)}>
            <Icon name="plus" size={15} />
            添加地点
          </button>
        ))}
    </Group>
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
  const size = (bytes: number) =>
    bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${Math.ceil(bytes / 1024)} KB`;
  const status = library?.status ?? 'loading';
  const count = library?.items.filter((i) => i.itemType !== 'note' && i.itemType !== 'attachment' && !i.deleted).length;
  return (
    <>
      <Group>
        <Row title="同步状态" desc={library?.error && status !== 'ok' ? <span className="s-err">{library.error}</span> : undefined}>
          {count !== undefined && <Tag>{count} 篇</Tag>}
          <Status tone={status === 'ok' ? 'ok' : status === 'loading' ? 'warn' : status === 'offline' ? 'ro' : 'bad'}>
            {{ loading: '连接中', ok: '已同步', offline: '离线', unavailable: '不可用' }[status]}
          </Status>
        </Row>
      </Group>
      <Group title="阅读">
        <Row title="PDF 打开位置" desc="该栏隐藏时使用最右侧栏">
          <select className="s-select" value={s.readerPane} onChange={(e) => set({ readerPane: Number(e.target.value) })}>
            {snap.state.paneNames.map((_, i) => (
              <option key={i} value={i}>
                {paneName(snap.state.paneNames, i)}
              </option>
            ))}
          </select>
        </Row>
        <Row title="阅读器主题">
          <Seg
            value={s.readerTheme}
            options={[
              ['auto', '跟随系统'],
              ['light', '浅色'],
              ['dark', '深色'],
            ]}
            onChange={(readerTheme) => set({ readerTheme })}
          />
        </Row>
        <Row title="默认缩放" desc="再次打开时恢复上次的位置和缩放">
          <select className="s-select" value={s.readerZoom} onChange={(e) => set({ readerZoom: e.target.value as LibrarySettings['readerZoom'] })}>
            <option value="page-width">适合宽度</option>
            <option value="page-fit">适合整页</option>
            <option value="auto">自动</option>
          </select>
        </Row>
      </Group>
      <Group title="管理" note="打开过的 PDF 在本机保留副本，可离线阅读；超出上限时先删除最久未打开的。">
        <Row title="DBLP 自动补全" desc="添加 PDF 时按标题匹配作者、会议和年份">
          <Switch on={s.autoDblp} onChange={(autoDblp) => set({ autoDblp })} />
        </Row>
        <Row title="回收站保留">
          <select className="s-select" value={s.trashDays} onChange={(e) => set({ trashDays: Number(e.target.value) })}>
            {[7, 30, 90, 365, 0].map((d) => (
              <option key={d} value={d}>
                {d ? `${d} 天` : '永久'}
              </option>
            ))}
          </select>
        </Row>
        <Row title="本地缓存上限" desc={cache ? `已用 ${size(cache.bytes)}（${cache.files} 个文件）` : undefined}>
          <select className="s-select" value={s.cacheGB} onChange={(e) => set({ cacheGB: Number(e.target.value) })}>
            {[1, 2, 5, 10, 20, 50].map((g) => (
              <option key={g} value={g}>
                {g} GB
              </option>
            ))}
          </select>
          <button className="s-btn" disabled={!cache?.files} onClick={() => void lib({ op: 'clearCache' }).then(refresh)}>
            清空
          </button>
        </Row>
      </Group>
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
  const runTest = (engine: TranslateEngine) => {
    setTest('翻译中…');
    void lib<TranslateResult>({ op: 'translate', text: 'Attention is all you need: the Transformer relies entirely on self-attention.', engine }).then(
      (r) => setTest(r.off ? '划词翻译已关闭' : (r.text ?? '')),
      (e: Error) => setTest(`失败：${e.message}`),
    );
  };
  const engine = v?.engine ?? null;
  const usable = !!engine && !!v?.engines.some((e) => e.id === engine);
  return (
    <Group title="划词翻译" note="密钥保存在同步服务器，所有设备共用。">
      {error && <Row title="错误" desc={<span className="s-err">{error}</span>} />}
      {v && (
        <>
          <Row title="翻译服务" desc="在阅读器中选中文字即可翻译">
            <Seg
              value={engine ?? 'off'}
              options={[
                ['off', '关闭'],
                ['deepl', 'DeepL'],
                ['openai', 'OpenAI 兼容'],
              ]}
              onChange={(e) => save({ engine: e === 'off' ? null : (e as TranslateEngine) })}
            />
          </Row>
          {engine && (
            <Row title="目标语言">
              <select className="s-select" value={v.target} onChange={(e) => save({ target: e.target.value })}>
                {TRANSLATE_TARGETS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Row>
          )}
          {engine === 'deepl' && <KeyRow title="DeepL 密钥" saved={v.deepl.key} hint="免费版密钥以 :fx 结尾" onSave={(deeplKey) => save({ deeplKey })} />}
          {engine === 'openai' && (
            <>
              <Row title="接口地址">
                <input
                  className="s-field mono w-240"
                  value={base}
                  placeholder="https://api.openai.com/v1"
                  onChange={(e) => setBase(e.target.value)}
                  onBlur={() => base !== v.openai.baseUrl && save({ openaiBaseUrl: base })}
                  onKeyDown={blurOnEnter}
                />
              </Row>
              <Row title="模型">
                <input
                  className="s-field mono w-240"
                  value={model}
                  placeholder="gpt-4.1-mini"
                  onChange={(e) => setModel(e.target.value)}
                  onBlur={() => model !== v.openai.model && save({ openaiModel: model })}
                  onKeyDown={blurOnEnter}
                />
              </Row>
              <KeyRow title="API 密钥" saved={v.openai.key} hint="本地模型可留空" onSave={(openaiKey) => save({ openaiKey })} />
            </>
          )}
          {engine && (
            <Row title="测试" desc={test || (usable ? '翻译一句示例文字' : '请先填写密钥或模型')}>
              <button className="s-btn" disabled={!usable} onClick={() => runTest(engine)}>
                <Icon name="languages" size={14} />
                测试翻译
              </button>
            </Row>
          )}
        </>
      )}
    </Group>
  );
}

/** A secret: shows only that one is saved; 替换 opens a field, 清除 removes it. */
function KeyRow({ title, saved, hint, onSave }: { title: string; saved: string | null; hint: string; onSave: (key: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const commit = () => {
    if (draft.trim()) onSave(draft.trim());
    setDraft('');
    setEditing(false);
  };
  const open = editing || !saved;
  return (
    <Row title={title} desc={saved && !editing ? `已保存（末位 ${saved}）` : hint}>
      {open ? (
        <input
          className="s-field mono w-240"
          type="password"
          autoFocus={editing}
          value={draft}
          placeholder="粘贴密钥"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setDraft('');
              setEditing(false);
            }
          }}
        />
      ) : (
        <>
          <button className="s-btn" onClick={() => setEditing(true)}>
            替换
          </button>
          <button className="s-btn ghost" onClick={() => onSave('')}>
            清除
          </button>
        </>
      )}
    </Row>
  );
}

/** Pomodoro lengths (this machine). */
function PlannerSettings({ snap }: { snap: Snapshot }) {
  const s = pomodoroSettings(snap.state);
  const set = (settings: Partial<PomodoroSettings>) => gleeok.dispatch({ type: 'setPomodoroSettings', settings });
  const field = (key: keyof PomodoroSettings, title: string, label: (n: number) => string, choices: number[]) => (
    <Row title={title}>
      <select className="s-select" value={s[key]} onChange={(e) => set({ [key]: Number(e.target.value) })}>
        {[...new Set([...choices, s[key]])]
          .sort((a, b) => a - b)
          .map((n) => (
            <option key={n} value={n}>
              {label(n)}
            </option>
          ))}
      </select>
    </Row>
  );
  const min = (n: number) => `${n} 分钟`;
  return (
    <Group title="番茄钟" note="每段结束时发送通知，由你决定是否继续。计时在后台运行。">
      {field('focusMin', '专注时长', min, [15, 20, 25, 30, 40, 45, 50, 60, 90])}
      {field('shortMin', '短休息', min, [3, 5, 10, 15])}
      {field('longMin', '长休息', min, [10, 15, 20, 25, 30])}
      {field('longEvery', '长休息间隔', (n) => `每 ${n} 个番茄`, [2, 3, 4, 5, 6])}
    </Group>
  );
}

/** The phone page: copy a sign-in link to open on the phone. */
function MobileCard({ snap }: { snap: Snapshot }) {
  const [link, setLink] = useState<string | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void gleeok.mobileLink().then(setLink);
  }, [snap.server.status]);
  if (snap.server.status === 'local') {
    return (
      <Group title="移动端">
        <Row title="移动端网页" desc="由同步服务器提供，本地模式下不可用" />
      </Group>
    );
  }
  if (link === null) {
    return (
      <Group title="移动端">
        <Row title="移动端网页" desc={<>同步服务器未配置地址（<code>GLEEOK_MOBILE_URL</code>）</>} />
      </Group>
    );
  }
  return (
    <Group title="移动端" note="链接包含访问令牌，请勿分享。手机需连接 Tailscale。">
      <Row title="登录链接" desc="在手机 Safari 中打开并添加到主屏幕">
        <button
          className="s-btn"
          disabled={!link}
          onClick={() =>
            link &&
            void gleeok.library({ op: 'copyText', text: link }).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 3000);
            })
          }
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} />
          {copied ? '已复制' : '复制链接'}
        </button>
      </Row>
      <Row title="地址">
        <span className="s-mono ink">{link?.split('#')[0] ?? '…'}</span>
      </Row>
    </Group>
  );
}

const IDLE_CHOICES = [10, 30, 60, 120, 0];

/** How long a 代码栏 out of sight keeps its VS Code window loaded (this machine). */
function CodeIdleSettings({ snap }: { snap: Snapshot }) {
  const minutes = codeIdleMinutes(snap.state);
  const choices = IDLE_CHOICES.includes(minutes) ? IDLE_CHOICES : [...IDLE_CHOICES.slice(0, -1), minutes, 0].sort((a, b) => (a || 1e9) - (b || 1e9));
  return (
    <Group>
      <Row title="自动卸载代码栏" desc="不可见超过设定时间后关闭网页以释放内存，标签页保留">
        <select className="s-select" value={minutes} onChange={(e) => gleeok.dispatch({ type: 'setCodeIdleMinutes', minutes: Number(e.target.value) })}>
          {choices.map((m) => (
            <option key={m} value={m}>
              {m === 0 ? '从不' : m < 60 ? `${m} 分钟` : `${m / 60} 小时`}
            </option>
          ))}
        </select>
      </Row>
    </Group>
  );
}

/** code-servers opened over SSH from this machine: one row per code-server the code links use. */
function CodeTunnelSettings({ snap }: { snap: Snapshot }) {
  const tunnels = snap.state.codeTunnels ?? [];
  const servers = codeServers([...snap.projects, ...snap.archivedProjects]);
  // A tunnel whose code-server no project uses any more still shows, so it can be turned off.
  for (const t of tunnels) if (!servers.some((s) => s.origin === t.origin)) servers.push({ origin: t.origin, link: { id: t.origin, label: '', url: t.origin } });
  return (
    <Group
      title="SSH 端口转发"
      note={
        <>
          经系统 ssh 转发到本机 localhost，沿用 <code>~/.ssh/config</code>，需密钥登录。远端端口为 code-server 的监听端口。
        </>
      }
    >
      {servers.length === 0 && <Row title="暂无 code-server" desc="项目添加代码链接后显示在这里" />}
      {servers.map(({ origin, link }) => (
        <TunnelRow key={origin} origin={origin} host={codeHost(link) || origin} tunnel={tunnels.find((t) => t.origin === origin)} status={snap.codeTunnels[origin]} />
      ))}
    </Group>
  );
}

function TunnelRow({ origin, host, tunnel, status }: { origin: string; host: string; tunnel?: CodeTunnel; status?: Snapshot['codeTunnels'][string] }) {
  // Over https something else (tailscale serve, Cloudflare, a proxy) usually stands in front of
  // code-server, on a port of its own: then code-server's own default.
  const defaultPort = () => {
    const u = new URL(origin);
    return (u.protocol === 'http:' && Number(u.port)) || 8080;
  };
  const [ssh, setSsh] = useState(tunnel?.ssh ?? host);
  const [port, setPort] = useState(String(tunnel?.remotePort ?? defaultPort()));
  useEffect(() => {
    setSsh(tunnel?.ssh ?? host);
    setPort(String(tunnel?.remotePort ?? defaultPort()));
  }, [tunnel?.ssh, tunnel?.remotePort]);
  const save = () => {
    const remotePort = Number(port);
    if (!ssh.trim() || !(remotePort > 0 && remotePort < 65536)) return;
    if (tunnel && tunnel.ssh === ssh.trim() && tunnel.remotePort === remotePort) return;
    gleeok.dispatch({ type: 'setCodeTunnel', origin, tunnel: { ssh: ssh.trim(), remotePort } });
  };
  const state = status?.state ?? 'off';
  return (
    <>
      <Row title={host} desc={<span className="s-mono">{origin}</span>}>
        {tunnel && (
          <Status tone={state === 'up' ? 'ok' : state === 'failed' ? 'bad' : state === 'connecting' ? 'warn' : 'ro'}>
            {{ off: '按需连接', connecting: '连接中…', up: `localhost:${tunnel.localPort}`, failed: '连接失败' }[state]}
          </Status>
        )}
        <Switch
          on={!!tunnel}
          onChange={(on) =>
            gleeok.dispatch({ type: 'setCodeTunnel', origin, tunnel: on ? { ssh: ssh.trim() || host, remotePort: Number(port) || defaultPort() } : null })
          }
        />
      </Row>
      {tunnel && (
        <div className="s-sub">
          <div className="s-inline-row">
            <span className="s-d">SSH 主机</span>
            <input className="s-field mono grow" value={ssh} placeholder="别名或 user@host" onChange={(e) => setSsh(e.target.value)} onBlur={save} onKeyDown={blurOnEnter} />
            <span className="s-d">远端端口</span>
            <input
              className="s-field mono w-80"
              value={port}
              inputMode="numeric"
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
              onBlur={save}
              onKeyDown={blurOnEnter}
            />
          </div>
          {state === 'failed' && (
            <div className="s-inline-row">
              <span className="s-d s-err grow">{status?.state === 'failed' ? status.error : ''}</span>
              <button className="s-btn" onClick={() => gleeok.dispatch({ type: 'retryCodeTunnel', origin })}>
                <Icon name="rotateCw" size={14} />
                重试
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function SyncSettings({ snap }: { snap: Snapshot }) {
  const { server } = snap;
  const [busy, setBusy] = useState(false);
  const local = server.status === 'local';
  return (
    <Group
      note={
        local ? (
          <>
            项目、链接与标签页仅保存在本机。如需在多台电脑间同步，请部署 Gleeok 服务器并在 <code>~/.config/gleeok/client.json</code> 中配置。
          </>
        ) : (
          <>
            项目、链接与标签页保存在服务器，离线时只读。配置文件位于 <code>~/.config/gleeok/client.json</code>。
          </>
        )
      }
    >
      <Row
        title={local ? '本地模式' : '同步服务器'}
        desc={server.error ? <span className="s-err">{server.error}</span> : server.url ? <span className="s-mono">{server.url}</span> : undefined}
      >
        <Status tone={{ ok: 'ok', offline: 'bad', unconfigured: 'bad', local: 'ro' }[server.status] as 'ok' | 'bad' | 'ro'}>
          {{ ok: '已连接', offline: '离线', unconfigured: '配置有误', local: '未同步' }[server.status]}
        </Status>
        {!local && (
          <button
            className="s-btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void gleeok.refreshProjects().finally(() => setBusy(false));
            }}
          >
            {busy ? '连接中…' : '重新连接'}
          </button>
        )}
      </Row>
    </Group>
  );
}

function VaultSettings({ snap }: { snap: Snapshot }) {
  const { vault } = snap;
  const mac = snap.platform === 'darwin';
  return (
    <>
      <Group>
        <Row title="状态" desc="锁屏或退出时自动锁定，主密码不保存">
          {vault.unlocked && <Tag>{vault.entries.length} 条</Tag>}
          <Status tone={vault.unlocked ? 'ok' : 'ro'}>{vault.unlocked ? '已解锁' : '已锁定'}</Status>
          {vault.unlocked ? (
            <button className="s-btn" onClick={() => gleeok.dispatch({ type: 'vaultLock' })}>
              <Icon name="lock" size={14} />
              锁定
            </button>
          ) : (
            <button className="s-btn primary" onClick={() => gleeok.dispatch({ type: 'vaultUnlock' })}>
              <Icon name="lockOpen" size={14} />
              解锁
            </button>
          )}
        </Row>
        <Row title="服务器">
          <span className="s-mono ink">{vault.serverUrl}</span>
        </Row>
        {vault.email && (
          <Row title="账号">
            <span className="s-val">{vault.email}</span>
          </Row>
        )}
      </Group>
      <Group title="快捷键">
        <Row title="填充登录信息">
          <Kbd>{mac ? '⌘⇧L' : 'Ctrl+Shift+L'}</Kbd>
        </Row>
        <Row title="搜索密码库" desc="在命令面板中复制网址、用户名和密码">
          <Kbd>{mac ? '⌘⇧K' : 'Ctrl+Shift+K'}</Kbd>
        </Row>
      </Group>
    </>
  );
}

function About({ snap }: { snap: Snapshot }) {
  const built = new Date(__GLEEOK_BUILD__);
  const pad = (n: number) => String(n).padStart(2, '0');
  const builtText = `${built.getFullYear()}-${pad(built.getMonth() + 1)}-${pad(built.getDate())} ${pad(built.getHours())}:${pad(built.getMinutes())}`;
  const { update, build, drm } = snap;
  const updateDesc = !snap.canSelfUpdate
    ? '当前安装方式不支持自动更新'
    : update.step
      ? `正在更新：${update.step}`
      : update.error
        ? <span className="s-err">{update.error}</span>
        : update.commits.length > 0
          ? `有 ${update.commits.length} 个更新`
          : '已是最新版本';
  return (
    <>
      <div className="s-about">
        <img className="s-logo" src={icon} alt="" />
        <span className="s-about-name">Gleeok</span>
      </div>
      <Group>
        <Row title="版本">
          {build.hot && <Tag>测试版</Tag>}
          <span className="s-val">{build.version}</span>
          {build.commit !== 'unknown' && <span className="s-mono ink">{build.commit.slice(0, 7)}</span>}
        </Row>
        <Row title="构建时间">
          <span className="s-val">{builtText}</span>
        </Row>
        <Row title="更新" desc={updateDesc}>
          {snap.canSelfUpdate && update.commits.length > 0 && (
            <button className="s-btn primary" onClick={() => gleeok.dispatch({ type: 'openUpdate' })}>
              查看并更新
            </button>
          )}
          {snap.canSelfUpdate && (
            <button className="s-btn" onClick={() => gleeok.dispatch({ type: 'checkUpdate' })}>
              检查更新
            </button>
          )}
        </Row>
        {build.updates === 'release' ? (
          <Row
            title="更新通道"
            desc={
              build.betaNeedsInstaller
                ? '最新测试版需要新的安装包，请等待下一个正式版'
                : (snap.state.updateChannel ?? 'stable') === 'beta'
                  ? '随 main 分支实时更新'
                  : '仅安装正式发布版本'
            }
          >
            <Seg
              value={snap.state.updateChannel ?? 'stable'}
              options={[
                ['stable', '正式版'],
                ['beta', '测试版'],
              ]}
              onChange={(channel) => gleeok.dispatch({ type: 'setUpdateChannel', channel })}
            />
          </Row>
        ) : (
          <Row title="更新通道" desc={build.updates === 'git' ? '代码目录，跟随 main 分支' : '当前安装方式不支持自动更新'} />
        )}
        <Row
          title="DRM"
          desc={
            drm.vmp === 'none' ? (
              <>
                仅开发签名，请运行 <code>deploy/macos-vmp-sign.sh</code>
              </>
            ) : drm.vmp === 'stale' ? (
              <span className="s-err">
                Electron 更新后签名失效，请运行 <code>deploy/macos-vmp-sign.sh</code>
              </span>
            ) : (
              '用于 Apple Music 等受保护内容'
            )
          }
        >
          {drm.vmp === 'signed' && <Tag>已签名</Tag>}
          <Status tone={drm.widevine ? 'ok' : 'warn'}>{drm.widevine ? `Widevine ${drm.widevine}` : '准备中'}</Status>
        </Row>
      </Group>
      <div className="s-foot">
        <span className="s-inline-row">
          <button className="s-btn" onClick={() => gleeok.dispatch({ type: 'openLink', url: 'https://github.com/Suchun-sv/Gleeok', newTab: true })}>
            <Icon name="github" size={14} />
            GitHub
          </button>
          <button className="s-btn" onClick={() => gleeok.dispatch({ type: 'openLog' })} title="网页崩溃与加载失败记录">
            <Icon name="fileText" size={14} />
            日志
          </button>
        </span>
        <span className="s-d">Apache-2.0</span>
      </div>
    </>
  );
}
