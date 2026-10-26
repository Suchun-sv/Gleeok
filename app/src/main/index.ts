import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { freemem, hostname, totalmem, userInfo } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, Menu, Notification, app, clipboard, components, dialog, ipcMain, nativeTheme, powerMonitor, screen, session, shell, type Input } from 'electron';
import { shortName } from '../../../shared/src/library-format.ts';
import type { LibraryItem } from '../../../shared/src/library.ts';
import type { TranslateEngine, TranslateResult } from '../../../shared/src/translate.ts';
import { agentHandoff, type AgentCreated, type AgentInfo } from '../../../shared/src/agents.ts';
import { AgentPort } from './agent-port.ts';
import { log, logPath, siteOf } from './log.ts';
import { Weather, searchPlaces } from './weather.ts';
import type { Action, AgentNew, AgentOp, AgentPanel, Command, LibraryOp, PaneRects, PlannerOp, Snapshot, VaultDialog } from '../../../shared/src/ipc.ts';
import { PLANNER_KINDS, type PlannerTask, type TimeBlock } from '../../../shared/src/planner.ts';
import { LibraryClient } from './library.ts';
import { SyncedClient } from './synced-client.ts';
import { PomodoroTimer } from './pomodoro.ts';
import { dblpApply, dblpAuto, dblpSearch } from './dblp.ts';
import { ReaderBridge, registerReaderScheme, serveReader } from './reader.ts';
import {
  CODE_PANE,
  NEW_TAB_URL,
  MAX_PANES,
  codeLinks,
  isInternalUrl,
  isLibraryUrl,
  isPlannerUrl,
  librarySettings,
  pomodoroSettings,
  isTerminalUrl,
  readerUrl,
  primaryCodeLink,
  terminalTitle,
  sameUrl,
  shortTitle,
  type DeviceSession,
  type Pane,
  paneName,
  visibleSlots,
  type AppWindowState,
  type Project,
  type ProjectSession,
  type Rect,
} from '../../../shared/src/model.ts';
import { setupGoogleSignIn } from './compat.ts';
import { ConfigClient } from './config.ts';
import { showContextMenu } from './contextmenu.ts';
import { runDevScript } from './devscript.ts';
import { loadDevice } from './device.ts';
import { Downloads } from './downloads.ts';
import { setupPermissions } from './permissions.ts';
import { matchShortcut } from './shortcuts.ts';
import { activeTab, createSession, loadState, looksLikeUrl, newTab, normalizeUrl, saveState } from './state.ts';
import { Terminals } from './terminal.ts';
import { PARTITION, TabViews } from './views.ts';
import { Shells, windowBackground } from './windows.ts';
import { canSelfUpdate, pendingUpdates, selfUpdate, vmpStatus } from './updater.ts';
import { installRelease, latestRelease, type Release } from './release-updater.ts';
import { buildInfo, confirmHotBoot, installHot, latestHot, leaveHot, runningHot, type HotUpdate } from './hot-update.ts';
import { VAULT_URL_DEFAULT, Vault, fillPage, readPage } from './vault.ts';
import { type Pairing, loadPairings, parseOffer, readLocalPaseo, readPairedPaseo, savePairings } from './paseo.ts';

app.setName('gleeok');
registerReaderScheme();
if (process.platform === 'linux') {
  // Stable Wayland app-id ("gleeok") for the launcher entry and niri window rules.
  app.setDesktopName('gleeok.desktop');
  app.commandLine.appendSwitch('class', 'gleeok');
}
if (process.env.GLEEOK_USER_DATA) app.setPath('userData', process.env.GLEEOK_USER_DATA);
if (process.env.GLEEOK_DOWNLOADS) app.setPath('downloads', process.env.GLEEOK_DOWNLOADS);

const statePath = () => join(app.getPath('userData'), 'state.json');
const config = new ConfigClient();
let state = loadState(statePath());
// The shell's CSS and every web page see it as prefers-color-scheme.
nativeTheme.themeSource = state.theme ?? 'system';
/** Reported by each window's renderer: where its pane boxes are. */
const paneRects = new Map<string, PaneRects>();
/** While a tab is dragged, pages are hidden (screenshots stand in) so panes can receive the drop. */
let tabDragging = false;
/** Windows showing the command palette: their pages are hidden behind screenshots too. */
const paletteWindows = new Set<string>();
let dragToken = 0;
let downloads: Downloads | null = null;
/** Per project, most recently closed tabs last; for reopen-closed-tab. Not persisted. */
const closedTabs = new Map<string, { slot: number; url: string }[]>();
/** Widevine (castLabs' Electron) and, on macOS, the production VMP signature DRM services need. */
let drm: Snapshot['drm'] = { widevine: null, vmp: vmpStatus().state };
function noteDrm() {
  try {
    const cdm = Object.values(components.status()).find((c) => /widevine/i.test(c.title ?? ''));
    const next = { widevine: cdm?.version ?? null, vmp: vmpStatus().state };
    if (next.widevine !== drm.widevine || next.vmp !== drm.vmp) log(`drm: widevine=${next.widevine ?? 'none'} vmp=${next.vmp}`);
    drm = next;
    changed();
  } catch (e) {
    log(`drm status: ${String(e)}`);
  }
}

/** The sidebar's weather. */
const weather = new Weather({ place: () => state.weatherPlace, changed: () => changed() });

/** Windows filling their screen: full screen, or a compositor (niri) sized them to the whole display. */
function fullscreenWindows(): string[] {
  return state.windows
    .filter((ws) => {
      const bw = shells.get(ws.id);
      if (!bw || bw.isDestroyed() || !bw.isVisible()) return false;
      if (bw.isFullScreen() || bw.isSimpleFullScreen()) return true;
      const b = bw.getBounds();
      const d = screen.getDisplayMatching(b).bounds;
      return b.x === d.x && b.y === d.y && b.width === d.width && b.height === d.height;
    })
    .map((ws) => ws.id);
}

/** Tabs whose page process died, and why: the pane shows that instead of a white page. */
const crashedTabs = new Map<string, string>();

/** The crashed tabs that still have their dead view (hibernating or closing a tab drops it). */
function crashed(): Map<string, string> {
  for (const id of crashedTabs.keys()) if (!views.crashed(id)) crashedTabs.delete(id);
  return crashedTabs;
}

/** Rebuild a tab's page from its address: a fresh view and process. */
function reviveTab(tabId: string) {
  crashedTabs.delete(tabId);
  views.destroy(tabId);
  changed();
}

const views = new TabViews({
  onUpdate(tabId, patch) {
    const hit = findTab(tabId);
    if (!hit) return;
    // Loading a page reports its URL too; only an actual change of address counts for sync.
    const moved = patch.url !== undefined && !sameUrl(patch.url, hit.tab.url);
    Object.assign(hit.tab, patch);
    notePendingLink(tabId, patch);
    if (moved) tabsChanged(hit.session);
    changed();
  },
  onFocus(tabId) {
    const hit = findTab(tabId);
    if (!hit || hit.session.projectId !== state.currentProjectId) return;
    touch(hit.session);
    if (state.focusedPane !== hit.slot) {
      state.focusedPane = hit.slot;
      changed();
    }
  },
  onInput: handleInput,
  onOpenTab(tabId, url) {
    const hit = findTab(tabId);
    if (hit) openTab(hit.session, hit.slot, url);
  },
  onContextMenu(tabId, wc, params) {
    const hit = findTab(tabId);
    if (!hit) return;
    showContextMenu(wc, params, {
      slots: allVisibleSlots(),
      slot: hit.slot,
      name: (slot) => paneName(state.paneNames, slot),
      openTab: (slot, url) => openTab(hit.session, slot, url),
    });
  },
  onFound(tabId, active, total) {
    const hit = findTab(tabId);
    if (hit) send({ type: 'findResult', slot: hit.slot, active, total });
  },
  onGone(tabId, reason, exitCode) {
    const url = findTab(tabId)?.tab.url ?? '';
    log(`page process gone: ${siteOf(url)} reason=${reason} exitCode=${exitCode}`);
    if (reason === 'clean-exit') return;
    crashedTabs.set(tabId, reason);
    changed();
  },
  log,
});

// ---- state helpers ----

function mainWindowState(): AppWindowState {
  return state.windows.find((w) => w.role === 'main')!;
}

function openWindows(): AppWindowState[] {
  return state.windows.filter((w) => shells.get(w.id));
}

/** Every pane slot on screen, across all windows, in order. */
function allVisibleSlots(): number[] {
  return openWindows()
    .flatMap((w) => visibleSlots(w))
    .sort((a, b) => a - b);
}

function windowOfSlot(slot: number): AppWindowState | null {
  return openWindows().find((w) => visibleSlots(w).includes(slot)) ?? null;
}

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? shells.get('main');
}

function visibleProjects(): Project[] {
  return config.projects.filter((p) => !p.archived);
}

function currentSession(): ProjectSession | null {
  const id = state.currentProjectId;
  if (!id) return null;
  const project = config.projects.find((p) => p.id === id);
  if (!state.sessions[id] && project) state.sessions[id] = createSession(project);
  return state.sessions[id] ?? null;
}

function findTab(tabId: string) {
  for (const session of Object.values(state.sessions)) {
    for (const [slot, pane] of session.panes.entries()) {
      const tab = pane.tabs.find((t) => t.id === tabId);
      if (tab) return { session, slot, pane, tab };
    }
  }
  return null;
}

function touch(session: ProjectSession) {
  session.lastActiveAt = Date.now();
}

function openTab(session: ProjectSession, slot: number, url: string) {
  const tab = newTab(url);
  const pane = session.panes[slot];
  const i = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
  pane.tabs.splice(i + 1, 0, tab);
  pane.activeTabId = tab.id;
  tabsChanged(session);
  changed();
  focusSlot(slot);
}

// ---- open tabs synced across devices ----
//
// The server keeps one row per (project, device); a device only ever writes its own row, so
// devices never overwrite each other. Instead of merging, opening a project hands off: if
// another device changed that project's tabs more recently, a sleeping project adopts them
// (with undo) and a running one is offered the switch.

const device = loadDevice();
const pushTimers = new Map<string, NodeJS.Timeout>();
/** Tabs as they were before adopting another device's, for undo. Not persisted. */
const tabsBeforeAdopt = new Map<string, Pane[]>();

function tabsChanged(session: ProjectSession) {
  session.changedAt = Date.now();
  clearTimeout(pushTimers.get(session.projectId));
  pushTimers.set(session.projectId, setTimeout(() => void pushTabs(session.projectId), 3000));
}

function deviceSession(session: ProjectSession): DeviceSession {
  return {
    deviceId: device.id,
    deviceName: device.name,
    changedAt: session.changedAt ?? 0,
    panes: session.panes.map((p) => {
      const tabs = p.tabs.filter((t) => t.url !== NEW_TAB_URL);
      return {
        tabs: tabs.map((t) => ({ url: t.url, title: t.title, ...(t.favicon ? { favicon: t.favicon } : {}) })),
        active: Math.max(0, tabs.findIndex((t) => t.id === p.activeTabId)),
      };
    }),
  };
}

async function pushTabs(projectId: string) {
  pushTimers.delete(projectId);
  const session = state.sessions[projectId];
  if (!session || !config.projects.some((p) => p.id === projectId)) return;
  await config.putSession(projectId, deviceSession(session)).catch(() => {
    // Offline: the next change pushes again.
  });
}

/**
 * Push every project's tabs once at launch: tabs that were already open never trigger a change,
 * so without this a device would stay invisible until its first edit. Sessions from before
 * sync existed have no changedAt; their last use stands in for it.
 */
function publishAllTabs() {
  for (const s of Object.values(state.sessions)) {
    s.changedAt ??= s.lastActiveAt;
    void pushTabs(s.projectId);
  }
}

const tabUrls = (panes: { tabs: { url: string }[] }[]) => JSON.stringify(panes.map((p) => p.tabs.map((t) => t.url)));

function adoptTabs(session: ProjectSession, remote: DeviceSession) {
  tabsBeforeAdopt.set(session.projectId, session.panes);
  for (const pane of session.panes) for (const t of pane.tabs) views.destroy(t.id);
  const panes: Pane[] = [];
  for (let i = 0; i < MAX_PANES; i++) {
    const r = remote.panes[i];
    const tabs = (r?.tabs ?? []).map((t) => ({ ...newTab(t.url), title: t.title, ...(t.favicon ? { favicon: t.favicon } : {}) }));
    if (tabs.length === 0) tabs.push(newTab());
    panes.push({ tabs, activeTabId: (tabs[r?.active ?? 0] ?? tabs[0]).id });
  }
  session.panes = panes;
  // Same moment as the source: neither device now counts as newer than the other.
  session.changedAt = remote.changedAt;
  changed();
  void pushTabs(session.projectId);
}

function ago(ms: number) {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  if (min < 24 * 60) return `${Math.round(min / 60)} 小时前`;
  return `${Math.round(min / 1440)} 天前`;
}

async function checkRemoteTabs(projectId: string) {
  const remote = (await config.listSessions(projectId).catch(() => [] as DeviceSession[])).find(
    (r) => r.deviceId !== device.id,
  );
  const session = state.sessions[projectId];
  if (!remote || !session || remote.changedAt <= (session.changedAt ?? 0)) return;
  if (tabUrls(remote.panes) === tabUrls(deviceSession(session).panes)) {
    session.changedAt = remote.changedAt;
    return;
  }
  const slot = state.focusedPane;
  if (session.lifecycle !== 'live') {
    adoptTabs(session, remote);
    send({
      type: 'toast',
      slot,
      text: `已接上「${remote.deviceName}」上的标签（${ago(remote.changedAt)}）`,
      undo: { type: 'restoreTabs', projectId },
      ms: 8000,
    });
  } else if (projectId === state.currentProjectId) {
    send({
      type: 'toast',
      slot,
      text: `「${remote.deviceName}」上的标签更新（${ago(remote.changedAt)}）`,
      undo: { type: 'adoptRemoteTabs', projectId },
      undoLabel: '换过去',
      ms: 30_000,
    });
  }
}

// ---- links saved from pasted URLs ----

interface PendingLink {
  projectId: string;
  slot: number;
  url: string;
  /** Title/favicon only count once the pasted page has committed, not the page it replaces. */
  committed: boolean;
  title?: string;
  icon?: string;
  settle?: NodeJS.Timeout;
  deadline: NodeJS.Timeout;
}
const pendingLinks = new Map<string, PendingLink>();

function startPendingLink(tabId: string, projectId: string, slot: number, url: string) {
  const old = pendingLinks.get(tabId);
  if (old) {
    clearTimeout(old.settle);
    clearTimeout(old.deadline);
  }
  pendingLinks.set(tabId, {
    projectId,
    slot,
    url,
    committed: false,
    // Pages that never report a title still get saved, under their host name.
    deadline: setTimeout(() => void savePendingLink(tabId), 10_000),
  });
}

function notePendingLink(tabId: string, patch: { url?: string; title?: string; favicon?: string }) {
  const p = pendingLinks.get(tabId);
  if (!p) return;
  if (patch.url) p.committed = true;
  if (!p.committed) return;
  if (patch.title) p.title = patch.title;
  if (patch.favicon) p.icon = patch.favicon;
  if (p.title) {
    // Titles often change once or twice while a page boots; take the one that sticks.
    clearTimeout(p.settle);
    p.settle = setTimeout(() => void savePendingLink(tabId), 2000);
  }
}

async function savePendingLink(tabId: string) {
  const p = pendingLinks.get(tabId);
  if (!p) return;
  pendingLinks.delete(tabId);
  clearTimeout(p.settle);
  clearTimeout(p.deadline);
  const link = {
    id: `l_${randomUUID().slice(0, 8)}`,
    label: shortTitle(p.title) || new URL(p.url).hostname,
    url: p.url,
    ...(p.icon && p.icon.length <= 2048 ? { icon: p.icon } : {}),
  };
  try {
    if (await config.addLink(p.projectId, link)) {
      const name = config.projects.find((x) => x.id === p.projectId)?.name ?? '';
      send({
        type: 'toast',
        slot: p.slot,
        text: `已保存到「${name}」：${link.label}`,
        undo: { type: 'removeLink', projectId: p.projectId, linkId: link.id },
      });
    }
  } catch {
    // Offline or rejected: the page still opened; only the bookmark is skipped.
  }
  changed();
}

// ---- lifecycle ----

/** A "day" starts at 04:00, so working past midnight still counts as the same day. */
const DAY_START_HOUR = 4;

function dayStart(now = new Date()): number {
  const d = new Date(now);
  d.setHours(DAY_START_HOUR, 0, 0, 0);
  if (now.getTime() < d.getTime()) d.setDate(d.getDate() - 1);
  return d.getTime();
}

function isLive(session: ProjectSession) {
  return session.panes.some((p) => p.tabs.some((t) => views.has(t.id)));
}

/** Close every page of a project but keep its tabs, so reopening reloads them lazily. */
function hibernate(projectId: string) {
  const session = state.sessions[projectId];
  if (!session) return;
  for (const pane of session.panes) for (const t of pane.tabs) views.destroy(t.id);
  session.lifecycle = 'hibernated';
  memory.delete(projectId);
  changed();
}

function startProject(projectId: string) {
  const session = state.sessions[projectId];
  if (!session || session.lifecycle === 'live') return;
  session.lifecycle = 'live';
  touch(session);
  changed();
}

/** Archive: out of the sidebar and its pages closed, but tabs kept so unarchiving picks up again. */
async function setArchived(id: string, archived: boolean, open = false) {
  if (archived) {
    if (state.currentProjectId === id) {
      state.currentProjectId = visibleProjects().find((p) => p.id !== id)?.id ?? null;
    }
    hibernate(id);
  }
  await config.setArchived(id, archived).catch(() => {});
  if (!archived && open) dispatch({ type: 'selectProject', id });
  changed();
}

async function deleteProject(id: string) {
  await config.remove(id);
  for (const pane of state.sessions[id]?.panes ?? []) for (const t of pane.tabs) views.destroy(t.id);
  delete state.sessions[id];
  if (state.currentProjectId === id) state.currentProjectId = visibleProjects()[0]?.id ?? null;
  changed();
}

async function confirmDelete(id: string) {
  const project = config.projects.find((p) => p.id === id);
  if (!project) return;
  const options = {
    type: 'warning' as const,
    buttons: ['删除', '取消'],
    defaultId: 1,
    cancelId: 1,
    message: `删除项目「${project.name}」？`,
    detail: '只删除 Gleeok 里的这个项目（链接和打开的标签），不影响 Paseo 和网站上的任何东西。',
  };
  const win = focusedWindow();
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (response === 0) await deleteProject(id).catch(() => {});
}

/** Projects untouched since the start of today go to sleep; anything used today stays alive. */
function hibernateStale() {
  const cutoff = dayStart();
  for (const s of Object.values(state.sessions)) {
    if (s.projectId !== state.currentProjectId && s.lastActiveAt < cutoff && isLive(s)) hibernate(s.projectId);
  }
}

const memory = new Map<string, number>();
let memoryTotal: Snapshot['memoryTotal'] = { gleeok: 0, systemUsed: 0, systemTotal: 0 };

function sampleMemory() {
  const metrics = app.getAppMetrics();
  const kbByPid = new Map(metrics.map((m) => [m.pid, m.memory.workingSetSize]));
  const mb = 1024 * 1024;
  memoryTotal = {
    gleeok: Math.round(metrics.reduce((n, m) => n + m.memory.workingSetSize, 0) / 1024),
    systemUsed: Math.round((totalmem() - freemem()) / mb),
    systemTotal: Math.round(totalmem() / mb),
  };
  memory.clear();
  for (const s of Object.values(state.sessions)) {
    const pids = new Set<number>();
    for (const pane of s.panes) {
      for (const t of pane.tabs) {
        const pid = views.get(t.id)?.webContents.getOSProcessId();
        if (pid) pids.add(pid);
      }
    }
    if (pids.size) memory.set(s.projectId, Math.round([...pids].reduce((n, pid) => n + (kbByPid.get(pid) ?? 0), 0) / 1024));
  }
  changed();
}

// ---- change propagation ----

let pending = false;
let saveTimer: NodeJS.Timeout | undefined;

/** Coalesce every mutation in this tick into one render, one view sync and one (debounced) save. */
function changed() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    shells.broadcast('snapshot', snapshot());
    syncViews();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveState(statePath(), state), 500);
  });
}

// --- Paseo daemons ---------------------------------------------------------------------------
// Catalogs come from this machine's daemon (local mode; a server gets it from the sync timer)
// and from daemons whose pairing links were pasted here, read through Paseo's relay.

let pairings: Pairing[] = loadPairings();
const pairingStatus = new Map<string, { at: string; error?: string }>();
let paseoSyncing: Promise<void> | null = null;

function syncPaseo(): Promise<void> {
  paseoSyncing ??= (async () => {
    const clientId = `gleeok-${device.id}`;
    const local = config.local ? await readLocalPaseo(clientId) : null;
    const found = local ? [local] : [];
    await Promise.all(
      pairings
        .filter((p) => p.serverId !== local?.serverId)
        .map(async (p) => {
          try {
            found.push(await readPairedPaseo(p.url, clientId));
            pairingStatus.set(p.serverId, { at: new Date().toISOString() });
          } catch (e) {
            pairingStatus.set(p.serverId, { at: new Date().toISOString(), error: String((e as Error).message ?? e).slice(0, 200) });
          }
        }),
    );
    for (const c of found) await config.putPaseoDaemon(c.serverId, c.body).catch(() => {});
    if (found.length) await config.refresh();
    changed();
  })().finally(() => (paseoSyncing = null));
  return paseoSyncing;
}

function snapshot(): Snapshot {
  return {
    projects: visibleProjects(),
    archivedProjects: config.projects.filter((p) => p.archived),
    paseo: config.paseo,
    paseoPairings: pairings.map((p) => ({ serverId: p.serverId, ...pairingStatus.get(p.serverId) })),
    downloads: downloads?.list ?? [],
    live: Object.values(state.sessions).filter(isLive).map((s) => s.projectId),
    memory: Object.fromEntries(memory),
    memoryTotal,
    tabDragging,
    canSelfUpdate: updateKind() !== null,
    build: { version: app.getVersion(), ...buildInfo(), hot: runningHot(), updates: updateKind(), betaNeedsInstaller },
    pomodoro: pomodoro.state,
    update,
    vault: {
      unlocked: vault?.unlocked ?? false,
      email: vault?.email ?? '',
      serverUrl: vault?.serverUrl ?? '',
      entries: vault?.entries() ?? [],
    },
    paletteWindows: [...paletteWindows],
    crashedTabs: Object.fromEntries(crashed()),
    weather: weather.snapshot,
    drm,
    fullscreenWindows: fullscreenWindows(),
    state,
    platform: process.platform,
    hostname: hostname(),
    server: { status: config.status, url: config.serverUrl, error: config.error },
  };
}

function syncViews() {
  const session = currentSession();
  for (const ws of state.windows) {
    const bw = shells.get(ws.id);
    if (!bw) continue;
    const desired = new Map<string, { url: string; bounds: Rect }>();
    // The entry/import pages replace the panes in the main window only; satellites keep showing pages.
    const hidden = tabDragging || paletteWindows.has(ws.id);
    if (session?.lifecycle === 'live' && !hidden && (ws.role !== 'main' || state.view === 'panes')) {
      const rects = paneRects.get(ws.id) ?? {};
      for (const slot of visibleSlots(ws)) {
        const tab = activeTab(session!.panes[slot]);
        const rect = rects[slot];
        // A dead page is taken off, so the pane can say so (and offer to reload) instead of white.
        if (rect && !isInternalUrl(tab.url) && !crashed().has(tab.id)) desired.set(tab.id, { url: tab.url, bounds: rect });
      }
    }
    views.sync(bw, desired);
  }
  // A terminal lives as long as some tab shows it, hibernated or not.
  const termTabs = new Set<string>();
  for (const s of Object.values(state.sessions)) for (const p of s.panes) for (const t of p.tabs) if (isTerminalUrl(t.url)) termTabs.add(t.id);
  terminals.retain(termTabs);
}

const terminals = new Terminals((e) => {
  for (const ws of state.windows) shells.get(ws.id)?.webContents.send('term-event', e);
});
/** Shell windows whose focus is in a terminal: Ctrl+<key> belongs to the shell there, not to Gleeok. */
const terminalFocus = new Set<number>();

/** Commands go to the window that shows the slot they are about. */
function send(command: Command) {
  const ws = windowOfSlot(command.slot) ?? mainWindowState();
  shells.get(ws.id)?.webContents.send('command', command);
}

function shellOfSlot(slot: number): BrowserWindow | null {
  return shells.get((windowOfSlot(slot) ?? mainWindowState()).id);
}

/** Screenshot every visible page, hand the images to each window, then take the pages away. */
/** Send a window screenshots of its visible pages, so they can stand in while the pages are hidden. */
async function sendPageImages(ws: AppWindowState) {
  const session = currentSession();
  const shell = shells.get(ws.id);
  if (!shell) return;
  // Only pages on screen: with the 文献库, 日程 or settings showing, the pages are off the window,
  // and capturing a page that is not on any window never finishes (the dialog never came).
  const onScreen = new Set(views.attachedIn(shell));
  const images: Record<number, string> = {};
  for (const slot of session?.lifecycle === 'live' ? visibleSlots(ws) : []) {
    const view = views.get(activeTab(session!.panes[slot]).id);
    if (!view || !onScreen.has(view) || view.webContents.isDestroyed() || view.webContents.isCrashed()) continue;
    // A hung page may never hand over a picture, or fail: its pane just goes without a stand-in.
    try {
      const image = await Promise.race([view.webContents.capturePage(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000))]);
      if (image) images[slot] = image.toDataURL();
      else log(`screenshot timed out: ${siteOf(view.webContents.getURL())}`);
    } catch (e) {
      log(`screenshot failed: ${siteOf(view.webContents.getURL())} ${(e as Error).message}`);
    }
  }
  // Wait until the window has painted them (beneath the pages); hiding the pages before that
  // flashes the empty panes for a frame.
  const shown = new Promise<void>((resolve) => {
    imagesShown.set(ws.id, resolve);
    setTimeout(resolve, 400);
  });
  shell.webContents.send('drag-images', images);
  await shown;
  imagesShown.delete(ws.id);
}

const imagesShown = new Map<string, () => void>();
ipcMain.on('page-images-shown', (_e, winId: string) => imagesShown.get(winId)?.());

/** Show something over the focused window's pages (palette, vault dialogs): pages become screenshots. */
async function openOverlay(channel: string, payload?: unknown) {
  const bw = focusedWindow();
  const ws = state.windows.find((w) => shells.get(w.id) === bw);
  if (!bw || !ws) return;
  if (!paletteWindows.has(ws.id)) {
    await sendPageImages(ws);
    paletteWindows.add(ws.id);
    changed();
  }
  bw.webContents.focus();
  bw.webContents.send(channel, payload);
}

const openPalette = () => openOverlay('palette');

// ---- self-update (git checkout) ----

let updating = false;
let update: Snapshot['update'] = { commits: [] };
/** Upstream commit the dialog last popped up for: each new version asks once. */
let updateAskedFor = '';

/** A git checkout pulls and rebuilds; an installed build takes the latest GitHub release. */
function updateKind(): 'git' | 'release' | null {
  // Any installed build can check (and take beta hot updates); installing a release itself may
  // not be possible (a Linux build that is not the AppImage), which installRelease says.
  return canSelfUpdate() ? 'git' : app.isPackaged ? 'release' : null;
}
/** When updates were last checked (the timer checks again after 6 h, or 30 min on beta). */
let lastUpdateCheck = Date.now();
/** The release, or beta hot update, found by the last check (installed builds). */
let pendingRelease: Release | null = null;
let pendingHot: HotUpdate | null = null;
/** The newest beta was built for another Electron: it needs the next installer. */
let betaNeedsInstaller = false;

/** Installed builds: a newer release first (both channels); on the beta channel, else the newest hot update. */
async function checkReleases(): Promise<{ head: string; commits: string[] }> {
  pendingHot = null;
  // A release check that fails must not keep the beta from being checked.
  let releaseError: unknown = null;
  try {
    pendingRelease = await latestRelease();
  } catch (e) {
    pendingRelease = null;
    releaseError = e;
    log(`update check (releases): ${String((e as Error).message ?? e)}`);
  }
  betaNeedsInstaller = false;
  if (pendingRelease) return { head: pendingRelease.version, commits: [`版本 ${pendingRelease.version}`, ...pendingRelease.notes] };
  if (state.updateChannel !== 'beta') {
    if (releaseError) throw releaseError;
    return { head: '', commits: [] };
  }
  const beta = await latestHot();
  if (!beta) return { head: '', commits: [] };
  if (!beta.compatible) {
    betaNeedsInstaller = true;
    return { head: '', commits: [] };
  }
  pendingHot = beta.hot;
  return { head: beta.hot.commit, commits: [`测试版 ${beta.hot.commit.slice(0, 7)}`, ...beta.hot.notes] };
}

async function checkUpdate(announceNone: boolean) {
  const kind = updateKind();
  if (!kind || updating) return;
  try {
    let head: string;
    let commits: string[];
    ({ head, commits } = kind === 'git' ? await pendingUpdates() : await checkReleases());
    update = { commits };
    changed();
    lastUpdateCheck = Date.now();
    if (commits.length > 0) {
      // A beta hot update only lights the sidebar button; a release (or a git update) asks.
      const quiet = commits[0].startsWith('测试版 ');
      if (announceNone || (head !== updateAskedFor && !quiet && !process.env.GLEEOK_DEV_SCRIPT)) void openOverlay('update-dialog');
      updateAskedFor = head;
    } else if (announceNone) {
      // Asked by hand: say so in a dialog, which shows whatever the window displays (pages, library, settings).
      void openOverlay('update-dialog');
    }
  } catch (e) {
    log(`update check: ${String((e as Error).message ?? e)}`);
    if (announceNone) send({ type: 'toast', slot: state.focusedPane, text: `检查更新失败：${String(e).slice(0, 80)}` });
  }
}

async function runSelfUpdate() {
  const kind = updateKind();
  if (updating || !kind) return;
  if (kind === 'release') return runReleaseUpdate();
  updating = true;
  const say = (text: string, ms = 120_000) => send({ type: 'toast', slot: state.focusedPane, text, ms });
  const step = (s: string) => {
    update = { ...update, step: s, error: undefined };
    changed();
    say(`正在更新 Gleeok：${s}`);
  };
  try {
    await selfUpdate(step);
    step('完成，正在重启…');
    // Dev scripts must not relaunch themselves in a loop.
    if (!process.env.GLEEOK_NO_RELAUNCH) app.relaunch();
    setTimeout(() => app.quit(), 800);
  } catch (e) {
    const error = String(e).replace(/^Error: /, '').slice(0, 300);
    update = { ...update, step: undefined, error };
    changed();
    say(`更新失败：${error.slice(0, 140)}`, 30_000);
  } finally {
    updating = false;
  }
}

/** Installed builds: download the release and restart into it (the installer / swap restarts). */
async function runReleaseUpdate() {
  updating = true;
  const step = (s: string) => {
    update = { ...update, step: s, error: undefined };
    changed();
  };
  try {
    // Always the newest: what the dialog showed may have been replaced since (a later beta).
    step('检查最新版本…');
    await checkReleases();
    if (pendingRelease) await installRelease(pendingRelease, step);
    else if (pendingHot) await installHot(pendingHot, step);
    else throw new Error('没有找到新版本');
  } catch (e) {
    const error = String((e as Error).message ?? e).slice(0, 300);
    log(`update: ${error}`);
    // The next try checks again (a newer beta may have replaced the one found).
    pendingRelease = null;
    pendingHot = null;
    update = { ...update, step: undefined, error };
    changed();
    send({ type: 'toast', slot: state.focusedPane, text: `更新失败：${error.slice(0, 140)}`, ms: 30_000 });
  } finally {
    updating = false;
  }
}

// ---- password vault ----

let vault: Vault | null = null;

// ---- 文献库 ----

const library = new LibraryClient(config);
library.cacheLimit = () => librarySettings(state).cacheGB * 1024 ** 3;
let libraryTimer: NodeJS.Timeout | undefined;
// The library goes out on its own channel, coalesced: it can be large and change in bursts.
library.onChange = () => {
  clearTimeout(libraryTimer);
  libraryTimer = setTimeout(() => {
    shells.broadcast('library', library.snapshot());
    readerBridge.push();
  }, 80);
};

// ---- 日程 ----

const planner = new SyncedClient(config, 'planner', PLANNER_KINDS);
let plannerTimer: NodeJS.Timeout | undefined;
planner.onChange = () => {
  clearTimeout(plannerTimer);
  plannerTimer = setTimeout(() => shells.broadcast('planner', planner.snapshot()), 60);
};
ipcMain.handle('planner:get', () => planner.snapshot());
ipcMain.handle('planner:mobileLink', () => config.mobileLink);
ipcMain.handle('planner:call', async (_e, op: PlannerOp) => {
  try {
    switch (op.op) {
      case 'sync':
        return { result: await planner.sync() };
      case 'create':
        return { result: await planner.create(op.kind, op.objects) };
      case 'patch':
        return { result: await planner.patch(op.kind, op.key, op.fields) };
      case 'remove':
        return { result: await planner.remove(op.kind, op.key) };
    }
  } catch (e) {
    return { error: String((e as Error).message ?? e).slice(0, 300) };
  }
});

// ---- 番茄钟 ----

const PHASE_NAMES = { focus: '专注', short: '短休息', long: '长休息' } as const;

const pomodoro = new PomodoroTimer({
  settings: () => pomodoroSettings(state),
  changed: () => changed(),
  record: (r) => void planner.create('pomodoros', [r]).catch((e) => console.warn('[gleeok] pomodoro not saved:', e)),
  finished(phase, s) {
    const next = s.awaiting ? `${PHASE_NAMES[s.awaiting]} ${pomodoroSettings(state)[s.awaiting === 'focus' ? 'focusMin' : s.awaiting === 'short' ? 'shortMin' : 'longMin']} 分钟` : '';
    const n = new Notification({
      title: phase === 'focus' ? '番茄完成 🍅' : '休息结束',
      body: [s.taskTitle, next && `接下来：${next}（在 Gleeok 里确认）`].filter(Boolean).join('\n'),
      silent: false,
    });
    n.on('click', () => {
      const bw = shells.get('main');
      if (bw) (bw.isMinimized() && bw.restore(), bw.show(), bw.focus());
    });
    n.show();
    const bw = shells.get('main');
    if (process.platform === 'darwin') app.dock?.bounce('informational');
    else if (bw && !bw.isFocused()) bw.flashFrame(true);
    void openOverlay('pomodoro-dialog');
  },
});

/** Start focusing (on a task, with the block it is in now, if any). */
function startPomodoro(taskKey?: string, blockKey?: string) {
  const task = taskKey ? planner.get<PlannerTask>('tasks', taskKey) : undefined;
  const now = Date.now();
  const block =
    blockKey ??
    (task ? planner.all<TimeBlock>('blocks').find((b) => b.taskKey === task.key && Date.parse(b.start) <= now && Date.parse(b.end) > now)?.key : undefined);
  pomodoro.start('focus', task ? { key: task.key, title: task.title, blockKey: block } : undefined);
}

const readerBridge = new ReaderBridge(library, {
  authorName: () => process.env.GLEEOK_AUTHOR_NAME || userInfo().username,
  view: () => {
    const s = librarySettings(state);
    return { theme: s.readerTheme, zoom: s.readerZoom };
  },
  // A link in a PDF opens beside it, in the reader's own pane.
  openLink(url, from) {
    for (const s of Object.values(state.sessions)) {
      s.panes.forEach((pane, slot) => {
        if (pane.tabs.some((t) => views.get(t.id)?.webContents === from)) openTab(s, slot, url);
      });
    }
  },
  translate: (text, engine) => translate(text, engine),
});

/** Read a PDF: bring its tab forward if this project has one open, else open it in the reading pane. */
function openReader(attachment: string, slot?: number) {
  const session = currentSession();
  const item = library.item(attachment);
  if (!session || !item) return send({ type: 'toast', slot: state.focusedPane, text: session ? '这个附件已经不在文献库里了' : '先在左边选一个项目' });
  const url = readerUrl(attachment);
  state.view = 'panes';
  for (const [s, pane] of session.panes.entries()) {
    const tab = pane.tabs.find((t) => t.url === url);
    if (tab && allVisibleSlots().includes(s)) {
      pane.activeTabId = tab.id;
      tabsChanged(session);
      changed();
      return focusSlot(s);
    }
  }
  const visible = allVisibleSlots();
  const pane = librarySettings(state).readerPane;
  const target = slot !== undefined && visible.includes(slot) ? slot : visible.includes(pane) ? pane : visible[visible.length - 1];
  const parent = item.parentItem ? library.item(item.parentItem) : undefined;
  const title = parent ? shortName(parent) : String(item.filename ?? 'PDF');
  const tab = activeTab(session.panes[target]);
  if (tab.url === NEW_TAB_URL) {
    tab.url = url;
    tab.title = title;
    tabsChanged(session);
    changed();
    focusSlot(target);
  } else {
    openTab(session, target, url);
    activeTab(session.panes[target]).title = title;
  }
  if (!isLive(session)) startProject(session.projectId);
}


/** A JSON call to the sync server (or the in-process one), its `error` thrown as the message. */
async function serverJson(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<unknown> {
  const res = await config.fetchRaw(method, path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    timeoutMs,
  });
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  if (res.status === 404 && !json?.error) throw new Error('同步服务器还不支持这个功能，先更新服务器');
  if (!res.ok) throw new Error(json?.error ?? `${method} ${path}: ${res.status}`);
  return json;
}

const translate = (text: string, engine?: TranslateEngine) => serverJson('POST', '/api/translate', { text, engine }, 70_000) as Promise<TranslateResult>;

/** New PDFs whose titles DBLP knows exactly get its metadata, in the background. */
function autoFill(added: LibraryItem[]) {
  if (librarySettings(state).autoDblp && added.length) void dblpAuto(library, added.map((i) => i.key)).catch(() => {});
  return added;
}

async function libraryCall(op: LibraryOp): Promise<unknown> {
  switch (op.op) {
    case 'sync':
      return library.sync();
    case 'create':
      return library.create(op.kind, op.objects);
    case 'patch':
      return library.patch(op.kind, op.key, op.fields);
    case 'remove':
      return library.remove(op.kind, op.key);
    case 'addFiles':
      return autoFill(await library.addFiles(op.paths, op.collection));
    case 'dblpSearch':
      return dblpSearch(op.title);
    case 'dblpApply':
      return dblpApply(library, op.key, op.dblpKey);
    case 'dblpAuto':
      return dblpAuto(library, op.keys);
    case 'copyText':
      return clipboard.writeText(op.text);
    case 'translateSettings':
      return serverJson('GET', '/api/translate/settings');
    case 'setTranslateSettings':
      return serverJson('PUT', '/api/translate/settings', op.settings);
    case 'translate':
      return translate(op.text, op.engine);
    case 'saveBib': {
      const bw = focusedWindow();
      const opts = { title: '导出 BibTeX', defaultPath: op.name, filters: [{ name: 'BibTeX', extensions: ['bib'] }] };
      const picked = bw ? await dialog.showSaveDialog(bw, opts) : await dialog.showSaveDialog(opts);
      if (picked.canceled || !picked.filePath) return null;
      writeFileSync(picked.filePath, op.text.endsWith('\n') ? op.text : `${op.text}\n`);
      return picked.filePath;
    }
    case 'cacheInfo':
      return library.cacheInfo();
    case 'clearCache':
      return library.clearCache();
    case 'revealFile':
      return shell.showItemInFolder(await library.filePath(op.key));
    case 'pickFiles': {
      const bw = focusedWindow();
      const opts = { title: '添加 PDF', properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[], filters: [{ name: 'PDF', extensions: ['pdf'] }] };
      const picked = bw ? await dialog.showOpenDialog(bw, opts) : await dialog.showOpenDialog(opts);
      if (picked.canceled || picked.filePaths.length === 0) return [];
      const added = await library.addFiles(picked.filePaths, op.collection, op.parentItem);
      return op.parentItem ? added : autoFill(added);
    }
  }
}
/** Logins offered in the last pick dialog, with passwords; kept in main only. */
let pickedLogins = new Map<string, { username: string; password: string; name: string }>();

/** The page in the focused pane, if one is loaded. */
function focusedPage() {
  const session = currentSession();
  if (!session) return null;
  const slot = state.focusedPane;
  const view = views.get(activeTab(session.panes[slot]).id);
  if (!view || view.webContents.isDestroyed()) return null;
  const url = view.webContents.getURL();
  return /^https?:/.test(url) ? { slot, wc: view.webContents, url, host: new URL(url).hostname } : null;
}

async function vaultFill() {
  const page = focusedPage();
  if (!vault) return;
  if (!page) return send({ type: 'toast', slot: state.focusedPane, text: '先在这一栏打开要登录的网页' });
  if (!vault.unlocked) return openOverlay('vault-dialog', { mode: 'unlock', email: vault.email, then: 'fill' } satisfies VaultDialog);
  try {
    const logins = await vault.loginsFor(page.url);
    if (logins.length === 0) {
      return send({
        type: 'toast',
        slot: page.slot,
        text: `密码库里没有 ${page.host} 的账号`,
        undo: { type: 'vaultSaveDialog' },
        undoLabel: '保存账号',
        ms: 8000,
      });
    }
    if (logins.length === 1) return void fillAndReport(page, logins[0]);
    pickedLogins = new Map(logins.map((l) => [l.id, l]));
    void openOverlay('vault-dialog', {
      mode: 'pick',
      host: page.host,
      logins: logins.map(({ id, name, username }) => ({ id, name, username })),
    } satisfies VaultDialog);
  } catch (e) {
    send({ type: 'toast', slot: page.slot, text: `密码库出错：${String(e).slice(0, 80)}` });
  }
}

async function fillAndReport(page: NonNullable<ReturnType<typeof focusedPage>>, login: { name: string; username: string; password: string }) {
  const ok = await fillPage(page.wc, login.username, login.password);
  send({
    type: 'toast',
    slot: page.slot,
    text: ok
      ? `已填写：${login.name}（${login.username}）`
      : `匹配到「${login.name}」，但这个页面上没有登录框可填。只想打开它保存的网址的话，在命令面板里搜这条记录`,
    ms: ok ? 5000 : 9000,
  });
  if (ok) page.wc.focus();
}

async function vaultSaveDialog() {
  const page = focusedPage();
  if (!vault) return;
  if (!page) return send({ type: 'toast', slot: state.focusedPane, text: '先在这一栏打开要保存账号的网页' });
  if (!vault.unlocked) return openOverlay('vault-dialog', { mode: 'unlock', email: vault.email, then: 'save' } satisfies VaultDialog);
  const typed = await readPage(page.wc);
  void openOverlay('vault-dialog', {
    mode: 'save',
    name: page.host.replace(/^www\./, ''),
    url: new URL(page.url).origin,
    username: typed.username,
    password: typed.password,
  } satisfies VaultDialog);
}

async function startTabDrag() {
  const token = ++dragToken;
  await Promise.all(openWindows().map(sendPageImages));
  if (token !== dragToken) return; // the drag already ended
  tabDragging = true;
  changed();
}

// ---- multi-window ----

/** Move a pane slot out of the main window into its own window (another monitor, ideally). */
function detachPane(slot: number) {
  const main = mainWindowState();
  if (!main.slots.includes(slot) || visibleSlots(main).filter((s) => s !== slot).length === 0) return;
  main.slots = main.slots.filter((s) => s !== slot);
  const ws: AppWindowState = {
    id: `w_${randomUUID().slice(0, 6)}`,
    role: 'satellite',
    slots: [slot],
    layout: { visible: 1, focusExpand: false, focusRatio: 2 },
  };
  state.windows.push(ws);
  shells.open(ws, { over: shells.get('main') });
  changed();
}

/**
 * Change how many panes projects have (and their names). Panes past the new count leave every
 * window, their tabs kept for when the count grows again; new panes join the main window.
 */
function setPanes(names: string[]) {
  const count = Math.min(Math.max(1, names.length), MAX_PANES);
  const before = mainWindowState().slots.length;
  const main = mainWindowState();
  const showingAll = main.layout.visible >= before;
  state.paneNames = names.slice(0, count).map((n) => n.trim().slice(0, 24));
  for (const ws of state.windows.filter((w) => w.role === 'satellite')) {
    ws.slots = ws.slots.filter((s) => s < count);
    if (ws.slots.length === 0) {
      state.windows = state.windows.filter((w) => w !== ws);
      paneRects.delete(ws.id);
      shells.closeQuietly(ws.id);
    }
  }
  const owned = new Set(state.windows.flatMap((w) => (w.role === 'satellite' ? w.slots : [])));
  main.slots = Array.from({ length: count }, (_, i) => i).filter((s) => !owned.has(s));
  // Every pane detached: the main window takes the first one back.
  if (main.slots.length === 0) {
    attachPane(Math.min(...owned));
    return setPanes(state.paneNames);
  }
  main.layout.visible = showingAll ? main.slots.length : Math.min(main.layout.visible, main.slots.length);
  for (const ws of state.windows) shells.retitle(ws);
  const visible = allVisibleSlots();
  if (!visible.includes(state.focusedPane)) focusSlot(visible[visible.length - 1]);
  changed();
}

/** Swap a window's pages for screenshots (while a pane divider is dragged) and back. */
async function coverPages(winId: string, active: boolean) {
  const ws = state.windows.find((w) => w.id === winId);
  if (!ws) return;
  if (active && !paletteWindows.has(winId)) {
    await sendPageImages(ws);
    paletteWindows.add(winId);
  } else if (!active) paletteWindows.delete(winId);
  changed();
}

/** Put a slot back into the main window; a satellite left empty closes. */
function attachPane(slot: number, opts: { closeWindow?: boolean } = {}) {
  const ws = state.windows.find((w) => w.role === 'satellite' && w.slots.includes(slot));
  if (!ws) return;
  ws.slots = ws.slots.filter((s) => s !== slot);
  const main = mainWindowState();
  main.slots = [...main.slots, slot].sort((a, b) => a - b);
  if (ws.slots.length === 0) {
    state.windows = state.windows.filter((w) => w !== ws);
    paneRects.delete(ws.id);
    if (opts.closeWindow !== false) shells.closeQuietly(ws.id);
  }
  changed();
}

/** Put keyboard focus into a pane: its page if one is loaded, otherwise the new-tab search box. */
function focusSlot(slot: number) {
  state.focusedPane = slot;
  changed();
  const session = currentSession();
  const bw = shellOfSlot(slot);
  if (!session || !bw) return;
  const tab = activeTab(session.panes[slot]);
  queueMicrotask(() => {
    if (!bw.isFocused()) bw.focus();
    const view = views.get(tab.id);
    if (tab.url !== NEW_TAB_URL && view) {
      view.webContents.focus();
    } else {
      bw.webContents.focus();
      send({ type: 'focusNewTab', slot });
    }
  });
}

// ---- actions ----

function dispatch(action: Action) {
  const session = currentSession();
  const slots = allVisibleSlots();
  const slotOf = (s?: number) => s ?? state.focusedPane;

  switch (action.type) {
    case 'selectProject': {
      state.currentProjectId = action.id;
      state.view = 'panes';
      // Entering a sleeping project shows its tabs but loads nothing until it is started.
      const s = currentSession();
      if (s) touch(s);
      void checkRemoteTabs(action.id);
      hibernateStale();
      changed();
      focusSlot(slots.includes(state.focusedPane) ? state.focusedPane : slots[0]);
      return;
    }
    case 'selectProjectIndex': {
      const p = visibleProjects()[action.index];
      if (p) dispatch({ type: 'selectProject', id: p.id });
      return;
    }
    case 'selectProjectDelta': {
      const list = visibleProjects();
      if (list.length === 0) return;
      const i = list.findIndex((p) => p.id === state.currentProjectId);
      const next = list[(i + action.delta + list.length) % list.length];
      dispatch({ type: 'selectProject', id: next.id });
      return;
    }
    case 'focusPane':
      focusSlot(action.slot);
      return;
    case 'focusPaneDelta': {
      const i = slots.indexOf(state.focusedPane);
      focusSlot(slots[(i + action.delta + slots.length) % slots.length]);
      return;
    }
    case 'setVisiblePanes': {
      const main = mainWindowState();
      const want = Math.min(Math.max(1, action.count), state.paneNames.length);
      // More panes than the main window holds: bring back panes that sit in windows of their own
      // (perhaps out of sight, on another workspace), lowest first.
      while (main.slots.length < want) {
        const away = state.windows.filter((w) => w.role === 'satellite').flatMap((w) => w.slots);
        if (away.length === 0) break;
        attachPane(Math.min(...away));
      }
      const next = Math.min(want, main.slots.length);
      // Each count of panes keeps its own widths: those set for three are no use for two.
      if (next !== main.layout.visible) {
        const saved = { ...main.layout.weightsFor };
        if (main.layout.weights) saved[main.layout.visible] = main.layout.weights;
        else delete saved[main.layout.visible];
        main.layout.weights = saved[next];
        delete saved[next];
        main.layout.weightsFor = Object.keys(saved).length ? saved : undefined;
      }
      main.layout.visible = next;
      const visible = allVisibleSlots();
      if (!visible.includes(state.focusedPane)) focusSlot(visible[visible.length - 1]);
      changed();
      return;
    }
    case 'setPanes':
      setPanes(action.names);
      return;
    case 'setSuggestions':
      if (action.suggestions === null) delete state.suggestions;
      else
        state.suggestions = action.suggestions
          .filter((t) => typeof t?.url === 'string' && t.url.trim())
          .slice(0, 48)
          .map((t) => ({
            label: String(t.label ?? '').trim().slice(0, 24),
            name: String(t.name ?? '').trim().slice(0, 40),
            // A bare host gets https://; gleeok:// (the terminal) and other schemes stay as given.
            url: /^[a-z][a-z0-9+.-]*:/i.test(t.url.trim()) ? t.url.trim() : `https://${t.url.trim()}`,
          }));
      changed();
      return;
    case 'setPaneWeights': {
      const ws = state.windows.find((w) => w.id === action.winId);
      if (!ws) return;
      ws.layout.weights = { ...ws.layout.weights, ...action.weights };
      changed();
      return;
    }
    case 'coverPages':
      void coverPages(action.winId, action.active);
      return;
    case 'toggleFocusExpand':
      mainWindowState().layout.focusExpand = !mainWindowState().layout.focusExpand;
      changed();
      return;
    case 'showDownload': {
      const d = downloads?.list.find((x) => x.id === action.id);
      if (d?.state === 'completed') shell.showItemInFolder(d.path);
      return;
    }
    case 'hibernate':
      hibernate(action.id);
      return;
    case 'startProject':
      startProject(action.id);
      return;
    case 'reviveTab':
      reviveTab(action.tabId);
      return;
    case 'openLog':
      void shell.openPath(logPath());
      return;
    case 'setWeatherPlace':
      if (action.place === 'auto') delete state.weatherPlace;
      else state.weatherPlace = action.place === 'off' ? null : action.place;
      weather.placeChanged();
      changed();
      return;
    case 'refreshWeather':
      weather.placeChanged();
      return;
    case 'setUpdateChannel':
      state.updateChannel = action.channel === 'beta' ? 'beta' : undefined;
      // Back to stable: the next start runs the installed build's own code again.
      if (action.channel === 'stable' && runningHot()) {
        leaveHot();
        send({ type: 'toast', slot: state.focusedPane, text: '已切回正式版：重启 Gleeok 后生效', ms: 8000 });
      }
      changed();
      void checkUpdate(false);
      return;
    case 'setClock':
      state.clock = action.mode === 'fullscreen' ? undefined : action.mode;
      changed();
      return;
    case 'setTheme':
      state.theme = action.theme === 'system' ? undefined : action.theme;
      nativeTheme.themeSource = action.theme;
      changed();
      return;
    case 'archiveProject':
      void setArchived(action.id, action.archived, action.open);
      return;
    case 'tabDrag':
      if (action.active) void startTabDrag();
      else {
        dragToken++;
        tabDragging = false;
        changed();
      }
      return;
    case 'openPalette':
      void openPalette();
      return;
    case 'checkUpdate':
      void checkUpdate(true);
      return;
    case 'selfUpdate':
      void runSelfUpdate();
      return;
    case 'openUpdate':
      void openOverlay('update-dialog');
      return;
    case 'vaultFill':
      void vaultFill();
      return;
    case 'vaultFillItem': {
      const login = pickedLogins.get(action.itemId);
      const page = focusedPage();
      pickedLogins.clear();
      if (login && page) void fillAndReport(page, login);
      return;
    }
    case 'vaultSaveDialog':
      void vaultSaveDialog();
      return;
    case 'vaultCopy': {
      const value = vault?.field(action.id, action.what, action.index);
      if (!value) return;
      clipboard.writeText(value);
      const label = { url: '网址', username: '用户名', password: '密码' }[action.what];
      if (action.what === 'password') {
        // Like password managers do: wipe it after a while, unless something else was copied since.
        setTimeout(() => {
          void Promise.resolve(clipboard.readText()).then((now) => {
            if (now === value) clipboard.clear();
          });
        }, 30_000);
      }
      send({
        type: 'toast',
        slot: state.focusedPane,
        text: action.what === 'password' ? `已复制${label}，30 秒后自动清除` : `已复制${label}`,
      });
      return;
    }
    case 'vaultLock':
      void vault?.lock().then(changed);
      send({ type: 'toast', slot: state.focusedPane, text: '密码库已锁定' });
      return;
    case 'adoptRemoteTabs': {
      const s = state.sessions[action.projectId];
      if (!s) return;
      void config
        .listSessions(action.projectId)
        .then((list) => {
          const remote = list.find((r) => r.deviceId !== device.id);
          if (remote) adoptTabs(s, remote);
        })
        .catch(() => {});
      return;
    }
    case 'restoreTabs': {
      const s = state.sessions[action.projectId];
      const before = tabsBeforeAdopt.get(action.projectId);
      if (!s || !before) return;
      for (const pane of s.panes) for (const t of pane.tabs) views.destroy(t.id);
      s.panes = before;
      tabsBeforeAdopt.delete(action.projectId);
      tabsChanged(s);
      changed();
      return;
    }
    case 'closePalette':
      paletteWindows.delete(action.winId);
      changed();
      return;
    case 'openCode': {
      const project = config.projects.find((p) => p.id === (action.projectId ?? state.currentProjectId));
      if (!project) return;
      const link = action.linkId ? project.links.find((l) => l.id === action.linkId) : primaryCodeLink(project);
      if (!link) {
        send({ type: 'toast', slot: state.focusedPane, text: `「${project.name}」还没有代码链接：可以在项目设置里添加` });
        return;
      }
      if (state.currentProjectId !== project.id) dispatch({ type: 'selectProject', id: project.id });
      const s = currentSession();
      if (!s) return;
      // An editor already open for this folder is brought forward instead of opening a second one.
      for (let slot = 0; slot < state.paneNames.length; slot++) {
        const tab = s.panes[slot].tabs.find((t) => sameCodePage(t.url, link.url));
        if (!tab) continue;
        state.view = 'panes';
        s.panes[slot].activeTabId = tab.id;
        if (!isLive(s)) startProject(s.projectId);
        tabsChanged(s);
        changed();
        focusSlot(slot);
        return;
      }
      const visible = allVisibleSlots();
      dispatch({ type: 'openLink', url: link.url, slot: visible.includes(CODE_PANE) ? CODE_PANE : state.focusedPane, newTab: true });
      return;
    }
    case 'codeMenu': {
      const project = config.projects.find((p) => p.id === action.projectId);
      if (!project) return;
      const links = codeLinks(project);
      const primary = primaryCodeLink(project);
      const name = (l: (typeof links)[number]) => l.label || l.url;
      Menu.buildFromTemplate([
        ...links.map((l) => ({
          label: `${l === primary ? '★ ' : ''}打开 ${name(l)}`,
          click: () => dispatch({ type: 'openCode', projectId: project.id, linkId: l.id }),
        })),
        ...(links.length > 1
          ? [
              { type: 'separator' as const },
              {
                label: '设为主要',
                submenu: links
                  .filter((l) => l !== primary)
                  .map((l) => ({ label: name(l), click: () => dispatch({ type: 'setPrimaryCode', projectId: project.id, linkId: l.id }) })),
              },
            ]
          : []),
        { type: 'separator' },
        {
          label: '编辑代码链接…',
          click: () => {
            dispatch({ type: 'selectProject', id: project.id });
            dispatch({ type: 'toggleEntry' });
          },
        },
      ]).popup({ window: focusedWindow() ?? undefined });
      return;
    }
    case 'setPrimaryCode':
      void config
        .setPrimaryCode(action.projectId, action.linkId)
        .catch(() => send({ type: 'toast', slot: state.focusedPane, text: '保存失败：服务器连不上' }))
        .then(changed);
      return;
    case 'upsertLink': {
      const { projectId, link, slot } = action;
      void config
        .upsertLink(projectId, link)
        .then((ok) => {
          const name = config.projects.find((x) => x.id === projectId)?.name ?? '';
          if (ok) send({ type: 'toast', slot, text: `已保存到「${name}」：${link.label}` });
        })
        .catch(() => send({ type: 'toast', slot, text: '保存失败：服务器连不上' }))
        .then(changed);
      return;
    }
    case 'openSaveLink': {
      const s = currentSession();
      const slot = slotOf(action.slot);
      if (!s || isInternalUrl(activeTab(s.panes[slot]).url)) return;
      shellOfSlot(slot)?.webContents.focus();
      send({ type: 'openSaveLink', slot });
      return;
    }
    case 'removeLink':
      void config
        .removeLink(action.projectId, action.linkId)
        .catch(() => {})
        .then(changed);
      return;
    case 'projectMenu': {
      const s = state.sessions[action.id];
      const live = !!s && isLive(s);
      if (config.projects.find((p) => p.id === action.id)?.archived) {
        Menu.buildFromTemplate([
          { label: '取消存档并打开', click: () => void setArchived(action.id, false, true) },
          { label: '取消存档', click: () => void setArchived(action.id, false) },
          { type: 'separator' },
          { label: '删除项目…', click: () => void confirmDelete(action.id) },
        ]).popup({ window: focusedWindow() ?? undefined });
        return;
      }
      Menu.buildFromTemplate([
        { label: '打开', click: () => dispatch({ type: 'selectProject', id: action.id }) },
        {
          label: '项目设置',
          click: () => {
            dispatch({ type: 'selectProject', id: action.id });
            dispatch({ type: 'toggleEntry' });
          },
        },
        { type: 'separator' },
        live
          ? { label: '休眠：关闭网页，释放内存', click: () => hibernate(action.id) }
          : {
              label: '启动',
              click: () => {
                dispatch({ type: 'selectProject', id: action.id });
                startProject(action.id);
              },
            },
        { type: 'separator' },
        { label: '存档', click: () => void setArchived(action.id, true) },
        { label: '删除项目…', click: () => void confirmDelete(action.id) },
      ]).popup({ window: focusedWindow() ?? undefined });
      return;
    }
    case 'detachPane':
      detachPane(slotOf(action.slot));
      return;
    case 'attachPane':
      attachPane(slotOf(action.slot));
      return;
    case 'togglePaneWindow': {
      const slot = state.focusedPane;
      if (mainWindowState().slots.includes(slot)) detachPane(slot);
      else attachPane(slot);
      return;
    }
    case 'toggleSidebar': {
      const w = mainWindowState();
      w.sidebarCollapsed = !w.sidebarCollapsed;
      changed();
      return;
    }
    case 'setView':
      state.view = action.view;
      changed();
      return;
    case 'pomoStart':
      startPomodoro(action.taskKey, action.blockKey);
      return;
    case 'pomoPause':
      pomodoro.pause();
      return;
    case 'pomoResume':
      pomodoro.resume();
      return;
    case 'pomoSkip':
      pomodoro.skip();
      return;
    case 'pomoStop':
      pomodoro.stop();
      return;
    case 'pomoConfirm':
      pomodoro.confirm(action.go);
      return;
    case 'setPomodoroSettings':
      state.pomodoro = { ...state.pomodoro, ...action.settings };
      changed();
      return;
    case 'togglePlanner':
      state.view = state.view === 'planner' ? 'panes' : 'planner';
      if (state.view === 'planner') void planner.sync();
      changed();
      return;
    case 'toggleLibrary':
      state.view = state.view === 'library' ? 'panes' : 'library';
      if (state.view === 'library') void library.sync();
      changed();
      return;
    case 'toggleEntry':
      if (!state.currentProjectId) return;
      if (state.view !== 'panes') {
        state.view = 'panes';
        changed();
      }
      // The renderer toggles: a second press (or the shortcut inside the drawer) closes it.
      void openOverlay('entry-drawer');
      return;
    case 'vaultUnlock':
      if (vault && !vault.unlocked) void openOverlay('vault-dialog', { mode: 'unlock', email: vault.email } satisfies VaultDialog);
      return;
    // Library actions work with no project open (openReader says so when it needs one).
    case 'openReader':
      openReader(action.attachment, action.slot);
      return;
    case 'setLibrarySettings':
      state.library = { ...state.library, ...action.settings };
      changed();
      return;
  }

  if (!session) return;
  touch(session);
  if (session.lifecycle !== 'live' && (action.type === 'navigate' || action.type === 'openLink' || action.type === 'history')) {
    startProject(session.projectId);
  }
  switch (action.type) {
    case 'newTab':
      state.view = 'panes';
      openTab(session, slotOf(action.slot), action.url ? normalizeUrl(action.url) : NEW_TAB_URL);
      return;
    case 'closeTab': {
      const slot = slotOf(action.slot);
      const pane = session.panes[slot];
      const id = action.tabId ?? pane.activeTabId;
      const i = pane.tabs.findIndex((t) => t.id === id);
      if (i < 0) return;
      if (pane.tabs[i].url !== NEW_TAB_URL) {
        const stack = closedTabs.get(session.projectId) ?? [];
        stack.push({ slot, url: pane.tabs[i].url });
        closedTabs.set(session.projectId, stack.slice(-20));
      }
      views.destroy(id);
      pane.tabs.splice(i, 1);
      if (pane.tabs.length === 0) pane.tabs.push(newTab());
      if (pane.activeTabId === id) pane.activeTabId = pane.tabs[Math.min(i, pane.tabs.length - 1)].id;
      tabsChanged(session);
      changed();
      focusSlot(slot);
      return;
    }
    case 'activateTab':
      session.panes[action.slot].activeTabId = action.tabId;
      tabsChanged(session);
      changed();
      focusSlot(action.slot);
      return;
    case 'cycleTab': {
      const pane = session.panes[state.focusedPane];
      const i = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
      pane.activeTabId = pane.tabs[(i + action.delta + pane.tabs.length) % pane.tabs.length].id;
      tabsChanged(session);
      changed();
      focusSlot(state.focusedPane);
      return;
    }
    case 'navigate':
    case 'openLink': {
      const slot = slotOf(action.slot);
      const url = normalizeUrl(action.url);
      const tab = activeTab(session.panes[slot]);
      // A terminal, the 文献库 or the 日程 takes a blank tab, or opens beside the current page.
      if (isTerminalUrl(url) || isLibraryUrl(url) || isPlannerUrl(url)) {
        state.view = 'panes';
        if (tab.url !== NEW_TAB_URL) return openTab(session, slot, url);
        tab.url = url;
        tab.title = isLibraryUrl(url) ? '文献库' : isPlannerUrl(url) ? '日程' : terminalTitle(url);
        tabsChanged(session);
        changed();
        focusSlot(slot);
        return;
      }
      // From the entry/import pages, links open as new tabs; elsewhere they replace a blank tab.
      if (action.type === 'openLink' && (state.view !== 'panes' || action.newTab)) {
        state.view = 'panes';
        if (tab.url !== NEW_TAB_URL) return openTab(session, slot, url);
      }
      // A live page reports its real URL once navigation commits (a download never does);
      // a blank tab has no page yet, so its URL is what creates one.
      if (action.type === 'navigate' && action.save && looksLikeUrl(action.url)) {
        startPendingLink(tab.id, session.projectId, slot, url);
      }
      const view = views.get(tab.id);
      if (view) view.webContents.loadURL(url).catch(() => {});
      else {
        tab.url = url;
        tabsChanged(session);
      }
      changed();
      focusSlot(slot);
      return;
    }
    case 'history': {
      const view = views.get(activeTab(session.panes[slotOf(action.slot)]).id);
      if (!view) return;
      const nav = view.webContents.navigationHistory;
      if (action.op === 'back' && nav.canGoBack()) nav.goBack();
      if (action.op === 'forward' && nav.canGoForward()) nav.goForward();
      // Reloading a dead page does not always bring it back; a fresh view does.
      if (action.op === 'reload') {
        if (views.crashed(activeTab(session.panes[slotOf(action.slot)]).id)) reviveTab(activeTab(session.panes[slotOf(action.slot)]).id);
        else view.webContents.reload();
      }
      return;
    }
    case 'focusAddress':
      shellOfSlot(state.focusedPane)?.webContents.focus();
      send({ type: 'focusAddress', slot: state.focusedPane });
      return;
    case 'moveTab': {
      const hit = findTab(action.tabId);
      if (!hit || hit.session !== session || hit.slot === action.toSlot) return;
      const from = hit.pane;
      const i = from.tabs.indexOf(hit.tab);
      from.tabs.splice(i, 1);
      if (from.tabs.length === 0) from.tabs.push(newTab());
      if (from.activeTabId === hit.tab.id) from.activeTabId = from.tabs[Math.min(i, from.tabs.length - 1)].id;
      const to = session.panes[action.toSlot];
      to.tabs.splice(to.tabs.findIndex((t) => t.id === to.activeTabId) + 1, 0, hit.tab);
      to.activeTabId = hit.tab.id;
      tabsChanged(session);
      changed();
      focusSlot(action.toSlot);
      return;
    }
    case 'reopenTab': {
      const last = closedTabs.get(session.projectId)?.pop();
      if (last) openTab(session, last.slot, last.url);
      return;
    }
    case 'zoom': {
      const wc = views.get(activeTab(session.panes[state.focusedPane]).id)?.webContents;
      if (wc) wc.setZoomLevel(action.delta === 0 ? 0 : wc.getZoomLevel() + action.delta * 0.5);
      return;
    }
    case 'openFind': {
      const slot = slotOf(action.slot);
      if (isInternalUrl(activeTab(session.panes[slot]).url)) return;
      shellOfSlot(slot)?.webContents.focus();
      send({ type: 'openFind', slot });
      return;
    }
    case 'find': {
      const wc = views.get(activeTab(session.panes[action.slot]).id)?.webContents;
      if (wc && action.text) wc.findInPage(action.text, { forward: action.forward ?? true, findNext: action.findNext ?? false });
      return;
    }
    case 'stopFind':
      views.get(activeTab(session.panes[action.slot]).id)?.webContents.stopFindInPage('clearSelection');
      return;
  }
}

function handleInput(input: Input, from?: Electron.WebContents): boolean {
  // In a terminal on Linux/Windows, Ctrl+C/D/L/R/W/... are the shell's keys (macOS uses Cmd for ours).
  if (from && terminalFocus.has(from.id) && process.platform !== 'darwin' && input.control && !input.alt && !input.meta && !input.shift && input.code !== 'Tab')
    return false;
  const action = matchShortcut(input, process.platform);
  if (!action) return false;
  dispatch(action);
  return true;
}

// ---- window & ipc ----

let lastFocusRefresh = 0;
const shells = new Shells({
  onInput: handleInput,
  onUserClosed(id) {
    if (id === 'main') return app.quit();
    // Closing a satellite hands its panes back to the main window.
    const ws = state.windows.find((w) => w.id === id);
    for (const slot of ws?.slots ?? []) attachPane(slot, { closeWindow: false });
  },
  onPlacementChanged: () => changed(),
  onClosing: (bw) => views.detachAll(bw),
  paneName: (slot) => paneName(state.paneNames, slot),
  onFocus: () => {
    if (Date.now() - lastFocusRefresh < 30_000) return;
    lastFocusRefresh = Date.now();
    void config.refresh().then(changed);
    if (state.currentProjectId) void checkRemoteTabs(state.currentProjectId);
  },
});
// Light ↔ dark (the setting, or the system's when following it): windows repaint their backdrop.
nativeTheme.on('updated', () => {
  for (const [, bw] of shells.all()) if (!bw.isDestroyed()) bw.setBackgroundColor(windowBackground());
});

ipcMain.handle('snapshot:get', () => snapshot());
ipcMain.handle('vault:unlock', async (_e, email: string, password: string, server?: string) => {
  try {
    await vault!.unlock(email, password, server);
    changed();
    return {};
  } catch (e) {
    return { error: String(e).replace(/^Error: /, '').slice(0, 200) };
  }
});
ipcMain.handle('vault:save', async (_e, login: { name: string; url: string; username: string; password: string }) => {
  try {
    await vault!.save(login);
    send({ type: 'toast', slot: state.focusedPane, text: `已存进密码库：${login.name}（${login.username}）` });
    return {};
  } catch (e) {
    return { error: String(e).replace(/^Error: /, '').slice(0, 200) };
  }
});
ipcMain.on('action', (_e, action: Action) => dispatch(action));
ipcMain.handle('term:attach', (_e, tabId: string, url: string, cols: number, rows: number) => terminals.attach(tabId, url, cols, rows));
ipcMain.on('term:input', (_e, tabId: string, data: string) => terminals.input(tabId, data));
ipcMain.on('term:resize', (_e, tabId: string, cols: number, rows: number) => terminals.resize(tabId, cols, rows));
ipcMain.on('term:focus', (e, focused: boolean) => (focused ? terminalFocus.add(e.sender.id) : terminalFocus.delete(e.sender.id)));
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(text));
ipcMain.on('pane-rects', (_e, winId: string, rects: PaneRects) => {
  paneRects.set(winId, rects);
  syncViews();
});
ipcMain.handle('project:create', async (_e, name: string) => {
  const p = await config.create(name);
  dispatch({ type: 'selectProject', id: p.id });
  dispatch({ type: 'toggleEntry' });
  return p;
});
ipcMain.handle('project:save', async (_e, project: Project) => {
  try {
    return await config.save(project);
  } finally {
    changed();
  }
});
ipcMain.handle('project:delete', (_e, id: string) => deleteProject(id));
ipcMain.handle('paseo:import', async (_e, serverId: string, projectIds: string[]) => {
  const created = await config.importPaseo(serverId, projectIds);
  changed();
  return created;
});
ipcMain.handle('paseo:pair', async (_e, url: string) => {
  let serverId: string;
  try {
    serverId = parseOffer(url.trim()).serverId;
  } catch (e) {
    return { error: (e as Error).message };
  }
  pairings = [...pairings.filter((p) => p.serverId !== serverId), { serverId, url: url.trim(), addedAt: new Date().toISOString() }];
  savePairings(pairings);
  // A sync already under way started without this link.
  await paseoSyncing;
  await syncPaseo();
  return { error: pairingStatus.get(serverId)?.error };
});
ipcMain.handle('paseo:code-server', async (_e, serverId: string, url: string) => {
  try {
    await config.setDaemonSettings(serverId, { codeServer: url.trim() || null });
    changed();
    return {};
  } catch (e) {
    const m = /"error":"([^"]+)"/.exec(String(e));
    return { error: m ? m[1] : String(e) };
  }
});
ipcMain.handle('paseo:detect-code-server', async (_e, serverId: string) => {
  try {
    const url = await config.detectCodeServer(serverId);
    changed();
    return { url };
  } catch (e) {
    return { error: String(e).slice(0, 120) };
  }
});
ipcMain.handle('paseo:unpair', (_e, serverId: string) => {
  pairings = pairings.filter((p) => p.serverId !== serverId);
  savePairings(pairings);
  pairingStatus.delete(serverId);
  changed();
});
// Agent connections: managed on the sync server (or the in-process one), handed over as text.
const agentPort = new AgentPort((req) => config.localFetch(req));

async function agentPanel(): Promise<AgentPanel> {
  const agents = (await serverJson('GET', '/api/agents')) as AgentInfo[];
  if (!config.local) return { agents, mode: 'server', url: config.serverUrl?.replace(/\/+$/, '') ?? null };
  await agentPort.update(agents.length > 0, !!state.agentLan);
  return { agents, mode: 'local', url: agentPort.status.url ?? null, port: { ...agentPort.status, lan: !!state.agentLan } };
}

async function agentNew(created: AgentCreated): Promise<AgentNew> {
  const panel = await agentPanel();
  if (!panel.url) throw new Error(panel.port?.error ?? '没有可以给 agent 的地址');
  const { name, scopes } = created.agent;
  const handoff = agentHandoff({ url: panel.url, token: created.token, name, scopes, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  return { panel, created, handoff };
}

async function agentCall(op: AgentOp): Promise<unknown> {
  switch (op.op) {
    case 'list':
      return agentPanel();
    case 'create':
      return agentNew((await serverJson('POST', '/api/agents', { name: op.name, scopes: op.scopes })) as AgentCreated);
    case 'rotate':
      return agentNew((await serverJson('POST', `/api/agents/${op.id}/rotate`)) as AgentCreated);
    case 'revoke':
      await config.fetchRaw('DELETE', `/api/agents/${op.id}`);
      return agentPanel();
    case 'setLan':
      state.agentLan = op.lan || undefined;
      changed();
      return agentPanel();
  }
}

ipcMain.handle('agents:call', async (_e, op: AgentOp) => {
  try {
    return { result: await agentCall(op) };
  } catch (e) {
    return { error: String((e as Error).message ?? e).slice(0, 300) };
  }
});

ipcMain.handle('weather:search', async (_e, name: string) => {
  try {
    return { result: await searchPlaces(String(name)) };
  } catch (e) {
    return { error: String((e as Error).message ?? e) };
  }
});

ipcMain.handle('library:get', () => library.snapshot());
ipcMain.handle('library:call', async (_e, op: LibraryOp) => {
  try {
    return { result: await libraryCall(op) };
  } catch (e) {
    return { error: String((e as Error).message ?? e).slice(0, 300) };
  }
});
ipcMain.handle('project:refresh', async () => {
  await config.refresh();
  changed();
});

/**
 * The application menu. Electron's default one binds Close Window to Ctrl/Cmd+W and Reload to
 * Ctrl/Cmd+R; where Gleeok lets a key through (Ctrl+W, Ctrl+R in a terminal on Linux/Windows,
 * which belong to the shell) those closed or reloaded the whole window. Linux and Windows get no
 * menu (it was hidden anyway); macOS keeps the app and Edit menus (copy and paste need them) and
 * closes a window with Shift+Cmd+W, leaving Cmd+W to close the tab, as browsers do.
 */
function setAppMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: '窗口',
        submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'close', accelerator: 'Shift+Command+W' }, { role: 'front' }],
      },
    ]),
  );
}

app.whenReady().then(async () => {
  setAppMenu();
  // castLabs' Electron fetches the Widevine CDM (DRM for Apple Music, Netflix…) on first run and
  // keeps it updated. Pages wait briefly for it; offline, they open without DRM.
  await Promise.race([
    components.whenReady().catch((e: unknown) => log(`widevine unavailable: ${String(e)}`)),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  noteDrm();
  // Late (first run, slow network): note it once the CDM is there.
  void components.whenReady().then(noteDrm, () => {});
  // The in-app update re-signs a new Electron; if that did not work, say how to do it by hand.
  if (drm.vmp === 'stale') {
    setTimeout(() => send({ type: 'toast', slot: state.focusedPane, text: 'Electron 更新后 Apple Music 的签名失效了：在终端运行 deploy/macos-vmp-sign.sh', ms: 20_000 }), 4000);
  }
  // Run from a checkout, the Dock would show Electron's icon; packaged builds carry their own.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'assets', 'icon.png'));
  // Present as plain Chrome: some sites refuse or degrade for UAs that mention Electron.
  const ses = session.fromPartition(PARTITION);
  serveReader(ses);
  ses.setUserAgent(ses.getUserAgent().replace(/ (Electron|gleeok)\/\S+/g, ''));
  setupGoogleSignIn(ses);
  downloads = new Downloads(ses, changed);
  setupPermissions(ses, focusedWindow);

  // After a restart nothing is loaded yet; only the project on screen resumes, the rest wait
  // for an explicit start.
  for (const s of Object.values(state.sessions)) if (s.projectId !== state.currentProjectId) s.lifecycle = 'hibernated';
  config.load();
  library.load();
  planner.load();
  vault = new Vault(config.vaultUrl);
  vault.onChange = changed;
  vault.prewarm();
  const main = shells.open(mainWindowState());
  for (const ws of state.windows) if (ws.role === 'satellite') shells.open(ws);
  await config.refresh();
  vault.serverUrl = config.vaultUrl ?? VAULT_URL_DEFAULT;
  void syncPaseo();
  setInterval(() => void syncPaseo(), 2 * 60_000);
  weather.start();
  // Local mode: reopen the agents' port if there are connections.
  if (config.local) void agentPanel().catch((e: unknown) => console.warn('[gleeok] agent port:', e));
  // Other machines' library edits arrive within a minute (and right away when the library opens);
  // the trash empties itself of old items a few times a day.
  const expireTrash = () => void library.emptyTrash(librarySettings(state).trashDays);
  void library.sync().then(expireTrash);
  setInterval(() => void library.sync(), 60_000);
  void planner.sync();
  setInterval(() => void planner.sync(), 60_000);
  setInterval(expireTrash, 6 * 3600_000);
  publishAllTabs();
  if (state.currentProjectId) void checkRemoteTabs(state.currentProjectId);
  hibernateStale();
  setInterval(hibernateStale, 10 * 60_000);
  powerMonitor.on('resume', hibernateStale);
  // Woken up, perhaps somewhere else: locate again and fetch a fresh forecast.
  powerMonitor.on('resume', () => weather.placeChanged());
  // A locked screen locks the vault too (and drops the decrypted logins from memory).
  powerMonitor.on('lock-screen', () => {
    if (vault?.unlocked) void vault.lock().then(changed);
  });
  powerMonitor.on('unlock-screen', hibernateStale);
  setInterval(sampleMemory, 10_000);
  // Pick up edits from other machines and Paseo link updates pushed by the sync timers.
  setInterval(() => void config.refresh().then(changed), 60_000);
  // Running from a git checkout: look for new commits shortly after launch and every 6 hours.
  setTimeout(() => void checkUpdate(false), 20_000);
  // Up and running for a while: a hot update that got this far is fine (see boot.js).
  setTimeout(confirmHotBoot, 15_000);
  // Every 6 hours; on the beta channel every half hour (hot updates come with each push).
  setInterval(() => {
    const every = state.updateChannel === 'beta' ? 30 * 60_000 : 6 * 3600_000;
    if (Date.now() - lastUpdateCheck >= every) void checkUpdate(false);
  }, 5 * 60_000);
  if (!state.currentProjectId && visibleProjects()[0]) state.currentProjectId = visibleProjects()[0].id;
  changed();
  // Unlock the vault right away (machines that used it before), so filling is instant later.
  if (vault.email && !process.env.GLEEOK_DEV_SCRIPT) {
    const askUnlock = () => void openOverlay('vault-dialog', { mode: 'unlock', email: vault!.email } satisfies VaultDialog);
    if (main.webContents.isLoading()) main.webContents.once('did-finish-load', askUnlock);
    else askUnlock();
  }
  if (process.env.GLEEOK_DEV_SCRIPT) {
    if (main.webContents.isLoading()) await new Promise((r) => main.webContents.once('did-finish-load', () => r(undefined)));
    await runDevScript(() => shells.all(), views, dispatch, () => state, snapshot, {
      fillFocused: async (u, p) => {
        const page = focusedPage();
        return page ? fillPage(page.wc, u, p) : false;
      },
      readFocused: async () => {
        const page = focusedPage();
        return page ? readPage(page.wc) : null;
      },
      crashPage: () => focusedPage()?.wc.forcefullyCrashRenderer(),
      pressKey: async (key) => {
        const page = focusedPage();
        if (!page) return;
        page.wc.sendInputEvent({ type: 'keyDown', keyCode: key });
        page.wc.sendInputEvent({ type: 'char', keyCode: key === 'Enter' ? '\r' : key });
        page.wc.sendInputEvent({ type: 'keyUp', keyCode: key });
      },
      evalPage: async (js) => {
        const session = currentSession();
        const view = session && views.get(activeTab(session.panes[state.focusedPane]).id);
        if (!view || view.webContents.isDestroyed()) return 'no focused page';
        return view.webContents.executeJavaScript(js).catch((e: unknown) => `eval failed: ${String(e)}`);
      },
      pageText: async (click) => {
        const page = focusedPage();
        if (!page) return null;
        if (click) await page.wc.executeJavaScript(`document.querySelector(${JSON.stringify(click)})?.click()`).catch(() => {});
        const text = (await page.wc.executeJavaScript('document.body.innerText').catch(() => '')) as string;
        const traits = await page.wc
          .executeJavaScript('JSON.stringify({ uaData: typeof navigator.userAgentData, chrome: typeof window.chrome, vendor: navigator.vendor, ua: navigator.userAgent.slice(0, 40) })')
          .catch(() => '');
        return { url: page.wc.getURL().slice(0, 90), traits, text: text.replace(/\s+/g, ' ').slice(0, 300) };
      },
    });
  }
});

app.on('before-quit', () => {
  vault?.dispose();
  void vault?.lock();
  shells.quitting = true;
  saveState(statePath(), state);
});
// Windows record their placement as they close, which happens after before-quit.
app.on('will-quit', () => {
  saveState(statePath(), state);
  terminals.killAll();
});
app.on('window-all-closed', () => app.quit());
// The GPU process and the like: when one dies every page may turn white at once.
app.on('child-process-gone', (_e, d) => log(`${d.type} process gone: reason=${d.reason} exitCode=${d.exitCode}${d.name ? ` name=${d.name}` : ''}`));

/** Same editor page: same origin and the same folder/workspace (code-server keeps `?folder=` in its URL). */
function sameCodePage(tabUrl: string, linkUrl: string) {
  try {
    const a = new URL(tabUrl);
    const b = new URL(linkUrl);
    const key = (u: URL) => u.searchParams.get('folder') ?? u.searchParams.get('workspace') ?? u.pathname.replace(/\/+$/, '');
    return a.origin === b.origin && key(a) === key(b);
  } catch {
    return false;
  }
}
