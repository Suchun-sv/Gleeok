import type { GlobalState, LayoutMode, Link, PaseoDaemon, Project, Rect, View } from './model.ts';

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
  downloads: Download[];
  /** Projects whose pages are loaded (green dot); the rest are hibernated or never opened. */
  live: string[];
  /** Approximate memory of each live project's page processes, in MB. */
  memory: Record<string, number>;
  /** A tab is being dragged: pages are swapped for screenshots so whole panes can take the drop. */
  tabDragging: boolean;
  /** Running from a git checkout, so the palette can offer "update Gleeok". */
  canSelfUpdate: boolean;
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
  | { type: 'setLayoutMode'; mode: LayoutMode }
  | { type: 'toggleFocusExpand' }
  | { type: 'toggleSidebar' }
  | { type: 'setView'; view: View }
  | { type: 'toggleEntry' }
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
  | { type: 'adoptRemoteTabs'; projectId: string }
  | { type: 'restoreTabs'; projectId: string }
  | { type: 'vaultFill' }
  | { type: 'vaultFillItem'; itemId: string }
  | { type: 'vaultSaveDialog' }
  | { type: 'vaultLock' }
  | { type: 'vaultCopy'; id: string; what: 'url' | 'username' | 'password'; index?: number }
  | { type: 'closePalette'; winId: string };

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
  /** Main asks this window to show the command palette. */
  onPalette(cb: () => void): () => void;
  onVaultDialog(cb: (d: VaultDialog) => void): () => void;
  vaultUnlock(email: string, password: string, server?: string): Promise<{ error?: string }>;
  vaultSave(login: { name: string; url: string; username: string; password: string }): Promise<{ error?: string }>;
  dispatch(action: Action): void;
  reportPaneRects(winId: string, rects: PaneRects): void;
  createProject(name: string): Promise<Project>;
  saveProject(project: Project): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  refreshProjects(): Promise<void>;
  importPaseo(serverId: string, projectIds: string[]): Promise<Project[]>;
}
