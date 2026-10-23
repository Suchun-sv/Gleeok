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
/** The 文献库 as a tab: drawn by Gleeok itself inside the pane, like a terminal. */
export const LIBRARY_URL = 'gleeok://library';
export const isLibraryUrl = (url: string) => url === LIBRARY_URL || url.startsWith(`${LIBRARY_URL}?`);
export const isInternalUrl = (url: string) => url === NEW_TAB_URL || isTerminalUrl(url) || isLibraryUrl(url);
/** A 文献库 PDF in Zotero's reader: a real page (served by Gleeok), so it lives in a pane like any site. */
export const READER_ORIGIN = 'gleeok://reader';
export const readerUrl = (attachment: string) => `${READER_ORIGIN}/?attachment=${attachment}`;
export const isReaderUrl = (url: string) => url.startsWith(`${READER_ORIGIN}/`);
export const readerAttachment = (url: string) => (isReaderUrl(url) ? new URL(url).searchParams.get('attachment') : null);
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
/** Every project keeps this many panes; GlobalState.paneNames says how many are in use. */
export const MAX_PANES = 6;
export const DEFAULT_PANE_NAMES = ['AI区', '草稿区', '产出区'];

/** A tile in the new-tab page's 常用 row: what it is for, the site's name, where it goes. */
export interface Suggestion {
  label: string;
  name: string;
  url: string;
}

export const DEFAULT_SUGGESTIONS: Suggestion[] = [
  { label: '终端', name: '本机', url: TERMINAL_URL },
  { label: 'AI 对话', name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { label: 'AI 对话', name: 'Claude', url: 'https://claude.ai/' },
  { label: '读论文', name: 'alphaXiv', url: 'https://www.alphaxiv.org/' },
  { label: '做 PPT', name: 'OneDrive', url: 'https://www.office.com/launch/onedrive' },
  { label: '草稿', name: 'Notion', url: 'https://www.notion.so/' },
  { label: '画布', name: 'Miro', url: 'https://miro.com/app/dashboard/' },
  { label: '代码', name: 'code-server', url: 'https://coder.com/docs/code-server' },
  { label: '邮件', name: 'Outlook', url: 'https://outlook.com/' },
  { label: '音乐', name: 'Apple Music', url: 'https://music.apple.com/' },
  { label: '看书', name: '微信读书', url: 'https://weread.qq.com/' },
  { label: '娱乐', name: 'RedNote', url: 'https://www.rednote.com/' },
];
/** What a pane is for, shown on its tab strip and wherever a pane is named; set in Settings. */
export const paneName = (names: string[], slot: number) => names[slot]?.trim() || `第${slot + 1}栏`;

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
  /** Always MAX_PANES long; the pane count and the layout decide which are visible. */
  panes: Pane[];
  lastActiveAt: number;
  lifecycle: 'live' | 'hibernated';
}

export interface Layout {
  /** Main window: how many of its panes are shown (the first ones). */
  visible: number;
  /** When on, the focused pane is focusRatio times as wide as the others. */
  focusExpand: boolean;
  focusRatio: number;
  /** Relative pane widths by slot (1 when unset), set by dragging the dividers between panes. */
  weights?: Record<number, number>;
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

export type View = 'panes' | 'settings' | 'library';

export interface GlobalState {
  currentProjectId: string | null;
  focusedPane: number;
  view: View;
  windows: AppWindowState[];
  sessions: Record<string, ProjectSession>;
  /** One name per pane in use (1..MAX_PANES). */
  paneNames: string[];
  /** The new-tab page's 常用 tiles once edited in Settings; unset follows DEFAULT_SUGGESTIONS. */
  suggestions?: Suggestion[];
  /** 文献库 preferences changed in Settings (this machine only); see librarySettings(). */
  library?: Partial<LibrarySettings>;
}

export interface LibrarySettings {
  /** The pane PDFs open in (index; the last visible one when it is not shown). */
  readerPane: number;
  /** Most disk space the local copies of PDFs may take, in GB. */
  cacheGB: number;
  /** Items in the trash longer than this are deleted for good (0: never). */
  trashDays: number;
  readerTheme: 'auto' | 'dark' | 'light';
  /** How a PDF opened for the first time is zoomed. */
  readerZoom: 'page-width' | 'page-fit' | 'auto';
}

export const DEFAULT_LIBRARY_SETTINGS: LibrarySettings = { readerPane: 2, cacheGB: 5, trashDays: 30, readerTheme: 'auto', readerZoom: 'page-width' };
export const librarySettings = (s: Pick<GlobalState, 'library'>): LibrarySettings => ({ ...DEFAULT_LIBRARY_SETTINGS, ...s.library });

export function visibleSlots(win: AppWindowState): number[] {
  return win.role === 'main' ? win.slots.slice(0, Math.max(1, win.layout.visible)) : win.slots;
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
