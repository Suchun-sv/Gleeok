import { useEffect, useRef, useState } from 'react';
import { PANE_COUNT, isCodeLink, paneName, primaryCodeLink, type Link, type Project } from '../../../shared/src/model.ts';
import { faviconFor } from './Panes.tsx';

/** Shows and edits a project's links. Edits stay local until saved to the server. */
export function EntryPage({ project, toggle }: { project: Project; toggle: React.ReactNode }) {
  const [draft, setDraft] = useState<Project>(project);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(project);

  // Background refreshes (another machine, or the Paseo sync moving a link) bump the version.
  // Follow them unless the user has unsaved edits.
  const seen = useRef(project);
  useEffect(() => {
    if (JSON.stringify(draft) === JSON.stringify(seen.current)) setDraft(project);
    seen.current = project;
  }, [project.version]);

  // The primary-code column only appears once the project has a code link.
  const hasCode = draft.links.some(isCodeLink);
  const primary = primaryCodeLink(draft);
  const makePrimary = (id: string) =>
    setDraft({
      ...draft,
      links: draft.links.map((l) => {
        if (!isCodeLink(l)) return l;
        const { primary: _, ...rest } = l;
        return l.id === id ? { ...rest, primary: true } : rest;
      }),
    });

  const setLink = (i: number, patch: Partial<Link>) =>
    setDraft({ ...draft, links: draft.links.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  async function save() {
    setSaving(true);
    setError('');
    try {
      setDraft(await gleeok.saveProject(draft));
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (confirm(`删除项目「${project.name}」？只删除 Gleeok 里的配置，不影响 Paseo。`)) {
      await gleeok.deleteProject(project.id);
    }
  }

  return (
    <div className="entry">
      <div className="entry-head">
        {toggle}
        <input
          className="project-name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <span className="meta">
          {project.source === 'paseo' && project.paseo
            ? `Paseo · ${project.paseo.cwd}`
            : '手动创建'}{' '}
          · v{project.version}
        </span>
      </div>

      <table className="links-table">
        <thead>
          <tr>
            <th />
            <th>名称</th>
            <th>链接</th>
            <th>默认栏</th>
            {hasCode && <th title="侧边栏的 </> 按钮打开主要的代码链接">主要代码</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {draft.links.map((l, i) => (
            <tr key={l.id}>
              <td>
                <button className="icon" onClick={() => gleeok.dispatch({ type: 'openLink', url: l.url })} title="打开">
                  <img src={l.icon ?? faviconFor(l.url)} alt="" />
                </button>
              </td>
              <td>
                <input value={l.label} onChange={(e) => setLink(i, { label: e.target.value })} />
              </td>
              <td>
                {l.kind && l.kind !== 'code' ? (
                  <input
                    value={l.url}
                    readOnly
                    className="managed"
                    title={
                      l.kind === 'paseo'
                        ? '由 Paseo 同步自动维护：始终指向最近使用的 workspace'
                        : l.kind === 'paseo-code'
                          ? '由 Paseo 同步自动维护：这个 daemon 的 code-server 里的项目文件夹（在「从 Paseo 导入」页设置地址）'
                          : '由 Paseo 同步自动维护：指向最近 workspace 里的终端，终端关掉后自动移除'
                    }
                  />
                ) : (
                  <input
                    value={l.url}
                    placeholder={l.kind === 'code' ? 'https://code-server 地址/?folder=/项目路径' : undefined}
                    onChange={(e) => setLink(i, { url: e.target.value })}
                  />
                )}
              </td>
              <td>
                <select
                  value={l.pinnedPane ?? ''}
                  onChange={(e) => setLink(i, { pinnedPane: e.target.value === '' ? undefined : Number(e.target.value) })}
                >
                  <option value="">—</option>
                  {Array.from({ length: PANE_COUNT }, (_, p) => (
                    <option key={p} value={p}>
                      {paneName(p)}
                    </option>
                  ))}
                </select>
              </td>
              {hasCode && (
                <td className="center">
                  {isCodeLink(l) && (
                    <input type="radio" name="primary-code" checked={l === primary} onChange={() => makePrimary(l.id)} title="设为主要代码链接" />
                  )}
                </td>
              )}
              <td>
                <button
                  className="icon"
                  onClick={() => setDraft({ ...draft, links: draft.links.filter((_, j) => j !== i) })}
                  title="删除"
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="entry-actions">
        <button
          onClick={() =>
            setDraft({
              ...draft,
              links: [...draft.links, { id: `l_${crypto.randomUUID().slice(0, 8)}`, label: '', url: '' }],
            })
          }
        >
          + 添加链接
        </button>
        <button
          onClick={() =>
            setDraft({
              ...draft,
              links: [...draft.links, { id: `l_${crypto.randomUUID().slice(0, 8)}`, label: '代码', url: '', kind: 'code' }],
            })
          }
          title="code-server、vscode.dev 等网页编辑器；侧边栏的 </> 按钮打开主要的那一条"
        >
          + 添加代码链接
        </button>
        <span className="spacer" />
        {error && <span className="error">{error}</span>}
        <button onClick={() => setDraft(project)} disabled={!dirty}>
          撤销
        </button>
        <button className="primary" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button onClick={() => gleeok.dispatch({ type: 'archiveProject', id: project.id, archived: true })}>
          存档
        </button>
        <button className="danger" onClick={() => void remove()}>
          删除项目
        </button>
      </div>
      <p className="hint">“默认栏”只影响这个项目第一次在某台机器上打开时各栏的初始标签。</p>
    </div>
  );
}
