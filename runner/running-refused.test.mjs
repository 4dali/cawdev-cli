// node --test tools/runner/running-refused.test.mjs
//
// i267, against the real daemon: a REFUSED move to RUNNING is the platform
// saying whose run this is, never this run's failure. The run that taught it
// was written back to QUEUED by a stale save while its daemon prepared the
// checkout, and the daemon answered the refusal by posting FAILED, so the
// refusal's own sentence became the run's exit summary.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-refused-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

const CODE = { id: 'run-refused', projectSlug: 'board', label: 'R1', branch: 'r1-work', profile: 'CODE' };

async function daemonRefusing(t, name, refuse) {
  const real = await aRepository();
  const platform = await fakePlatform({ offers: [CODE], refuseTransition: refuse });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url, name, agentCommand: '/bin/echo', pollSeconds: 1, workspacePollSeconds: 1,
    projects: { board: { workspaces: [real] } },
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
    await rm(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(`${real}-read`, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(socketPathFor(name), { force: true });
  });
  return { platform, said: () => said };
}

const REFUSAL = 'A run that is QUEUED cannot move to RUNNING. From here it can move to: [STARTING, FAILED, CANCELLED].';

test('a RUNNING the platform refuses (400) leaves the run alone: no FAILED, no agent', async (t) => {
  const { platform, said } = await daemonRefusing(t, 'test-refused-400',
    (transition) => (transition.state === 'RUNNING' ? REFUSAL : null));
  assert.ok(await platform.until((transitions) => transitions.some((each) => each.state === 'RUNNING')), said());
  assert.ok(await platform.until(() => said().includes('leaving it as the platform has it')), said());
  // Time for a FAILED to arrive if one were going to.
  await new Promise((done) => setTimeout(done, 1500));
  assert.deepEqual(platform.transitions.filter((each) => each.state === 'FAILED'), [], said());
  assert.match(said(), /the platform did not let this run start \(A run that is QUEUED cannot move to RUNNING/);
  assert.doesNotMatch(said(), /spawning|spawned/i);
});

test('a RUNNING that is rate limited (429) is not a refusal: the run still fails', async (t) => {
  const { platform, said } = await daemonRefusing(t, 'test-refused-429',
    (transition) => (transition.state === 'RUNNING' ? { status: 429, message: 'slow down' } : null));
  assert.ok(await platform.until((transitions) => transitions.some((each) => each.state === 'FAILED')), said());
  assert.equal(platform.transitions.find((each) => each.state === 'FAILED').summary, 'slow down');
});

test('a RUNNING that fails with a 500 is still the run\'s failure, as before', async (t) => {
  const { platform, said } = await daemonRefusing(t, 'test-refused-500',
    (transition) => (transition.state === 'RUNNING' ? { status: 500, message: 'the platform fell over' } : null));
  assert.ok(await platform.until((transitions) => transitions.some((each) => each.state === 'FAILED')), said());
  assert.equal(platform.transitions.find((each) => each.state === 'FAILED').summary, 'the platform fell over');
});
