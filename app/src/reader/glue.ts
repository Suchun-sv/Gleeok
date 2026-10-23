/**
 * Starts Zotero's reader (app/vendor/zotero-reader, which defines `createReader`) on a 文献库
 * PDF, and keeps Gleeok informed: annotations and the reading position are saved through the
 * bridge from preload/page.ts, and annotations made on other devices arrive the same way.
 */

interface ZoteroReader {
  setAnnotations(annotations: unknown[]): void;
  unsetAnnotations(ids: string[]): void;
}

interface Opened {
  buf: Uint8Array;
  annotations: unknown[];
  state: unknown;
  colorScheme: 'dark' | 'light' | null;
  title: string;
  authorName: string;
  ftl: string[];
}

declare global {
  interface Window {
    createReader(options: Record<string, unknown>): ZoteroReader;
    gleeokReader: {
      open(attachment: string): Promise<Opened>;
      saveAnnotations(attachment: string, annotations: unknown[]): Promise<void>;
      deleteAnnotations(attachment: string, ids: string[]): Promise<void>;
      saveState(attachment: string, state: unknown): Promise<void>;
      openLink(url: string): void;
      onAnnotations(cb: (change: { set: unknown[]; unset: string[] }) => void): void;
    };
  }
}

const attachment = new URLSearchParams(location.search).get('attachment') ?? '';
const noop = () => {};

function fail(message: string) {
  document.body.innerHTML = '';
  const p = document.createElement('p');
  p.style.cssText = 'margin: 40px; font: 14px system-ui; color: #d9dce3';
  p.textContent = message;
  document.body.append(p);
  document.body.style.background = '#16171b';
}

async function start() {
  let data: Opened;
  try {
    data = await window.gleeokReader.open(attachment);
  } catch (e) {
    return fail(`打不开这个 PDF：${String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
  }
  document.title = data.title;
  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  const reader = window.createReader({
    type: 'pdf',
    data: { buf: data.buf, url: location.href },
    annotations: data.annotations,
    primaryViewState: data.state ?? undefined,
    sidebarWidth: 240,
    // A narrow pane keeps the page; the sidebar button brings the annotations back.
    sidebarOpen: window.innerWidth > 800,
    sidebarView: 'annotations',
    showAnnotations: true,
    colorScheme: data.colorScheme ?? undefined,
    readOnly: false,
    title: data.title,
    authorName: data.authorName,
    ftl: data.ftl,
    onSaveAnnotations: (annotations: unknown[]) => void window.gleeokReader.saveAnnotations(attachment, annotations),
    onDeleteAnnotations: (ids: string[]) => void window.gleeokReader.deleteAnnotations(attachment, ids),
    onChangeViewState: (state: unknown, primary: boolean) => {
      if (!primary) return;
      clearTimeout(stateTimer);
      stateTimer = setTimeout(() => void window.gleeokReader.saveState(attachment, state), 1500);
    },
    onOpenLink: (url: string) => window.gleeokReader.openLink(url),
    // Dragging or copying annotations out: their text (and comments).
    onSetDataTransferAnnotations: (dataTransfer: DataTransfer, annotations: { text?: string; comment?: string }[]) => {
      dataTransfer.setData('text/plain', annotations.map((a) => [a.text, a.comment].filter(Boolean).join('\n')).join('\n\n'));
    },
    onConfirm: (_title: string, text: string) => window.confirm(text),
    onOpenTagsPopup: noop,
    onClosePopup: noop,
    onToggleSidebar: noop,
    onChangeSidebarWidth: noop,
    onChangeSidebarView: noop,
    onAddToNote: noop,
    onRotatePages: noop,
    onDeletePages: noop,
    onToggleContextPane: noop,
    onTextSelectionAnnotationModeChange: noop,
    onSaveCustomThemes: noop,
    onSetReadAloudVoice: noop,
    onSetReadAloudStatus: noop,
    onBringReaderToFront: noop,
  });
  window.gleeokReader.onAnnotations(({ set, unset }) => {
    if (set.length) reader.setAnnotations(set);
    if (unset.length) reader.unsetAnnotations(unset);
  });
}

void start();

export {};
