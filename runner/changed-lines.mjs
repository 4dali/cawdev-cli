// R316: which lines a branch changed since it left its base.
//
// A scratch SonarQube project (scanAsScratchProject in runner.mjs) has no
// new-code period of its own to compare against — it is overwritten on every
// run of the branch, so SonarQube has never seen a "previous version" of it.
// "New" is redefined here as "on a line this branch changed since the
// merge-base", computed from git rather than from SonarQube.
//
// `parseUnifiedZero` is kept as its own pure function — the hunk arithmetic
// is the part worth getting right without a repository to run it against.

import { spawn } from 'node:child_process';

function git(cwd, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolvePromise(out)
        : reject(new Error(`git ${args.join(' ')} failed: ${
            err.trim() || out.trim() || `exit ${code}, and it said nothing`}`)),
    );
  });
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * `git diff -U0`'s zero-context unified output, as `Map<path, Set<line>>` of
 * the lines each touched file gained. A deleted file (`+++ /dev/null`) is
 * skipped — it has no lines left to be new on. `d` missing on a hunk header
 * means one line added; `d` present as `0` means the hunk is a pure deletion
 * and adds none.
 */
export function parseUnifiedZero(text) {
  const changed = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      current = path === '/dev/null' ? null : path.replace(/^b\//, '');
      if (current && !changed.has(current)) {
        changed.set(current, new Set());
      }
      continue;
    }
    if (current === null) {
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const set = changed.get(current);
      for (let offset = 0; offset < count; offset += 1) {
        set.add(start + offset);
      }
    }
  }
  return changed;
}

/**
 * What `branch` changed since `base`, as `Map<path, Set<line> | 'ALL'>`.
 *
 * Diffs the working tree rather than `HEAD` — a coding run's uncommitted
 * edits count too, which is the point: the scratch scan runs before anything
 * is committed. An untracked file has no diff to parse and counts whole.
 */
export async function changedLines(cwd, base) {
  const diff = await git(cwd,
    ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', base]);
  const changed = parseUnifiedZero(diff);
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
  for (const rawPath of untracked.split('\n')) {
    const path = rawPath.trim();
    if (path) {
      changed.set(path, 'ALL');
    }
  }
  return changed;
}
