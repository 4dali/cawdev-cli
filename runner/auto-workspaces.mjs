// Checkouts made on demand — a second coding session on a project starts at
// once instead of waiting for the first one's checkout.
//
// R47 made a project's concurrency the number of its checkouts, and every one
// had to be written into the config by hand. With `autoWorkspaces: N` in the
// machine's config, the daemon makes up to N more itself when a coding run
// would otherwise wait for "no free workspace": a CLONE beside the first
// checkout, named `<first>-auto-<n>`. A clone and not a `git worktree`, on
// purpose: the daemon resets a never-pushed branch by checking the default
// branch out, and git refuses to check out a branch another worktree has —
// two clones share nothing and cannot refuse each other anything.
//
// The clone is LOCAL — from the first checkout, which needs no credential and
// copies objects instead of downloading them — and its `origin` is then put
// back to the first checkout's own remote, so it pushes and fetches where
// every checkout of the project does.
//
// Nothing here writes the config. The clones are found again by their NAME
// (`discoverAutoWorkspaces`), at boot and on SIGHUP, so deleting one — the
// attached terminal's `/drop`, or `rm -rf` — is the whole of removing it.
// Configured checkouts are never touched: only a `-auto-<n>` directory is one
// of these.

import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** `<first>-auto-<n>`, and nothing else, is a checkout this module made. */
export function autoNumberOf(first, path) {
  const match = new RegExp(`^${escape(basename(first))}-auto-(\\d+)$`).exec(basename(path));
  return match && dirname(path) === dirname(first) ? Number(match[1]) : null;
}

/** Whether `path` is a checkout made on demand for the project whose first checkout is `first`. */
export function isAutoWorkspace(first, path) {
  return autoNumberOf(first, path) !== null;
}

/** The next free `-auto-<n>` beside `first`, numbered from 2 — the first checkout is 1. */
export function nextAutoWorkspace(first, existing) {
  const taken = new Set(existing.map((path) => autoNumberOf(first, path)).filter((n) => n !== null));
  let n = 2;
  while (taken.has(n)) n += 1;
  return join(dirname(first), `${basename(first)}-auto-${n}`);
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The on-demand checkouts that exist beside `first` right now, in number order. */
export async function discoverAutoWorkspaces(first) {
  let names;
  try {
    names = await readdir(dirname(first));
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    const path = join(dirname(first), name);
    if (autoNumberOf(first, path) === null) continue;
    const git = await stat(join(path, '.git')).catch(() => null);
    if (git) found.push(path);
  }
  return found.sort((a, b) => autoNumberOf(first, a) - autoNumberOf(first, b));
}

function run(cwd, args) {
  return new Promise((done, fail) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', fail);
    child.on('close', (code) => (code === 0
      ? done(out.trim())
      : fail(new Error(`git ${args.join(' ')} failed: ${err.trim() || `exit ${code}`}`))));
  });
}

/**
 * Makes one more checkout of the project whose first checkout is `first`.
 *
 * @returns the new path. Throws with git's own words when it cannot, and
 *   leaves nothing half-made behind that `discoverAutoWorkspaces` would take
 *   for a checkout: a failed clone has no `.git`.
 */
export async function createAutoWorkspace(first, existing) {
  const path = nextAutoWorkspace(first, existing);
  const origin = await run(first, ['remote', 'get-url', 'origin']).catch(() => null);
  await run(dirname(first), ['clone', '--quiet', first, path]);
  if (origin) {
    await run(path, ['remote', 'set-url', 'origin', origin]);
    // Best effort: the run about to use this checkout fetches before it
    // branches anyway, and a remote that wants a passphrase only a person can
    // type must not stop the checkout from existing.
    await run(path, ['fetch', '--quiet', '--prune', 'origin']).catch(() => null);
  }
  return path;
}
