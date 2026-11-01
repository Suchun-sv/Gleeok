import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';

/**
 * code-server sign-in for 代码栏. The password typed once on code-server's own sign-in page is
 * kept for that server (encrypted with the system keychain, in userData/code-logins.json); from
 * then on Gleeok fills and submits that page itself, so a code tab opens straight into VS Code.
 * A kept password that stops working is dropped, and the page is left for the user again.
 */

/** What the sign-in page prints when its form is sent (see ARM). */
const TYPED = '[gleeok-code-login] ';

/** Injected into a sign-in page: report the password when the user sends the form. */
export const ARM = `(() => {
  const form = document.querySelector('form');
  const input = document.querySelector('input[type=password]');
  if (!form || !input || window.__gleeokLogin) return 'no form';
  window.__gleeokLogin = true;
  form.addEventListener('submit', () => console.log(${JSON.stringify(TYPED)} + JSON.stringify(input.value)), true);
  return 'armed';
})()`;

/** Injected into a sign-in page: sign in with a kept password. */
export const fill = (password: string) => `(() => {
  const form = document.querySelector('form');
  const input = document.querySelector('input[type=password]');
  if (!form || !input) return 'no form';
  input.value = ${JSON.stringify(password)};
  form.requestSubmit ? form.requestSubmit() : form.submit();
  return 'sent';
})()`;

/** code-server's sign-in page: /login on its origin (any query). */
export const isSignInPage = (url: string) => {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') === '/login';
  } catch {
    return false;
  }
};

/** The password a sign-in page reported, if the message is one. */
export function typedPassword(message: string): string | null {
  if (!message.startsWith(TYPED)) return null;
  try {
    const value = JSON.parse(message.slice(TYPED.length));
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

export class CodeLogins {
  #path: string;

  constructor(userData: string) {
    this.#path = join(userData, 'code-logins.json');
  }

  /** False where the system offers no keychain to encrypt with: then nothing is kept. */
  get canKeep() {
    return safeStorage.isEncryptionAvailable();
  }

  get(origin: string): string | null {
    const sealed = this.#read()[origin];
    if (!sealed || !this.canKeep) return null;
    try {
      return safeStorage.decryptString(Buffer.from(sealed, 'base64'));
    } catch {
      return null;
    }
  }

  keep(origin: string, password: string) {
    if (!this.canKeep) return false;
    const all = this.#read();
    all[origin] = safeStorage.encryptString(password).toString('base64');
    this.#write(all);
    return true;
  }

  forget(origin: string) {
    const all = this.#read();
    if (!(origin in all)) return;
    delete all[origin];
    this.#write(all);
  }

  #read(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.#path, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  #write(all: Record<string, string>) {
    writeFileSync(this.#path, JSON.stringify(all, null, 1), { mode: 0o600 });
  }
}
