// node --test tools/runner/auto-workspaces.test.mjs
//
// Checkouts made on demand: their names, making one for real against a bare
// origin, finding them again, and the daemon starting a second coding run at
// once — in a clone it made — instead of queueing it behind the first.
//
//   env -u CAWDEV_URL -u CAWDEV_TOKEN node --test tools/runner/auto-workspaces.test.mjs

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';
import {
  autoNumberOf, createAutoWorkspace, discoverAutoWorkspaces, isAutoWorkspace, nextAutoWorkspace,
} from './auto-workspaces.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

test('a checkout made on demand is known by its name, beside the first, and nothing else is', () => {
  const first = '/code/saasng';
  assert.equal(autoNumberOf(first, '/code/saasng-auto-2'), 2);
  assert.equal(autoNumberOf(first, '/code/saasng-auto-12'), 12);
  assert.equal(autoNumberOf(first, '/code/saasng-2'), null, 'a checkout somebody configured is theirs');
  assert.equal(autoNumberOf(first, '/elsewhere/saasng-auto-2'), null, 'beside the first, or not one of these');
  assert.equal(autoNumberOf(first, '/code/saasng'), null);
  assert.equal(isAutoWorkspace('/code/a.b', '/code/a.b-auto-3'), true, 'a dot in the name is not a pattern');
  assert.equal(isAutoWorkspace('/code/a.b', '/code/axb-auto-3'), false);

  assert.equal(nextAutoWorkspace(first, [first]), '/code/saasng-auto-2');
  assert.equal(nextAutoWorkspace(first, [first, '/code/saasng-auto-2', '/code/saasng-auto-4']),
    '/code/saasng-auto-3', 'the lowest number free');
});

/** A bare origin with a `main`, and a first checkout cloned from it. */
async function aProject(t) {
  const root = await mkdtemp(join(tmpdir(), 'cawdev-auto-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const origin = join(root, 'origin.git');
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = join(root, 'seed');
  await run('git', ['clone', '-q', origin, seed]);
  await run('git', ['-C', seed, '-c', 'user.email=t@x', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'first']);
  await run('git', ['-C', seed, 'push', '-q', 'origin', 'HEAD:main']);
  const first = join(root, 'board');
  await run('git', ['clone', '-q', origin, first]);
  await run('git', ['-C', first, 'config', 'user.email', 'test@cawdev.test']);
  await run('git', ['-C', first, 'config', 'user.name', 'Test']);
  return { root, origin, first };
}

test('one is a clone of the first, pointed at the SAME origin, and found again by its name', async (t) => {
  const { origin, first } = await aProject(t);
  const made = await createAutoWorkspace(first, [first]);
  assert.equal(made, `${first}-auto-2`);

  const { stdout: url } = await run('git', ['-C', made, 'remote', 'get-url', 'origin']);
  assert.equal(url.trim(), origin, 'it pushes where the project pushes, not into the first checkout');
  const { stdout: main } = await run('git', ['-C', made, 'rev-parse', 'origin/main']);
  const { stdout: expected } = await run('git', ['-C', origin, 'rev-parse', 'main']);
  assert.equal(main.trim(), expected.trim());

  // A directory with the right name and no checkout in it is not one.
  await mkdir(`${first}-auto-7`);
  assert.deepEqual(await discoverAutoWorkspaces(first), [made]);
});

test('with none free, the daemon makes a checkout and starts the second coding run at once', async (t) => {
  const { first } = await aProject(t);
  const offers = ['a', 'b', 'c'].map((id) => ({
    id: `run-${id}`, projectSlug: 'board', label: `card ${id}`, branch: `r-${id}-work`, profile: 'CODE',
  }));
  const platform = await fakePlatform({ offers });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const name = 'test-auto-workspaces';
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: '/bin/echo',
    pollSeconds: 1,
    autoWorkspaces: 1,
    projects: { board: { workspaces: [first] } },
  }));
  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env(),
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

  const both = await platform.until(
    (transitions) => transitions.filter((each) => each.state === 'RUNNING').length >= 2);
  assert.ok(both, `the second run waited instead:\n${said}`);
  const started = platform.transitions.filter((each) => each.state === 'RUNNING').slice(0, 2);
  assert.deepEqual(started.map((each) => each.workspace).sort(), [first, `${first}-auto-2`].sort());
  assert.match(said, /cloning another beside/);

  // One allowed, one made: the third waits, and says that the allowance is spent.
  const waited = await platform.until(() => /the 1 this machine may make are made/.test(said));
  assert.ok(waited, said);
});
