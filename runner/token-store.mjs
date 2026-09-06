// Where this machine keeps its runner token — and why it is not in the config.
//
// R93 promised that no token is ever typed. It kept that promise for a machine
// with NO config, by writing one into the config it generated. A machine that
// already HAD a config fell through: `cawdev` started a daemon, `readConfig`
// refused to boot, and the log said "mint one in the console under Agent
// tokens" — the hand-carried secret R93 exists to abolish, reached by a
// different door.
//
// **The fix cannot be "write it into whichever config we found."** A config
// names working copies and permissions, so it is the kind of file people keep
// beside the code and commit — `tools/runner/macbook-laptop.json` in this very
// repository is tracked. Putting a credential in one is how a
// `runner:operate` token ends up in a git history, and CLAUDE.md's rule that
// secrets are gitignored is not a rule about `.env` in particular.
//
// So the credential lives on its own, here, the way `session.json` does and for
// the same reason: what a person is and what a machine may do are two
// different secrets with two different lifetimes, and R52's rule that a run's
// credential can never be borrowed for a decision is exactly why they are not
// one file.
//
// Keyed by URL, because one machine can point at more than one cawdev and a
// token minted against one instance is not a credential at another.
//
// A token IN a config still works and is read first — R93's own generated file
// is that shape, it is written 0600 under `~/.cawdev`, and breaking every
// machine set up before this would be a poor way to remove some friction.
//
// Zero dependencies, like everything in tools/.

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Beside the session and the sockets: one directory a person can delete. */
export function tokenFile() {
  return join(homedir(), '.cawdev', 'token.json');
}

function key(url) {
  return String(url).replace(/\/+$/, '');
}

async function readAll() {
  try {
    const parsed = JSON.parse(await readFile(tokenFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // No file, unreadable, or half-written. The answer to all three is the
    // same — this machine has not minted one yet — and that is a state
    // `cawdev` knows how to leave.
    return {};
  }
}

/** The token stored for one instance, or null. */
export async function loadToken(url) {
  const stored = (await readAll())[key(url)];
  return typeof stored?.token === 'string' && stored.token ? stored.token : null;
}

/**
 * Remember the token this machine minted for itself.
 *
 * 0700 on the directory and 0600 forced **after** the write, because
 * `writeFile`'s mode is masked by the umask and is ignored outright for a file
 * that already exists — so asking for 0600 and getting 0644 is the ordinary
 * outcome rather than the unusual one.
 */
export async function saveToken(url, token, { name = null } = {}) {
  const all = await readAll();
  all[key(url)] = { token, name, mintedAt: new Date().toISOString() };
  await mkdir(dirname(tokenFile()), { recursive: true, mode: 0o700 });
  await writeFile(tokenFile(), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await chmod(tokenFile(), 0o600).catch(() => undefined);
}

/**
 * Forget one instance's token.
 *
 * This does NOT revoke it — the platform is where a token dies, and a CLI that
 * pretended otherwise would leave a live credential behind a reassuring
 * message. Removing the file is removing this machine's copy, and the caller
 * says so.
 */
export async function clearToken(url) {
  const all = await readAll();
  if (!(key(url) in all)) {
    return;
  }
  delete all[key(url)];
  await mkdir(dirname(tokenFile()), { recursive: true, mode: 0o700 });
  await writeFile(tokenFile(), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await chmod(tokenFile(), 0o600).catch(() => undefined);
}
