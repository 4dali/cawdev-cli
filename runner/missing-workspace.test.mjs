// node --test tools/runner/missing-workspace.test.mjs
//
// R377, against the real daemon: a workspace folder that is not there is said
// to be missing — in the queued reason, in the heartbeat survey, in a failed
// run — and never as `spawn claude ENOENT`, which sends a person looking at
// their PATH.

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
  const path = await mkdtemp(join(tmpdir(), 'cawdev-mw-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

const CODE = { id: 'run-code', projectSlug: 'board', label: 'R1', branch: 'r1-work', profile: 'CODE' };
const ASK = { id: 'run-ask', projectSlug: 'board', label: 'R2', branch: null, profile: 'ASK' };

async function daemonWith(t, { workspaces, offers, name, agentCommand = '/bin/echo' }) {
  const platform = await fakePlatform({ offers });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url, name, agentCommand, pollSeconds: 1, workspacePollSeconds: 1,
    projects: { board: { workspaces } },
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
  return { platform, said: () => said, daemon };
}

const reasonFor = (platform, id) => platform.queuedReasons.find((each) => each.runId === id)?.why ?? '';

async function heldAsMissing(t, offer, name) {
  const gone = join(tmpdir(), `cawdev-mw-gone-${name}`);
  const { platform, said } = await daemonWith(t, { workspaces: [gone], offers: [offer], name });
  const queued = await platform.untilQueued((reasons) => reasons.some((each) => /does not exist/.test(each.why)));
  assert.ok(queued, `no queued reason about the missing folder:\n${said()}`);
  const why = reasonFor(platform, offer.id);
  assert.ok(why.includes(gone), why);
  assert.match(why, /board's workspace/);
  assert.match(why, /cawdev config/);
  // A few more polls: still held, never claimed.
  await new Promise((done) => setTimeout(done, 2500));
  assert.deepEqual(platform.transitions.filter((each) => ['RUNNING', 'FAILED'].includes(each.state)), []);
  assert.doesNotMatch(said(), /spawn\b.*ENOENT/);
  return { platform, gone };
}

test('a coding run on a missing workspace is held, and the reason says the folder is missing', async (t) => {
  await heldAsMissing(t, CODE, 'test-mw-code');
});

test('an ASK run on a missing workspace is held the same way', async (t) => {
  await heldAsMissing(t, ASK, 'test-mw-ask');
});

test('the heartbeat survey says a missing path does not exist', async (t) => {
  const { platform } = await heldAsMissing(t, CODE, 'test-mw-survey');
  const reported = await platform.until(() => platform.workspaceReports
    .some((each) => each.path === platform.workspaceReports[0]?.path && /does not exist/.test(each.error ?? '')));
  assert.ok(reported, JSON.stringify(platform.workspaceReports));
});

test('a folder that is not a git checkout is said to be one', async (t) => {
  const bare = await mkdtemp(join(tmpdir(), 'cawdev-mw-plain-'));
  t.after(() => rm(bare, { recursive: true, force: true }));
  const { platform, said } = await daemonWith(t, { workspaces: [bare], offers: [CODE], name: 'test-mw-notgit' });
  const queued = await platform.untilQueued((reasons) => reasons.some((each) => /not a git checkout/.test(each.why)));
  assert.ok(queued, said());
});

test('with the first workspace missing, a coding run and an ASK both start in the second', async (t) => {
  const real = await aRepository();
  t.after(() => rm(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  t.after(() => rm(`${real}-read`, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const gone = join(tmpdir(), 'cawdev-mw-gone-second');
  const { platform, said } = await daemonWith(t, {
    workspaces: [gone, real], offers: [CODE, ASK], name: 'test-mw-second',
  });
  const started = await platform.until(
    (transitions) => transitions.filter((each) => each.state === 'RUNNING').length === 2);
  assert.ok(started, `both runs should start:\n${said()}`);
  // Only a coding run reports a workspace; the ASK holds none.
  const coding = platform.transitions.find((each) => each.state === 'RUNNING' && each.workspace);
  assert.equal(coding.workspace, real);
  assert.deepEqual(platform.transitions.filter((each) => each.state === 'FAILED'), [], said());
});

test('a valid checkout and a missing agent says the agent is not on the PATH', async (t) => {
  const real = await aRepository();
  t.after(() => rm(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  t.after(() => rm(`${real}-read`, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const { platform, said } = await daemonWith(t, {
    workspaces: [real], offers: [ASK], name: 'test-mw-agent', agentCommand: '/nonexistent/claude',
  });
  const failed = await platform.until((transitions) => transitions.some((each) => each.state === 'FAILED'));
  assert.ok(failed, said());
  const summary = platform.transitions.find((each) => each.state === 'FAILED').summary;
  assert.match(summary, /not found on this runner's PATH/);
  assert.match(summary, /agentCommands/);
  assert.doesNotMatch(summary, /spawn .* ENOENT/);
});

test('the daemon says at boot, and again on SIGHUP, which workspace cannot be used', async (t) => {
  const gone = join(tmpdir(), 'cawdev-mw-gone-boot');
  const { platform, said, daemon } = await daemonWith(t, { workspaces: [gone], offers: [], name: 'test-mw-boot' });
  const sentence = `board's workspace ${gone} does not exist`;
  assert.ok(await platform.until(() => said().includes(sentence)), said());
  daemon.kill('SIGHUP');
  assert.ok(await platform.until(() => said().includes('restart the daemon after changing "workspaces"')), said());
  assert.ok(said().split(sentence).length >= 3, said());
});
