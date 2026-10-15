// node --test tools/runner/changed-lines.test.mjs
//
// R316: `parseUnifiedZero` is pinned against hand-built unified-diff text —
// the hunk arithmetic is the part worth getting right without a repository —
// and `changedLines` end to end against a real temporary repository, because
// that is the only way to prove the working tree (not just HEAD) is diffed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedLines, parseUnifiedZero } from './changed-lines.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test('a pure deletion adds nothing', () => {
  const diff = [
    'diff --git a/f.txt b/f.txt',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -12,5 +12,0 @@',
    '-old one',
    '-old two',
    '',
  ].join('\n');
  assert.deepEqual(parseUnifiedZero(diff), new Map([['f.txt', new Set()]]));
});

test('+5 with no comma counts line 5 only', () => {
  const diff = [
    'diff --git a/f.txt b/f.txt',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -4,0 +5 @@',
    '+new line',
    '',
  ].join('\n');
  assert.deepEqual(parseUnifiedZero(diff), new Map([['f.txt', new Set([5])]]));
});

test('+5,3 counts lines 5 through 7', () => {
  const diff = [
    'diff --git a/f.txt b/f.txt',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -4,0 +5,3 @@',
    '+a',
    '+b',
    '+c',
    '',
  ].join('\n');
  assert.deepEqual(parseUnifiedZero(diff), new Map([['f.txt', new Set([5, 6, 7])]]));
});

test('a deleted file (+++ /dev/null) is skipped', () => {
  const diff = [
    'diff --git a/gone.txt b/gone.txt',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-bye',
    '-bye',
    '',
  ].join('\n');
  assert.deepEqual(parseUnifiedZero(diff), new Map());
});

test('a path with a space is read whole', () => {
  const diff = [
    'diff --git a/a file.txt b/a file.txt',
    '--- a/a file.txt',
    '+++ b/a file.txt',
    '@@ -0,0 +1 @@',
    '+hi',
    '',
  ].join('\n');
  assert.deepEqual(parseUnifiedZero(diff), new Map([['a file.txt', new Set([1])]]));
});

test('changedLines against a real repository: tracked edits (even uncommitted) and untracked files', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'cawdev-changed-lines-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);

  writeFileSync(join(repo, 'kept.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(repo, 'untouched.txt'), 'same\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']).trim();

  // An uncommitted edit to a tracked file — changedLines must see it without
  // a second commit, because the scratch scan runs before anything commits.
  writeFileSync(join(repo, 'kept.txt'), 'one\ntwo point five\ntwo point six\nthree\n');
  writeFileSync(join(repo, 'new.txt'), 'brand new\n');

  const changed = await changedLines(repo, base);
  assert.deepEqual(changed.get('kept.txt'), new Set([2, 3]));
  assert.equal(changed.get('untouched.txt'), undefined);
  assert.equal(changed.get('new.txt'), 'ALL');
});
