import { useEffect, useMemo, useRef, useState } from 'react';
import type { NewPaseoProject, Snapshot } from '../../../shared/src/ipc.ts';
import { codeFolderUrl, codeHost, codeServers, terminalUrl, type Link, type PaseoDaemon, type PaseoProject, type Project } from '../../../shared/src/model.ts';
import { Icon } from './Icons.tsx';

const newId = () => `l_${crypto.randomUUID().slice(0, 8)}`;
const short = (host: string) => host.split('.')[0];
const tilde = (path: string) => path.replace(/^\/(home|Users)\/[^/]+/, '~');
/** Where most of a daemon's projects live, as the default place for a new one. */
const usualParent = (d?: PaseoDaemon) => {
  const count = new Map<string, number>();
  for (const p of d?.projects ?? []) {
    const parent = tilde(p.path.replace(/\/[^/]+\/?$/, ''));
    count.set(parent, (count.get(parent) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '~';
};
/** owner/repo or a git URL typed into the search. */
const repoLike = (q: string) => /^[\w.-]+\/[\w.-]+$/.test(q) || /^(https?:\/\/|git@)\S+$/.test(q);
const repoLeaf = (repo: string) => repo.replace(/\.git$/, '').split(/[/:]/).pop() ?? '';
const ago = (at: string | null | undefined) => {
  if (!at) return '';
  const m = Math.round((Date.now() - Date.parse(at)) / 60_000);
  if (m < 60) return `${Math.max(1, m)} 分钟前`;
  if (m < 60 * 24) return `${Math.round(m / 60)} 小时前`;
  if (m < 60 * 24 * 7) return `${Math.round(m / 60 / 24)} 天前`;
  return `${Math.round(m / 60 / 24 / 7)} 周前`;
};

const STEPS = ['项目', '代码', '终端'];

/**
 * 新建项目, over the pages: first a new project (made in Paseo too, from a new folder, an existing
 * one, or a GitHub clone, unless 不用 Paseo) or one already in Paseo, then the code-server folder
 * it opens and the terminal it starts, each of which can be skipped.
 */
export function NewProjectDialog({ snap, onClose }: { snap: Snapshot; onClose: () => void }) {
  const daemons = snap.paseo;
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<'new' | 'import'>('new');
  const [name, setName] = useState('');
  const [serverId, setServerId] = useState(daemons[0]?.serverId ?? '');
  const [picked, setPicked] = useState<PaseoProject | null>(null);
  const [query, setQuery] = useState('');
  const [codeBase, setCodeBase] = useState('');
  const [codePath, setCodePath] = useState('');
  const [termHost, setTermHost] = useState('');
  const [termPath, setTermPath] = useState('');
  const [skipped, setSkipped] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A new project in Paseo: which machine, and from what.
  const writable = new Set(snap.paseoWritable);
  const [newHost, setNewHost] = useState(() => daemons.find((d) => writable.has(d.serverId))?.serverId ?? 'none');
  const [src, setSrc] = useState<'empty' | 'dir' | 'git'>('empty');
  const [parent, setParent] = useState(() => usualParent(daemons.find((d) => d.serverId === newHost)));
  const [dirPath, setDirPath] = useState('');
  const [dirs, setDirs] = useState<string[]>([]);
  const [repoQ, setRepoQ] = useState('');
  const [repos, setRepos] = useState<{ name: string; description: string; private: boolean }[]>([]);
  const [repoError, setRepoError] = useState('');
  const [repo, setRepo] = useState<string | null>(null);
  // Made in Paseo already (a later step failed): a retry must not make it again.
  const made = useRef<{ key: string; project: Project; path: string } | null>(null);

  const thisMachine = short(snap.hostname).toLowerCase();
  const daemon = daemons.find((d) => d.serverId === serverId);
  const imported = useMemo(
    () => new Set([...snap.projects, ...snap.archivedProjects].map((p) => p.paseo?.projectId).filter(Boolean)),
    [snap.projects, snap.archivedProjects],
  );

  // code-servers: each Paseo machine's, then any other the projects' code links use.
  const codeOptions = useMemo(() => {
    const out: { label: string; base: string }[] = [];
    const seen = new Set<string>();
    const add = (label: string, base: string) => {
      const key = base.replace(/\/+$/, '');
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ label, base: key });
      }
    };
    for (const d of daemons) if (d.codeServer) add(short(d.hostname), d.codeServer);
    for (const s of codeServers([...snap.projects, ...snap.archivedProjects])) add(codeHost(s.link) || s.origin, s.origin);
    // Names alike (several localhost): the port tells them apart.
    return out.map((o) => {
      if (out.filter((x) => x.label === o.label).length < 2) return o;
      try {
        return { ...o, label: new URL(o.base).host };
      } catch {
        return o;
      }
    });
  }, [daemons, snap.projects, snap.archivedProjects]);

  // Terminals: over ssh to each Paseo machine, or on this one.
  const termOptions = useMemo(() => {
    const hosts = [...new Set(daemons.map((d) => d.hostname).filter((h) => short(h).toLowerCase() !== thisMachine))];
    return [...hosts.map((h) => ({ label: short(h), host: h })), { label: '本机', host: '' }];
  }, [daemons, thisMachine]);

  const newDaemon = daemons.find((d) => d.serverId === newHost);
  const onPaseo = mode === 'new' && !!newDaemon;
  const target = src === 'dir' ? dirPath.trim() : `${parent.trim().replace(/\/+$/, '') || '~'}/${src === 'git' ? repoLeaf(repo ?? '') : name.trim()}`;
  const paseoReq = (): NewPaseoProject =>
    src === 'dir' ? { kind: 'dir', path: dirPath.trim() } : src === 'git' ? { kind: 'git', repo: repo ?? '', parent: parent.trim() } : { kind: 'empty', parent: parent.trim(), name: name.trim() };

  // Folders as a path is typed; repositories as a search is typed (the daemon's gh).
  useEffect(() => {
    if (!onPaseo || src !== 'dir') return;
    let live = true;
    const t = setTimeout(() => {
      void gleeok.paseoDirs(newHost, dirPath.trim() || `${parent}/`).then((r) => live && setDirs(r));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [onPaseo, src, newHost, dirPath, parent]);
  useEffect(() => {
    if (!onPaseo || src !== 'git') return;
    let live = true;
    const t = setTimeout(() => {
      void gleeok.paseoRepos(newHost, repoQ.trim()).then((r) => {
        if (!live) return;
        setRepos(r.repos);
        setRepoError(r.error ?? '');
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [onPaseo, src, newHost, repoQ]);

  const title = step === 0 ? '新建项目' : mode === 'new' ? name.trim() : picked?.name ?? '';
  const ready =
    step > 0 ||
    (mode === 'import'
      ? !!picked
      : !!name.trim() && (!onPaseo || (src === 'empty' ? !!parent.trim() : src === 'dir' ? !!dirPath.trim() : !!repo)));

  function sameMachine(d?: PaseoDaemon) {
    return !!d && short(d.hostname).toLowerCase() === thisMachine;
  }

  function next(skip = false) {
    if (!ready || busy) return;
    const marks = { ...skipped, [step]: skip };
    setSkipped(marks);
    if (step === 0) {
      // From Paseo: code and terminal start where the project lives.
      if (mode === 'import' && picked && daemon) {
        // The project's own folder (a workspace may be a passing worktree).
        const dir = picked.path;
        setCodeBase(daemon.codeServer?.replace(/\/+$/, '') ?? codeOptions[0]?.base ?? '');
        setCodePath(dir);
        setTermHost(sameMachine(daemon) ? '' : daemon.hostname);
        setTermPath(dir);
      } else if (onPaseo && newDaemon) {
        // A new Paseo project: the same, at the folder it will get.
        setCodeBase(newDaemon.codeServer?.replace(/\/+$/, '') ?? codeOptions[0]?.base ?? '');
        setCodePath(target);
        setTermHost(sameMachine(newDaemon) ? '' : newDaemon.hostname);
        setTermPath(target);
      } else {
        setCodeBase((b) => b || codeOptions[0]?.base || '');
        setTermHost((h) => h || termOptions[0]?.host || '');
      }
      setStep(1);
      return;
    }
    if (step === 1) {
      if (!skip && !termPath) setTermPath(codePath);
      setStep(2);
      return;
    }
    void finish(marks);
  }

  async function finish(marks: Record<number, boolean>) {
    setBusy(true);
    setError('');
    try {
      let project: Project;
      // The folder as typed, and where it really is once the daemon has made it.
      let real = target;
      if (onPaseo) {
        const req = paseoReq();
        const key = JSON.stringify([newHost, req]);
        if (made.current?.key !== key) {
          const r = await gleeok.createPaseoProject(newHost, req, name.trim());
          if (!r.project) throw new Error(r.error ?? '没能创建');
          made.current = { key, project: r.project, path: r.path ?? target };
        }
        project = made.current.project;
        real = made.current.path;
      } else if (mode === 'import' && picked) {
        const created = await gleeok.importPaseo(serverId, [picked.projectId]);
        if (!created[0]) throw new Error('Paseo 没有返回这个项目');
        project = created[0];
      } else {
        project = await gleeok.createProject(name.trim());
      }
      const links: Link[] = [];
      const at = (path: string) => (onPaseo && path.trim() === target ? real : path.trim());
      if (!marks[1] && codeBase && codePath.trim()) {
        const url = codeFolderUrl(codeBase, at(codePath));
        // Paseo's own code link may already be this folder.
        if (!project.links.some((l) => l.url === url)) links.push({ id: newId(), label: '代码', url, kind: 'code', primary: true });
      }
      if (!marks[2]) {
        const label = `${termHost ? short(termHost) : '本机'} 终端`;
        links.push({ id: newId(), label, url: terminalUrl({ host: termHost, cwd: at(termPath), name: label }), kind: 'terminal' });
      }
      if (links.length) {
        const others = links.some((l) => l.primary) ? project.links.map(({ primary: _, ...l }) => l) : project.links;
        await gleeok.saveProject({ ...project, links: [...others, ...links] });
      }
      gleeok.dispatch({ type: 'selectProject', id: project.id });
      onClose();
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setBusy(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
      if (e.key === 'Enter' && !e.isComposing) next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Not yet imported first, most recently used on top; a search narrows by name or folder.
  const q = query.trim().toLowerCase();
  const projects = [...(daemon?.projects ?? [])]
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(imported.has(a.projectId)) - Number(imported.has(b.projectId)) ||
        String(b.latest?.at ?? '').localeCompare(String(a.latest?.at ?? '')),
    );
  return (
    <div className="np-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="np" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="新建项目">
        <div className="np-head">
          <span className="np-title">{title}</span>
          <button className="icon-btn" onClick={onClose} title="关闭（Esc）">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="np-steps">
          {STEPS.map((s, i) => (
            <span key={s} className="np-step-wrap">
              {i > 0 && <span className="np-line" />}
              <span className={`np-step ${i === step ? 'on' : i < step ? 'done' : ''}`}>
                <span className="num">{i < step ? <Icon name="check" size={11} /> : i + 1}</span>
                {s}
              </span>
            </span>
          ))}
        </div>

        {step === 0 && (
          <>
            <div className="np-seg">
              <button className={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')}>
                新建项目
              </button>
              <button className={mode === 'import' ? 'on' : ''} onClick={() => setMode('import')}>
                从 Paseo 导入
              </button>
            </div>
            <div className="np-body">
              {mode === 'new' ? (
                <>
                  <label className="np-field-wrap">
                    <span className="np-label">名称</span>
                    <span className="np-field">
                      <input autoFocus placeholder="项目名称" value={name} onChange={(e) => setName(e.target.value)} />
                    </span>
                  </label>
                  {daemons.length > 0 && (
                    <div>
                      <span className="np-label">建在</span>
                      <div className="np-chips">
                        {daemons.map((d) => {
                          const ok = writable.has(d.serverId);
                          return (
                            <button
                              key={d.serverId}
                              className={`np-chip ${d.serverId === newHost ? 'on' : ''}`}
                              disabled={!ok}
                              title={ok ? undefined : '只读，先在 设置 → Paseo 里贴配对链接'}
                              onClick={() => {
                                setNewHost(d.serverId);
                                setParent(usualParent(d));
                                setDirPath('');
                                setDirs([]);
                                setRepos([]);
                                setRepo(null);
                              }}
                            >
                              <Icon name="server" size={14} />
                              {short(d.hostname)}
                            </button>
                          );
                        })}
                        <button className={`np-chip ${newHost === 'none' ? 'on' : ''}`} onClick={() => setNewHost('none')}>
                          <Icon name="circleOff" size={14} />
                          不用 Paseo
                        </button>
                      </div>
                    </div>
                  )}
                  {onPaseo && (
                    <div className="np-group">
                      <div className="np-src">
                        <button className={src === 'empty' ? 'on' : ''} onClick={() => setSrc('empty')}>
                          <Icon name="folderPlus" size={14} />
                          新文件夹
                        </button>
                        <button className={src === 'dir' ? 'on' : ''} onClick={() => setSrc('dir')}>
                          <Icon name="folderOpen" size={14} />
                          已有文件夹
                        </button>
                        <button className={src === 'git' ? 'on' : ''} onClick={() => setSrc('git')}>
                          <Icon name="github" size={14} />
                          GitHub
                        </button>
                      </div>
                      {src === 'dir' ? (
                        <>
                          <span className="np-field">
                            <Icon name="folder" size={15} />
                            <input className="mono" placeholder={`${parent}/`} value={dirPath} onChange={(e) => setDirPath(e.target.value)} />
                          </span>
                          <div className="np-pick">
                            {dirs.map((full) => {
                              const path = tilde(full);
                              const known = newDaemon?.projects.some((p) => p.path === full);
                              return (
                                <button
                                  key={full}
                                  className={`np-srow ${path === dirPath.trim() ? 'on' : ''}`}
                                  disabled={known}
                                  title={known ? '已在 Paseo，用「从 Paseo 导入」' : undefined}
                                  onClick={() => {
                                    setDirPath(path);
                                    if (!name.trim()) setName(full.split('/').pop() ?? '');
                                  }}
                                >
                                  <Icon name="folder" size={14} />
                                  <span className="np-txt">{path}</span>
                                  {known && <span className="np-tag">已在 Paseo</span>}
                                </button>
                              );
                            })}
                          </div>
                        </>
                      ) : src === 'git' ? (
                        <>
                          <span className="np-field">
                            <Icon name="search" size={15} />
                            <input placeholder="搜索仓库，或粘贴地址" value={repoQ} onChange={(e) => setRepoQ(e.target.value)} />
                          </span>
                          <div className="np-pick">
                            {[
                              ...(repoLike(repoQ.trim()) && !repos.some((r) => r.name === repoQ.trim()) ? [{ name: repoQ.trim(), description: '', private: false }] : []),
                              ...repos.slice(0, 4),
                            ].map((r) => (
                              <button
                                key={r.name}
                                className={`np-row ${r.name === repo ? 'on' : ''}`}
                                onClick={() => {
                                  setRepo(r.name);
                                  if (!name.trim()) setName(repoLeaf(r.name));
                                }}
                              >
                                <span className="np-ic gh">
                                  <Icon name="github" size={15} />
                                </span>
                                <span className="np-txt">
                                  <span className="t">{r.name}</span>
                                  {r.description && <span className="d">{r.description}</span>}
                                </span>
                                {r.private && <span className="np-tag">私有</span>}
                                <span className="np-tick">{r.name === repo && <Icon name="check" size={15} />}</span>
                              </button>
                            ))}
                            {repoError && <p className="np-note">{repoError}</p>}
                          </div>
                          <span className="np-field">
                            <Icon name="folder" size={15} />
                            <input className="mono" placeholder="~/github" value={parent} onChange={(e) => setParent(e.target.value)} />
                          </span>
                          <p className="np-note">
                            克隆到 <b>{repo ? target : `${parent}/…`}</b>
                          </p>
                        </>
                      ) : (
                        <>
                          <span className="np-field">
                            <Icon name="folder" size={15} />
                            <input className="mono" placeholder="~/github" value={parent} onChange={(e) => setParent(e.target.value)} />
                          </span>
                          <p className="np-note">
                            新建 <b>{name.trim() ? target : `${parent}/…`}</b>
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </>
              ) : daemons.length === 0 ? (
                <p className="np-note">还没连上 Paseo。在 设置 → Paseo 里连接后，这里会列出它的项目。</p>
              ) : (
                <>
                  <div className="np-chips">
                    {daemons.map((d) => (
                      <button
                        key={d.serverId}
                        className={`np-chip ${d.serverId === serverId ? 'on' : ''}`}
                        onClick={() => {
                          setServerId(d.serverId);
                          setPicked(null);
                          setQuery('');
                        }}
                      >
                        <Icon name="server" size={14} />
                        {short(d.hostname)}
                      </button>
                    ))}
                  </div>
                  <span className="np-field np-search">
                    <Icon name="search" size={15} />
                    <input autoFocus placeholder="搜索" value={query} onChange={(e) => setQuery(e.target.value)} />
                  </span>
                  <div className="np-pick">
                    {projects.length === 0 && <p className="np-note">{q ? '没有匹配的项目。' : '这台机器上没有 Paseo 项目。'}</p>}
                    {projects.map((p) => {
                        const done = imported.has(p.projectId);
                        const on = picked?.projectId === p.projectId;
                        return (
                          <button key={p.projectId} className={`np-row ${done ? 'muted' : on ? 'on' : ''}`} disabled={done} onClick={() => setPicked(p)}>
                            <span className="np-ic">P</span>
                            <span className="np-txt">
                              <span className="t">{p.name}</span>
                              <span className="d">{p.path.replace(/^\/(home|Users)\/[^/]+/, '~')}</span>
                            </span>
                            {done ? <span className="np-tag">已导入</span> : <span className="np-when">{ago(p.latest?.at)}</span>}
                            <span className="np-tick">{on && <Icon name="check" size={15} />}</span>
                          </button>
                        );
                    })}
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {step === 1 && (
          <div className="np-body">
            <div>
              <span className="np-label">code-server</span>
              {codeOptions.length === 0 ? (
                <p className="np-note">还没有可用的 code-server，可以跳过，之后在项目设置里加。</p>
              ) : (
                <div className="np-chips">
                  {codeOptions.map((o) => (
                    <button key={o.base} className={`np-chip ${o.base === codeBase ? 'on' : ''}`} onClick={() => setCodeBase(o.base)} title={o.base}>
                      <Icon name="server" size={14} />
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <label className="np-field-wrap">
              <span className="np-label">文件夹</span>
              <span className="np-field">
                <Icon name="folder" size={15} />
                <input className="mono" autoFocus placeholder="~/github/项目" value={codePath} onChange={(e) => setCodePath(e.target.value)} />
              </span>
            </label>
          </div>
        )}

        {step === 2 && (
          <div className="np-body">
            <div>
              <span className="np-label">机器</span>
              <div className="np-chips">
                {termOptions.map((o) => (
                  <button key={o.label} className={`np-chip ${o.host === termHost ? 'on' : ''}`} onClick={() => setTermHost(o.host)}>
                    <Icon name={o.host ? 'server' : 'laptop'} size={14} />
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="np-field-wrap">
              <span className="np-label">目录</span>
              <span className="np-field">
                <Icon name="terminal" size={15} />
                <input className="mono" autoFocus placeholder="~" value={termPath} onChange={(e) => setTermPath(e.target.value)} />
              </span>
            </label>
            <p className="np-note">{termHost ? '用 ssh 打开，沿用 ~/.ssh/config。' : '在这台电脑上打开。'}</p>
          </div>
        )}

        <div className="np-foot">
          {busy && onPaseo ? (
            <span className="np-busy">
              <span className="np-spin" />
              {src === 'git' ? `克隆 ${repo}` : src === 'dir' ? '添加到 Paseo' : `新建 ${target}`}
            </span>
          ) : (
            <span className="np-error">{error}</span>
          )}
          {step > 0 && (
            <button className="np-btn ghost" disabled={busy} onClick={() => next(true)}>
              跳过
            </button>
          )}
          {step > 0 ? (
            <button className="np-btn" disabled={busy} onClick={() => setStep(step - 1)}>
              上一步
            </button>
          ) : (
            <button className="np-btn" onClick={onClose}>
              取消
            </button>
          )}
          <button className="np-btn primary" disabled={!ready || busy} onClick={() => next()}>
            {busy ? '创建中' : step === 2 ? '完成' : '下一步'}
          </button>
        </div>
      </div>
    </div>
  );
}
