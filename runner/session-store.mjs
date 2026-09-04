// Where the CLI remembers who you are — R81.
//
// One file, `~/.cawdev/session.json`, mode 0600, holding the session cookies
// the platform handed back after somebody approved a sign-in in their browser.
// **What is stored is a person's session and nothing else**: no password ever
// reaches this process, and the daemon's own token is not in here — R52's rule
// that a run's credential can never be borrowed for a decision is exactly why
// these two are different files.
//
// Keyed by URL, because one machine can point at more than one cawdev and
// reusing a cookie across instances is either a 401 or, worse, not one.
//
// Zero dependencies, like everything in tools/.

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Beside the sockets: one directory a person can chmod, back up, or delete. */
export function sessionFile() {
  return join(homedir(), '.cawdev', 'session.json');
}

function key(url) {
  return String(url).replace(/\/+$/, '');
}

async function readAll() {
  try {
    const parsed = JSON.parse(await readFile(sessionFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // No file, unreadable, or half-written. None of the three is worth an
    // error: the answer to all of them is "you are not signed in yet".
    return {};
  }
}

/** What was stored for one instance, or null. */
export async function loadSession(url) {
  const stored = (await readAll())[key(url)];
  if (!stored?.cookies || !stored.email) {
    return null;
  }
  return { email: stored.email, cookies: new Map(Object.entries(stored.cookies)) };
}

/**
 * Remember a session for next time.
 *
 * The directory is created 0700 and the file forced to 0600 **after** writing:
 * `writeFile`'s mode is masked by the process umask, so asking for 0600 and
 * getting 0644 is the normal outcome rather than the unusual one, and a
 * world-readable session cookie is the whole thing this file must not be.
 */
export async function saveSession(url, { email, cookies }) {
  const all = await readAll();
  all[key(url)] = {
    email,
    cookies: Object.fromEntries(cookies instanceof Map ? cookies : Object.entries(cookies ?? {})),
    savedAt: new Date().toISOString(),
  };
  await mkdir(dirname(sessionFile()), { recursive: true, mode: 0o700 });
  await writeFile(sessionFile(), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await chmod(sessionFile(), 0o600).catch(() => undefined);
}

/** Forget one instance. Signing out, and what a dead cookie earns. */
export async function clearSession(url) {
  const all = await readAll();
  if (!(key(url) in all)) {
    return;
  }
  delete all[key(url)];
  await mkdir(dirname(sessionFile()), { recursive: true, mode: 0o700 });
  await writeFile(sessionFile(), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await chmod(sessionFile(), 0o600).catch(() => undefined);
}
