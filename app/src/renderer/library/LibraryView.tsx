import { useEffect, useMemo, useRef, useState } from 'react';
import type { LibrarySnapshot } from '../../../../shared/src/ipc.ts';
import type { LibraryCollection, LibraryItem } from '../../../../shared/src/library.ts';
import { ITEM_TYPES, READ_STATUS_LABELS } from '../../../../shared/src/library-schema.ts';
import { LIBRARY_URL } from '../../../../shared/src/model.ts';
import { ItemPane } from './ItemPane.tsx';
import {
  childrenOf,
  collectionAndBelow,
  collectionTree,
  creatorsShort,
  isRegular,
  lib,
  matches,
  publicationOf,
  useLibrary,
  yearOf,
  type CollectionNode,
} from './data.ts';

type Source = { kind: 'all' | 'recent' | 'read' | 'unfiled' | 'trash' } | { kind: 'collection'; key: string };
type SortCol = 'title' | 'creator' | 'year' | 'publication' | 'added' | 'status';
type MenuItem = { label: string; run: () => void; danger?: boolean; disabled?: boolean } | 'sep';

const ITEMS_MIME = 'application/x-gleeok-items';
const COLLECTION_MIME = 'application/x-gleeok-collection';
const RECENT_DAYS = 30;

/** Below this width the collections and details columns fold away. */
const COMPACT_WIDTH = 900;

const loadPref = <T,>(name: string, fallback: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(`gleeok.library.${name}`) ?? 'null') as T) ?? fallback;
  } catch {
    return fallback;
  }
};
const savePref = (name: string, value: unknown) => localStorage.setItem(`gleeok.library.${name}`, JSON.stringify(value));

const DEFAULT_WIDTHS = { creator: 150, year: 56, publication: 170, added: 96, status: 56 };

/**
 * The 文献库: collections | items | details, like Zotero. `mode` is 'full' in place of the panes,
 * or 'pane' inside a tab, where narrow widths fold the side columns away.
 */
export function LibraryView({ mode, slot, platform }: { mode: 'full' | 'pane'; slot?: number; platform: string }) {
  const snap = useLibrary();
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [source, setSource] = useState<Source>(() => loadPref('source', { kind: 'all' }));
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [sort, setSort] = useState<{ col: SortCol; desc: boolean }>(() => loadPref('sort', { col: 'added', desc: true }));
  const [widths, setWidths] = useState(() => ({ ...DEFAULT_WIDTHS, ...loadPref('widths', {}) }));
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showCollections, setShowCollections] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    if (root.current) ro.observe(root.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => savePref('source', source), [source]);
  useEffect(() => savePref('sort', sort), [sort]);
  useEffect(() => savePref('widths', widths), [widths]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const onError = (e: unknown) => setError(String((e as Error).message ?? e));
  const compact = width < COMPACT_WIDTH;

  const rows = useMemo(() => (snap ? listItems(snap, source, query, tagFilter, sort) : []), [snap, source, query, tagFilter, sort]);
  const selectedItems = rows.filter((i) => selected.includes(i.key));
  const detail = selectedItems.length === 1 ? selectedItems[0] : null;
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of snap?.items ?? []) if (isRegular(i) && !i.deleted) for (const t of i.tags ?? []) counts.set(t.tag, (counts.get(t.tag) ?? 0) + 1);
    return [...counts].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
  }, [snap]);

  if (!snap) return <div className="library loading">正在打开文献库…</div>;

  const collections = snap.collections;
  const inTrash = source.kind === 'trash';
  const currentCollection = source.kind === 'collection' ? source.key : undefined;

  // ---- actions ----
  const run = (p: Promise<unknown>) => void p.then(() => setError(''), onError);
  const patchItems = (keys: string[], fields: (i: LibraryItem) => Record<string, unknown>) =>
    run(Promise.all(keys.map((k) => snap.items.find((i) => i.key === k)).filter(Boolean).map((i) => lib({ op: 'patch', kind: 'items', key: i!.key, fields: fields(i!) }))));
  const addToCollection = (keys: string[], col: string) =>
    patchItems(keys, (i) => ({ collections: [...new Set([...(i.collections ?? []), col])] }));
  const removeFromCollection = (keys: string[], col: string) => patchItems(keys, (i) => ({ collections: (i.collections ?? []).filter((c) => c !== col) }));
  const trash = (keys: string[]) => {
    patchItems(keys, () => ({ deleted: true }));
    setSelected([]);
  };
  const restore = (keys: string[]) => patchItems(keys, () => ({ deleted: null }));
  const destroy = (keys: string[]) => {
    if (!confirm(keys.length === 1 ? '彻底删除这一项（连同笔记、附件和批注）？' : `彻底删除这 ${keys.length} 项？`)) return;
    run(Promise.all(keys.map((k) => lib({ op: 'remove', kind: 'items', key: k }))));
    setSelected([]);
  };
  const newItem = (itemType: string) =>
    run(
      lib<LibraryItem[]>({
        op: 'create',
        kind: 'items',
        objects: [{ itemType, title: '', creators: [], ...(currentCollection ? { collections: [currentCollection] } : {}) }],
      }).then(([i]) => {
        if (inTrash) setSource({ kind: 'all' });
        setSelected([i.key]);
        setShowDetails(true);
      }),
    );
  const newCollection = (parent: string | false) =>
    run(
      lib<LibraryCollection[]>({ op: 'create', kind: 'collections', objects: [{ name: '新分类', parentCollection: parent }] }).then(([c]) => {
        setSource({ kind: 'collection', key: c.key });
        setRenaming(c.key);
      }),
    );
  const open = (item: LibraryItem) => {
    const pdf = item.itemType === 'attachment' ? item : childrenOf(snap, item.key, 'attachment').find((a) => a.fileHash);
    if (!pdf) return setError('这一项没有 PDF 附件');
    gleeok.dispatch({ type: 'openReader', attachment: pdf.key, slot });
  };
  const addPdfs = (files: FileList) => {
    const paths = [...files].filter((f) => /\.pdf$/i.test(f.name)).map((f) => gleeok.pathForFile(f));
    if (paths.length === 0) return setError('只能拖入 PDF 文件');
    run(lib({ op: 'addFiles', paths, collection: currentCollection }));
  };

  // ---- selection ----
  const click = (e: React.MouseEvent, key: string) => {
    if (e.shiftKey && anchor) {
      const keys = rows.map((r) => r.key);
      const [a, b] = [keys.indexOf(anchor), keys.indexOf(key)].sort((x, y) => x - y);
      setSelected(keys.slice(a, b + 1));
    } else if (e.metaKey || e.ctrlKey) {
      setSelected(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
      setAnchor(key);
    } else {
      setSelected([key]);
      setAnchor(key);
    }
  };
  const onListKey = (e: React.KeyboardEvent) => {
    const keys = rows.map((r) => r.key);
    const at = keys.indexOf(selected[selected.length - 1] ?? '');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = keys[Math.min(keys.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (!next) return;
      setSelected(e.shiftKey ? [...new Set([...selected, next])] : [next]);
      setAnchor(next);
      list.current?.querySelector(`[data-key="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter' && detail) open(detail);
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) (inTrash ? destroy(selected) : trash(selected));
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault();
      setSelected(keys);
    }
  };
  const onRootKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      search.current?.focus();
    }
  };

  const itemMenu = (e: React.MouseEvent, item: LibraryItem) => {
    e.preventDefault();
    const keys = selected.includes(item.key) ? selected : [item.key];
    if (!selected.includes(item.key)) setSelected([item.key]);
    const items: MenuItem[] = inTrash
      ? [
          { label: '恢复', run: () => restore(keys) },
          { label: '彻底删除', run: () => destroy(keys), danger: true },
        ]
      : [
          { label: '打开 PDF', run: () => open(item), disabled: keys.length > 1 || !childrenOf(snap, item.key, 'attachment').some((a) => a.fileHash) },
          { label: '添加 PDF 附件…', run: () => run(lib({ op: 'pickFiles', parentItem: item.key })), disabled: keys.length > 1 },
          'sep',
          ...collections
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
            .map((c) => ({ label: `加入分类：${c.name}`, run: () => addToCollection(keys, c.key) })),
          ...(currentCollection ? [{ label: '移出当前分类', run: () => removeFromCollection(keys, currentCollection) }] : []),
          'sep',
          { label: '复制标题', run: () => void navigator.clipboard.writeText(keys.map((k) => String(snap.items.find((i) => i.key === k)?.title ?? '')).join('\n')) },
          ...(item.DOI ? [{ label: '复制 DOI', run: () => void navigator.clipboard.writeText(String(item.DOI)) }] : []),
          'sep',
          { label: keys.length > 1 ? `移到回收站（${keys.length} 项）` : '移到回收站', run: () => trash(keys), danger: true },
        ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const collectionMenu = (e: React.MouseEvent, c: LibraryCollection) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: '新建子分类', run: () => newCollection(c.key) },
        { label: '重命名', run: () => setRenaming(c.key) },
        'sep',
        {
          label: '删除分类（条目保留）',
          danger: true,
          run: () => {
            if (!confirm(`删除分类「${c.name}」和它的子分类？里面的条目不会被删除。`)) return;
            if (source.kind === 'collection' && collectionAndBelow(collections, c.key).has(source.key)) setSource({ kind: 'all' });
            run(lib({ op: 'remove', kind: 'collections', key: c.key }));
          },
        },
      ],
    });
  };

  // ---- drag and drop onto collections ----
  const dropProps = (target: string | false) => ({
    onDragOver: (e: React.DragEvent) => {
      const t = e.dataTransfer.types;
      if (t.includes(ITEMS_MIME) || t.includes(COLLECTION_MIME) || t.includes('Files')) {
        e.preventDefault();
        setDropTarget(target || 'root');
      }
    },
    onDragLeave: () => setDropTarget(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropTarget(null);
      const items = e.dataTransfer.getData(ITEMS_MIME);
      const col = e.dataTransfer.getData(COLLECTION_MIME);
      if (items && target) addToCollection(JSON.parse(items) as string[], target);
      else if (col && col !== target && !(target && collectionAndBelow(collections, col).has(target)))
        run(lib({ op: 'patch', kind: 'collections', key: col, fields: { parentCollection: target } }));
      else if (e.dataTransfer.files.length) {
        const paths = [...e.dataTransfer.files].filter((f) => /\.pdf$/i.test(f.name)).map((f) => gleeok.pathForFile(f));
        if (paths.length) run(lib({ op: 'addFiles', paths, collection: target || undefined }));
      }
    },
  });

  const sourceButton = (s: Source, icon: string, label: string, count?: number) => (
    <button
      className={`lib-source ${sameSource(source, s) ? 'on' : ''}`}
      onClick={() => {
        setSource(s);
        setSelected([]);
        setShowCollections(false);
      }}
    >
      <span className="lib-source-icon">{icon}</span>
      <span className="lib-source-name">{label}</span>
      {count !== undefined && <span className="lib-count">{count}</span>}
    </button>
  );

  const renderNode = (n: CollectionNode, depth: number): React.ReactNode => {
    const c = n.collection;
    const on = source.kind === 'collection' && source.key === c.key;
    return (
      <div key={c.key}>
        <div
          className={`lib-source collection ${on ? 'on' : ''} ${dropTarget === c.key ? 'drop' : ''}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          draggable={renaming !== c.key}
          onDragStart={(e) => e.dataTransfer.setData(COLLECTION_MIME, c.key)}
          onClick={() => {
            setSource({ kind: 'collection', key: c.key });
            setSelected([]);
            setShowCollections(false);
          }}
          onContextMenu={(e) => collectionMenu(e, c)}
          onDoubleClick={() => setRenaming(c.key)}
          {...dropProps(c.key)}
        >
          <span className="lib-source-icon">📁</span>
          {renaming === c.key ? (
            <input
              className="lib-rename"
              autoFocus
              defaultValue={c.name}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setRenaming(null);
              }}
              onBlur={(e) => {
                const name = e.currentTarget.value.trim();
                setRenaming(null);
                if (name && name !== c.name) run(lib({ op: 'patch', kind: 'collections', key: c.key, fields: { name } }));
              }}
            />
          ) : (
            <span className="lib-source-name">{c.name}</span>
          )}
        </div>
        {n.children.map((ch) => renderNode(ch, depth + 1))}
      </div>
    );
  };

  const regular = snap.items.filter(isRegular);
  const live = regular.filter((i) => !i.deleted);
  const sidebar = (
    <aside className="lib-sources">
      <div {...dropProps(false)} className={dropTarget === 'root' ? 'drop' : ''}>
        {sourceButton({ kind: 'all' }, '📚', '我的文献库', live.length)}
      </div>
      {sourceButton({ kind: 'recent' }, '🕘', '最近添加')}
      {sourceButton({ kind: 'read' }, '📖', '最近阅读')}
      {sourceButton({ kind: 'unfiled' }, '📄', '未分类')}
      {sourceButton({ kind: 'trash' }, '🗑', '回收站', regular.length - live.length || undefined)}
      <div className="lib-sep">
        分类
        <button className="icon-btn" title="新建分类" onClick={() => newCollection(false)}>
          +
        </button>
      </div>
      <div className="lib-tree">{collectionTree(collections).map((n) => renderNode(n, 0))}</div>
      {allTags.length > 0 && (
        <div className="lib-tag-filter">
          {allTags.map(([tag, n]) => (
            <button
              key={tag}
              className={tagFilter.includes(tag) ? 'on' : ''}
              onClick={() => setTagFilter(tagFilter.includes(tag) ? tagFilter.filter((t) => t !== tag) : [...tagFilter, tag])}
              onDragOver={(e) => e.dataTransfer.types.includes(ITEMS_MIME) && e.preventDefault()}
              onDrop={(e) => {
                const keys = JSON.parse(e.dataTransfer.getData(ITEMS_MIME) || '[]') as string[];
                patchItems(keys, (i) => ({ tags: (i.tags ?? []).some((t) => t.tag === tag) ? i.tags : [...(i.tags ?? []), { tag }] }));
              }}
              title={`${n} 项；把条目拖到这里加上这个标签`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
    </aside>
  );

  const sourceTitle =
    source.kind === 'collection'
      ? (collections.find((c) => c.key === source.key)?.name ?? '分类')
      : { all: '我的文献库', recent: '最近添加', read: '最近阅读', unfiled: '未分类', trash: '回收站' }[source.kind];

  const header = (col: SortCol, label: string, resizable = true) => (
    <div
      className={`lib-th ${col}`}
      style={col === 'title' ? undefined : { width: widths[col as keyof typeof widths] }}
      onClick={() => setSort(sort.col === col ? { col, desc: !sort.desc } : { col, desc: col === 'added' || col === 'year' })}
    >
      {label}
      {sort.col === col && <span className="lib-sort">{sort.desc ? '▾' : '▴'}</span>}
      {resizable && col !== 'title' && (
        <span
          className="lib-col-resize"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const start = e.clientX;
            const w0 = widths[col as keyof typeof widths];
            const el = e.currentTarget;
            el.setPointerCapture(e.pointerId);
            const move = (ev: PointerEvent) => setWidths((w) => ({ ...w, [col]: Math.max(40, w0 - (ev.clientX - start)) }));
            const up = () => {
              el.removeEventListener('pointermove', move);
              el.removeEventListener('pointerup', up);
            };
            el.addEventListener('pointermove', move);
            el.addEventListener('pointerup', up);
          }}
        />
      )}
    </div>
  );

  const showPub = !compact || width > 640;
  const itemsColumn = (
    <section className="lib-items" onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()} onDrop={(e) => e.dataTransfer.files.length && (e.preventDefault(), addPdfs(e.dataTransfer.files))}>
      <div className="lib-toolbar">
        {compact && (
          <button className="lib-toggle" onClick={() => setShowCollections(!showCollections)} title="分类">
            ☰ {sourceTitle}
          </button>
        )}
        <input ref={search} className="lib-search" placeholder="搜索标题、作者、年份、标签、笔记" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
        {inTrash ? (
          <button
            className="danger"
            disabled={rows.length === 0}
            onClick={() => confirm(`清空回收站（${rows.length} 项）？`) && run(Promise.all(rows.map((i) => lib({ op: 'remove', kind: 'items', key: i.key }))))}
          >
            清空回收站
          </button>
        ) : (
          <>
            <button onClick={() => run(lib({ op: 'pickFiles', collection: currentCollection }))} title="选择 PDF 文件加进文献库（也可以直接把 PDF 拖进来）">
              添加 PDF
            </button>
            <button
              className="primary"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ x: r.left, y: r.bottom + 4, items: ITEM_TYPES.map((t) => ({ label: t.label, run: () => newItem(t.type) })) });
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              + 新建
            </button>
          </>
        )}
        {mode === 'full' && (
          <button onClick={() => gleeok.dispatch({ type: 'newTab', url: LIBRARY_URL })} title="在焦点所在的那一栏打开文献库">
            在栏中打开
          </button>
        )}
      </div>
      <div className="lib-table-head">
        {header('title', '标题', false)}
        {header('creator', '作者')}
        {header('year', '年份')}
        {showPub && header('publication', '期刊 / 会议')}
        {!compact && header('added', '添加时间')}
        {!compact && header('status', '状态')}
        <div className="lib-th attach" />
      </div>
      <div ref={list} className="lib-table" tabIndex={0} onKeyDown={onListKey}>
        {rows.length === 0 && (
          <p className="lib-empty">
            {inTrash ? '回收站是空的' : query || tagFilter.length ? '没有匹配的条目' : '这里还没有文献：点「+ 新建」，或者把 PDF 拖进来'}
          </p>
        )}
        {rows.map((i) => {
          const pdf = childrenOf(snap, i.key, 'attachment').some((a) => a.fileHash);
          const notes = childrenOf(snap, i.key, 'note').length;
          return (
            <div
              key={i.key}
              data-key={i.key}
              className={`lib-tr ${selected.includes(i.key) ? 'on' : ''}`}
              draggable
              onDragStart={(e) => {
                const keys = selected.includes(i.key) ? selected : [i.key];
                e.dataTransfer.setData(ITEMS_MIME, JSON.stringify(keys));
                e.dataTransfer.effectAllowed = 'copyLink';
              }}
              onClick={(e) => click(e, i.key)}
              onDoubleClick={() => (inTrash ? undefined : pdf ? open(i) : setShowDetails(true))}
              onContextMenu={(e) => itemMenu(e, i)}
            >
              <div className="lib-td title">{String(i.title || '') || <span className="meta">（无标题）</span>}</div>
              <div className="lib-td" style={{ width: widths.creator }}>
                {creatorsShort(i)}
              </div>
              <div className="lib-td" style={{ width: widths.year }}>
                {yearOf(i)}
              </div>
              {showPub && (
                <div className="lib-td" style={{ width: widths.publication }}>
                  {publicationOf(i)}
                </div>
              )}
              {!compact && (
                <div className="lib-td" style={{ width: widths.added }}>
                  {new Date(i.dateAdded).toLocaleDateString('zh-CN')}
                </div>
              )}
              {!compact && (
                <div className={`lib-td status ${String(i.readStatus ?? 'unread')}`} style={{ width: widths.status }}>
                  {READ_STATUS_LABELS[String(i.readStatus ?? 'unread')]}
                </div>
              )}
              <div className="lib-td attach" title={[pdf && 'PDF', notes && `${notes} 条笔记`].filter(Boolean).join('，')}>
                {pdf ? '📄' : ''}
                {notes ? '📝' : ''}
              </div>
            </div>
          );
        })}
      </div>
      <div className="lib-status">
        {rows.length} 项{selected.length > 1 ? ` · 已选 ${selected.length} 项` : ''}
        {snap.status === 'offline' && <span className="warn"> · 离线：显示的是本机缓存，修改暂时无法保存</span>}
        {snap.status === 'unavailable' && <span className="warn"> · {snap.error ?? '文献库不可用'}</span>}
        {error && (
          <span className="warn">
            {' '}
            · {error}{' '}
            <button className="lib-link" onClick={() => setError('')}>
              知道了
            </button>
          </span>
        )}
        {compact && detail && (
          <button className="lib-link" onClick={() => setShowDetails(true)}>
            查看详情
          </button>
        )}
      </div>
    </section>
  );

  const details = detail ? (
    <ItemPane snap={snap} item={detail} onOpen={(a) => open(a)} onError={onError} />
  ) : selected.length > 1 ? (
    <div className="lib-multi">
      <p>已选 {selected.length} 项</p>
      {inTrash ? (
        <>
          <button onClick={() => restore(selected)}>全部恢复</button>
          <button className="danger" onClick={() => destroy(selected)}>
            彻底删除
          </button>
        </>
      ) : (
        <button className="danger" onClick={() => trash(selected)}>
          移到回收站
        </button>
      )}
      <p className="hint">把它们拖到左边的分类或标签上，就能一次加入分类或打上标签。</p>
    </div>
  ) : (
    <div className="lib-multi">
      <p className="hint">选中一项查看和编辑它的信息、笔记和附件。</p>
      <p className="hint">快捷键：↑↓ 选择，回车打开 PDF，Delete 移到回收站，{platform === 'darwin' ? '⌘' : 'Ctrl+'}F 搜索。</p>
    </div>
  );

  return (
    <div ref={root} className={`library ${mode} ${compact ? 'compact' : ''}`} onKeyDown={onRootKey}>
      {(!compact || showCollections) && <div className={compact ? 'lib-drawer left' : 'lib-col-left'}>{sidebar}</div>}
      {itemsColumn}
      {!compact && <div className="lib-col-right">{details}</div>}
      {compact && showDetails && detail && (
        <div className="lib-drawer right">
          <button className="lib-drawer-close icon-btn" onClick={() => setShowDetails(false)} title="收起">
            ×
          </button>
          {details}
        </div>
      )}
      {compact && (showCollections || (showDetails && detail)) && (
        <div
          className="lib-scrim"
          onClick={() => {
            setShowCollections(false);
            setShowDetails(false);
          }}
        />
      )}
      {menu && (
        <div className="lib-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          {menu.items.map((m, i) =>
            m === 'sep' ? (
              <div key={i} className="lib-menu-sep" />
            ) : (
              <button
                key={i}
                className={m.danger ? 'danger' : ''}
                disabled={m.disabled}
                onClick={() => {
                  setMenu(null);
                  m.run();
                }}
              >
                {m.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

const sameSource = (a: Source, b: Source) => a.kind === b.kind && (a.kind !== 'collection' || (b.kind === 'collection' && a.key === b.key));

function listItems(snap: LibrarySnapshot, source: Source, query: string, tags: string[], sort: { col: SortCol; desc: boolean }): LibraryItem[] {
  const now = Date.now();
  let items = snap.items.filter((i) => isRegular(i) && (source.kind === 'trash' ? i.deleted : !i.deleted));
  if (source.kind === 'collection') {
    const keys = collectionAndBelow(snap.collections, source.key);
    items = items.filter((i) => (i.collections ?? []).some((c) => keys.has(c)));
  }
  if (source.kind === 'unfiled') items = items.filter((i) => !(i.collections ?? []).length);
  if (source.kind === 'recent') items = items.filter((i) => now - Date.parse(i.dateAdded) < RECENT_DAYS * 86_400_000);
  if (source.kind === 'read') items = items.filter((i) => typeof i.lastReadAt === 'string');
  if (tags.length) items = items.filter((i) => tags.every((t) => (i.tags ?? []).some((x) => x.tag === t)));
  if (query.trim()) items = items.filter((i) => matches(snap, i, query));

  const key: Record<SortCol, (i: LibraryItem) => string> = {
    title: (i) => String(i.title ?? ''),
    creator: creatorsShort,
    year: yearOf,
    publication: publicationOf,
    added: (i) => i.dateAdded,
    status: (i) => String(i.readStatus ?? 'unread'),
  };
  // 最近阅读 always shows the latest read first.
  const by = source.kind === 'read' ? (i: LibraryItem) => String(i.lastReadAt) : key[sort.col];
  const desc = source.kind === 'read' ? true : sort.desc;
  return items.sort((a, b) => {
    const x = by(a);
    const y = by(b);
    // Empty values sink to the bottom whichever way the column sorts.
    if (!x !== !y) return x ? -1 : 1;
    return (desc ? -1 : 1) * x.localeCompare(y, 'zh-CN', { numeric: true });
  });
}
