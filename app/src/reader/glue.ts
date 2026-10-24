/**
 * Starts Zotero's reader (app/vendor/zotero-reader, which defines `createReader`) on a 文献库
 * PDF, and keeps Gleeok informed: annotations and the reading position are saved through the
 * bridge from preload/page.ts, and annotations made on other devices arrive the same way.
 */

interface ZoteroReader {
  setAnnotations(annotations: unknown[]): void;
  unsetAnnotations(ids: string[]): void;
  setSelectedAnnotations(ids: string[]): void;
  /** Internal, but it is what the popup's own colour buttons call. */
  _annotationManager: { addAnnotation(annotation: Record<string, unknown>): { id: string } | null };
}

type Engine = 'deepl' | 'openai';
interface Translation {
  off?: boolean;
  text?: string;
  engine?: Engine;
  label?: string;
  engines: { id: Engine; label: string }[];
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
      translate(text: string, engine?: Engine): Promise<Translation>;
      onAnnotations(cb: (change: { set: unknown[]; unset: string[] }) => void): void;
    };
  }
}

const attachment = new URLSearchParams(location.search).get('attachment') ?? '';
const noop = () => {};
const message = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
let reader: ZoteroReader | undefined;

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
    return fail(`打不开这个 PDF：${message(e)}`);
  }
  document.title = data.title;
  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  reader = window.createReader({
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
    if (set.length) reader?.setAnnotations(set);
    if (unset.length) reader?.unsetAnnotations(unset);
  });
}

/*
 * 划词翻译: the reader's selection popup has a slot for plugins (Zotero's own translate plugin
 * uses it): it fires "renderTextSelectionPopup" each time it draws and takes what is appended
 * then. The translation comes from the sync server; asked once per passage (the popup redraws).
 */
const translations = new Map<string, Promise<Translation>>();

function translate(text: string, engine?: Engine) {
  const key = `${engine ?? ''}\n${text}`;
  let p = translations.get(key);
  if (!p) {
    p = window.gleeokReader.translate(text, engine);
    translations.set(key, p);
    p.catch(() => translations.delete(key));
  }
  return p;
}

const el = (tag: string, className: string, text = '') => {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
};

const button = (label: string, title: string, onClick: (b: HTMLButtonElement) => void) => {
  const b = el('button', 'gk-tr-btn', label) as HTMLButtonElement;
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(b);
  });
  return b;
};

async function fill(box: HTMLElement, annotation: Record<string, unknown>, text: string, engine?: Engine) {
  box.replaceChildren(el('div', 'gk-tr-wait', '翻译中…'));
  let r: Translation;
  try {
    r = await translate(text, engine);
  } catch (e) {
    box.replaceChildren(el('div', 'gk-tr-error', message(e)));
    return;
  }
  if (r.off || !r.text) {
    (box.closest('.section') ?? box).remove();
    return;
  }
  const translated = r.text;
  const bar = el('div', 'gk-tr-bar');
  bar.append(el('span', 'gk-tr-engine', r.label ?? ''));
  for (const other of r.engines.filter((e) => e.id !== r.engine)) {
    bar.append(button(`换 ${other.label}`, `用 ${other.label} 再翻译一次`, () => void fill(box, annotation, text, other.id)));
  }
  bar.append(
    button('复制', '复制译文', (b) => {
      void navigator.clipboard.writeText(translated).then(() => (b.textContent = '已复制'));
    }),
    button('存为批注', '高亮这段文字，译文写进批注的评论', () => {
      const added = reader?._annotationManager.addAnnotation({ ...annotation, color: '#ffd400', comment: translated });
      if (added) reader?.setSelectedAnnotations([added.id]);
    }),
  );
  box.replaceChildren(el('div', 'gk-tr-text', translated), bar);
}

window.addEventListener('customEvent', (e) => {
  const { type, append, params } = (e as CustomEvent<{ type: string; append: (...nodes: Node[]) => void; params: { annotation?: Record<string, unknown> } }>).detail;
  const annotation = params?.annotation;
  const text = typeof annotation?.text === 'string' ? annotation.text.trim() : '';
  if (type !== 'renderTextSelectionPopup' || !annotation || !text) return;
  const box = el('div', 'gk-tr');
  append(box);
  void fill(box, annotation, text);
});

const style = document.createElement('style');
style.textContent = `
  .selection-popup:has(.gk-tr) { max-width: none; }
  .gk-tr { width: min(300px, 80vw); padding: 2px 2px 0; font-size: 13px; line-height: 1.55; }
  .gk-tr-text { white-space: pre-wrap; max-height: 260px; overflow: auto; user-select: text; }
  .gk-tr-wait { opacity: 0.6; }
  .gk-tr-error { color: #e5484d; }
  .gk-tr-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 6px; }
  .gk-tr-engine { margin-right: auto; font-size: 11px; opacity: 0.6; }
  .gk-tr-btn { font: inherit; font-size: 12px; padding: 2px 8px; border-radius: 5px; border: 1px solid rgba(128, 128, 128, 0.35); background: transparent; color: inherit; cursor: pointer; }
  .gk-tr-btn:hover { background: rgba(128, 128, 128, 0.15); }
`;
document.head.append(style);

void start();

export {};
