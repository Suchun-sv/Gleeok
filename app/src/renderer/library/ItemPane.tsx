import { useEffect, useRef, useState } from 'react';
import type { LibrarySnapshot } from '../../../../shared/src/ipc.ts';
import type { Creator, LibraryItem } from '../../../../shared/src/library.ts';
import { CREATOR_LABELS, FIELD_LABELS, ITEM_TYPES, READ_STATUS_LABELS, itemTypeDef } from '../../../../shared/src/library-schema.ts';
import { childrenOf, formatSize, lib } from './data.ts';

type Tab = 'info' | 'notes' | 'attachments';

/** The right-hand column: an item's fields, notes and attachments, all saved as you edit. */
export function ItemPane({ snap, item, onOpen, onError }: { snap: LibrarySnapshot; item: LibraryItem; onOpen: (attachment: LibraryItem) => void; onError: (e: unknown) => void }) {
  const [tab, setTab] = useState<Tab>('info');
  const notes = childrenOf(snap, item.key, 'note');
  const attachments = childrenOf(snap, item.key, 'attachment');
  const save = (fields: Record<string, unknown>) => void lib({ op: 'patch', kind: 'items', key: item.key, fields }).catch(onError);

  return (
    <div className="lib-item-pane">
      <div className="lib-tabs">
        <button className={tab === 'info' ? 'on' : ''} onClick={() => setTab('info')}>
          信息
        </button>
        <button className={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}>
          笔记{notes.length ? ` ${notes.length}` : ''}
        </button>
        <button className={tab === 'attachments' ? 'on' : ''} onClick={() => setTab('attachments')}>
          附件{attachments.length ? ` ${attachments.length}` : ''}
        </button>
      </div>
      <div className="lib-pane-body">
        {tab === 'info' && <Info key={item.key} item={item} save={save} />}
        {tab === 'notes' && <Notes key={item.key} item={item} notes={notes} onError={onError} />}
        {tab === 'attachments' && <Attachments item={item} attachments={attachments} onOpen={onOpen} onError={onError} />}
      </div>
    </div>
  );
}

/** A text field that keeps its own draft while focused and saves on blur / Enter. */
function Field({ value, onSave, multiline, placeholder }: { value: string; onSave: (v: string) => void; multiline?: boolean; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const commit = () => {
    focused.current = false;
    if (draft !== value) onSave(draft);
  };
  const props = {
    value: draft,
    placeholder,
    onFocus: () => (focused.current = true),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit,
  };
  return multiline ? (
    <textarea {...props} rows={Math.min(12, Math.max(2, Math.ceil(draft.length / 48)))} />
  ) : (
    <input {...props} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
  );
}

function Info({ item, save }: { item: LibraryItem; save: (fields: Record<string, unknown>) => void }) {
  const def = itemTypeDef(item.itemType);
  const own = new Set(def.fields);
  // Fields this item has from another type (or from Zotero) stay visible and editable.
  const strays = Object.keys(item).filter((k) => FIELD_LABELS[k] && !own.has(k) && typeof item[k] === 'string' && item[k]);
  const str = (k: string) => (typeof item[k] === 'string' ? (item[k] as string) : '');
  const set = (k: string) => (v: string) => save({ [k]: v.trim() ? v : null });

  return (
    <div className="lib-info">
      <label className="lib-row">
        <span>类型</span>
        <select value={item.itemType} onChange={(e) => save({ itemType: e.target.value })}>
          {ITEM_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
          {!ITEM_TYPES.some((t) => t.type === item.itemType) && <option value={item.itemType}>{item.itemType}</option>}
        </select>
      </label>
      <div className="lib-row">
        <span>{FIELD_LABELS.title}</span>
        <Field value={str('title')} onSave={set('title')} multiline placeholder="未命名" />
      </div>
      <Creators item={item} creatorTypes={def.creatorTypes} save={save} />
      {def.fields
        .filter((f) => f !== 'title' && f !== 'abstractNote' && f !== 'extra')
        .map((f) => (
          <div className="lib-row" key={f}>
            <span>{FIELD_LABELS[f] ?? f}</span>
            <Field value={str(f)} onSave={set(f)} />
          </div>
        ))}
      {strays.map((f) => (
        <div className="lib-row stray" key={f} title="这个字段不属于当前类型，保留着">
          <span>{FIELD_LABELS[f]}</span>
          <Field value={str(f)} onSave={set(f)} />
        </div>
      ))}
      <div className="lib-row">
        <span>{FIELD_LABELS.abstractNote}</span>
        <Field value={str('abstractNote')} onSave={set('abstractNote')} multiline />
      </div>
      <div className="lib-row">
        <span>{FIELD_LABELS.extra}</span>
        <Field value={str('extra')} onSave={set('extra')} multiline />
      </div>
      <label className="lib-row">
        <span>阅读状态</span>
        <select value={String(item.readStatus ?? 'unread')} onChange={(e) => save({ readStatus: e.target.value === 'unread' ? null : e.target.value })}>
          {Object.entries(READ_STATUS_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <Tags item={item} save={save} />
      <p className="lib-dates">
        添加于 {new Date(item.dateAdded).toLocaleString('zh-CN')} · 修改于 {new Date(item.dateModified).toLocaleString('zh-CN')}
      </p>
    </div>
  );
}

function Creators({ item, creatorTypes, save }: { item: LibraryItem; creatorTypes: string[]; save: (fields: Record<string, unknown>) => void }) {
  const creators = item.creators ?? [];
  const put = (next: Creator[]) => save({ creators: next });
  const change = (i: number, patch: Partial<Creator>) => put(creators.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, d: number) => {
    const next = [...creators];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    put(next);
  };
  return (
    <div className="lib-creators">
      {creators.map((c, i) => (
        <div className="lib-creator" key={i}>
          <select value={c.creatorType} onChange={(e) => change(i, { creatorType: e.target.value })}>
            {[...new Set([...creatorTypes, c.creatorType])].map((t) => (
              <option key={t} value={t}>
                {CREATOR_LABELS[t] ?? t}
              </option>
            ))}
          </select>
          {c.name !== undefined ? (
            <Field value={c.name} onSave={(v) => change(i, { name: v })} placeholder="名称" />
          ) : (
            <>
              <Field value={c.lastName ?? ''} onSave={(v) => change(i, { lastName: v })} placeholder="姓" />
              <Field value={c.firstName ?? ''} onSave={(v) => change(i, { firstName: v })} placeholder="名" />
            </>
          )}
          <button
            className="icon-btn"
            title={c.name !== undefined ? '分成姓和名' : '合成一个名称（机构等）'}
            onClick={() =>
              change(
                i,
                c.name !== undefined
                  ? { name: undefined, lastName: c.name, firstName: '' }
                  : { name: [c.firstName, c.lastName].filter(Boolean).join(' '), lastName: undefined, firstName: undefined },
              )
            }
          >
            {c.name !== undefined ? '⇆' : '⇥'}
          </button>
          <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="上移">
            ↑
          </button>
          <button className="icon-btn" onClick={() => put(creators.filter((_, j) => j !== i))} title="删除">
            ×
          </button>
        </div>
      ))}
      <button className="lib-link" onClick={() => put([...creators, { creatorType: creatorTypes[0], lastName: '', firstName: '' }])}>
        + 添加{CREATOR_LABELS[creatorTypes[0]] ?? '作者'}
      </button>
    </div>
  );
}

function Tags({ item, save }: { item: LibraryItem; save: (fields: Record<string, unknown>) => void }) {
  const tags = item.tags ?? [];
  const [draft, setDraft] = useState('');
  const add = () => {
    const tag = draft.trim();
    setDraft('');
    if (tag && !tags.some((t) => t.tag === tag)) save({ tags: [...tags, { tag }] });
  };
  return (
    <div className="lib-row">
      <span>标签</span>
      <div className="lib-tags">
        {tags.map((t) => (
          <span className="lib-tag" key={t.tag}>
            {t.tag}
            <button onClick={() => save({ tags: tags.filter((x) => x.tag !== t.tag) })} title="去掉">
              ×
            </button>
          </span>
        ))}
        <input value={draft} placeholder="+ 标签" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} onBlur={add} />
      </div>
    </div>
  );
}

function Notes({ item, notes, onError }: { item: LibraryItem; notes: LibraryItem[]; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState<string | null>(notes[0]?.key ?? null);
  const note = notes.find((n) => n.key === open);
  const add = async () => {
    try {
      const [n] = await lib<LibraryItem[]>({ op: 'create', kind: 'items', objects: [{ itemType: 'note', parentItem: item.key, note: '' }] });
      setOpen(n.key);
    } catch (e) {
      onError(e);
    }
  };
  return (
    <div className="lib-notes">
      <div className="lib-note-list">
        {notes.map((n) => (
          <button key={n.key} className={n.key === open ? 'on' : ''} onClick={() => setOpen(n.key)}>
            {noteTitle(n)}
          </button>
        ))}
        <button className="lib-link" onClick={() => void add()}>
          + 新笔记
        </button>
      </div>
      {note && (
        <NoteEditor
          key={note.key}
          note={note}
          onSave={(html) => void lib({ op: 'patch', kind: 'items', key: note.key, fields: { note: html } }).catch(onError)}
          onDelete={() => void lib({ op: 'remove', kind: 'items', key: note.key }).then(() => setOpen(null), onError)}
        />
      )}
    </div>
  );
}

export const noteTitle = (n: LibraryItem) =>
  String(n.note ?? '')
    .replace(/<\/(p|h\d|li|div|blockquote)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
    .split('\n')[0]
    .slice(0, 60) || '（空笔记）';

/** Rich text with a small toolbar; saves a moment after typing stops, and on leaving. */
function NoteEditor({ note, onSave, onDelete }: { note: LibraryItem; onSave: (html: string) => void; onDelete: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saved = useRef(String(note.note ?? ''));
  const range = useRef<Range | null>(null);
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    // Someone else's edit arrives: show it unless this note is being typed in.
    if (box.current && document.activeElement !== box.current && String(note.note ?? '') !== saved.current) {
      box.current.innerHTML = String(note.note ?? '');
      saved.current = String(note.note ?? '');
    }
  }, [note.note]);
  useEffect(() => {
    if (box.current) box.current.innerHTML = String(note.note ?? '');
    return () => clearTimeout(timer.current);
  }, []);
  const flush = () => {
    clearTimeout(timer.current);
    const html = box.current?.innerHTML ?? '';
    if (html !== saved.current) {
      saved.current = html;
      onSave(html);
    }
  };
  const cmd = (name: string, value?: string) => {
    document.execCommand(name, false, value);
    box.current?.focus();
    flush();
  };
  return (
    <div className="lib-note-editor">
      <div className="lib-note-toolbar">
        <button onMouseDown={(e) => (e.preventDefault(), cmd('formatBlock', 'h2'))} title="标题">
          H
        </button>
        <button onMouseDown={(e) => (e.preventDefault(), cmd('bold'))} title="粗体">
          <b>B</b>
        </button>
        <button onMouseDown={(e) => (e.preventDefault(), cmd('italic'))} title="斜体">
          <i>I</i>
        </button>
        <button onMouseDown={(e) => (e.preventDefault(), cmd('insertUnorderedList'))} title="列表">
          •
        </button>
        <button onMouseDown={(e) => (e.preventDefault(), cmd('insertOrderedList'))} title="编号列表">
          1.
        </button>
        <button onMouseDown={(e) => (e.preventDefault(), cmd('formatBlock', 'blockquote'))} title="引用">
          ❝
        </button>
        <button
          onMouseDown={(e) => {
            e.preventDefault();
            // Remember the selection: typing the address moves focus out of the note.
            const sel = window.getSelection();
            range.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
            setLink('');
          }}
          title="链接"
        >
          🔗
        </button>
        {link !== null && (
          <input
            className="lib-link-input"
            autoFocus
            placeholder="链接地址，回车确定"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setLink(null);
              if (e.key !== 'Enter') return;
              const url = link.trim();
              setLink(null);
              if (!url || !range.current) return;
              const sel = window.getSelection();
              sel?.removeAllRanges();
              sel?.addRange(range.current);
              cmd('createLink', /^[a-z]+:/i.test(url) ? url : `https://${url}`);
            }}
            onBlur={() => setLink(null)}
          />
        )}
        <button onMouseDown={(e) => (e.preventDefault(), cmd('formatBlock', 'p'))} title="正文">
          ¶
        </button>
        <span className="spacer" />
        <button onClick={onDelete} title="删除这条笔记">
          删除
        </button>
      </div>
      <div
        ref={box}
        className="lib-note-body"
        contentEditable
        suppressContentEditableWarning
        onInput={() => {
          clearTimeout(timer.current);
          timer.current = setTimeout(flush, 800);
        }}
        onBlur={flush}
      />
    </div>
  );
}

function Attachments({ item, attachments, onOpen, onError }: { item: LibraryItem; attachments: LibraryItem[]; onOpen: (a: LibraryItem) => void; onError: (e: unknown) => void }) {
  return (
    <div className="lib-attachments">
      {attachments.length === 0 && <p className="hint">还没有附件</p>}
      {attachments.map((a) => (
        <div className="lib-attachment" key={a.key}>
          <span className="lib-file-icon">📄</span>
          <div className="lib-attachment-name">
            <Field value={String(a.filename ?? a.title ?? 'PDF')} onSave={(v) => void lib({ op: 'patch', kind: 'items', key: a.key, fields: { filename: v } }).catch(onError)} />
            <span className="meta">{a.fileHash ? formatSize(a.fileSize) : '文件还没上传'}</span>
          </div>
          <button disabled={!a.fileHash} onClick={() => onOpen(a)}>
            打开
          </button>
          <button
            className="icon-btn"
            title="删除附件（连同它的批注）"
            onClick={() => confirm(`删除附件「${String(a.filename ?? 'PDF')}」和它的批注？`) && void lib({ op: 'remove', kind: 'items', key: a.key }).catch(onError)}
          >
            ×
          </button>
        </div>
      ))}
      <button className="lib-link" onClick={() => void lib({ op: 'pickFiles', parentItem: item.key }).catch(onError)}>
        + 添加 PDF
      </button>
    </div>
  );
}
