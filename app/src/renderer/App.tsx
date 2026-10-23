import { useEffect, useState } from 'react';
import type { Command, Snapshot, VaultDialog as VaultDialogState } from '../../../shared/src/ipc.ts';
import { EntryPage } from './EntryPage.tsx';
import { ImportPage } from './ImportPage.tsx';
import { Palette } from './Palette.tsx';
import { UpdateDialog } from './UpdateDialog.tsx';
import { VaultDialog } from './VaultDialog.tsx';
import { Panes } from './Panes.tsx';
import { LayoutControls } from './Icons.tsx';
import { Sidebar, SidebarToggle } from './Sidebar.tsx';

/** Which window this renderer belongs to: 'main' or a satellite id (from ?win=). */
const WIN_ID = new URLSearchParams(location.search).get('win') ?? 'main';

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [command, setCommand] = useState<(Command & { seq: number }) | null>(null);
  const [dragImages, setDragImages] = useState<Record<number, string>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [vaultDialog, setVaultDialog] = useState<VaultDialogState | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);

  useEffect(() => {
    void gleeok.getSnapshot().then(setSnap);
    const offSnap = gleeok.onSnapshot(setSnap);
    let seq = 0;
    const offCmd = gleeok.onCommand((c) => setCommand({ ...c, seq: ++seq }));
    const offImages = gleeok.onDragImages(setDragImages);
    const offPalette = gleeok.onPalette(() => setPaletteOpen(true));
    const offVault = gleeok.onVaultDialog((d) => {
      setPaletteOpen(false);
      setVaultDialog(d);
    });
    const offUpdate = gleeok.onUpdateDialog(() => {
      setPaletteOpen(false);
      setVaultDialog(null);
      setUpdateOpen(true);
    });
    return () => {
      offUpdate();
      offSnap();
      offCmd();
      offImages();
      offPalette();
      offVault();
    };
  }, []);

  if (!snap) return null;
  const project = snap.projects.find((p) => p.id === snap.state.currentProjectId) ?? null;
  const session = project ? snap.state.sessions[project.id] : undefined;
  const win = snap.state.windows.find((w) => w.id === WIN_ID);
  if (!win) return null;
  const palette = vaultDialog ? (
    <VaultDialog
      key={JSON.stringify(vaultDialog).length}
      dialog={vaultDialog}
      winId={WIN_ID}
      serverUrl={snap.vault.serverUrl}
      onClose={() => setVaultDialog(null)}
    />
  ) : updateOpen ? (
    <UpdateDialog update={snap.update} winId={WIN_ID} onClose={() => setUpdateOpen(false)} />
  ) : paletteOpen ? (
    <Palette snap={snap} winId={WIN_ID} onClose={() => setPaletteOpen(false)} />
  ) : null;

  if (win.role === 'satellite') {
    return (
      <div className="app">
        <main>
          {project && session ? (
            <Panes
              snap={snap}
              project={project}
              session={session}
              command={command}
              win={win}
              dragImages={dragImages}
              leading={<span className="sat-project">{project.name}</span>}
            />
          ) : (
            <div className="empty">
              <p>主窗口里还没有选中项目</p>
            </div>
          )}
        </main>
        {palette}
      </div>
    );
  }

  const collapsed = !!win.sidebarCollapsed;
  const toggle = collapsed ? <SidebarToggle platform={snap.platform} /> : null;

  return (
    <div className="app">
      {!collapsed && <Sidebar snap={snap} />}
      <main>
        {snap.state.view === 'import' ? (
          <ImportPage snap={snap} toggle={toggle} />
        ) : !project ? (
          <Empty snap={snap} toggle={toggle} />
        ) : snap.state.view === 'entry' ? (
          <EntryPage key={project.id} project={project} toggle={toggle} />
        ) : session ? (
          <Panes
            snap={snap}
            project={project}
            session={session}
            command={command}
            win={win}
            dragImages={dragImages}
            leading={toggle}
            trailing={<LayoutControls mode={win.layout.mode} focusExpand={win.layout.focusExpand} platform={snap.platform} />}
          />
        ) : null}
      </main>
      {palette}
    </div>
  );
}

function Empty({ snap, toggle }: { snap: Snapshot; toggle: React.ReactNode }) {
  return (
    <div className="empty">
      {toggle && <div className="corner-toggle">{toggle}</div>}
      {snap.server.status === 'unconfigured' ? (
        <p>
          还没有配置服务器：{snap.server.error}
          <br />
          内容形如 <code>{'{ "serverUrl": "http://<你的服务器>:7420", "token": "..." }'}</code>
        </p>
      ) : (
        <p>在左侧新建或选择一个项目</p>
      )}
    </div>
  );
}
