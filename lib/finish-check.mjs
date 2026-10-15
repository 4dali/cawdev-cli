// A finished run is committed and pushed — R345.
//
// R325's run ended FINISHED with a file modified and its branch never pushed,
// and the next run in that checkout refused to start on top of it. Nothing
// between a coding session's last turn and FINISHED looked at the checkout:
// the merge run did (`finishMerge`), an ordinary CODE run did not, on either
// door — the daemon's `finish` or the session's own `report done`.
//
// Two answers, one per door, both reading `leftOver`:
//   - `report done` refuses while anything is left and says what, so the
//     session — which knows what the files are — commits them in its own turn;
//   - the daemon, when it is the one ending the run, `settleBranch`es: commits
//     what is left and pushes, or reports why it could not, which the caller
//     turns into FAILED with the checkout held (R80) instead of a FINISHED
//     that strands the next run.
//
// No `--force`, ever, and nothing committed that looks like a credential: a
// finish that pushes a key is worse than one that leaves a file behind.

import { execFile } from 'node:child_process';
import { findSecret } from './secrets.mjs';

/** The profiles whose run is a branch somebody will build on. */
export const COMMITS_ITS_WORK = new Set(['CODE']);

/** How many paths a refusal or a summary names; the count still tells the truth. */
const NAMED = 10;

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (failure, stdout, stderr) => {
      if (failure) {
        failure.message = (stderr || failure.message).trim();
        reject(failure);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * What a run left in its checkout that is not on the remote: uncommitted
 * paths, and how many commits on `branch` no remote ref contains — the work a
 * push would carry. Measured against EVERY remote ref, not `origin/<branch>`,
 * so a branch the remote has never seen but whose commits are all on `main`
 * (a run stopped at its plan gate) is not "unpushed work", and a checkout
 * with no remote at all has nothing to push. `null` when the directory is not
 * a git checkout we can read: nothing to judge is not a failure to judge.
 */
export async function leftOver(cwd, branch, { git = runGit } = {}) {
  if (!cwd || !branch) return null;
  let status;
  try {
    status = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  } catch {
    return null;
  }
  const dirty = status.split('\n').map((line) => line.slice(3).trim()).filter(Boolean);
  const current = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  const remote = (await git(cwd, ['remote']).catch(() => '')).split('\n')[0]?.trim() || null;
  const exists = await git(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])
    .then(() => true, () => false);
  let ahead = 0;
  if (remote && exists) {
    const counted = await git(cwd, ['rev-list', '--count', branch, '--not', '--remotes'])
      .catch(() => '0');
    ahead = Number(counted.trim()) || 0;
  }
  return { dirty, ahead, remote, onBranch: current === branch, branch };
}

/** Whether anything is left — what both doors ask first. */
export function isUnfinished(left) {
  return Boolean(left) && (left.dirty.length > 0 || left.ahead > 0);
}

function named(paths) {
  const shown = paths.slice(0, NAMED).map((path) => `\`${path}\``).join(', ');
  return paths.length > NAMED ? `${shown} and ${paths.length - NAMED} more` : shown;
}

/**
 * What `report done` says instead of finishing — to the session, which can fix
 * it. Names the files and the commits, and says what "done" means here.
 */
export function notDoneYet(left) {
  const what = [];
  if (!left.onBranch && left.dirty.length) {
    what.push(`the checkout is not on \`${left.branch}\``);
  }
  if (left.dirty.length) {
    what.push(`${left.dirty.length} uncommitted file(s): ${named(left.dirty)}`);
  }
  if (left.ahead > 0) {
    what.push(`${left.ahead} commit(s) on \`${left.branch}\` that ${left.remote} has not seen`);
  }
  return `Not finished yet — the run is still open. A finished run is committed and pushed, `
    + `and this one has ${what.join('; ')}. Commit what belongs to this work on `
    + `\`${left.branch}\` (discard what does not), \`git push\`, then report done again. If `
    + 'something stops you, report blocked and say what.';
}

/**
 * Commits what the session left and pushes the branch — the daemon's door.
 *
 * Returns `{ ok: true, note }` when the branch is clean and on the remote (the
 * note says what was done on the session's behalf, or is null when nothing
 * was), and `{ ok: false, reason }` otherwise, in words for the run's summary.
 * Never forces; a remote that has moved is a reason, not something to win.
 */
export async function settleBranch(cwd, branch, { git = runGit, push, label = 'cawdev' } = {}) {
  const left = await leftOver(cwd, branch, { git });
  if (!left || !isUnfinished(left)) {
    return { ok: true, note: null };
  }
  if (!left.onBranch && left.dirty.length) {
    return {
      ok: false,
      reason: `The checkout is not on ${branch}, so the daemon did not commit or push anything `
        + 'for it. The work is held in the checkout.',
    };
  }

  let committed = [];
  if (left.dirty.length) {
    await git(cwd, ['add', '-A']);
    const staged = await git(cwd, ['diff', '--cached']).catch(() => '');
    const secret = findSecret(staged);
    if (secret) {
      await git(cwd, ['reset', '-q']).catch(() => null);
      return {
        ok: false,
        reason: `The session left ${left.dirty.length} uncommitted file(s) (${named(left.dirty)}), `
          + `and the change contains what looks like ${secret.name}, so the daemon did not `
          + 'commit it. The work is held in the checkout: commit what belongs, or discard it.',
      };
    }
    try {
      await git(cwd, ['commit', '-q', '-m', `${label}: what the session left uncommitted`,
        '-m', `Committed by the cawdev daemon as the run finished (R345): ${left.dirty.join(', ')}`]);
      committed = left.dirty;
    } catch (failure) {
      await git(cwd, ['reset', '-q']).catch(() => null);
      return {
        ok: false,
        reason: `The session left ${left.dirty.length} uncommitted file(s) (${named(left.dirty)}) and `
          + `committing them failed: ${failure.message.split('\n')[0]}. The work is held in the checkout.`,
      };
    }
  }

  if (!left.remote) {
    return {
      ok: true,
      note: committed.length
        ? `The session left ${committed.length} file(s) uncommitted (${named(committed)}); the `
          + 'daemon committed them. This checkout has no remote, so nothing was pushed.'
        : null,
    };
  }
  const pushed = await push(cwd, branch);
  if (!pushed.ok) {
    return {
      ok: false,
      reason: `${branch} could not be pushed: ${String(pushed.result).split('\n')[0]}`
        + (committed.length ? ` (the daemon had committed ${named(committed)} first)` : '')
        + '. The work is held in the checkout.',
    };
  }
  return {
    ok: true,
    note: committed.length
      ? `The session left ${committed.length} file(s) uncommitted (${named(committed)}); the `
        + `daemon committed them and pushed ${branch}.`
      : `The daemon pushed ${branch}, which the session had committed and not pushed.`,
  };
}
