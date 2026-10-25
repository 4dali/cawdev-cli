// Protected files — R562.
//
// A project lists globs an agent may not change. Three layers enforce it and
// this is the part that does not depend on the CLI: `protectedChanges` compares
// the branch with the commit it was cut from, so it catches an Edit, a shell
// `git checkout main -- pom.xml`, a `git mv`, a `sed -i` and a build step alike,
// on every CLI and on a machine set to allow everything.
//
// Zero dependencies, like the rest of tools/.

import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { matches, normalise } from './secrets.mjs';
import { byCodeUnit } from './order.mjs';

/** The modes a project can choose. REFUSE is what an unreadable policy means. */
export const MODES = ['REFUSE', 'ASK'];

/**
 * The policy out of a shield, whatever shape it arrived in.
 *
 * Unreadable or missing is REFUSE with no globs — never a way of allowing.
 */
export function protectedPolicy(shield) {
  const globs = Array.isArray(shield?.protectedPaths)
    ? shield.protectedPaths.filter((glob) => typeof glob === 'string' && glob.trim())
      .map((glob) => glob.trim())
    : [];
  const mode = String(shield?.protectedMode ?? '').toUpperCase() === 'ASK' ? 'ASK' : 'REFUSE';
  const allowed = Array.isArray(shield?.protectedAllowed)
    ? shield.protectedAllowed.filter((path) => typeof path === 'string')
    : [];
  return { globs, mode, allowed };
}

/**
 * Whether a path, absolute or relative to the checkout, is a protected one.
 *
 * A path that leaves the checkout is not protected here — it is the scope
 * rule's business — and a symlink is followed when it exists, so a link into a
 * protected directory is the directory.
 */
export function isProtected(path, root, globs) {
  if (typeof path !== 'string' || !path || !Array.isArray(globs) || globs.length === 0) {
    return false;
  }
  const base = normalise(root);
  const candidates = [normalise(path.startsWith('/') ? path : `${base}/${path}`)];
  const real = resolveReal(candidates[0]);
  if (real && real !== candidates[0]) {
    candidates.push(real);
  }
  let realBase = base;
  try {
    realBase = realpathSync(base);
  } catch {
    // The checkout is not there; the lexical answer stands.
  }
  return candidates.some((resolved) => {
    for (const root of [base, realBase]) {
      if (resolved === root || resolved.startsWith(`${root}/`)) {
        const relative = resolved === root ? '' : resolved.slice(root.length + 1);
        return globs.some((glob) => matchesHere(relative, glob.replace(/^\.\//, '')));
      }
    }
    return false;
  });
}

/**
 * Whether a relative path is under a glob. On macOS and Windows the default
 * volume is case-insensitive, so `POM.XML` IS `pom.xml` there; comparing
 * without case protects a little more than a case-sensitive volume needs, which
 * is the safe direction to be wrong in.
 */
function matchesHere(path, glob) {
  return process.platform === 'darwin' || process.platform === 'win32'
    ? matches(path.toLowerCase(), glob.toLowerCase())
    : matches(path, glob);
}

/** The real path of the longest part that exists, with the rest appended. */
function resolveReal(path) {
  const parts = path.split('/');
  for (let keep = parts.length; keep > 1; keep -= 1) {
    const head = parts.slice(0, keep).join('/') || '/';
    try {
      const real = realpathSync(head);
      return normalise([real, ...parts.slice(keep)].join('/'));
    } catch {
      // Not there yet; try the parent.
    }
  }
  return null;
}

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * The protected paths this branch changes, sorted and unique.
 *
 * The committed diff against `base` (a diff, not a log, so a change later
 * reverted does not count; `--no-renames`, so moving a protected file away is
 * caught on its old path) plus the working tree. Empty when there is nothing to
 * judge: no globs, or no base.
 */
export async function protectedChanges(cwd, base, globs, { git = runGit } = {}) {
  if (!base || !Array.isArray(globs) || globs.length === 0) {
    return [];
  }
  const touched = new Set();
  // A git failure THROWS. An unreadable base (garbage-collected, a shallow
  // clone) is not a reason to say the branch is clean: the callers turn a throw
  // into a refusal, which is the direction this fails in.
  const diff = await git(cwd, ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD']);
  for (const path of diff.split('\0')) {
    if (path) {
      touched.add(path);
    }
  }
  const status = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  const entries = status.split('\0');
  for (let at = 0; at < entries.length; at += 1) {
    const entry = entries[at];
    if (entry.length < 4) {
      continue;
    }
    touched.add(entry.slice(3));
    // A rename or copy carries the old path as the next field.
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
      at += 1;
      if (entries[at]) {
        touched.add(entries[at]);
      }
    }
  }
  return [...touched]
    .filter((path) => globs.some((glob) => matchesHere(path, glob.replace(/^\.\//, ''))))
    .sort(byCodeUnit);
}

/** The base a branch was cut from: the merge-base with its upstream, else the claim's commit. */
export async function protectedBase(cwd, baseBranch, fallback, { git = runGit } = {}) {
  if (baseBranch) {
    for (const ref of [`origin/${baseBranch}`, baseBranch]) {
      try {
        const sha = (await git(cwd, ['merge-base', ref, 'HEAD'])).trim();
        if (sha) {
          return sha;
        }
      } catch {
        // Try the next ref.
      }
    }
  }
  return fallback || null;
}

/** What is changed and not allowed. */
export function notAllowed(changed, allowed = []) {
  const leave = new Set(allowed);
  return changed.filter((path) => !leave.has(path));
}

/** The sentence a refusal gives, shared by every door. */
export function protectedRefusal(paths, base) {
  const list = paths.join(', ');
  return `Not finished — this branch changes protected file(s) the project never lets an agent `
    + `change: ${list}. Restore them (git checkout ${base ? base.slice(0, 12) : '<base>'} -- `
    + `<path>, or delete what you added), commit, push, and report done again.`;
}

/** The paragraph every prompt carries. Null when nothing is protected. */
export function protectedLine(policy, already = []) {
  const globs = policy?.globs ?? [];
  if (!globs.length) {
    return null;
  }
  const how = policy.mode === 'ASK'
    ? 'Changing one stops and asks a person first, and an allowed change is marked on the card in '
      + 'red; prefer a design that leaves them alone.'
    : 'An agent never changes them — not with an edit, not with the shell, not with git; the run '
      + 'cannot finish while the branch changes one.';
  const lines = [
    `**Protected files.** This project protects: ${globs.map((glob) => `\`${glob}\``).join(', ')}. `
      + `${how} Check your plan against this list before you start.`,
  ];
  if (already.length) {
    lines.push(`This branch already changes ${already.map((path) => `\`${path}\``).join(', ')}, `
      + 'which are protected; deal with that first.');
  }
  return lines.join('\n\n');
}

/**
 * Rules for the CLI's permission list, one per glob.
 *
 * Only `Edit(path)` is matched — Claude Code rejects `Write(path)` as "not
 * matched by file permission checks" and applies Edit rules to every
 * file-editing tool, NotebookEdit included (measured on 2.1.307; see
 * `protectFiles` in the runner).
 */
export function denyRules(globs) {
  return (globs ?? []).map((glob) => `Edit(./${glob.replace(/^\.\//, '')})`);
}

/** A path relative to the checkout, or null when it is outside it. */
export function relativeTo(path, root) {
  const base = normalise(root);
  const resolved = normalise(String(path).startsWith('/') ? String(path) : `${base}/${path}`);
  if (resolved === base) {
    return '';
  }
  return resolved.startsWith(`${base}/`) ? resolved.slice(base.length + 1) : null;
}
