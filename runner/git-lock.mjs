/**
 * A git lock a crash left behind, and the `/clean` that removes it.
 *
 * When the machine dies mid-git (a crash, a power cut), git leaves
 * `.git/index.lock` behind and refuses every later command in that checkout
 * with "Unable to create '…/index.lock': File exists". Every session that
 * prepares its branch there fails the same way, and `/continue` alone only
 * fails again. `/clean` removes the lock; `/continue` then picks the session up.
 *
 * <strong>The path is read from the failure, then checked against the run's
 * own checkout.</strong> The failure text travels through the platform, so it
 * is trusted no further than a lock file inside `<workspace>/.git/` (or the
 * reading worktree's admin directory beside it). Anything else is refused, and
 * the path is named so a person can judge it.
 *
 * <strong>Young locks are left alone.</strong> A lock a live git holds is
 * seconds old at most, because the daemon never opens an editor; one older
 * than `MIN_AGE_MS` is a leftover. Refusing a fresh one is the direction
 * `tool-rules.mjs` fails in: unsure means held.
 */
import { rm, stat } from 'node:fs/promises';
import { basename, sep } from 'node:path';

/** How old a lock must be before `/clean` calls it a leftover. */
export const MIN_AGE_MS = 60_000;

const LOCK_SAID = /Unable to create '([^']+\.lock)': File exists/;

/**
 * The stale lock a session stopped on, or null. `said` is the run's
 * `exitSummary`; `workspace` the checkout it ran in. Pure.
 */
export function staleLockOf(said, workspace) {
  const path = LOCK_SAID.exec(String(said ?? ''))?.[1];
  if (!path || !workspace || path.includes(`${sep}..${sep}`)) {
    return null;
  }
  const root = workspace.endsWith(sep) ? workspace.slice(0, -1) : workspace;
  const own = path.startsWith(`${root}${sep}.git${sep}`);
  // The reading copy (`<first>-read`) is a worktree: its lock lives in the
  // main checkout's `.git/worktrees/<name>/`.
  const worktree = path.includes(`${sep}.git${sep}worktrees${sep}${basename(root)}${sep}`);
  return own || worktree ? path : null;
}

/**
 * Removes the lock if it is old enough to be a leftover. Resolves to what was
 * done, in words the terminal prints: `{ removed, said }`. Never throws.
 */
export async function removeStaleLock(path, { now = Date.now(), minAgeMs = MIN_AGE_MS } = {}) {
  let info;
  try {
    info = await stat(path);
  } catch (failure) {
    if (failure.code === 'ENOENT') {
      return { removed: false, said: `${path} is already gone — /continue picks it back up` };
    }
    return { removed: false, said: `could not read ${path}: ${failure.message}` };
  }
  const age = now - info.mtimeMs;
  if (age < minAgeMs) {
    return {
      removed: false,
      said: `${path} is ${Math.max(0, Math.round(age / 1000))}s old — a git may still hold it; try again in a minute`,
    };
  }
  try {
    await rm(path);
  } catch (failure) {
    return { removed: false, said: `could not remove ${path}: ${failure.message}` };
  }
  return { removed: true, said: `removed ${path}` };
}
