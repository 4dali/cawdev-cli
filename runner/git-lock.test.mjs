// /clean: the git lock a crash left behind (git-lock.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeStaleLock, staleLockOf } from './git-lock.mjs';

const SAID = (path) => `git checkout -b r104-x origin/main failed: fatal: Unable to create '${path}': File exists.\n\nAnother git process seems to be running`;

test('the lock is read from the failure and trusted only inside the run\'s checkout', () => {
  const ws = '/work/saasng';
  assert.equal(staleLockOf(SAID('/work/saasng/.git/index.lock'), ws), '/work/saasng/.git/index.lock');
  assert.equal(staleLockOf(SAID('/work/saasng/.git/index.lock'), `${ws}/`), '/work/saasng/.git/index.lock');
  assert.equal(staleLockOf(SAID('/work/saasng/.git/worktrees/saasng-read/index.lock'), '/work/saasng-read'),
    '/work/saasng/.git/worktrees/saasng-read/index.lock', 'the reading worktree');
  assert.equal(staleLockOf(SAID('/work/other/.git/index.lock'), ws), null, 'another checkout');
  assert.equal(staleLockOf(SAID('/work/saasng/.git/../../etc/x.lock'), ws), null, 'no climbing out');
  assert.equal(staleLockOf(SAID('/work/saasng/.git/index.lock'), null), null, 'no checkout said');
  assert.equal(staleLockOf('/work/saasng has uncommitted changes', ws), null, 'another failure');
  assert.equal(staleLockOf(null, ws), null);
});

test('an old lock is removed; a young one, or none, is left and said', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-lock-'));
  await mkdir(join(dir, '.git'));
  const lock = join(dir, '.git', 'index.lock');
  await writeFile(lock, '');

  const young = await removeStaleLock(lock);
  assert.equal(young.removed, false);
  assert.match(young.said, /a git may still hold it/);
  await access(lock);

  const old = (Date.now() - 5 * 60_000) / 1000;
  await utimes(lock, old, old);
  assert.deepEqual(await removeStaleLock(lock), { removed: true, said: `removed ${lock}` });
  await assert.rejects(access(lock));

  const gone = await removeStaleLock(lock);
  assert.equal(gone.removed, false);
  assert.match(gone.said, /already gone/);
});
