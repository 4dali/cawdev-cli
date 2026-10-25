// node --test tools/lib/finish-check.test.mjs
//
// R345: a finished run is committed and pushed. Real repositories, a bare one
// as the remote, because what is being judged is git's own answer.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { isUnfinished, leftOver, notDoneYet, settleBranch } from './finish-check.mjs';

const run = promisify(execFile);
const git = async (cwd, ...args) => (await run('git', args, { cwd })).stdout.trim();
const BRANCH = 'r1-the-work';

/** A checkout on BRANCH, cloned from a bare remote whose main has one commit. */
async function aCheckout(t, { remote = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cawdev-finish-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const work = join(root, 'work');
  if (remote) {
    await run('git', ['init', '-q', '--bare', '-b', 'main', join(root, 'origin.git')]);
    await run('git', ['clone', '-q', join(root, 'origin.git'), work]);
  } else {
    await run('git', ['init', '-q', '-b', 'main', work]);
  }
  await git(work, 'config', 'user.email', 'test@cawdev.test');
  await git(work, 'config', 'user.name', 'test');
  await git(work, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(work, 'README.md'), 'hello\n');
  await git(work, 'add', '-A');
  await git(work, 'commit', '-q', '-m', 'first');
  if (remote) await git(work, 'push', '-q', 'origin', 'main');
  await git(work, 'switch', '-q', '-c', BRANCH);
  return { root, work, origin: join(root, 'origin.git') };
}

const push = async (cwd, branch) => {
  try {
    await git(cwd, 'push', '-q', '--set-upstream', 'origin', branch);
    return { ok: true, result: 'pushed' };
  } catch (failure) {
    return { ok: false, result: failure.stderr || failure.message };
  }
};

test('a branch with nothing new is finished, pushed or not — a run stopped at its gate', async (t) => {
  const { work } = await aCheckout(t);
  const left = await leftOver(work, BRANCH);
  assert.equal(isUnfinished(left), false, 'every commit on the branch is already on a remote');
  assert.deepEqual(await settleBranch(work, BRANCH, { push }), { ok: true, note: null });
});

test('uncommitted files are named, and the daemon commits and pushes them', async (t) => {
  const { work, origin } = await aCheckout(t);
  await writeFile(join(work, 'README.md'), 'changed\n');
  await writeFile(join(work, 'new.txt'), 'new\n');

  const left = await leftOver(work, BRANCH);
  assert.deepEqual(left.dirty.sort(), ['README.md', 'new.txt']);
  assert.equal(isUnfinished(left), true);
  assert.match(notDoneYet(left), /2 uncommitted file\(s\): `README.md`, `new.txt`/);
  assert.match(notDoneYet(left), /report done again/);

  const settled = await settleBranch(work, BRANCH, { push, label: 'R1' });
  assert.equal(settled.ok, true);
  assert.match(settled.note, /left 2 file\(s\) uncommitted .* committed them and pushed r1-the-work/);
  assert.equal(await git(work, 'status', '--porcelain'), '');
  assert.match(await git(origin, 'log', '-1', '--format=%s', BRANCH), /^R1: what the session left uncommitted/);
});

test('commits the remote has not seen are counted, and pushed', async (t) => {
  const { work, origin } = await aCheckout(t);
  await writeFile(join(work, 'a.txt'), 'a\n');
  await git(work, 'add', '-A');
  await git(work, 'commit', '-q', '-m', 'the work');

  const left = await leftOver(work, BRANCH);
  assert.equal(left.ahead, 1);
  assert.match(notDoneYet(left), /1 commit\(s\) on `r1-the-work` that origin has not seen/);

  const settled = await settleBranch(work, BRANCH, { push });
  assert.equal(settled.ok, true);
  assert.match(settled.note, /pushed r1-the-work, which the session had committed and not pushed/);
  assert.equal(await git(origin, 'log', '-1', '--format=%s', BRANCH), 'the work');
  assert.equal(isUnfinished(await leftOver(work, BRANCH)), false);
});

test('nothing that looks like a credential is committed: the work is held instead', async (t) => {
  const { work, origin } = await aCheckout(t);
  await writeFile(join(work, 'config.txt'), 'key = AKIAIOSFODNN7EXAMPLE\n');

  const settled = await settleBranch(work, BRANCH, { push });
  assert.equal(settled.ok, false);
  assert.match(settled.reason, /looks like .*did not commit it/);
  assert.match(await git(work, 'status', '--porcelain'), /\?\? config.txt/, 'left exactly as it was, unstaged');
  await assert.rejects(git(origin, 'rev-parse', '--verify', BRANCH), 'nothing reached the remote');
});

test('a remote that has moved is a reason, never a force', async (t) => {
  const { root, work, origin } = await aCheckout(t);
  await writeFile(join(work, 'a.txt'), 'a\n');
  await git(work, 'add', '-A');
  await git(work, 'commit', '-q', '-m', 'mine');
  // Somebody else pushes the same branch first.
  const other = join(root, 'other');
  await run('git', ['clone', '-q', origin, other]);
  await git(other, 'config', 'user.email', 'o@cawdev.test');
  await git(other, 'config', 'user.name', 'o');
  await git(other, 'switch', '-q', '-c', BRANCH);
  await writeFile(join(other, 'b.txt'), 'b\n');
  await git(other, 'add', '-A');
  await git(other, 'commit', '-q', '-m', 'theirs');
  await git(other, 'push', '-q', 'origin', BRANCH);

  const settled = await settleBranch(work, BRANCH, { push });
  assert.equal(settled.ok, false);
  assert.match(settled.reason, /r1-the-work could not be pushed/);
  assert.equal(await git(origin, 'log', '-1', '--format=%s', BRANCH), 'theirs', 'their commit stands');
});

test('with no remote, what is left is committed and nothing is asked of a push', async (t) => {
  const { work } = await aCheckout(t, { remote: false });
  assert.equal(isUnfinished(await leftOver(work, BRANCH)), false, 'commits with nowhere to go are not unpushed');
  await writeFile(join(work, 'a.txt'), 'a\n');
  let pushed = false;
  const settled = await settleBranch(work, BRANCH, { push: async () => { pushed = true; return { ok: true }; } });
  assert.equal(settled.ok, true);
  assert.match(settled.note, /no remote, so nothing was pushed/);
  assert.equal(pushed, false);
  assert.equal(await git(work, 'status', '--porcelain'), '');
});

test('dirty files on another branch are held, not committed to the wrong one', async (t) => {
  const { work } = await aCheckout(t);
  await git(work, 'switch', '-q', 'main');
  await writeFile(join(work, 'a.txt'), 'a\n');
  const left = await leftOver(work, BRANCH);
  assert.match(notDoneYet(left), /not on `r1-the-work`/);
  const settled = await settleBranch(work, BRANCH, { push });
  assert.equal(settled.ok, false);
  assert.match(settled.reason, /not on r1-the-work/);
});

test('not a checkout is nothing to judge', async () => {
  assert.equal(await leftOver(tmpdir() + '/cawdev-no-such-dir', BRANCH), null);
  assert.equal(isUnfinished(null), false);
  assert.equal(await leftOver(null, BRANCH), null);
});

// --- R562: protected files ---------------------------------------------------

test('a protected change is not committed or pushed, and the run is held', async (t) => {
  const { work, origin } = await aCheckout(t);
  const base = await git(work, 'rev-parse', 'HEAD');
  await mkdir(join(work, 'secret'));
  await writeFile(join(work, 'secret', 'a.txt'), 'a\n');

  const settled = await settleBranch(work, BRANCH, {
    push, protected: { globs: ['secret/**'], base, allowed: [] },
  });

  assert.equal(settled.ok, false);
  assert.match(settled.reason, /`secret\/a\.txt` is protected in this project/);
  assert.match(settled.reason, /nothing was committed or pushed/);
  assert.match(await git(work, 'status', '--porcelain'), /secret/, 'left in the checkout');
  assert.equal(await git(origin, 'branch', '--list', BRANCH), '', 'never pushed');
});

test('the same change, once a person allowed it, is committed and pushed', async (t) => {
  const { work, origin } = await aCheckout(t);
  const base = await git(work, 'rev-parse', 'HEAD');
  await mkdir(join(work, 'secret'));
  await writeFile(join(work, 'secret', 'a.txt'), 'a\n');

  const settled = await settleBranch(work, BRANCH, {
    push, protected: { globs: ['secret/**'], base, allowed: ['secret/a.txt'] },
  });

  assert.equal(settled.ok, true);
  assert.match(await git(origin, 'branch', '--list', BRANCH), new RegExp(BRANCH));
});

test('a protected change that is already committed and pushed is still caught', async (t) => {
  const { work } = await aCheckout(t);
  const base = await git(work, 'rev-parse', 'HEAD');
  await mkdir(join(work, 'secret'));
  await writeFile(join(work, 'secret', 'a.txt'), 'a\n');
  await git(work, 'add', '-A');
  await git(work, 'commit', '-q', '-m', 'the work');
  await push(work, BRANCH);

  const settled = await settleBranch(work, BRANCH, {
    push, protected: { globs: ['secret/**'], base, allowed: [] },
  });

  assert.equal(settled.ok, false);
  assert.match(settled.reason, /secret\/a\.txt/);
});
