import { useEffect, useRef, useState } from 'react';
import type { VaultDialog as Dialog } from '../../../shared/src/ipc.ts';

/** Unlock / pick a login / save a login. Shown over the pages, like the palette. */
export function VaultDialog(props: { dialog: Dialog; winId: string; serverUrl: string; onClose: () => void }) {
  const { dialog, winId, serverUrl, onClose } = props;
  function close(next?: Parameters<typeof gleeok.dispatch>[0]) {
    gleeok.dispatch({ type: 'closePalette', winId });
    if (next) gleeok.dispatch(next);
    onClose();
  }
  return (
    <div className="palette-backdrop" onMouseDown={() => close()}>
      <div className="palette vault" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && close()}>
        {dialog.mode === 'unlock' && <Unlock dialog={dialog} close={close} serverUrl={serverUrl} />}
        {dialog.mode === 'pick' && <Pick dialog={dialog} close={close} />}
        {dialog.mode === 'save' && <Save dialog={dialog} close={close} />}
      </div>
    </div>
  );
}

type Close = (next?: Parameters<typeof gleeok.dispatch>[0]) => void;

function Unlock({ dialog, close, serverUrl }: { dialog: Extract<Dialog, { mode: 'unlock' }>; close: Close; serverUrl: string }) {
  const [email, setEmail] = useState(dialog.email);
  const [server, setServer] = useState(serverUrl);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  async function submit() {
    if (!email || !password || busy) return;
    setBusy(true);
    setError('');
    const r = await gleeok.vaultUnlock(email, password, dialog.email ? undefined : server);
    setBusy(false);
    setPassword('');
    if (r.error) return setError(r.error);
    close(dialog.then ? { type: dialog.then === 'fill' ? 'vaultFill' : 'vaultSaveDialog' } : undefined);
  }

  return (
    <form
      className="vault-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>解锁密码库</h3>
      {!dialog.email && (
        <>
          <label>
            服务器
            <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://vault.bitwarden.com" />
          </label>
          <input ref={first} type="email" placeholder="账号邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
        </>
      )}
      <input
        ref={dialog.email ? first : undefined}
        type="password"
        placeholder={dialog.email ? `${dialog.email} 的主密码` : '主密码'}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <p className="error">{error}</p>}
      <div className="row">
        <span className="hint">
          主密码只用来解锁，不会被保存；退出 Gleeok 后需要重新解锁。{!dialog.then && '不需要的话按 Esc 跳过。'}
        </span>
        <button type="submit" className="primary" disabled={busy || !email || !password}>
          {busy ? '解锁中…（约几秒）' : '解锁'}
        </button>
      </div>
    </form>
  );
}

function Pick({ dialog, close }: { dialog: Extract<Dialog, { mode: 'pick' }>; close: Close }) {
  const [index, setIndex] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  return (
    <div
      ref={box}
      tabIndex={0}
      className="vault-form"
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') setIndex((i) => Math.min(i + 1, dialog.logins.length - 1));
        if (e.key === 'ArrowUp') setIndex((i) => Math.max(i - 1, 0));
        if (e.key === 'Enter') close({ type: 'vaultFillItem', itemId: dialog.logins[index].id });
      }}
    >
      <h3>{dialog.host} 的账号</h3>
      <div className="palette-list">
        {dialog.logins.map((l, i) => (
          <div
            key={l.id}
            className={`palette-item ${i === index ? 'active' : ''}`}
            onMouseMove={() => setIndex(i)}
            onClick={() => close({ type: 'vaultFillItem', itemId: l.id })}
          >
            <span className="title">{l.username || '（无用户名）'}</span>
            <span className="detail">{l.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Save({ dialog, close }: { dialog: Extract<Dialog, { mode: 'save' }>; close: Close }) {
  const [name, setName] = useState(dialog.name);
  const [username, setUsername] = useState(dialog.username);
  const [password, setPassword] = useState(dialog.password);
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  async function submit() {
    if (!password || busy) return;
    setBusy(true);
    const r = await gleeok.vaultSave({ name: name.trim() || dialog.name, url: dialog.url, username, password });
    setBusy(false);
    if (r.error) return setError(r.error);
    close();
  }

  return (
    <form
      className="vault-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>存进密码库</h3>
      <label>
        名称 <input ref={first} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        网站 <input value={dialog.url} readOnly className="managed" />
      </label>
      <label>
        用户名 <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="（页面上没读到，可以手动填）" />
      </label>
      <label>
        密码
        <input type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="（页面上没读到，可以手动填）" />
        <button type="button" onClick={() => setShow(!show)}>
          {show ? '隐藏' : '显示'}
        </button>
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <span className="hint">用户名和密码是从当前网页的登录框里读出来的。</span>
        <button type="button" onClick={() => close()}>
          取消
        </button>
        <button type="submit" className="primary" disabled={busy || !password}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}
