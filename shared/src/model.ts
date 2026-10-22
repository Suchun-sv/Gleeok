// Config lives on the Gleeok server and is shared by every machine.

export interface Link {
  id: string;
  label: string;
  url: string;
  /** Pane this link opens in when the project is opened for the first time on a machine. */
  pinnedPane?: number;
  /**
   * Managed by the server from the Paseo sync: 'paseo' points at the project's most recently used
   * workspace, 'paseo-terminal' at a terminal in that workspace (and disappears when it is closed).
   */
  kind?: 'paseo' | 'paseo-terminal';
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
  syncedAt: string;
  projects: PaseoProject[];
}

export interface PaseoProject {
  projectId: string;
  name: string;
  path: string;
  workspaceCount: number;
  /** Most recently active non-archived workspace, if any. */
  latest: { workspaceId: string; name: string; at: string | null; terminalId?: string | null } | null;
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

/** The server-managed links a Paseo project should carry, in order. */
export function managedPaseoLinks(
  daemon: Pick<PaseoDaemon, 'serverId' | 'webBase'>,
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
  return out;
}

export type ProjectInput = Pick<Project, 'name'> &
  Partial<Pick<Project, 'source' | 'paseo' | 'links' | 'order' | 'archived'>>;

// State is local to one machine: screens, windows and open tabs differ per device.

export const NEW_TAB_URL = 'gleeok://newtab';
export const PANE_COUNT = 3;

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

export type View = 'panes' | 'entry' | 'import';

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
