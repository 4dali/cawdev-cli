// node --test tools/runner/pr-request.test.mjs
//
// `/pr` from the terminal, as the daemon carries it out — the two ways it
// used to come back with nothing a person could act on.
//
// 1. A checkout cloned on demand (`autoWorkspaces`) after the daemon booted
//    was refused: the set of served paths was taken once, at start, and
//    `saasng-auto-2` was not in it. Every `/pr` on a session that ran there
//    answered "This runner does not serve …".
// 2. With no `gh` on the machine the failure said so, and nothing else — not
//    the fix, and not the link that opens the pull request by hand.
//
// @author Claude Opus 5.5 (Claude Code)
// @author Moez Ben MBarka

import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;
const BRANCH = 'r5-tasks-board';

/** An origin, a first checkout of it, and the session's branch already pushed. */
async function aProject(t) {
  const root = await mkdtemp(join(tmpdir(), 'cawdev-pr-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const origin = join(root, 'origin.git');
  const first = join(root, 'board');
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await run('git', ['clone', '-q', origin, first]);
  const git = (...args) => run('git', args, { cwd: first });
  await git('config', 'user.email', 'test@cawdev.test');
  await git('config', 'user.name', 'Test');
  await writeFile(join(first, 'README.md'), 'board\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'first');
  await git('push', '-q', 'origin', 'main');
  await git('checkout', '-q', '-b', BRANCH);
  await git('commit', '-q', '--allow-empty', '-m', 'the card');
  await git('push', '-q', 'origin', BRANCH);
  await git('checkout', '-q', 'main');
  return { root, first };
}

/** A PATH with git on it and no `gh` anywhere — the machine in the report. */
async function pathWithoutGh(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cawdev-nogh-'));
  const git = (await run('sh', ['-c', 'command -v git'])).stdout.trim();
  await symlink(git, join(dir, 'git'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

test('/pr on a checkout cloned AFTER the daemon booted is carried out, and no gh says the fix', async (t) => {
  const { first } = await aProject(t);
  const platform = await fakePlatform();
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const name = 'test-pr-auto';
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: '/bin/echo',
    pollSeconds: 1,
    workspacePollSeconds: 1,
    autoWorkspaces: 1,
    projects: { board: { workspaces: [first] } },
  }));
  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env({ PATH: await pathWithoutGh(t) }),
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
  });

  // Past boot for real: the request watcher is polling. Anything added after
  // this is what a set taken at start never learnt about.
  const polling = await platform.until(
    () => platform.seen.some((each) => each.endsWith('/workspace-requests/claim')));
  assert.ok(polling, `the daemon never asked for workspace requests:\n${said}`);

  // The clone a busy project gets, made after boot — then the SIGHUP that
  // `/drop` and the config screen send, which is how the daemon finds it.
  const auto = `${first}-auto-1`;
  await run('git', ['clone', '-q', first, auto]);
  daemon.kill('SIGHUP');
  const found = await platform.until(() => /auto-1/.test(said) || platform.heartbeats.length > 1, 8000);
  assert.ok(found !== undefined, said);

  platform.askOfWorkspace({ id: 'wr-pr', path: auto, kind: 'OPEN_PR', message: BRANCH });
  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never answered:\n${said}`);

  const [done] = platform.finishedRequests;
  assert.doesNotMatch(done.result, /does not serve/, `refused a checkout it made itself:\n${said}`);
  assert.equal(done.ok, false);
  assert.match(done.result, /gh is not installed/);
  assert.match(done.result, /brew install gh && gh auth login/, 'the fix, not only the fault');
});

test('/pr on a branch with no commit beyond main pushes nothing and says the work is uncommitted', async (t) => {
  const { first } = await aProject(t);
  const git = (...args) => run('git', args, { cwd: first });
  // The session that ended with everything still in the working tree.
  await git('checkout', '-q', '-b', 'task-empty');
  await writeFile(join(first, 'README.md'), 'changed, never committed\n');

  const platform = await fakePlatform({
    workspaceRequests: [{ id: 'wr-empty', path: first, kind: 'OPEN_PR', message: 'task-empty', defaultBranch: 'main' }],
  });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const name = 'test-pr-empty';
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url, name, agentCommand: '/bin/echo', pollSeconds: 1, workspacePollSeconds: 1,
    projects: { board: first },
  }));
  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env({ PATH: await pathWithoutGh(t) }),
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
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never answered:\n${said}`);
  const [done] = platform.finishedRequests;
  assert.equal(done.ok, false);
  assert.match(done.result, /task-empty has no commit beyond main/);
  assert.match(done.result, /1 file\(s\) are uncommitted in /);
  assert.doesNotMatch(done.result, /compare/, 'no link to a page that says there is nothing to compare');
  const remote = (await git('ls-remote', '--heads', 'origin', 'task-empty')).stdout.trim();
  assert.equal(remote, '', 'an empty branch was not pushed');
});
