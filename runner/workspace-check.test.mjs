import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { spawnFailureSaid, workspaceProblem, workspaceProblemSaid } from './workspace-check.mjs';

describe('workspace-check', () => {
  let root;
  before(async () => { root = await mkdtemp(join(tmpdir(), 'wscheck-')); });
  after(async () => { await rm(root, { recursive: true, force: true }); });

  it('reports a missing folder', async () => {
    const path = join(root, 'nope');
    assert.deepEqual(await workspaceProblem(path), { kind: 'missing', path });
  });

  it('reports a file that is not a folder', async () => {
    const path = join(root, 'a-file');
    await writeFile(path, 'x');
    assert.deepEqual(await workspaceProblem(path), { kind: 'not-a-directory', path });
  });

  it('reports a folder with no .git', async () => {
    const path = await mkdtemp(join(root, 'plain-'));
    assert.deepEqual(await workspaceProblem(path), { kind: 'not-git', path });
  });

  it('accepts a real repository', async () => {
    const path = await mkdtemp(join(root, 'repo-'));
    execFileSync('git', ['init', '--quiet', path]);
    assert.equal(await workspaceProblem(path), null);
  });

  it('accepts a .git that is a file, as in a worktree', async () => {
    const path = await mkdtemp(join(root, 'tree-'));
    await writeFile(join(path, '.git'), 'gitdir: /elsewhere\n');
    assert.equal(await workspaceProblem(path), null);
  });

  it('names the slug and path for each kind', () => {
    for (const kind of ['missing', 'not-a-directory', 'not-git']) {
      const said = workspaceProblemSaid('cawdev', { kind, path: '/w/a' }, { first: '/w/a' });
      assert.match(said, /cawdev's workspace \/w\/a/);
      assert.match(said, /cawdev config/);
    }
    assert.match(workspaceProblemSaid('p', { kind: 'missing', path: '/w/a' }, { first: '/w/a' }),
      /does not exist/);
    assert.match(workspaceProblemSaid('p', { kind: 'not-git', path: '/w/a' }, { first: '/w/a' }),
      /not a git checkout/);
  });

  it('offers autoWorkspaces only when the missing folder is not the first', () => {
    const first = workspaceProblemSaid('p', { kind: 'missing', path: '/w/a' }, { first: '/w/a' });
    const second = workspaceProblemSaid('p', { kind: 'missing', path: '/w/b' }, { first: '/w/a' });
    assert.doesNotMatch(first, /autoWorkspaces/);
    assert.match(second, /autoWorkspaces/);
    assert.match(second, /beside \/w\/a/);
  });

  it('says the workspace, not the PATH, for an ENOENT with a missing cwd', () => {
    const said = spawnFailureSaid({
      failure: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
      command: 'claude', cwd: join(root, 'gone'), slug: 'p', label: 'the agent', first: join(root, 'gone'),
    });
    assert.match(said, /does not exist/);
    assert.doesNotMatch(said, /spawn claude ENOENT/);
    assert.doesNotMatch(said, /PATH/);
  });

  it('says the PATH for an ENOENT with a valid cwd', () => {
    const said = spawnFailureSaid({
      failure: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
      command: 'claude', cwd: root, slug: 'p', label: 'the agent', first: root,
    });
    assert.match(said, /`claude` not found on this runner's PATH/);
    assert.match(said, /agentCommands/);
  });

  it('keeps the old text for any other failure', () => {
    const said = spawnFailureSaid({
      failure: Object.assign(new Error('spawn claude EACCES'), { code: 'EACCES' }),
      command: 'claude', cwd: root, slug: 'p', label: 'the agent',
    });
    assert.equal(said, 'Could not spawn the agent: spawn claude EACCES');
  });
});
