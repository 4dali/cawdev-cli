// node --test tools/runner/paths.test.mjs
//
// R289 — where a checkout goes, and what is there already.
//
// The pure half is pinned as a table: `~` expands the way the shell expands it,
// tab completes as far as the matches agree, two spellings of one repository
// are one repository. `inspectPath` is run against real folders — a git
// checkout made for the test, an empty one, a file — because the whole point
// of it is to read the disk correctly, and a fake filesystem would only prove
// the fake.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TYPE_A_PATH, absolute, completePath, describe, expandHome, inspectPath, sameRepository,
  suggestProjectPaths, suggestWorkspacePaths, usable,
} from './paths.mjs';
import { plainAskPath } from './configure.mjs';
import { pickFromLine } from './select.mjs';

const HOME = '/home/alice';

test('~ expands to the home directory, and only a leading ~', () => {
  assert.equal(expandHome('~', HOME), HOME);
  assert.equal(expandHome('~/code/x', HOME), '/home/alice/code/x');
  assert.equal(expandHome('/srv/~/x', HOME), '/srv/~/x');
  assert.equal(expandHome('~bob/x', HOME), '~bob/x', 'another user\'s home is not guessed at');
  assert.equal(absolute('~/code/x', HOME), '/home/alice/code/x', 'the bug: resolve alone made this <cwd>/~/code/x');
});

test('a new project is suggested beside the checkouts already served, then under the default root', () => {
  const file = { projects: { cawdev: '/work/team/cawdev', other: { workspaces: ['/work/team/other', '/tmp/other-2'] } } };
  assert.deepEqual(suggestProjectPaths(file, 'dycrypt', { home: HOME }), [
    { path: '/work/team/dycrypt', why: 'beside cawdev' },
    { path: '/tmp/dycrypt', why: 'beside other-2' },
    { path: '/home/alice/cawdev/dycrypt', why: 'the default' },
  ]);
  assert.deepEqual(suggestProjectPaths({}, 'dycrypt', { home: HOME }),
    [{ path: '/home/alice/cawdev/dycrypt', why: 'the default' }]);
});

test('a second workspace is <first>-2, skipping numbers already taken', () => {
  assert.deepEqual(suggestWorkspacePaths({ projects: { cawdev: '/work/cawdev' } }, 'cawdev', { home: HOME }), [
    { path: '/work/cawdev-2', why: 'next to cawdev' },
    { path: '/home/alice/cawdev/cawdev-2', why: 'under the default root' },
  ]);
  const three = suggestWorkspacePaths({ projects: { cawdev: { workspaces: ['/work/cawdev', '/work/cawdev-2'] } } }, 'cawdev', { home: HOME });
  assert.equal(three[0].path, '/work/cawdev-3');
});

test('tab completes one match whole, several as far as they agree, none not at all', () => {
  const entries = ['projects', 'pictures', '.hidden'];
  assert.deepEqual(completePath('/r/pr', entries, HOME), { dir: '/r', matches: ['/r/projects'], completed: '/r/projects/' });
  assert.deepEqual(completePath('/r/p', entries, HOME).matches, ['/r/pictures', '/r/projects']);
  assert.equal(completePath('/r/p', entries, HOME).completed, '/r/p', 'p is as far as they agree');
  assert.equal(completePath('/r/x', entries, HOME).completed, '/r/x');
  assert.deepEqual(completePath('/r/', entries, HOME).matches, ['/r/pictures', '/r/projects'], 'dotfiles only when asked for');
  assert.deepEqual(completePath('/r/.h', entries, HOME).matches, ['/r/.hidden']);
  assert.equal(completePath('~/pr', entries, HOME).completed, '/home/alice/projects/', '~ is expanded on the way');
  assert.equal(completePath('/r/al', ['alpha', 'alps'], HOME).completed, '/r/alp', 'the common prefix grows');
});

test('one repository under two spellings is one repository', () => {
  assert.ok(sameRepository('git@github.com:4dali/cawdev.git', 'https://github.com/4dali/cawdev'));
  assert.ok(sameRepository('ssh://git@github.com/4dali/cawdev.git', 'HTTPS://GitHub.com/4dali/cawdev/'));
  assert.ok(!sameRepository('git@github.com:4dali/cawdev.git', 'https://github.com/4dali/dycrypt'));
  assert.ok(!sameRepository(null, 'https://github.com/4dali/cawdev'));
});

test('inspectPath reads what is really there', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cawdev-inspect-'));
  const checkout = join(root, 'cawdev');
  mkdirSync(checkout);
  execFileSync('git', ['-C', checkout, 'init', '-q']);
  execFileSync('git', ['-C', checkout, 'remote', 'add', 'origin', 'git@github.com:4dali/cawdev.git']);
  mkdirSync(join(root, 'empty'));
  mkdirSync(join(root, 'stuff'));
  writeFileSync(join(root, 'stuff', 'notes.txt'), 'x');
  writeFileSync(join(root, 'a-file'), 'x');
  const url = 'https://github.com/4dali/cawdev';

  assert.deepEqual(await inspectPath(join(root, 'nope'), { gitUrl: url }), { kind: 'missing' });
  assert.deepEqual(await inspectPath(join(root, 'empty'), { gitUrl: url }), { kind: 'empty' });
  assert.deepEqual(await inspectPath(join(root, 'stuff'), { gitUrl: url }), { kind: 'not-empty' });
  assert.deepEqual(await inspectPath(join(root, 'a-file'), { gitUrl: url }), { kind: 'file' });
  assert.deepEqual(await inspectPath(checkout, { gitUrl: url }),
    { kind: 'checkout', remote: 'git@github.com:4dali/cawdev.git', matches: true });
  assert.deepEqual(await inspectPath(checkout, { gitUrl: 'https://github.com/4dali/dycrypt' }),
    { kind: 'other-repo', remote: 'git@github.com:4dali/cawdev.git' });
  assert.deepEqual(await inspectPath(checkout, { gitUrl: null }),
    { kind: 'checkout', remote: 'git@github.com:4dali/cawdev.git', matches: null }, 'no URL to check against');
});

test('the words for each state, and which of them may be used', () => {
  assert.equal(describe({ kind: 'missing' }), 'new folder — will clone here');
  assert.equal(describe({ kind: 'checkout', matches: true }, 'cawdev'), 'already a checkout of cawdev — used as it is');
  assert.match(describe({ kind: 'checkout', matches: null, remote: 'x' }, 'cawdev'), /cannot check it is cawdev without signing in/);
  assert.equal(describe({ kind: 'other-repo', remote: 'r' }, 'cawdev'), 'a checkout of r, not cawdev');
  assert.equal(describe({ kind: 'not-empty' }), 'exists and is not empty');
  for (const kind of ['missing', 'empty', 'checkout']) assert.ok(usable({ kind }), kind);
  for (const kind of ['other-repo', 'not-empty', 'file', 'unreadable']) assert.ok(!usable({ kind }), kind);
});

/** The shell door: a numbered list on stdin, then a line. */
function plainAsker(answers) {
  const said = [];
  return {
    said,
    ask: { line: async () => answers.shift() },
    say: (line) => said.push(String(line)),
    pick: async (_ask, _say, select) => {
      const typed = answers.shift();
      return pickFromLine(select, typed);
    },
  };
}

test('the shell door offers the same suggestions with the same descriptions, then a line', async () => {
  const inspect = async (where) => (where.endsWith('-2') ? { kind: 'empty' } : { kind: 'missing' });
  const spec = {
    question: 'Where?', slug: 'cawdev', gitUrl: 'u', inspect,
    suggestions: [{ path: '/w/cawdev-2', why: 'next to cawdev' }, { path: '/h/cawdev/cawdev-2', why: 'under the default root' }],
  };
  // Picking row 1 returns it.
  let plain = plainAsker(['1']);
  assert.equal(await plainAskPath({ ...plain, ...spec }), '/w/cawdev-2');
  // Picking the last row asks for a line; empty takes the first suggestion, ~ expands.
  plain = plainAsker(['3', '']);
  assert.equal(await plainAskPath({ ...plain, ...spec }), '/w/cawdev-2');
  plain = plainAsker(['3', '~/elsewhere']);
  assert.equal(await plainAskPath({ ...plain, ...spec }), absolute('~/elsewhere'));
  assert.equal(TYPE_A_PATH, 'type-a-path');
});
