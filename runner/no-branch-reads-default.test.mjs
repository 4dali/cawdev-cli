// node --test tools/runner/no-branch-reads-default.test.mjs
//
// A session with no branch — a plan, a verify, an ask — takes no checkout, and
// used to run in the project's first one as it happened to be. A cancelled CTO
// Interview left `cto-interview` checked out there, far behind main, and every
// plan after it read that stale code. It reads `<first>-read` now: a detached
// worktree at origin's default branch, and the checkout itself is not moved —
// a coding run may be working in it.

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

/** An origin with two commits on main, and a clone left on an old side branch. */
async function aCheckoutLeftOnAnOldBranch() {
  const root = await mkdtemp(join(tmpdir(), 'cawdev-nobranch-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const path = join(root, 'checkout');
  const at = (cwd) => (...args) => run('git', args, { cwd });
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await run('git', ['clone', '-q', origin, seed]);
  const s = at(seed);
  await s('config', 'user.email', 't@cawdev.test');
  await s('config', 'user.name', 'T');
  await writeFile(join(seed, 'a.txt'), 'one\n');
  await s('add', '.');
  await s('commit', '-q', '-m', 'first');
  await s('push', '-q', 'origin', 'HEAD:main');

  await run('git', ['clone', '-q', origin, path]);
  const c = at(path);
  await c('config', 'user.email', 't@cawdev.test');
  await c('config', 'user.name', 'T');
  await c('checkout', '-q', '-b', 'cto-interview');
  await writeFile(join(path, 'brief.md'), 'the brief\n');
  await c('add', '.');
  await c('commit', '-q', '-m', 'brief');

  // main moves on after the checkout was left behind.
  await writeFile(join(seed, 'a.txt'), 'two\n');
  await s('commit', '-q', '-am', 'second');
  await s('push', '-q', 'origin', 'HEAD:main');
  const tip = (await s('rev-parse', 'HEAD')).stdout.trim();
  return { root, path, tip };
}

async function daemonWith(t, { path, name, offers }) {
  const platform = await fakePlatform({ offers });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url, name, agentCommand: '/bin/echo', pollSeconds: 1, workspacePollSeconds: 1,
    projects: { board: path },
  }));
  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env(), stdio: ['ignore', 'pipe', 'pipe'],
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
  return { platform, said: () => said };
}

const PLAN = { id: 'run-plan', projectSlug: 'board', label: 'R6', branch: null, profile: 'PLAN' };

const at = async (cwd, ...args) => (await run('git', args, { cwd })).stdout.trim();

test('a plan reads origin\'s main in the reading copy, whatever the checkout is on', async (t) => {
  const { root, path, tip } = await aCheckoutLeftOnAnOldBranch();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const { platform, said } = await daemonWith(t, { path, name: 'test-nobranch-read', offers: [PLAN] });

  const started = await platform.until((all) => all.some((each) => each.state === 'RUNNING'));
  assert.ok(started, `the plan never started:\n${said()}`);
  const read = `${path}-read`;
  assert.equal(await at(read, 'rev-parse', 'HEAD'), tip, `the reading copy is at origin's tip:\n${said()}`);
  assert.match(said(), new RegExp(`reading origin/main at ${tip.slice(0, 7)}`));
  assert.match(said(), /working copy .*-read is on no branch of its own/);
  // The checkout it came from is exactly where it was.
  assert.equal(await at(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'cto-interview');
});

test('the checkout is never moved, even with uncommitted work in it', async (t) => {
  const { root, path, tip } = await aCheckoutLeftOnAnOldBranch();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await writeFile(join(path, 'brief.md'), 'an edit in progress\n');
  const { platform, said } = await daemonWith(t, { path, name: 'test-nobranch-dirty', offers: [PLAN] });

  const started = await platform.until((all) => all.some((each) => each.state === 'RUNNING'));
  assert.ok(started, `the plan never started:\n${said()}`);
  assert.equal(await at(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'cto-interview');
  assert.match(await at(path, 'status', '--porcelain'), /brief\.md/, 'the edit is still there');
  assert.equal(await at(`${path}-read`, 'rev-parse', 'HEAD'), tip);
});
