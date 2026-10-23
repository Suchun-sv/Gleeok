import { useEffect, useRef, useState } from 'react';
import type { Command, Snapshot, VaultDialog as VaultDialogState } from '../../../shared/src/ipc.ts';
import { EntryDrawer } from './EntryDrawer.tsx';
import { SettingsPage } from './Settings.tsx';
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
  const [entryOpen, setEntryOpen] = useState(false);

  useEffect(() => {
    void gleeok.getSnapshot().then(setSnap);
    const offSnap = gleeok.onSnapshot(setSnap);
    let seq = 0;
    const offCmd = gleeok.onCommand((c) => setCommand({ ...c, seq: ++seq }));
    const offImages = gleeok.onDragImages((images) => {
      // Decode, paint beneath the pages, then tell main it may take the pages away.
      void Promise.all(
        Object.values(images).map((src) => {
          const img = new Image();
          img.src = src;
          return img.decode().catch(() => {});
        }),
      ).then(() => {
        setDragImages(images);
        requestAnimationFrame(() => requestAnimationFrame(() => gleeok.pageImagesShown(WIN_ID)));
      });
    });
    const offPalette = gleeok.onPalette(() => setPaletteOpen(true));
    const offVault = gleeok.onVaultDialog((d) => {
      setPaletteOpen(false);
      setVaultDialog(d);
    });
    const offUpdate = gleeok.onUpdateDialog(() => {
      setPaletteOpen(false);
      setVaultDialog(null);
      setEntryOpen(false);
      setUpdateOpen(true);
    });
    const offEntry = gleeok.onEntryDrawer(() => {
      setPaletteOpen(false);
      setEntryOpen((open) => {
        // Pressed again while open: close, and give the pages back.
        if (open) gleeok.dispatch({ type: 'closePalette', winId: WIN_ID });
        return !open;
      });
    });
    return () => {
      offEntry();
      offUpdate();
      offSnap();
      offCmd();
      offImages();
      offPalette();
      offVault();
    };
  }, []);

  // Screenshots are painted before main hides the pages, so they must go once the pages are
  // back (a little later, so the pages have repainted), or if the cover never came.
  const covered = !!snap && (snap.tabDragging || snap.paletteWindows.includes(WIN_ID));
  const wasCovered = useRef(false);
  useEffect(() => {
    if (covered) {
      wasCovered.current = true;
      return;
    }
    if (Object.keys(dragImages).length === 0) return;
    const t = setTimeout(() => setDragImages({}), wasCovered.current ? 150 : 1500);
    wasCovered.current = false;
    return () => clearTimeout(t);
  }, [covered, dragImages]);

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
  ) : entryOpen && project ? (
    <EntryDrawer
      key={project.id}
      project={project}
      snap={snap}
      onClose={() => {
        setEntryOpen(false);
        gleeok.dispatch({ type: 'closePalette', winId: WIN_ID });
      }}
    />
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
        {snap.state.view === 'settings' ? (
          <SettingsPage snap={snap} toggle={toggle} />
        ) : !project ? (
          <Empty snap={snap} toggle={toggle} />
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
