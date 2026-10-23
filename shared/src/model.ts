// Config lives on the Gleeok server and is shared by every machine.

export interface Link {
  id: string;
  label: string;
  url: string;
  /** Pane this link opens in when the project is opened for the first time on a machine. */
  pinnedPane?: number;
  /**
   * Managed by the server from the Paseo sync: 'paseo' points at the project's most recently used
   * workspace, 'paseo-terminal' at a terminal in that workspace (and disappears when it is closed),
   * 'paseo-code' at the project's folder in the daemon's code-server (when one is set for it).
   * 'code' is a code-editor link the user added by hand; 'terminal' a shell (see terminalUrl).
   */
  kind?: 'paseo' | 'paseo-terminal' | 'paseo-code' | 'code' | 'terminal';
  /** Code links only: the one the 代码 button opens. At most one per project. */
  primary?: boolean;
  /** Favicon captured from the page itself when the link was saved. */
  icon?: string;
}

export interface PaseoRef {
  /** Which Paseo daemon the project came from; several daemons may feed one server. */
  daemonId: string;
  projectId: string;
  cwd: string;
}

export interface Project {
  id: string;
  name: string;
  source: 'paseo' | 'manual';
  paseo?: PaseoRef;
  links: Link[];
  order: number;
  archived: boolean;
  version: number;
  updatedAt: string;
}

/** What one Paseo daemon reported in its last sync; the import picker reads this. */
export interface PaseoDaemon {
  serverId: string;
  hostname: string;
  version: string;
  /** Web UI origin used to build links, e.g. https://app.paseo.sh */
  webBase: string;
  /**
   * code-server on the daemon's machine, found by the server's detection or set by the user (who
   * wins); projects get a 代码 link into it. Never sent by the sync.
   */
  codeServer?: string;
  codeServerSource?: 'user' | 'detected';
  syncedAt: string;
  projects: PaseoProject[];
}

export interface PaseoProject {
  projectId: string;
  name: string;
  path: string;
  workspaceCount: number;
  /** Most recently active non-archived workspace, if any. */
  latest: {
    workspaceId: string;
    name: string;
    at: string | null;
    terminalId?: string | null;
    /** The workspace's own directory (a worktree may differ from the project root). */
    dir?: string | null;
  } | null;
}

export function paseoProjectUrl(daemon: Pick<PaseoDaemon, 'serverId' | 'webBase'>, p: PaseoProject): string {
  const base = daemon.webBase.replace(/\/$/, '');
  return p.latest
    ? `${base}/h/${daemon.serverId}/workspace/${p.latest.workspaceId}`
    : `${base}/new?serverId=${daemon.serverId}&projectId=${p.projectId}`;
}

export function paseoTerminalUrl(daemon: Pick<PaseoDaemon, 'serverId' | 'webBase'>, p: PaseoProject): string | null {
  if (!p.latest?.terminalId) return null;
  const base = daemon.webBase.replace(/\/$/, '');
  return `${base}/h/${daemon.serverId}/workspace/${p.latest.workspaceId}?open=terminal:${encodeURIComponent(p.latest.terminalId)}`;
}

/** code-server opens a folder from `?folder=`; slashes stay readable. */
export function codeFolderUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/?folder=${encodeURIComponent(path).replace(/%2F/g, '/')}`;
}

export const isManagedLink = (l: Link) => l.kind === 'paseo' || l.kind === 'paseo-terminal' || l.kind === 'paseo-code';
export const isCodeLink = (l: Link) => l.kind === 'code' || l.kind === 'paseo-code';
export const codeLinks = (p: Pick<Project, 'links'>) => p.links.filter(isCodeLink);
/** The code link the 代码 button opens: the one marked primary, else the first. */
export function primaryCodeLink(p: Pick<Project, 'links'>): Link | undefined {
  const links = codeLinks(p);
  return links.find((l) => l.primary) ?? links[0];
}
/** Code-server pages open in 草稿区. */
export const CODE_PANE = 1;

/** The server-managed links a Paseo project should carry, in order. */
export function managedPaseoLinks(
  daemon: Pick<PaseoDaemon, 'serverId' | 'webBase' | 'hostname' | 'codeServer'>,
  p: PaseoProject,
  existing: Link[],
  newId: () => string,
): Link[] {
  const keep = (kind: Link['kind']) => existing.find((l) => l.kind === kind);
  const out: Link[] = [];
  const paseo = keep('paseo');
  out.push({ ...(paseo ?? { id: newId(), label: 'Paseo', pinnedPane: 0 }), url: paseoProjectUrl(daemon, p), kind: 'paseo' });
  const termUrl = paseoTerminalUrl(daemon, p);
  if (termUrl) {
    const term = keep('paseo-terminal');
    out.push({ ...(term ?? { id: newId(), label: '终端' }), url: termUrl, kind: 'paseo-terminal' });
  }
  if (daemon.codeServer) {
    const code = keep('paseo-code');
    out.push({ ...(code ?? { id: newId(), label: `代码 · ${daemon.hostname}` }), url: codeFolderUrl(daemon.codeServer, p.latest?.dir || p.path), kind: 'paseo-code' });
  }
  return out;
}

export type ProjectInput = Pick<Project, 'name'> &
  Partial<Pick<Project, 'source' | 'paseo' | 'links' | 'order' | 'archived'>>;

// State is local to one machine: screens, windows and open tabs differ per device.

export const NEW_TAB_URL = 'gleeok://newtab';

/**
 * A terminal tab: a shell on this machine, or over ssh on `host`, starting in `cwd`. The URL
 * carries the whole target, so a terminal tab survives restarts and moves between devices.
 */
export const TERMINAL_URL = 'gleeok://terminal';
export interface TerminalTarget {
  host?: string;
  cwd?: string;
  name?: string;
}
export const isTerminalUrl = (url: string) => url === TERMINAL_URL || url.startsWith(`${TERMINAL_URL}?`);
/** Pages Gleeok draws itself instead of loading in a web view. */
export const isInternalUrl = (url: string) => url === NEW_TAB_URL || isTerminalUrl(url);
export function terminalUrl(t: TerminalTarget): string {
  const q = new URLSearchParams();
  if (t.host?.trim()) q.set('host', t.host.trim());
  if (t.cwd?.trim()) q.set('cwd', t.cwd.trim());
  if (t.name?.trim()) q.set('name', t.name.trim());
  const s = q.toString();
  return s ? `${TERMINAL_URL}?${s}` : TERMINAL_URL;
}
export function parseTerminalUrl(url: string): TerminalTarget {
  const q = new URLSearchParams(url.slice(TERMINAL_URL.length).replace(/^\?/, ''));
  return { host: q.get('host') ?? undefined, cwd: q.get('cwd') ?? undefined, name: q.get('name') ?? undefined };
}
export function terminalTitle(url: string): string {
  const t = parseTerminalUrl(url);
  if (t.name) return t.name;
  const dir = t.cwd?.replace(/\/+$/, '').split('/').pop() || '~';
  return t.host ? `${t.host}:${dir}` : `终端 ${dir}`;
}
export const PANE_COUNT = 3;
/** What each pane is for, shown on its tab strip and wherever a pane is named. */
export const PANE_NAMES = ['AI区', '草稿区', '产出区'];
export const paneName = (slot: number) => PANE_NAMES[slot] ?? `第${slot + 1}栏`;

export interface Tab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
}

export interface Pane {
  tabs: Tab[];
  activeTabId: string;
}

/** One device's open tabs for a project, as stored on the server (see sessions sync). */
export interface DeviceSession {
  deviceId: string;
  deviceName: string;
  /** When the tabs last changed on that device (ms since epoch). */
  changedAt: number;
  panes: { tabs: { url: string; title: string; favicon?: string }[]; active: number }[];
}

export interface ProjectSession {
  projectId: string;
  /** Last time this device's tabs for the project changed; compared against other devices. */
  changedAt?: number;
  /** Always PANE_COUNT long; the layout decides how many are visible. */
  panes: Pane[];
  lastActiveAt: number;
  lifecycle: 'live' | 'hibernated';
}

export type LayoutMode = 'three' | 'two';

export interface Layout {
  mode: LayoutMode;
  /** When on, the focused pane is focusRatio times as wide as the others. */
  focusExpand: boolean;
  focusRatio: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AppWindowState {
  id: string;
  role: 'main' | 'satellite';
  /**
   * Pane indices this window shows. A window owns slots, not content: switching
   * project refills every slot of every window from the new project's panes.
   */
  slots: number[];
  layout: Layout;
  /** Main window only: project sidebar folded away. */
  sidebarCollapsed?: boolean;
  placement?: { displayKey: string; bounds: Rect };
}

export type View = 'panes' | 'settings';

export interface GlobalState {
  currentProjectId: string | null;
  focusedPane: number;
  view: View;
  windows: AppWindowState[];
  sessions: Record<string, ProjectSession>;
}

export function visibleSlots(win: AppWindowState): number[] {
  return win.layout.mode === 'two' ? win.slots.slice(0, 2) : win.slots;
}

/** URLs that differ only by trailing slashes or case count as the same link. */
export function sameUrl(a: string, b: string) {
  const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** "GitHub · Change is constant. GitHub keeps you ahead. · GitHub" → "GitHub". */
export function shortTitle(title?: string) {
  const t = title?.trim() ?? '';
  if (t.length <= 30) return t;
  return t.split(/\s+[·|—–-]\s+/)[0].trim() || t;
}
