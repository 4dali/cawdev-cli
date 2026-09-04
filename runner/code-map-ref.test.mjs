// node --test tools/runner/code-map-ref.test.mjs
//
// The map is of the DEFAULT BRANCH, not of whatever the checkout is sitting on.
//
// The first version read `git ls-files`, which is the working tree. R47's
// survey deliberately picks a *free* workspace — which is exactly the one left
// on somebody's abandoned branch — so the stored map was of a branch chosen at
// random by which checkout happened to be idle. On the machine this was found
// on, that was a map of 481 files or one of 474, depending on nothing.
//
// A map of the wrong branch is worse than no map: it is confidently wrong about
// what exists.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { codeMapOf } from '../lib/code-map.mjs';

const run = promisify(execFile);

/** A repository whose default branch and feature branch differ. */
async function aRepository(t) {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-map-'));
  t.after(() => rm(path, { recursive: true, force: true }));

  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });

  await mkdir(join(path, 'app'), { recursive: true });
  await writeFile(join(path, 'app', 'one.ts'), "import { two } from './two';");
  await writeFile(join(path, 'app', 'two.ts'), '');
  await run('git', ['add', '-A'], { cwd: path });
  await run('git', ['commit', '-qm', 'on main'], { cwd: path });

  // A branch that adds a file, and is checked out — the state a free workspace
  // is left in after a session.
  await run('git', ['checkout', '-qb', 'r99-something'], { cwd: path });
  await writeFile(join(path, 'app', 'three.ts'), "import { one } from './one';");
  await run('git', ['add', '-A'], { cwd: path });
  await run('git', ['commit', '-qm', 'on the branch'], { cwd: path });

  return path;
}

/** The list a ref holds, which is what the daemon now reads. */
async function pathsAt(path, ref) {
  const { stdout } = await run('git', ['ls-tree', '-r', '--name-only', ref], { cwd: path });
  return stdout.split('\n').map((each) => each.trim()).filter(Boolean);
}

test('the map is of the default branch, not of the checked-out branch', async (t) => {
  const path = await aRepository(t);

  // The checkout is sitting on the feature branch, which is the case that
  // produced the bug.
  const { stdout: on } = await run('git', ['branch', '--show-current'], { cwd: path });
  assert.equal(on.trim(), 'r99-something');

  const fromMain = await pathsAt(path, 'main');
  const fromBranch = await pathsAt(path, 'r99-something');

  assert.deepEqual(fromMain.sort(), ['app/one.ts', 'app/two.ts']);
  // The branch has a file main does not. Reading the working tree would have
  // put it on the project's map before it was merged.
  assert.ok(fromBranch.includes('app/three.ts'));
  assert.ok(!fromMain.includes('app/three.ts'));
});

test('what merges onto the default branch is what joins the map', async (t) => {
  const path = await aRepository(t);

  // Before the merge, the branch's file is not part of the project.
  assert.ok(!(await pathsAt(path, 'main')).includes('app/three.ts'));

  await run('git', ['checkout', '-q', 'main'], { cwd: path });
  await run('git', ['merge', '-q', '--no-ff', '-m', 'merged', 'r99-something'], { cwd: path });

  // After it, it is — with no hook on merging, because "the default branch
  // moved" is the same event said more honestly.
  const after = await pathsAt(path, 'main');
  assert.ok(after.includes('app/three.ts'));

  const map = codeMapOf(after.map((each) => ({ path: each })));
  assert.equal(map.files.length, 3);
});
