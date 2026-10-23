import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PANE_NAMES,
  MAX_PANES,
  NEW_TAB_URL,
  isTerminalUrl,
  terminalTitle,
  type GlobalState,
  type Pane,
  type Project,
  type ProjectSession,
  type Tab,
} from '../../../shared/src/model.ts';

export function defaultState(): GlobalState {
  return {
    currentProjectId: null,
    focusedPane: 0,
    view: 'panes',
    windows: [
      {
        id: 'main',
        role: 'main',
        slots: [0, 1, 2],
        layout: { visible: 3, focusExpand: false, focusRatio: 2 },
      },
    ],
    sessions: {},
    paneNames: [...DEFAULT_PANE_NAMES],
  };
}

export function loadState(path: string): GlobalState {
  try {
    const s = { ...defaultState(), ...(JSON.parse(readFileSync(path, 'utf8')) as GlobalState) };
    // Older builds also had full-page 'entry' and 'import' views.
    if (s.view !== 'settings') s.view = 'panes';
    // Older builds had exactly three panes and a 'two' | 'three' layout mode.
    for (const w of s.windows) {
      const old = w.layout as typeof w.layout & { mode?: string };
      if (old.visible === undefined) old.visible = old.mode === 'two' ? 2 : 3;
      delete old.mode;
    }
    for (const session of Object.values(s.sessions)) padPanes(session.panes);
    return s;
  } catch {
    return defaultState();
  }
}

export function saveState(path: string, state: GlobalState) {
  writeFileSync(path, JSON.stringify(state, null, 1));
}

export function newTab(url = NEW_TAB_URL): Tab {
  return { id: `t_${randomUUID().slice(0, 8)}`, url, title: url === NEW_TAB_URL ? '新标签页' : isTerminalUrl(url) ? terminalTitle(url) : url };
}

/** First time a project is opened on this machine: pinned links fill their panes, the rest start blank. */
export function createSession(project: Project): ProjectSession {
  const panes: Pane[] = [];
  for (let i = 0; i < MAX_PANES; i++) {
    const tabs = project.links.filter((l) => l.pinnedPane === i).map((l) => ({ ...newTab(l.url), title: l.label }));
    if (tabs.length === 0) tabs.push(newTab());
    panes.push({ tabs, activeTabId: tabs[0].id });
  }
  return { projectId: project.id, panes, lastActiveAt: Date.now(), lifecycle: 'hibernated' };
}

/** Sessions from builds with fewer panes get blank ones up to MAX_PANES. */
export function padPanes(panes: Pane[]) {
  while (panes.length < MAX_PANES) {
    const tab = newTab();
    panes.push({ tabs: [tab], activeTabId: tab.id });
  }
}

export function activeTab(pane: Pane): Tab {
  return pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];
}

/** Whether address-bar input is a URL (as opposed to something to search for). */
export function looksLikeUrl(input: string): boolean {
  const s = input.trim();
  return /^https?:\/\//i.test(s) || /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/\S*)?$/i.test(s);
}

/** Address-bar input → URL: keep URLs, add https to bare hosts, search everything else. */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('about:')) return s;
  if (/^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/\S*)?$/i.test(s)) {
    return (/^(localhost|127\.|100\.|192\.168\.|10\.)/.test(s) ? 'http://' : 'https://') + s;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}
