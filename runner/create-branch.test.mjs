// node --test tools/runner/create-branch.test.mjs
//
// R379's half of the daemon: a `CREATE_BRANCH` workspace request puts a named
// branch on origin, cut from the tip of another branch, and refuses a name that
// is already there. Against the real daemon with a real bare origin on disk, so
// the assertions are on refs.

import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

async function git(cwd, args) {
  return (await run('git', args, { cwd })).stdout.trim();
}

/** A bare origin with `main` and `feature-x` (one commit ahead), and a clone of it. */
async function aRepositoryWithAFeatureBranch() {
  const root = await mkdtemp(join(tmpdir(), 'cawdev-newbranch-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await run('git', ['init', '-q', '-b', 'main', seed]);
  await git(seed, ['config', 'user.email', 'test@cawdev.test']);
  await git(seed, ['config', 'user.name', 'Test']);
  await writeFile(join(seed, 'README.md'), '# a project\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-q', '-m', 'first']);
  await git(seed, ['checkout', '-q', '-b', 'feature-x']);
  await writeFile(join(seed, 'FEATURE.md'), '# x\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-q', '-m', 'feature']);
  await git(seed, ['push', '-q', origin, 'main', 'feature-x']);

  const path = join(root, 'checkout');
  await run('git', ['clone', '-q', origin, path]);
  return {
    root,
    origin,
    path,
    mainTip: await git(seed, ['rev-parse', 'main']),
    featureTip: await git(seed, ['rev-parse', 'feature-x']),
  };
}

async function daemonWith(t, { repo, name, workspaceRequests }) {
  const platform = await fakePlatform({ workspaceRequests });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: '/bin/echo',
    pollSeconds: 1,
    workspacePollSeconds: 1,
    projects: { board: repo.path },
  }));
  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env({}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  daemon.stdout.on('data', (chunk) => (said += chunk));
  daemon.stderr.on('data', (chunk) => (said += chunk));
  t.after(async () => {
    daemon.kill('SIGKILL');
    platform.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(socketPathFor(name), { force: true });
    await rm(repo.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { platform, said: () => said };
}

test('a CREATE_BRANCH pushes the source tip to the new name and reports the sha first', async (t) => {
  const repo = await aRepositoryWithAFeatureBranch();
  const { platform, said } = await daemonWith(t, {
    repo,
    name: 'test-create-branch',
    workspaceRequests: [
      { id: 'wr-ok', path: repo.path, kind: 'CREATE_BRANCH', message: 'r9-child', fromBranch: 'feature-x' },
      { id: 'wr-there', path: repo.path, kind: 'CREATE_BRANCH', message: 'feature-x', fromBranch: 'main' },
      { id: 'wr-no-source', path: repo.path, kind: 'CREATE_BRANCH', message: 'r9-other', fromBranch: 'nope' },
      { id: 'wr-bad-name', path: repo.path, kind: 'CREATE_BRANCH', message: 'a..b', fromBranch: 'main' },
      { id: 'wr-blank', path: repo.path, kind: 'CREATE_BRANCH', message: 'r9-x', fromBranch: ' ' },
    ],
  });

  const came = await platform.untilFinished((finished) => finished.length === 5);
  assert.ok(came, `the runner never answered all five:\n${said()}`);
  const byId = Object.fromEntries(platform.finishedRequests.map((each) => [each.id, each]));

  assert.equal(byId['wr-ok'].ok, true, byId['wr-ok'].result);
  assert.equal(byId['wr-ok'].result.split('\n')[0], repo.featureTip);
  assert.match(byId['wr-ok'].result, /r9-child created from feature-x at/);
  // On the REMOTE at the SOURCE's tip, not main's, and no local branch made.
  assert.equal(await git(repo.origin, ['rev-parse', 'refs/heads/r9-child']), repo.featureTip);
  assert.equal(await git(repo.path, ['branch', '--list', 'r9-child']), '');
  assert.equal(await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');

  // An existing name is a refusal, whatever it points at — unlike CUT_BRANCH.
  assert.equal(byId['wr-there'].ok, false);
  assert.match(byId['wr-there'].result, /`feature-x` is already on origin at [0-9a-f]{7}\. Nothing was created\./);
  assert.equal(await git(repo.origin, ['rev-parse', 'refs/heads/feature-x']), repo.featureTip);

  assert.equal(byId['wr-no-source'].ok, false);
  assert.match(byId['wr-no-source'].result, /origin\/nope is not on origin/);
  assert.equal(await git(repo.origin, ['branch', '--list', 'r9-other']), '');

  assert.equal(byId['wr-bad-name'].ok, false);
  assert.match(byId['wr-bad-name'].result, /is not a branch name git accepts/);

  assert.equal(byId['wr-blank'].ok, false);
  assert.match(byId['wr-blank'].result, /Nothing was created/);
});
