// node --test tools/lib/protected.test.mjs
//
// R562: the part of protected files that does not depend on the CLI. Real
// repositories, because what is being judged is git's own answer.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  denyRules, isProtected, notAllowed, protectedBase, protectedChanges, protectedLine,
  protectedPolicy, relativeTo,
} from './protected.mjs';

const run = promisify(execFile);
const git = async (cwd, ...args) => (await run('git', args, { cwd })).stdout.trim();

async function aRepo(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cawdev-protected-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@cawdev.test');
  await git(root, 'config', 'user.name', 'test');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await mkdir(join(root, 'secret'));
  await writeFile(join(root, 'secret', 'a.txt'), 'a\n');
  await writeFile(join(root, 'pom.xml'), '<p/>\n');
  await writeFile(join(root, 'README.md'), 'hello\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'first');
  const base = await git(root, 'rev-parse', 'HEAD');
  await git(root, 'switch', '-q', '-c', 'work');
  return { root, base };
}

const globs = ['secret/**', 'pom.xml'];

test('a directory glob covers the directory and what is under it; a bare name only itself', () => {
  assert.equal(isProtected('/w/secret/a.txt', '/w', globs), true);
  assert.equal(isProtected('/w/secret/deep/er/b.txt', '/w', globs), true);
  assert.equal(isProtected('/w/secret', '/w', globs), true);
  assert.equal(isProtected('pom.xml', '/w', globs), true);
  assert.equal(isProtected('/w/module/pom.xml', '/w', globs), false);
  assert.equal(isProtected('/w/README.md', '/w', globs), false);
  assert.equal(isProtected('/w/secret/a.txt', '/w', []), false);
});

test('case does not hide a file on a volume that ignores it', { skip: !['darwin', 'win32'].includes(process.platform) }, () => {
  assert.equal(isProtected('/w/POM.XML', '/w', globs), true);
  assert.equal(isProtected('/w/Secret/A.txt', '/w', globs), true);
});

test('.. cannot walk out of or into a protected path unnoticed', () => {
  assert.equal(isProtected('/w/src/../secret/a.txt', '/w', globs), true);
  assert.equal(isProtected('/w/secret/../README.md', '/w', globs), false);
  assert.equal(isProtected('/elsewhere/secret/a.txt', '/w', globs), false);
});

test('a symlink into a protected directory is the protected directory', async (t) => {
  const { root } = await aRepo(t);
  await symlink(join(root, 'secret'), join(root, 'shortcut'));
  assert.equal(isProtected(join(root, 'shortcut', 'a.txt'), root, globs), true);
  assert.equal(isProtected(join(root, 'shortcut', 'new.txt'), root, globs), true);
});

test('a committed change is found, a reverted one is not', async (t) => {
  const { root, base } = await aRepo(t);
  await writeFile(join(root, 'secret', 'a.txt'), 'changed\n');
  await git(root, 'commit', '-q', '-am', 'edit');
  assert.deepEqual(await protectedChanges(root, base, globs), ['secret/a.txt']);

  await git(root, 'checkout', base, '--', 'secret/a.txt');
  await git(root, 'commit', '-q', '-am', 'revert');
  assert.deepEqual(await protectedChanges(root, base, globs), []);
});

test('uncommitted and untracked changes count', async (t) => {
  const { root, base } = await aRepo(t);
  await writeFile(join(root, 'pom.xml'), '<changed/>\n');
  await writeFile(join(root, 'secret', 'new.txt'), 'n\n');
  await writeFile(join(root, 'README.md'), 'not protected\n');
  assert.deepEqual(await protectedChanges(root, base, globs), ['pom.xml', 'secret/new.txt']);
});

test('the paths come back in code-unit order, whatever order git reports them', async (t) => {
  const { root, base } = await aRepo(t);
  // Committed paths are reported by the diff first, untracked ones after.
  await writeFile(join(root, 'secret', 'z.txt'), 'z\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'z');
  await writeFile(join(root, 'secret', 'ab.txt'), 'x\n');
  await writeFile(join(root, 'secret', 'a-b.txt'), 'x\n');
  assert.deepEqual(await protectedChanges(root, base, globs), [
    'secret/a-b.txt', 'secret/ab.txt', 'secret/z.txt',
  ]);
});

test('moving a protected file away is caught on its old path', async (t) => {
  const { root, base } = await aRepo(t);
  await mkdir(join(root, 'elsewhere'));
  await rename(join(root, 'secret', 'a.txt'), join(root, 'elsewhere', 'a.txt'));
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'move');
  assert.deepEqual(await protectedChanges(root, base, globs), ['secret/a.txt']);

  // And uncommitted, as a staged rename.
  const second = await aRepo(t);
  await mkdir(join(second.root, 'elsewhere'));
  await git(second.root, 'mv', 'secret/a.txt', 'elsewhere/a.txt');
  assert.deepEqual(await protectedChanges(second.root, second.base, globs), ['secret/a.txt']);
});

test('a base git cannot read is a failure, never a clean branch', async (t) => {
  const { root } = await aRepo(t);
  await assert.rejects(() => protectedChanges(root, 'f'.repeat(40), globs));
});

test('nothing to judge is nothing: no base, no globs', async (t) => {
  const { root } = await aRepo(t);
  await writeFile(join(root, 'pom.xml'), '<changed/>\n');
  assert.deepEqual(await protectedChanges(root, null, globs), []);
  assert.deepEqual(await protectedChanges(root, 'HEAD', []), []);
});

test('the base is the merge-base with the default branch', async (t) => {
  const { root, base } = await aRepo(t);
  await writeFile(join(root, 'pom.xml'), '<changed/>\n');
  await git(root, 'commit', '-q', '-am', 'edit');
  assert.equal(await protectedBase(root, 'main', null), base);
  assert.equal(await protectedBase(root, 'no-such', 'abc'), 'abc');
});

test('the policy: unreadable is REFUSE with nothing listed, never a way of allowing', () => {
  assert.deepEqual(protectedPolicy(null), { globs: [], mode: 'REFUSE', allowed: [] });
  assert.deepEqual(protectedPolicy({ protectedPaths: ['a', ' ', 3], protectedMode: 'ask' }),
    { globs: ['a'], mode: 'ASK', allowed: [] });
  assert.equal(protectedPolicy({ protectedMode: 'MAYBE' }).mode, 'REFUSE');
});

test('what is allowed is subtracted, and the CLI rules are Edit rules only', () => {
  assert.deepEqual(notAllowed(['a', 'b'], ['b']), ['a']);
  assert.deepEqual(denyRules(['secret/**', './pom.xml']), ['Edit(./secret/**)', 'Edit(./pom.xml)']);
  assert.equal(relativeTo('/w/secret/a.txt', '/w'), 'secret/a.txt');
  assert.equal(relativeTo('/x/a.txt', '/w'), null);
});

test('the prompt paragraph names the globs, the mode, and what the branch already changes', () => {
  assert.equal(protectedLine({ globs: [], mode: 'REFUSE' }), null);
  const refuse = protectedLine({ globs: ['secret/**'], mode: 'REFUSE' });
  assert.match(refuse, /\*\*Protected files\.\*\* This project protects: `secret\/\*\*`\./);
  assert.match(refuse, /An agent never changes them/);
  assert.doesNotMatch(refuse, /already changes/);
  const ask = protectedLine({ globs: ['pom.xml'], mode: 'ASK' }, ['pom.xml']);
  assert.match(ask, /stops and asks a person first/);
  assert.match(ask, /This branch already changes `pom\.xml`, which are protected; deal with that first\./);
});
