import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FOLD_OVER_LINES, branchDiff, fileAt, foldedByDefault, layoutDiff, parseDiff, printableDiffLine,
} from './diff-view.mjs';

const plain = new Proxy({}, { get: () => (text) => text });

const DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' export { a, b };',
  'diff --git a/README.md b/README.md',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/README.md',
  '@@ -0,0 +1 @@',
  '+# Hello',
  'diff --git a/old.txt b/new.txt',
  'similarity index 100%',
  'rename from old.txt',
  'rename to new.txt',
  'diff --git a/logo.png b/logo.png',
  'deleted file mode 100644',
  'Binary files a/logo.png and /dev/null differ',
  '',
].join('\n');

test('a diff becomes files: status, counts and the lines under each hunk', () => {
  const files = parseDiff(DIFF);
  assert.deepEqual(files.map((file) => [file.path, file.status, file.additions, file.deletions, file.binary]), [
    ['src/app.js', 'modified', 1, 1, false],
    ['README.md', 'added', 1, 0, false],
    ['new.txt', 'renamed', 0, 0, false],
    ['logo.png', 'deleted', 0, 0, true],
  ]);
  assert.equal(files[2].oldPath, 'old.txt');
  assert.deepEqual(files[0].lines.map((line) => line.kind), ['hunk', 'ctx', 'del', 'add', 'ctx']);
});

test('generated, binary and very long files open folded', () => {
  const file = (path, lines = 1, binary = false) => ({ path, binary, lines: Array.from({ length: lines }, () => ({})) });
  assert.equal(foldedByDefault(file('frontend/package-lock.json')), true);
  assert.equal(foldedByDefault(file('Cargo.lock')), true);
  assert.equal(foldedByDefault(file('logo.png', 0, true)), true);
  assert.equal(foldedByDefault(file('src/big.js', FOLD_OVER_LINES + 1)), true);
  assert.equal(foldedByDefault(file('src/app.js', 10)), false);
});

test('the layout names every file, and each file header row is known for n and p', () => {
  const files = parseDiff(DIFF);
  const { rows, fileRows } = layoutDiff({ files, folded: new Set(['README.md']), branch: 'r42-x', base: 'main' }, 80, plain);
  assert.equal(rows[0], 'r42-x into main  4 files +2 −1');
  assert.equal(fileRows.length, 4);
  assert.match(rows[fileRows[0]], /^▾ src\/app\.js/);
  assert.match(rows[fileRows[1]], /^▸ README\.md/);
  assert.match(rows[fileRows[1] + 1], /folded: 2 lines/);
  assert.match(rows[fileRows[2]], /old\.txt → new\.txt/);
  assert.equal(rows[fileRows[3] + 1], '  binary: not drawn');
  assert.ok(rows.includes('+const b = 3;'));
  assert.equal(fileAt(fileRows, 0), -1);
  assert.equal(fileAt(fileRows, fileRows[1] + 1), 1);
});

test('a file\'s bytes cannot drive the terminal', () => {
  assert.equal(printableDiffLine('+\x1b]0;owned\x07\tx'), '+�]0;owned�    x');
});

test('the diff of a real branch, from the merge base, after a fetch that may fail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diff-view-'));
  const sh = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  try {
    sh('init', '-q', '-b', 'main');
    sh('config', 'user.email', 't@example.com');
    sh('config', 'user.name', 'T');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    sh('add', '.');
    sh('commit', '-q', '-m', 'base');
    sh('switch', '-q', '-c', 'r42-x');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
    sh('commit', '-q', '-am', 'branch');
    sh('switch', '-q', 'main');
    // main moving on is not the branch's change: three dots, from the merge base.
    writeFileSync(join(dir, 'b.txt'), 'main only\n');
    sh('add', '.');
    sh('commit', '-q', '-m', 'main moves');

    const diff = await branchDiff(dir, { branch: 'r42-x', base: 'main' });
    assert.equal(diff.stale, true, 'no origin here, so the fetch failed and it said so');
    assert.deepEqual(diff.files.map((file) => [file.path, file.additions]), [['a.txt', 1]]);
    await assert.rejects(branchDiff(dir, { branch: 'nope', base: 'main' }), /nope is not in/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
