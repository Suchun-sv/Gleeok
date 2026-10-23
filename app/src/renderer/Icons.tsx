/** Lucide glyphs (the icon set Paseo uses), drawn as muted icon buttons like Paseo's chrome. */
const paths = {
  columns2: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M12 3v18" />
    </>
  ),
  columns3: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="M15 3v18" />
    </>
  ),
  focus: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
    </>
  ),
  panelRight: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
    </>
  ),
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </>
  ),
};

export type IconName = keyof typeof paths;

export function IconButton({ icon, title, on, onClick, size = 15 }: { icon: IconName; title: string; on?: boolean; onClick: () => void; size?: number }) {
  return (
    <button className={`icon-btn ${on ? 'on' : ''}`} onClick={onClick} title={title} aria-pressed={on}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {paths[icon]}
      </svg>
    </button>
  );
}

/** Layout switches and the project-settings drawer, at the right end of the main window's last tab strip. */
export function LayoutControls({ mode, focusExpand, platform }: { mode: 'two' | 'three'; focusExpand: boolean; platform: string }) {
  const mod = platform === 'darwin' ? '⌘⌥' : 'Ctrl+Alt+';
  return (
    <>
      <IconButton icon="columns2" on={mode === 'two'} title={`二栏（${mod}Shift+2）`} onClick={() => gleeok.dispatch({ type: 'setLayoutMode', mode: 'two' })} />
      <IconButton icon="columns3" on={mode === 'three'} title={`三栏（${mod}Shift+3）`} onClick={() => gleeok.dispatch({ type: 'setLayoutMode', mode: 'three' })} />
      <IconButton
        icon="focus"
        on={focusExpand}
        title={`焦点放大：焦点所在的一栏更宽（${mod}F）`}
        onClick={() => gleeok.dispatch({ type: 'toggleFocusExpand' })}
      />
      <span className="trailing-sep" />
      <IconButton icon="panelRight" title={`项目设置：链接、代码、存档（${mod}E）`} onClick={() => gleeok.dispatch({ type: 'toggleEntry' })} />
    </>
  );
}
