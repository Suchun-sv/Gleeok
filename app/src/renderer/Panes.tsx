import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Command, PaneRects, Snapshot } from '../../../shared/src/ipc.ts';
import {
  NEW_TAB_URL,
  paneName,
  sameUrl,
  shortTitle,
  visibleSlots,
  type AppWindowState,
  type Link,
  type Pane,
  type Project,
  type ProjectSession,
  type Tab,
} from '../../../shared/src/model.ts';

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
  // Once a pane lives in its own window, the panes left in the main window split it evenly.
  const focusExpand = main.layout.focusExpand && !snap.state.windows.some((w) => w.role === 'satellite');
  // A slot can be detached while the main window still shows at least one other pane.
  const canDetach = win.role === 'main' && slots.length > 1;
  const boxes = useRef(new Map<number, HTMLDivElement>());
  const lastSent = useRef('');

  function measure() {
    const rects: PaneRects = {};
    for (const slot of slots) {
      const r = boxes.current.get(slot)?.getBoundingClientRect();
      rects[slot] = r
        ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
        : null;
    }
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
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      gleeok.reportPaneRects(win.id, {});
      lastSent.current = '';
    };
  }, [slots.join(',')]);

  return (
    <div className="panes">
      {slots.map((slot, i) => (
        <PaneView
          leading={i === 0 ? leading : null}
          trailing={i === slots.length - 1 ? trailing : null}
          key={slot}
          slot={slot}
          pane={session.panes[slot]}
          project={project}
          focused={snap.state.focusedPane === slot}
          grow={focusExpand && snap.state.focusedPane === slot ? focusRatio : 1}
          boxRef={(el) => (el ? boxes.current.set(slot, el) : boxes.current.delete(slot))}
          command={command?.slot === slot ? command : null}
          dragging={snap.tabDragging}
          covered={snap.tabDragging || snap.paletteWindows.includes(win.id)}
          dragImage={dragImages[slot]}
          asleep={session.lifecycle !== 'live'}
          windowButton={
            win.role === 'satellite' ? (
              <button onClick={() => gleeok.dispatch({ type: 'attachPane', slot })} title="合并回主窗口">
                ⇱
              </button>
            ) : canDetach ? (
              <button onClick={() => gleeok.dispatch({ type: 'detachPane', slot })} title="拆到新窗口（可放到另一块屏幕）">
                ⧉
              </button>
            ) : null
          }
        />
      ))}
    </div>
  );
}

interface PaneProps {
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
}

function PaneView(props: PaneProps) {
  const { slot, pane, project, focused, grow, boxRef, command, leading, trailing, windowButton, dragging, covered, dragImage, asleep } = props;
  const tab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];
  const isNew = tab.url === NEW_TAB_URL;
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
    if (command?.type === 'focusNewTab') search.current?.focus();
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
        <span className="pane-name">{paneName(slot)}</span>
        {pane.tabs.map((t) => (
          <TabButton key={t.id} tab={t} slot={slot} active={t.id === tab.id} />
        ))}
        <button className="tab-add" onClick={() => gleeok.dispatch({ type: 'newTab', slot })} title="新标签页">
          +
        </button>
        {trailing && <div className="tabs-trailing">{trailing}</div>}
      </div>
      <div className="toolbar">
        <button onClick={() => gleeok.dispatch({ type: 'history', slot, op: 'back' })} disabled={isNew}>
          ‹
        </button>
        <button onClick={() => gleeok.dispatch({ type: 'history', slot, op: 'forward' })} disabled={isNew}>
          ›
        </button>
        <button onClick={() => gleeok.dispatch({ type: 'history', slot, op: 'reload' })} disabled={isNew}>
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
        {isNew && <NewTab slot={slot} project={project} inputRef={search} />}
        {asleep && !isNew && !dragging && (
          <div className="asleep">
            {tab.favicon ? <img src={tab.favicon} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} /> : null}
            <p className="title">{tab.title || tab.url}</p>
            <p className="hint">项目已休眠，网页没有加载</p>
            <button className="primary" onClick={() => gleeok.dispatch({ type: 'startProject', id: project.id })}>
              启动「{project.name}」
            </button>
          </div>
        )}
        {covered && !isNew && !asleep && dragImage && <img className="drop-shot" src={dragImage} alt="" />}
        {dragging && (
          <div className="drop-zone">
            <span>移到{paneName(slot)}</span>
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
      {tab.favicon ? <img src={tab.favicon} alt="" /> : <span className="fav" />}
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

/** Tools offered on every new-tab page, after the project's own links. */
const SUGGESTIONS = [
  { label: '读论文', name: 'alphaXiv', url: 'https://www.alphaxiv.org/' },
  { label: '做 PPT', name: 'OneDrive', url: 'https://www.office.com/launch/onedrive' },
  { label: '草稿', name: 'Notion', url: 'https://www.notion.so/' },
  { label: '画布', name: 'Miro', url: 'https://miro.com/app/dashboard/' },
  { label: '代码', name: 'code-server', url: 'https://coder.com/docs/code-server' },
  { label: '邮件', name: 'Outlook', url: 'https://outlook.com/' },
  { label: '娱乐', name: 'RedNote', url: 'https://www.rednote.com/' },
];

function NewTab({
  slot,
  project,
  inputRef,
}: {
  slot: number;
  project: Project;
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
        {project.links.length === 0 && <p className="hint">这个项目还没有链接，去入口页添加</p>}
        {project.links.map((l) => (
          <button key={l.id} onClick={() => gleeok.dispatch({ type: 'navigate', slot, url: l.url })} title={l.url}>
            <img src={l.icon ?? faviconFor(l.url)} alt="" />
            <span>{l.label}</span>
          </button>
        ))}
      </div>
      <h3>常用</h3>
      <div className="links">
        {SUGGESTIONS.map((t) => (
          <button key={t.url} onClick={() => gleeok.dispatch({ type: 'navigate', slot, url: t.url })} title={t.url}>
            <img src={faviconFor(t.url)} alt="" />
            <span>{t.label}</span>
            <span className="sub">{t.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function faviconFor(url: string) {
  try {
    return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(url).hostname}`;
  } catch {
    return '';
  }
}
