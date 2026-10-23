import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Command, GleeokApi, Snapshot, VaultDialog } from '../../../shared/src/ipc.ts';

function subscribe<T>(channel: string, cb: (v: T) => void) {
  const handler = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, handler);
  return () => void ipcRenderer.off(channel, handler);
}

const api: GleeokApi = {
  getSnapshot: () => ipcRenderer.invoke('snapshot:get'),
  onSnapshot: (cb) => subscribe<Snapshot>('snapshot', cb),
  onCommand: (cb) => subscribe<Command>('command', cb),
  onDragImages: (cb) => subscribe<Record<number, string>>('drag-images', cb),
  onPalette: (cb) => subscribe<void>('palette', () => cb()),
  onVaultDialog: (cb) => subscribe<VaultDialog>('vault-dialog', cb),
  onUpdateDialog: (cb) => subscribe<void>('update-dialog', () => cb()),
  onEntryDrawer: (cb) => subscribe<void>('entry-drawer', () => cb()),
  vaultUnlock: (email, password, server) => ipcRenderer.invoke('vault:unlock', email, password, server),
  vaultSave: (login) => ipcRenderer.invoke('vault:save', login),
  dispatch: (action) => ipcRenderer.send('action', action),
  pageImagesShown: (winId) => ipcRenderer.send('page-images-shown', winId),
  reportPaneRects: (winId, rects) => ipcRenderer.send('pane-rects', winId, rects),
  createProject: (name) => ipcRenderer.invoke('project:create', name),
  saveProject: (project) => ipcRenderer.invoke('project:save', project),
  deleteProject: (id) => ipcRenderer.invoke('project:delete', id),
  refreshProjects: () => ipcRenderer.invoke('project:refresh'),
  importPaseo: (serverId, projectIds) => ipcRenderer.invoke('paseo:import', serverId, projectIds),
  pairPaseo: (url) => ipcRenderer.invoke('paseo:pair', url),
  unpairPaseo: (serverId) => ipcRenderer.invoke('paseo:unpair', serverId),
  setCodeServer: (serverId, url) => ipcRenderer.invoke('paseo:code-server', serverId, url),
  detectCodeServer: (serverId) => ipcRenderer.invoke('paseo:detect-code-server', serverId),
};

contextBridge.exposeInMainWorld('gleeok', api);
