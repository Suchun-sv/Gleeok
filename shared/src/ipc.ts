import type { GlobalState, LibrarySettings, Link, Suggestion, PaseoDaemon, Project, Rect, View } from './model.ts';
import type { LibraryCollection, LibraryItem, LibraryKind } from './library.ts';

export interface VaultLoginSummary {
  id: string;
  name: string;
  username: string;
}

/** Dialogs the vault needs; shown over the pages like the palette. */
export type VaultDialog =
  | { mode: 'unlock'; email: string; then?: 'fill' | 'save' }
  | { mode: 'pick'; host: string; logins: VaultLoginSummary[] }
  | { mode: 'save'; name: string; url: string; username: string; password: string };

/** The 文献库 as the renderer sees it (sent on its own channel: it can be large). */
export interface LibrarySnapshot {
  /** offline: the cached copy, changes cannot be saved; unavailable: no library on the server. */
  status: 'loading' | 'ok' | 'offline' | 'unavailable';
  error?: string;
  version: number;
  items: LibraryItem[];
  collections: LibraryCollection[];
}

export type LibraryOp =
  | { op: 'create'; kind: LibraryKind; objects: Record<string, unknown>[] }
  | { op: 'patch'; kind: LibraryKind; key: string; fields: Record<string, unknown> }
  | { op: 'remove'; kind: LibraryKind; key: string }
  | { op: 'addFiles'; paths: string[]; collection?: string }
  /** Ask for PDFs with the system file picker, then add them. */
  | { op: 'pickFiles'; collection?: string; parentItem?: string }
  | { op: 'sync' }
  /** Local copies of PDFs: how much space they take, or drop them all. */
  | { op: 'cacheInfo' }
  | { op: 'clearCache' }
  /** Show an attachment's local copy in the file manager (fetching it first). */
  | { op: 'revealFile'; key: string };

export type ServerStatus = 'ok' | 'offline' | 'unconfigured' | 'local';

export interface Download {
  id: string;
  filename: string;
  path: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  received: number;
  total: number;
}

export interface Snapshot {
  projects: Project[];
  archivedProjects: Project[];
  paseo: PaseoDaemon[];
  /** Daemons this machine reads through a pasted pairing link; `at`/`error` from the last attempt. */
  paseoPairings: { serverId: string; at?: string; error?: string }[];
  downloads: Download[];
  /** Projects whose pages are loaded (green dot); the rest are hibernated or never opened. */
  live: string[];
  /** Approximate memory of each live project's page processes, in MB. */
  memory: Record<string, number>;
  /** Memory in MB: all of Gleeok's processes (pages included), and the machine's used / total. */
  memoryTotal: { gleeok: number; systemUsed: number; systemTotal: number };
  /** A tab is being dragged: pages are swapped for screenshots so whole panes can take the drop. */
  tabDragging: boolean;
  /** Running from a git checkout, so the palette can offer "update Gleeok". */
  canSelfUpdate: boolean;
  /** New commits upstream (subjects, newest first) and, while updating, the current step. */
  update: { commits: string[]; step?: string; error?: string };
  vault: {
    unlocked: boolean;
    email: string;
    serverUrl: string;
    /** While unlocked: saved logins without their passwords, so the palette can open their addresses. */
    entries: { id: string; name: string; username: string; urls: string[]; hasPassword: boolean }[];
  };
  /** Windows whose pages are swapped for screenshots because the command palette is open there. */
  paletteWindows: string[];
  state: GlobalState;
  platform: string;
  /** This machine's hostname: a terminal on a project's own machine needs no ssh. */
  hostname: string;
  server: { status: ServerStatus; url?: string; error?: string };
}

export type Action =
  | { type: 'selectProject'; id: string }
  | { type: 'selectProjectIndex'; index: number }
  | { type: 'selectProjectDelta'; delta: number }
  | { type: 'focusPane'; slot: number }
  | { type: 'focusPaneDelta'; delta: number }
  | { type: 'newTab'; slot?: number; url?: string }
  | { type: 'closeTab'; slot?: number; tabId?: string }
  | { type: 'activateTab'; slot: number; tabId: string }
  | { type: 'cycleTab'; delta: number }
  | { type: 'navigate'; slot: number; url: string; /** typed by pasting: remember it as a project link */ save?: boolean }
  | { type: 'openLink'; url: string; slot?: number; /** open beside the current page rather than replacing it */ newTab?: boolean }
  | { type: 'history'; slot?: number; op: 'back' | 'forward' | 'reload' }
  /** Main window: show its first `count` panes. */
  | { type: 'setVisiblePanes'; count: number }
  /** How many panes projects have, and their names. */
  | { type: 'setPanes'; names: string[] }
  /** The new-tab page's 常用 tiles; null goes back to the built-in list. */
  | { type: 'setSuggestions'; suggestions: Suggestion[] | null }
  /** Relative widths after dragging a divider (slot → weight); `cover` hides the pages while dragging. */
  | { type: 'setPaneWeights'; winId: string; weights: Record<number, number> }
  | { type: 'coverPages'; winId: string; active: boolean }
  | { type: 'toggleFocusExpand' }
  | { type: 'toggleSidebar' }
  | { type: 'setView'; view: View }
  /** The project's entry drawer (links and settings), over the current window's pages. */
  | { type: 'toggleEntry' }
  /** The 文献库 in place of the panes, and back. */
  | { type: 'toggleLibrary' }
  | { type: 'setLibrarySettings'; settings: Partial<LibrarySettings> }
  /** Read a 文献库 PDF in a pane (the given one, else the default reading pane). */
  | { type: 'openReader'; attachment: string; slot?: number }
  | { type: 'vaultUnlock' }
  | { type: 'focusAddress' }
  | { type: 'moveTab'; tabId: string; toSlot: number }
  | { type: 'reopenTab' }
  | { type: 'zoom'; delta: -1 | 0 | 1 }
  | { type: 'openFind'; slot?: number }
  | { type: 'find'; slot: number; text: string; forward?: boolean; findNext?: boolean }
  | { type: 'stopFind'; slot: number }
  | { type: 'showDownload'; id: string }
  | { type: 'projectMenu'; id: string }
  | { type: 'hibernate'; id: string }
  | { type: 'startProject'; id: string }
  | { type: 'archiveProject'; id: string; archived: boolean; open?: boolean }
  | { type: 'detachPane'; slot?: number }
  | { type: 'attachPane'; slot?: number }
  | { type: 'togglePaneWindow' }
  | { type: 'removeLink'; projectId: string; linkId: string }
  | { type: 'upsertLink'; projectId: string; link: Link; slot: number }
  | { type: 'openSaveLink'; slot?: number }
  | { type: 'tabDrag'; active: boolean }
  | { type: 'openPalette' }
  | { type: 'checkUpdate' }
  | { type: 'selfUpdate' }
  | { type: 'openUpdate' }
  | { type: 'adoptRemoteTabs'; projectId: string }
  | { type: 'restoreTabs'; projectId: string }
  | { type: 'vaultFill' }
  | { type: 'vaultFillItem'; itemId: string }
  | { type: 'vaultSaveDialog' }
  | { type: 'vaultLock' }
  | { type: 'vaultCopy'; id: string; what: 'url' | 'username' | 'password'; index?: number }
  | { type: 'closePalette'; winId: string }
  /** Open a project's code link (its primary one by default), reusing a tab already showing it. */
  | { type: 'openCode'; projectId?: string; linkId?: string }
  | { type: 'codeMenu'; projectId: string }
  | { type: 'setPrimaryCode'; projectId: string; linkId: string };

/** Commands main sends to the shell renderer for things only the DOM can do. */
export type Command =
  | { type: 'focusAddress'; slot: number }
  | { type: 'focusNewTab'; slot: number }
  | { type: 'openFind'; slot: number }
  | { type: 'findResult'; slot: number; active: number; total: number }
  | { type: 'toast'; slot: number; text: string; undo?: Action; /** label for the undo button */ undoLabel?: string; ms?: number }
  | { type: 'openSaveLink'; slot: number };

export type PaneRects = Record<number, Rect | null>;

export interface GleeokApi {
  getSnapshot(): Promise<Snapshot>;
  onSnapshot(cb: (s: Snapshot) => void): () => void;
  onCommand(cb: (c: Command) => void): () => void;
  /** Screenshots of this window's panes, keyed by slot, sent when pages are about to be hidden. */
  onDragImages(cb: (images: Record<number, string>) => void): () => void;
  /** The screenshots are painted (under the pages), so main can take the pages away without a blank frame. */
  pageImagesShown(winId: string): void;
  termAttach(tabId: string, url: string, cols: number, rows: number): Promise<{ buffer: string; end: number; error?: string }>;
  termInput(tabId: string, data: string): void;
  termResize(tabId: string, cols: number, rows: number): void;
  termFocus(focused: boolean): void;
  onTermEvent(cb: (e: { tabId: string; data?: string; end?: number; exit?: number }) => void): () => void;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): void;
  /** Main asks this window to show the command palette. */
  onPalette(cb: () => void): () => void;
  onVaultDialog(cb: (d: VaultDialog) => void): () => void;
  /** Main asks this window to show the update dialog. */
  onUpdateDialog(cb: () => void): () => void;
  /** Main asks this window to open (or, if open, close) the current project's entry drawer. */
  onEntryDrawer(cb: () => void): () => void;
  vaultUnlock(email: string, password: string, server?: string): Promise<{ error?: string }>;
  vaultSave(login: { name: string; url: string; username: string; password: string }): Promise<{ error?: string }>;
  dispatch(action: Action): void;
  reportPaneRects(winId: string, rects: PaneRects): void;
  createProject(name: string): Promise<Project>;
  saveProject(project: Project): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  refreshProjects(): Promise<void>;
  importPaseo(serverId: string, projectIds: string[]): Promise<Project[]>;
  getLibrary(): Promise<LibrarySnapshot>;
  onLibrary(cb: (lib: LibrarySnapshot) => void): () => void;
  library(op: LibraryOp): Promise<{ result?: unknown; error?: string }>;
  /** A dropped file's path on disk. */
  pathForFile(file: File): string;
  /** Remember a daemon's pairing link on this machine and read its projects through the relay. */
  pairPaseo(url: string): Promise<{ error?: string }>;
  unpairPaseo(serverId: string): Promise<void>;
  /** Set the code-server address projects from this daemon link into; '' goes back to detection. */
  setCodeServer(serverId: string, url: string): Promise<{ error?: string }>;
  /** Look for a code-server on the daemon's machine now; resolves to what was found. */
  detectCodeServer(serverId: string): Promise<{ url?: string | null; error?: string }>;
}
