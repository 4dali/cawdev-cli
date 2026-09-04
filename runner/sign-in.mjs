// Signing in — R81, and the reason this file exists is what it does NOT do.
//
// There is no password field here. The CLI asks the platform for a code, opens
// R55's sign-in page in a browser, and waits until a person approves it. A
// password belongs on a page a browser has told you the origin of; typing one
// into a full-screen ANSI app is asking somebody to trust a rendering.
//
// What comes back is a PERSON'S SESSION, and person-actions keep going over
// HTTP with it. R52's split is untouched: the socket says what this machine is
// doing, and anything that CHANGES something is you.

import { spawn } from 'node:child_process';
import { hostname, userInfo } from 'node:os';
import { loadSession, saveSession } from './session-store.mjs';

/**
 * A cookie jar and the CSRF dance, in the smallest form that works.
 *
 * The API uses a session cookie plus a double-submit CSRF cookie, because it
 * was built for a browser. A client that is not a browser has to do by hand
 * what Angular's HttpClient does for free: read `XSRF-TOKEN` and echo it back
 * as `X-XSRF-TOKEN`.
 */
export class Session {
  constructor(url) {
    this.url = String(url).replace(/\/+$/, '');
    this.cookies = new Map();
    this.email = null;
  }

  get signedIn() {
    return this.email !== null;
  }

  #cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  #remember(response) {
    // Node exposes repeated Set-Cookie headers through getSetCookie().
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const at = pair.indexOf('=');
      if (at > 0) {
        this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
      }
    }
  }

  async request(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(this.cookies.size ? { cookie: this.#cookieHeader() } : {}),
        // Sent on every write. The server checks it against the cookie; a
        // missing one is a 403 that looks exactly like "wrong password".
        ...(this.cookies.has('XSRF-TOKEN')
          ? { 'x-xsrf-token': this.cookies.get('XSRF-TOKEN') }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    this.#remember(response);
    const text = await response.text();
    if (!response.ok) {
      const failure = new Error(messageIn(text) ?? `${method} ${path} failed: HTTP ${response.status}`);
      failure.status = response.status;
      throw failure;
    }
    return text ? JSON.parse(text) : null;
  }

  /** One open GET, purely to be handed the CSRF cookie before the first POST. */
  async prime() {
    await this.request('/api/health').catch(() => undefined);
  }

  /** Whether the stored cookies still mean anything. */
  async resume() {
    try {
      const me = await this.request('/api/auth/me');
      this.email = me.email;
      return true;
    } catch {
      this.email = null;
      return false;
    }
  }

  async signOut() {
    await this.request('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    this.cookies.clear();
    this.email = null;
  }
}

function messageIn(text) {
  try {
    return JSON.parse(text).message ?? null;
  } catch {
    return null;
  }
}

/**
 * The session stored for this instance, if there is one and it still works.
 *
 * A stored cookie that the platform no longer honours is not an error worth
 * saying anything about — it is what an expired session looks like, and the
 * answer is the same as having none.
 */
export async function storedSession(url) {
  const session = new Session(url);
  const stored = await loadSession(session.url);
  if (!stored) {
    return session;
  }
  session.cookies = stored.cookies;
  await session.resume();
  return session;
}

/**
 * How this machine describes itself on the approval page.
 *
 * Display text, and the page treats it as such. It is here so the person
 * approving has something to compare against the terminal in front of them.
 */
export function describeThisMachine() {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return hostname();
  }
}

/**
 * Sign in through the browser, and remember it.
 *
 * @param session the jar to fill
 * @param say where to print the code and the URL — the caller owns the screen
 * @param open false to print the URL without launching anything
 */
export async function signInThroughBrowser(session, say, { open = true } = {}) {
  await session.prime();
  const started = await session.request('/api/auth/cli/start', {
    method: 'POST',
    body: { client: describeThisMachine() },
  });

  const url = `${session.url}${started.verifyPath}`;
  say({ kind: 'opening', url, code: started.code });
  if (open) {
    openInBrowser(url);
  }

  const deadline = new Date(started.expiresAt).getTime();
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 1500));
    let answer;
    try {
      answer = await session.request('/api/auth/cli/collect', {
        method: 'POST',
        body: { code: started.code, secret: started.secret },
      });
    } catch (failure) {
      // A 404 is the grant having expired or been collected already; anything
      // else is the platform having a moment and is worth another poll.
      if (failure.status === 404) break;
      continue;
    }
    if (answer.status === 'APPROVED') {
      session.email = answer.user.email;
      await saveSession(session.url, { email: session.email, cookies: session.cookies });
      return { signedIn: true, email: session.email };
    }
    if (answer.status === 'REFUSED') {
      return { signedIn: false, refused: true };
    }
  }
  return { signedIn: false, expired: true };
}

/**
 * Hand the URL to whatever the desktop uses.
 *
 * Detached and silenced, because the browser's own stderr has no business in
 * the middle of a transcript. A failure here is not fatal and is not even
 * reported: the URL has already been printed, and "open failed" on a machine
 * with no desktop is noise about something that was never going to work.
 */
export function openInBrowser(url) {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Printed already.
  }
}
