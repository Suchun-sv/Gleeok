import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Command, PaneRects, Snapshot } from '../../../shared/src/ipc.ts';
import { Icon } from './Icons.tsx';
import { TerminalView } from './Terminal.tsx';
import { LibraryView } from './library/LibraryView.tsx';
import { PlannerView, showProjectTasks, showTask } from './planner/PlannerView.tsx';
import { byOrder, dayKey, dueDay, dueLabel, hhmm, isOverdue, plan, usePlanner } from './planner/data.ts';
import type { PlannerTask } from '../../../shared/src/planner.ts';
import { useLibrary } from './library/data.ts';
import {
  NEW_TAB_URL,
  DEFAULT_SUGGESTIONS,
  LIBRARY_URL,
  PLANNER_URL,
  isLibraryUrl,
  isPlannerUrl,
  isReaderUrl,
  isTerminalUrl,
  paneName,
  sameUrl,
  shortTitle,
  visibleSlots,
  CODE_SIDE_SLOT,
  CODE_SIDE_WIDTH,
  primaryCodeLink,
  type AppWindowState,
  type Link,
  type Pane,
  type Project,
  type ProjectSession,
  type Suggestion,
  type Tab,
} from '../../../shared/src/model.ts';

/** Why a page's process stopped (Electron's render-process-gone reasons), for the pane's message. */
const CRASH_REASONS: Record<string, string> = {
  oom: '内存不足',
  'memory-eviction': '内存紧张，被系统回收',
  killed: '被系统结束',
  crashed: '崩溃',
  'abnormal-exit': '异常退出',
  'launch-failed': '启动失败',
  'integrity-failure': '代码完整性检查失败',
};

interface Props {
  snap: Snapshot;
  project: Project;
  session: ProjectSession;
  command: (Command & { seq: number }) | null;
  win: AppWindowState;
  dragImages: Record<number, string>;
  leading?: React.ReactNode;
  /** Shown at the right end of the last pane's tab strip. */
  trailing?: React.ReactNode;
}

/**
 * The renderer only draws chrome (tab strips, address bars) and reserves an empty box per pane.
 * Main lays a native WebContentsView over each box, so the boxes' rects are reported up.
 */
export function Panes({ snap, project, session, command, win, dragImages, leading, trailing }: Props) {
  const main = snap.state.windows.find((w) => w.role === 'main')!;
  const slots = visibleSlots(win);
  const { focusRatio } = main.layout;
  // 代码侧边栏 (split mode): code-server's views on the right, its editors in the rightmost pane.
  const codeShown =
    win.role === 'main' && !!snap.state.codeSplit && !!snap.state.codeSide?.open && session.lifecycle === 'live' && !!primaryCodeLink(project);
  const editorSlot = codeShown ? slots.at(-1) : undefined;
  const sideBox = useRef<HTMLDivElement>(null);
  const [sideLive, setSideLive] = useState<number | null>(null);
  const sideWidth = sideLive ?? snap.state.codeSide?.width ?? CODE_SIDE_WIDTH;
  // Once a pane lives in its own window, the panes left in the main window split it evenly.
  const focusExpand = main.layout.focusExpand && !snap.state.windows.some((w) => w.role === 'satellite');
  // A slot can be detached while the main window still shows at least one other pane.
  const canDetach = win.role === 'main' && slots.length > 1;
  const boxes = useRef(new Map<number, HTMLDivElement>());
  const lastSent = useRef('');
  const names = snap.state.paneNames;
  // Widths while a divider is being dragged; dropped once main has the new weights.
  const [live, setLive] = useState<Record<number, number> | null>(null);
  const savedWeights = JSON.stringify(win.layout.weights ?? {});
  useEffect(() => setLive(null), [savedWeights]);
  const weightOf = (slot: number) => live?.[slot] ?? win.layout.weights?.[slot] ?? 1;
  const focusOf = (slot: number) => (focusExpand && snap.state.focusedPane === slot ? focusRatio : 1);

  /** Drag the divider between two panes. Pages turn into screenshots meanwhile, so the pointer is never lost to them. */
  function startResize(e: React.PointerEvent<HTMLDivElement>, left: number, right: number) {
    if (e.button !== 0) return;
    const a = boxes.current.get(left)?.closest('.pane');
    const b = boxes.current.get(right)?.closest('.pane');
    if (!a || !b) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    gleeok.dispatch({ type: 'coverPages', winId: win.id, active: true });
    const wa = a.getBoundingClientRect().width;
    const total = wa + b.getBoundingClientRect().width;
    const sum = weightOf(left) * focusOf(left) + weightOf(right) * focusOf(right);
    const startX = e.clientX;
    let latest: Record<number, number> | null = null;
    const move = (ev: PointerEvent) => {
      if (ev.buttons === 0) return end();
      const width = Math.min(Math.max(wa + ev.clientX - startX, MIN_PANE_WIDTH), total - MIN_PANE_WIDTH);
      const grow = (sum * width) / total;
      latest = { [left]: grow / focusOf(left), [right]: (sum - grow) / focusOf(right) };
      setLive((prev) => ({ ...prev, ...latest }));
    };
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('lostpointercapture', end);
      if (latest) gleeok.dispatch({ type: 'setPaneWeights', winId: win.id, weights: latest });
      gleeok.dispatch({ type: 'coverPages', winId: win.id, active: false });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('lostpointercapture', end);
  }

  /** Drag the line between the panes and the 代码侧边栏 (pages are screenshots meanwhile). */
  function startSideResize(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    gleeok.dispatch({ type: 'coverPages', winId: win.id, active: true });
    const startX = e.clientX;
    const start = sideWidth;
    let latest = start;
    const move = (ev: PointerEvent) => {
      if (ev.buttons === 0) return end();
      latest = Math.min(Math.max(start + startX - ev.clientX, 200), 800);
      setSideLive(latest);
    };
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('lostpointercapture', end);
      gleeok.dispatch({ type: 'setCodeSideWidth', width: latest });
      gleeok.dispatch({ type: 'coverPages', winId: win.id, active: false });
      setTimeout(() => setSideLive(null), 300);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('lostpointercapture', end);
  }

  function measure() {
    const rects: PaneRects = {};
    const rectOf = (el: Element | null | undefined) => {
      const r = el?.getBoundingClientRect();
      return r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null;
    };
    for (const slot of slots) rects[slot] = rectOf(boxes.current.get(slot));
    if (codeShown) rects[CODE_SIDE_SLOT] = rectOf(sideBox.current);
    const json = JSON.stringify(rects);
    if (json !== lastSent.current) {
      lastSent.current = json;
      gleeok.reportPaneRects(win.id, rects);
    }
  }

  useLayoutEffect(measure);
  useEffect(() => {
    const ro = new ResizeObserver(measure);
    for (const el of boxes.current.values()) ro.observe(el);
    if (sideBox.current) ro.observe(sideBox.current);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      gleeok.reportPaneRects(win.id, {});
      lastSent.current = '';
    };
  }, [slots.join(','), codeShown]);

  return (
    <div className="panes">
      {slots.map((slot, i) => [
        i > 0 && (
          <div
            key={`divider-${slot}`}
            className="pane-divider"
            onPointerDown={(e) => startResize(e, slots[i - 1], slot)}
            onDoubleClick={() =>
              gleeok.dispatch({ type: 'setPaneWeights', winId: win.id, weights: Object.fromEntries(slots.map((s) => [s, 1])) })
            }
            title="拖动调整宽度，双击恢复等宽"
          />
        ),
        slot === editorSlot ? (
          <CodeEditorPane
            key={slot}
            name={paneName(names, slot)}
            projectName={project.name}
            focused={snap.state.focusedPane === slot}
            grow={weightOf(slot) * focusOf(slot)}
            boxRef={(el) => (el ? boxes.current.set(slot, el) : boxes.current.delete(slot))}
            leading={i === 0 ? leading : null}
            trailing={i === slots.length - 1 ? trailing : null}
          />
        ) : (
        <PaneView
          platform={snap.platform}
          name={paneName(names, slot)}
          suggestions={snap.state.suggestions ?? DEFAULT_SUGGESTIONS}
          projects={snap.projects}
          leading={i === 0 ? leading : null}
          trailing={i === slots.length - 1 ? trailing : null}
          key={slot}
          slot={slot}
          pane={session.panes[slot]}
          project={project}
          focused={snap.state.focusedPane === slot}
          grow={weightOf(slot) * focusOf(slot)}
          boxRef={(el) => (el ? boxes.current.set(slot, el) : boxes.current.delete(slot))}
          command={command?.slot === slot ? command : null}
          dragging={snap.tabDragging}
          covered={snap.tabDragging || snap.paletteWindows.includes(win.id)}
          dragImage={dragImages[slot]}
          asleep={session.lifecycle !== 'live'}
          crashedTabs={snap.crashedTabs}
          windowButton={
            win.role === 'satellite' ? (
              <button onClick={() => gleeok.dispatch({ type: 'attachPane', slot })} title="合并回主窗口">
                ⇱
              </button>
            ) : (
              <>
                {(slots.length > 1 || win.maximized !== undefined) && (
                  <button
                    className={win.maximized !== undefined ? 'on' : ''}
                    onClick={() => gleeok.dispatch({ type: 'toggleMaximize', slot })}
                    title={`${win.maximized !== undefined ? '还原，显示所有栏' : '最大化这一栏，其他栏暂时收起'}（${snap.platform === 'darwin' ? '⌘⌥Z' : 'Ctrl+Alt+Z'}）`}
                  >
                    <Icon name={win.maximized !== undefined ? 'minimize' : 'maximize'} size={12} />
                  </button>
                )}
                {canDetach && (
                  <button onClick={() => gleeok.dispatch({ type: 'detachPane', slot })} title="拆到新窗口（可放到另一块屏幕）">
                    ⧉
                  </button>
                )}
              </>
            )
          }
        />
        ),
      ])}
      {codeShown && [
        <div key="code-divider" className="pane-divider" onPointerDown={startSideResize} title="拖动调整代码侧边栏的宽度" />,
        <div key="code-side" ref={sideBox} className="code-side" style={{ width: sideWidth }} />,
      ]}
    </div>
  );
}

/**
 * The rightmost pane while the 代码侧边栏 is open: VS Code's editors (a native view main puts in
 * the box), under a plain strip with the pane's name, the layout buttons and a close button.
 */
function CodeEditorPane(props: {
  name: string;
  projectName: string;
  focused: boolean;
  grow: number;
  boxRef: (el: HTMLDivElement | null) => void;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <section className={`pane code-editor ${props.focused ? 'focused' : ''}`} style={{ flexGrow: props.grow }}>
      <div className="tabs">
        {props.leading && <div className="tabs-leading">{props.leading}</div>}
        <span className="pane-name">{props.name}</span>
        <span className="code-editor-label">
          <Icon name="code" size={12} /> 代码 · {props.projectName}
        </span>
        <button className="tab-add" onClick={() => gleeok.dispatch({ type: 'toggleCodeSide' })} title="收起代码侧边栏，这一栏回到网页">
          ×
        </button>
        {props.trailing && <div className="tabs-trailing">{props.trailing}</div>}
      </div>
      <div className="content" ref={props.boxRef} />
    </section>
  );
}

/** A dragged divider stops short of squeezing either pane below this. */
const MIN_PANE_WIDTH = 220;

interface PaneProps {
  platform: string;
  name: string;
  suggestions: Suggestion[];
  projects: Project[];
  slot: number;
  pane: Pane;
  project: Project;
  focused: boolean;
  grow: number;
  boxRef: (el: HTMLDivElement | null) => void;
  command: (Command & { seq: number }) | null;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  windowButton?: React.ReactNode;
  /** A tab drag is in progress: pages are hidden and this pane shows a screenshot instead. */
  dragging: boolean;
  /** Pages are hidden (tab drag or palette): show the screenshot in their place. */
  covered: boolean;
  dragImage?: string;
  /** The project is hibernated: pages are not loaded until the user starts it. */
  asleep: boolean;
  /** Tabs whose page process died (tab id → reason). */
  crashedTabs: Record<string, string>;
}

function PaneView(props: PaneProps) {
  const { platform, name, suggestions, projects, slot, pane, project, focused, grow, boxRef, command, leading, trailing, windowButton, dragging, dragImage, asleep, crashedTabs } = props;
  const tab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];
  const isNew = tab.url === NEW_TAB_URL;
  const isTerm = isTerminalUrl(tab.url);
  const isLib = isLibraryUrl(tab.url);
  const isPlanner = isPlannerUrl(tab.url);
  // Bumped whenever main focuses this pane while it shows a terminal.
  const [termFocus, setTermFocus] = useState(0);
  const address = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(isNew ? '' : tab.url);
  const findInput = useRef<HTMLInputElement>(null);
  const [find, setFind] = useState<{ text: string; result: string } | null>(null);
  const [dropTarget, setDropTarget] = useState(false);
  const [toast, setToast] = useState<Extract<Command, { type: 'toast' }> | null>(null);
  const paste = usePasteTracker();
  const [saveOpen, setSaveOpen] = useState(false);
  const savedLink = isNew ? undefined : project.links.find((l) => sameUrl(l.url, tab.url));

  useEffect(() => setDraft(isNew ? '' : tab.url), [tab.id, tab.url]);
  useEffect(() => {
    if (command?.type === 'focusAddress') address.current?.select();
    if (command?.type === 'focusNewTab') {
      if (isTerm) setTermFocus(command.seq);
      else search.current?.focus();
    }
    if (command?.type === 'openFind') {
      setFind((f) => f ?? { text: '', result: '' });
      requestAnimationFrame(() => findInput.current?.select());
    }
    if (command?.type === 'toast') setToast(command);
    if (command?.type === 'openSaveLink') setSaveOpen(true);
    if (command?.type === 'findResult') {
      setFind((f) => f && { ...f, result: command.total ? `${command.active}/${command.total}` : '无结果' });
    }
  }, [command?.seq]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ms ?? 5000);
    return () => clearTimeout(t);
  }, [toast]);
  // Find and save bars belong to the page they were opened on.
  useEffect(() => {
    setFind(null);
    setSaveOpen(false);
  }, [tab.id]);

  function closeFind() {
    gleeok.dispatch({ type: 'stopFind', slot });
    setFind(null);
    gleeok.dispatch({ type: 'focusPane', slot });
  }

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(TAB_MIME)) return;
      e.preventDefault();
      setDropTarget(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      // Moving between children also fires dragleave; only count actually leaving the pane.
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(false);
    },
    onDrop: (e: React.DragEvent) => {
      setDropTarget(false);
      const tabId = e.dataTransfer.getData(TAB_MIME);
      if (tabId) gleeok.dispatch({ type: 'moveTab', tabId, toSlot: slot });
    },
  };

  const focusMe = () => !focused && gleeok.dispatch({ type: 'focusPane', slot });

  return (
    <section
      className={`pane ${focused ? 'focused' : ''} ${dropTarget ? 'drop-target' : ''}`}
      style={{ flexGrow: grow }}
      onMouseDown={focusMe}
      {...dropProps}
    >
      <div className="tabs">
        {leading && <div className="tabs-leading">{leading}</div>}
        <span className="pane-name">{name}</span>
        {pane.tabs.map((t) => (
          <TabButton key={t.id} tab={t} slot={slot} active={t.id === tab.id} />
        ))}
        <button className="tab-add" onClick={() => gleeok.dispatch({ type: 'newTab', slot })} title="新标签页">
          +
        </button>
        {trailing && <div className="tabs-trailing">{trailing}</div>}
      </div>
      <div className="toolbar">
        <button onClick={() => gleeok.dispatch({ type: 'history', slot, op: 'back' })} disabled={isNew || isTerm || isLib || isPlanner}>
          ‹
        </button>
        <button onClick={() => gleeok.dispatch({ type: 'history', slot, op: 'forward' })} disabled={isNew || isTerm || isLib || isPlanner}>
          ›
        </button>
        <button onClick={() => gleeok.dispatch({ type: 'history', slot, op: 'reload' })} disabled={isNew || isTerm || isLib || isPlanner}>
          ⟳
        </button>
        <input
          ref={address}
          value={draft}
          placeholder="输入网址或搜索"
          onChange={(e) => setDraft(e.target.value)}
          onPaste={paste.onPaste}
          onBlur={() => {
            setDraft(isNew ? '' : tab.url);
            paste.reset();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              gleeok.dispatch({ type: 'navigate', slot, url: draft, save: paste.wasPasted(draft) });
              paste.reset();
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              setDraft(isNew ? '' : tab.url);
              gleeok.dispatch({ type: 'focusPane', slot });
            }
          }}
        />
        {!isNew && (
          <button
            className={`star ${savedLink ? 'saved' : ''}`}
            onClick={() => setSaveOpen((o) => !o)}
            title={savedLink ? `已在项目链接里：${savedLink.label}` : '保存到项目链接（⌘D / Ctrl+D）'}
          >
            {savedLink ? '★' : '☆'}
          </button>
        )}
        {toast && (
          <span className="toast" title={toast.text}>
            <span className="text">{toast.text}</span>
            {toast.undo && (
              <button
                onClick={() => {
                  gleeok.dispatch(toast.undo!);
                  setToast(null);
                }}
              >
                {toast.undoLabel ?? '撤销'}
              </button>
            )}
          </span>
        )}
        {windowButton}
      </div>
      {saveOpen && !isNew && (
        <SaveBar
          key={tab.id}
          slot={slot}
          projectId={project.id}
          projectName={project.name}
          tab={tab}
          existing={savedLink}
          onClose={() => {
            setSaveOpen(false);
            gleeok.dispatch({ type: 'focusPane', slot });
          }}
        />
      )}
      {find && (
        <div className="findbar">
          <input
            ref={findInput}
            placeholder="在页面中查找"
            value={find.text}
            onChange={(e) => {
              setFind({ text: e.target.value, result: '' });
              if (e.target.value) gleeok.dispatch({ type: 'find', slot, text: e.target.value });
              else gleeok.dispatch({ type: 'stopFind', slot });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && find.text)
                gleeok.dispatch({ type: 'find', slot, text: find.text, forward: !e.shiftKey, findNext: true });
              if (e.key === 'Escape') closeFind();
            }}
          />
          <span className="meta">{find.result}</span>
          <button onClick={() => gleeok.dispatch({ type: 'find', slot, text: find.text, forward: false, findNext: true })}>↑</button>
          <button onClick={() => gleeok.dispatch({ type: 'find', slot, text: find.text, forward: true, findNext: true })}>↓</button>
          <button onClick={closeFind}>×</button>
        </div>
      )}
      <div className="content" ref={boxRef}>
        {isNew && <NewTab slot={slot} project={project} suggestions={suggestions} inputRef={search} />}
        {isTerm && <TerminalView key={tab.id} tab={tab} focusSeq={termFocus} platform={platform} />}
        {isLib && <LibraryView mode="pane" slot={slot} platform={platform} />}
        {isPlanner && <PlannerView mode="pane" projects={projects} currentProjectId={project.id} />}
        {asleep && !isNew && !isTerm && !isLib && !isPlanner && !dragging && (
          <div className="asleep">
            {tab.favicon ? <img src={tab.favicon} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} /> : null}
            <p className="title">{tab.title || tab.url}</p>
            <p className="hint">项目已休眠，网页没有加载</p>
            <button className="primary" onClick={() => gleeok.dispatch({ type: 'startProject', id: project.id })}>
              启动「{project.name}」
            </button>
          </div>
        )}
        {!asleep && !dragging && crashedTabs[tab.id] && (
          <div className="asleep">
            {tab.favicon ? <img src={tab.favicon} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} /> : null}
            <p className="title">{tab.title || tab.url}</p>
            <p className="hint">这个网页的进程停止了（{CRASH_REASONS[crashedTabs[tab.id]] ?? crashedTabs[tab.id]}），所以显示不出来。</p>
            <button className="primary" onClick={() => gleeok.dispatch({ type: 'reviveTab', tabId: tab.id })}>
              重新加载
            </button>
          </div>
        )}
        {/* Painted beneath the page just before main hides it (see App), so covering never flashes. */}
        {!isNew && !isTerm && !isLib && !isPlanner && !asleep && dragImage && <img className="drop-shot" src={dragImage} alt="" />}
        {dragging && (
          <div className="drop-zone">
            <span>移到{name}</span>
          </div>
        )}
      </div>
    </section>
  );
}

/** Inline editor for saving the current page as a project link; prefilled from the page itself. */
function SaveBar(props: {
  slot: number;
  projectId: string;
  projectName: string;
  tab: Tab;
  existing?: Link;
  onClose: () => void;
}) {
  const { slot, projectId, projectName, tab, existing, onClose } = props;
  const icon = existing?.icon ?? (tab.favicon && tab.favicon.length <= 2048 ? tab.favicon : undefined);
  const [label, setLabel] = useState(existing?.label ?? (shortTitle(tab.title) || hostOf(tab.url)));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);

  function save() {
    const link: Link = {
      ...existing,
      id: existing?.id ?? `l_${crypto.randomUUID().slice(0, 8)}`,
      label: label.trim() || hostOf(tab.url),
      url: existing?.url ?? tab.url,
      ...(icon ? { icon } : {}),
    };
    gleeok.dispatch({ type: 'upsertLink', projectId, link, slot });
    onClose();
  }

  return (
    <div className="savebar">
      <img src={icon ?? faviconFor(tab.url)} alt="" />
      <input
        ref={input}
        value={label}
        placeholder="名称"
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') onClose();
        }}
      />
      <span className="url" title={tab.url}>
        {existing?.url ?? tab.url}
      </span>
      <span className="meta">→ {projectName}</span>
      <button className="primary" onClick={save}>
        {existing ? '更新' : '保存'}
      </button>
      {existing && (
        <button
          onClick={() => {
            gleeok.dispatch({ type: 'removeLink', projectId, linkId: existing.id });
            onClose();
          }}
        >
          删除
        </button>
      )}
      <button onClick={onClose}>取消</button>
    </div>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const TAB_MIME = 'application/x-gleeok-tab';

/**
 * Tracks whether an input's current value came from a paste with no typing since; such a
 * URL is remembered as a project link when submitted. Hand-typed or edited input is not.
 */
function usePasteTracker() {
  const pasted = useRef<string | null>(null);
  return {
    onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => {
      const el = e.currentTarget;
      // The value after the paste lands; compare on submit.
      requestAnimationFrame(() => (pasted.current = el.value));
    },
    wasPasted: (value: string) => pasted.current !== null && pasted.current === value,
    reset: () => (pasted.current = null),
  };
}

function TabButton({ tab, slot, active }: { tab: Tab; slot: number; active: boolean }) {
  return (
    <div
      className={`tab ${active ? 'active' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TAB_MIME, tab.id);
        e.dataTransfer.effectAllowed = 'move';
        // Pages sit above the shell and would swallow the drag; main swaps them for screenshots.
        gleeok.dispatch({ type: 'tabDrag', active: true });
      }}
      onDragEnd={() => gleeok.dispatch({ type: 'tabDrag', active: false })}
      onClick={() => gleeok.dispatch({ type: 'activateTab', slot, tabId: tab.id })}
      onAuxClick={(e) => e.button === 1 && gleeok.dispatch({ type: 'closeTab', slot, tabId: tab.id })}
      title={`${tab.title}\n${tab.url}`}
    >
      {tab.favicon ? (
        <img src={tab.favicon} alt="" />
      ) : isTerminalUrl(tab.url) || isReaderUrl(tab.url) || isLibraryUrl(tab.url) || isPlannerUrl(tab.url) ? (
        <img src={faviconFor(tab.url)} alt="" />
      ) : (
        <span className="fav" />
      )}
      <span className="title">{tab.title || tab.url}</span>
      <button
        className="close"
        onClick={(e) => {
          e.stopPropagation();
          gleeok.dispatch({ type: 'closeTab', slot, tabId: tab.id });
        }}
      >
        ×
      </button>
    </div>
  );
}

/** How many of the project's tasks the new-tab page lists before "还有 N 个". */
const PROJECT_TASKS_SHOWN = 6;

/**
 * The new-tab page's way into the 日程: what today holds (the next block, what is due, all
 * projects), then this project's open tasks with an input to add one.
 */
function PlannerTile({ slot, project }: { slot: number; project: Project }) {
  const data = usePlanner();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const now = new Date();
  const today = dayKey(now);
  const open = (data?.tasks ?? []).filter((t) => !t.done && !t.deleted);
  const due = open
    .filter((t) => (dueDay(t) ?? '9') <= today)
    .sort((a, b) => Number(isOverdue(b, now)) - Number(isOverdue(a, now)) || (b.priority ?? 0) - (a.priority ?? 0) || String(a.due).localeCompare(String(b.due)));
  const titles = new Map((data?.tasks ?? []).map((t) => [t.key, t.title]));
  // The block under way, else the next one today.
  const next = (data?.blocks ?? [])
    .filter((b) => dayKey(new Date(b.start)) === today && Date.parse(b.end) > now.getTime() && !(b.taskKey && !titles.has(b.taskKey)))
    .sort((a, b) => a.start.localeCompare(b.start))[0];
  const go = (task?: string) => {
    if (task) showTask(task);
    gleeok.dispatch({ type: 'navigate', slot, url: PLANNER_URL });
  };
  const todayShown = due.slice(0, next ? 2 : 3);
  // This project's open tasks not already listed under today: overdue, by date (none last), priority.
  const mine = open
    .filter((t) => t.projectId === project.id && !todayShown.includes(t))
    .sort(
      (a, b) =>
        Number(isOverdue(b, now)) - Number(isOverdue(a, now)) ||
        (a.due ?? '9').localeCompare(b.due ?? '9') ||
        (b.priority ?? 0) - (a.priority ?? 0) ||
        byOrder(a, b),
    );
  const add = async () => {
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    const top = Math.min(0, ...(data?.tasks ?? []).map((t) => t.order ?? 0)) - 1;
    try {
      await plan<PlannerTask[]>({ op: 'create', kind: 'tasks', objects: [{ title, projectId: project.id, order: top }] });
      setError('');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const taskTile = (t: PlannerTask) => (
    <button key={t.key} onClick={() => go(t.key)} title={t.title}>
      <img src={faviconFor(PLANNER_URL)} alt="" />
      <span>{t.title}</span>
      <span className={`sub ${isOverdue(t, now) ? 'late' : ''}`}>{t.due ? dueLabel(t) : '没有日期'}</span>
    </button>
  );
  return (
    <>
      <h3>日程</h3>
      <div className="newtab-label">今天</div>
      <div className="links">
        <button onClick={() => go()} title="在这一栏打开日程">
          <img src={faviconFor(PLANNER_URL)} alt="" />
          <span>日程</span>
          <span className="sub">{data ? (due.length ? `今天 ${due.length} 个任务` : '今天没有待办') : ''}</span>
        </button>
        {next && (
          <button onClick={() => go(next.taskKey)} title={next.taskKey ? titles.get(next.taskKey) : next.title}>
            <img src={faviconFor(PLANNER_URL)} alt="" />
            <span>
              {hhmm(new Date(next.start))} {next.taskKey ? titles.get(next.taskKey) : next.title}
            </span>
            <span className="sub">{Date.parse(next.start) <= now.getTime() ? '进行中' : '接下来'}</span>
          </button>
        )}
        {todayShown.map(taskTile)}
      </div>
      <div className="newtab-label">
        「{project.name}」的任务
        <button
          className="link"
          onClick={() => {
            showProjectTasks(project.id);
            go();
          }}
        >
          在日程中查看全部 →
        </button>
      </div>
      <div className="links">
        {mine.slice(0, PROJECT_TASKS_SHOWN).map(taskTile)}
        {mine.length > PROJECT_TASKS_SHOWN && (
          <button
            onClick={() => {
              showProjectTasks(project.id);
              go();
            }}
          >
            <img src={faviconFor(PLANNER_URL)} alt="" />
            <span>还有 {mine.length - PROJECT_TASKS_SHOWN} 个</span>
            <span className="sub">在日程中查看</span>
          </button>
        )}
      </div>
      <input
        className="newtab-add"
        placeholder={`+ 添加任务到「${project.name}」，回车`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void add()}
      />
      {error && <p className="hint error">{error}</p>}
    </>
  );
}

/** The new-tab page's way into the 文献库: open it here, or jump back into a recent read. */
function LibraryTile({ slot }: { slot: number }) {
  const lib = useLibrary();
  const recent = (lib?.items ?? [])
    .filter((i) => typeof i.lastReadAt === 'string' && !i.deleted)
    .sort((a, b) => String(b.lastReadAt).localeCompare(String(a.lastReadAt)))
    .slice(0, 6);
  return (
    <>
      <h3>文献库</h3>
      <div className="links">
        <button onClick={() => gleeok.dispatch({ type: 'navigate', slot, url: LIBRARY_URL })} title="在这一栏打开文献库">
          <img src={faviconFor(LIBRARY_URL)} alt="" />
          <span>文献库</span>
          <span className="sub">{lib ? `${lib.items.filter((i) => i.itemType !== 'note' && i.itemType !== 'attachment' && !i.deleted).length} 篇` : ''}</span>
        </button>
        {recent.map((i) => {
          const pdf = lib!.items.find((a) => a.parentItem === i.key && a.itemType === 'attachment' && a.fileHash && !a.deleted);
          return (
            <button key={i.key} disabled={!pdf} onClick={() => pdf && gleeok.dispatch({ type: 'openReader', attachment: pdf.key, slot })} title={String(i.title ?? '')}>
              <img src={PDF_ICON} alt="" />
              <span>{String(i.title ?? '未命名')}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function NewTab({
  slot,
  project,
  suggestions,
  inputRef,
}: {
  slot: number;
  project: Project;
  suggestions: Suggestion[];
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [q, setQ] = useState('');
  const paste = usePasteTracker();
  return (
    <div className="newtab">
      <input
        ref={inputRef}
        className="search"
        placeholder="输入网址或搜索（粘贴的网址会存进项目链接）"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onPaste={paste.onPaste}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && q.trim()) gleeok.dispatch({ type: 'navigate', slot, url: q, save: paste.wasPasted(q) });
        }}
      />
      <h3>{project.name}</h3>
      <div className="links">
        {project.links.length === 0 && <p className="hint">这个项目还没有链接，在右上角的项目设置里添加</p>}
        {project.links.map((l) => (
          <button key={l.id} onClick={() => gleeok.dispatch({ type: 'navigate', slot, url: l.url })} title={l.url}>
            <img src={l.icon ?? faviconFor(l.url)} alt="" />
            <span>{l.label}</span>
          </button>
        ))}
      </div>
      <PlannerTile slot={slot} project={project} />
      <LibraryTile slot={slot} />
      <h3>常用</h3>
      <div className="links">
        {suggestions.map((t, i) => (
          <button key={i} onClick={() => gleeok.dispatch({ type: 'navigate', slot, url: t.url })} title={t.url}>
            <img src={faviconFor(t.url)} alt="" />
            <span>{t.label}</span>
            <span className="sub">{t.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const glyph = (paths: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`)}`;
/** lucide "file-text" and "library", for reader and library tabs. */
const PDF_ICON = glyph('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>');
const LIBRARY_ICON = glyph(
  '<rect width="8" height="18" x="3" y="3" rx="1"/><path d="M7 3v18"/><path d="M20.4 18.9c.2.5-.1 1.1-.6 1.3l-1.9.7c-.5.2-1.1-.1-1.3-.6L11.1 5.1c-.2-.5.1-1.1.6-1.3l1.9-.7c.5-.2 1.1.1 1.3.6Z"/>',
);

const PLANNER_ICON = glyph('<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>');

/** lucide "square-terminal", for terminal tabs and links. */
const TERMINAL_ICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2"/></svg>',
)}`;

export function faviconFor(url: string) {
  if (isTerminalUrl(url)) return TERMINAL_ICON;
  if (isReaderUrl(url)) return PDF_ICON;
  if (isLibraryUrl(url)) return LIBRARY_ICON;
  if (isPlannerUrl(url)) return PLANNER_ICON;
  try {
    return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(url).hostname}`;
  } catch {
    return '';
  }
}
