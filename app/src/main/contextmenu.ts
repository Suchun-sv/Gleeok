import { Menu, clipboard, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { paneName } from '../../../shared/src/model.ts';

export interface MenuOps {
  /** Pane indices currently visible, and the one this page sits in. */
  slots: number[];
  slot: number;
  openTab(slot: number, url: string): void;
}

export function showContextMenu(wc: WebContents, p: ContextMenuParams, ops: MenuOps) {
  const items: MenuItemConstructorOptions[] = [];
  const sep = () => items.length && items[items.length - 1].type !== 'separator' && items.push({ type: 'separator' });

  if (p.linkURL) {
    items.push({ label: '在新标签页中打开链接', click: () => ops.openTab(ops.slot, p.linkURL) });
    for (const s of ops.slots) {
      if (s !== ops.slot) items.push({ label: `在${paneName(s)}打开链接`, click: () => ops.openTab(s, p.linkURL) });
    }
    items.push({ label: '复制链接地址', click: () => clipboard.writeText(p.linkURL) });
    sep();
  }

  if (p.mediaType === 'image' && p.srcURL) {
    items.push(
      { label: '在新标签页中打开图片', click: () => ops.openTab(ops.slot, p.srcURL) },
      { label: '复制图片', click: () => wc.copyImageAt(p.x, p.y) },
      { label: '复制图片地址', click: () => clipboard.writeText(p.srcURL) },
    );
    sep();
  }

  if (p.isEditable) {
    if (p.misspelledWord && p.dictionarySuggestions.length) {
      for (const s of p.dictionarySuggestions.slice(0, 4)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
      sep();
    }
    items.push(
      { label: '撤销', role: 'undo', enabled: p.editFlags.canUndo },
      { label: '重做', role: 'redo', enabled: p.editFlags.canRedo },
      { type: 'separator' },
      { label: '剪切', role: 'cut', enabled: p.editFlags.canCut },
      { label: '复制', role: 'copy', enabled: p.editFlags.canCopy },
      { label: '粘贴', role: 'paste', enabled: p.editFlags.canPaste },
      { label: '粘贴为纯文本', role: 'pasteAndMatchStyle', enabled: p.editFlags.canPaste },
      { label: '全选', role: 'selectAll' },
    );
    sep();
  } else if (p.selectionText.trim()) {
    const text = p.selectionText.trim();
    items.push(
      { label: '复制', role: 'copy' },
      {
        label: `搜索“${text.length > 20 ? `${text.slice(0, 20)}…` : text}”`,
        click: () => ops.openTab(ops.slot, `https://www.google.com/search?q=${encodeURIComponent(text)}`),
      },
    );
    sep();
  }

  if (!p.linkURL && !p.isEditable && !p.selectionText.trim()) {
    const nav = wc.navigationHistory;
    items.push(
      { label: '后退', enabled: nav.canGoBack(), click: () => nav.goBack() },
      { label: '前进', enabled: nav.canGoForward(), click: () => nav.goForward() },
      { label: '重新加载', click: () => wc.reload() },
      { label: '复制页面地址', click: () => clipboard.writeText(wc.getURL()) },
    );
    sep();
  }

  items.push({ label: '检查元素', click: () => wc.inspectElement(p.x, p.y) });
  Menu.buildFromTemplate(items).popup();
}
