// node --test tools/runner/workspaces.test.mjs
//
// R47's "Done when", against the real daemon: several coding runs on ONE
// project at the same time, in different checkouts, each saying which.
//
// The gate this covers used to key on the project slug, because there was one
// checkout per project and the two were the same thing. Getting it wrong in
// either direction is expensive: too tight and a machine with three checkouts
// still runs one session; too loose and two agents share a working copy, which
// is the failure the gate has always existed to prevent.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

/** A checkout a run can actually be prepared in: a repo with a `main`. */
async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-ws-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

/**
 * A checkout that shares an `origin` with another — R212. `aRepository()` has
 * no remote, which is fine while a branch only ever lives in one checkout; a
 * branch that moves between checkouts needs a remote for them to move through.
 */
async function aBareOrigin() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-origin-'));
  await run('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: path });
  return path;
}

async function aClone(origin) {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-ws-'));
  await run('git', ['clone', '-q', origin, path]);
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  return path;
}

function codingRun(id, label) {
  return { id, projectSlug: 'board', label, branch: `r${id}-work`, profile: 'CODE' };
}

async function daemonWith(t, { workspaces, offers, name }) {
  const platform = await fakePlatform({ offers });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: '/bin/echo',
    pollSeconds: 1,
    projects: { board: { workspaces } },
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
    await rm(home, { recursive: true, force: true });
    await rm(socketPathFor(name), { force: true });
    for (const workspace of workspaces) {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  return { platform, said: () => said };
}

test('two checkouts run two coding sessions on one project, at the same time', async (t) => {
  const workspaces = [await aRepository(), await aRepository()];
  const { platform, said } = await daemonWith(t, {
    name: 'test-workspaces-two',
    workspaces,
    offers: [codingRun('run-a', 'first card'), codingRun('run-b', 'second card')],
  });

  const both = await platform.until(
    (transitions) => transitions.filter((each) => each.state === 'RUNNING').length === 2,
  );
  assert.ok(both, `only one run started:\n${said()}`);

  const started = platform.transitions.filter((each) => each.state === 'RUNNING');
  // Each in its own checkout — the whole point. Two runs reporting the same
  // path would be two agents in one working copy.
  assert.notEqual(started[0].workspace, started[1].workspace);
  assert.deepEqual(
    [...started.map((each) => each.workspace)].sort(),
    [...workspaces].sort(),
  );

  const failed = platform.transitions.filter((each) => each.state === 'FAILED');
  assert.deepEqual(failed, [], `a run failed: ${failed[0]?.summary}\n${said()}`);
});

test('a third run waits, and the reason names the workspaces rather than the project', async (t) => {
  const workspaces = [await aRepository()];
  const { platform, said } = await daemonWith(t, {
    name: 'test-workspaces-one',
    workspaces,
    offers: [codingRun('run-c', 'first card'), codingRun('run-d', 'second card')],
  });

  await platform.until((transitions) => transitions.some((each) => each.state === 'RUNNING'));

  // The old message was "board already has a run here", which was a proxy for
  // the truth. This is the truth.
  const waited = await platform.until(() => /no free workspace in board \(1 here, all busy\)/.test(said()));
  assert.ok(waited, `nothing said why the second run waited:\n${said()}`);
});

test('an ASK session takes no workspace and does not queue behind coding', async (t) => {
  const workspaces = [await aRepository()];
  const { platform, said } = await daemonWith(t, {
    name: 'test-workspaces-ask',
    workspaces,
    offers: [
      codingRun('run-e', 'the card'),
      { id: 'run-f', projectSlug: 'board', label: 'what is R12 about?', branch: null, profile: 'ASK' },
    ],
  });

  // Both, on one checkout: asking a question while the only workspace is busy
  // is exactly when somebody wants to. An ASK run prepares nothing and writes
  // nothing, so it has nothing to fight over.
  const both = await platform.until(
    (transitions) => transitions.filter((each) => each.state === 'RUNNING').length === 2,
  );
  assert.ok(both, `the question queued behind the coding run:\n${said()}`);

  const asked = platform.transitions.find(
    (each) => each.state === 'RUNNING' && each.runId === 'run-f',
  );
  // It took no checkout, and says so rather than claiming one it is not in.
  assert.equal(asked.workspace, null);
});

test('a bare path is still one workspace', async (t) => {
  const workspace = await aRepository();
  const platform = await fakePlatform({ offers: [codingRun('run-g', 'the card')] });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const config = join(home, 'config.json');
  // The form every config used before R47, which must keep working exactly as
  // it did: one checkout, one coding run at a time.
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name: 'test-workspaces-bare',
    agentCommand: '/bin/echo',
    pollSeconds: 1,
    projects: { board: workspace },
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
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(socketPathFor('test-workspaces-bare'), { force: true });
  });

  const started = await platform.until((t2) => t2.some((each) => each.state === 'RUNNING'));
  assert.ok(started, `a bare path stopped working:\n${said}`);
  assert.equal(
    platform.transitions.find((each) => each.state === 'RUNNING').workspace,
    workspace,
  );
});

test("a pushed branch's next run takes the free checkout, not the busy one it prefers", async (t) => {
  // R212. run-p takes workspaces[0] first — the daemon walks offers in order
  // and `find` returns the first free path — and run-q would PREFER that same
  // checkout. Its branch is entirely on the remote, so the preference is not
  // worth waiting for: it goes into workspaces[1] on the same pass.
  const workspaces = [await aRepository(), await aRepository()];
  const { platform, said } = await daemonWith(t, {
    name: 'test-workspaces-prefers',
    workspaces,
    offers: [
      codingRun('run-p', 'first card'),
      { ...codingRun('run-q', 'a pushed branch'), prefers: workspaces[0] },
    ],
  });

  const both = await platform.until(
    (transitions) => transitions.filter((each) => each.state === 'RUNNING').length === 2,
  );
  assert.ok(both, `the pushed branch waited for its old checkout:\n${said()}`);

  const q = platform.transitions.find((each) => each.state === 'RUNNING' && each.runId === 'run-q');
  assert.equal(q.workspace, workspaces[1]);
  assert.ok(!said().includes('which is busy'), `it waited when it did not have to:\n${said()}`);
});

test('a free preferred checkout is the one taken', async (t) => {
  // R212's other half: the preference is honoured when it can be. Offered
  // first with both checkouts free, run-t goes where its branch already is
  // rather than into the first free path, which is what `find` alone gives.
  const workspaces = [await aRepository(), await aRepository()];
  const { platform, said } = await daemonWith(t, {
    name: 'test-workspaces-preferred-free',
    workspaces,
    offers: [{ ...codingRun('run-t', 'a pushed branch'), prefers: workspaces[1] }],
  });

  const started = await platform.until((transitions) => transitions.some((each) => each.state === 'RUNNING'));
  assert.ok(started, `the run never started:\n${said()}`);
  const t1 = platform.transitions.find((each) => each.state === 'RUNNING' && each.runId === 'run-t');
  assert.equal(t1.workspace, workspaces[1]);
});

test('a bound branch still waits for its checkout and says what it is protecting', async (t) => {
  // R86/R87, unchanged by R212 for a branch that is bound: the checkout holds
  // work origin does not, and the run waits for it however many others are
  // free — and the reason, which reaches the run page, says why.
  const workspaces = [await aRepository(), await aRepository()];
  const { platform, said } = await daemonWith(t, {
    name: 'test-workspaces-bound',
    workspaces,
    offers: [
      codingRun('run-r', 'first card'),
      { ...codingRun('run-s', 'a bound branch'), mustUse: workspaces[0] },
    ],
  });

  await platform.until((transitions) => transitions.some((each) => each.state === 'RUNNING'));
  const waited = await platform.until(
    () => /waiting for .* which is busy — the branch has work only that checkout holds/.test(said()),
  );
  assert.ok(waited, `nothing said why the bound branch waited:\n${said()}`);
  const started = platform.transitions.filter((each) => each.state === 'RUNNING');
  assert.deepEqual(started.map((each) => each.runId), ['run-r']);
});

test('a stale local branch is brought up to origin before a session starts', async (t) => {
  // R212. Two checkouts of one origin. The branch was written and pushed from
  // ws1; ws2 remembers it at an older commit — the shape a checkout is left in
  // after the branch moved on to another one. A session starting in ws2 must
  // start on what origin has, not on what ws2 remembered, or its first push
  // is refused and its first commit sits on old code.
  const origin = await aBareOrigin();
  const ws1 = await aClone(origin);
  await writeFile(join(ws1, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: ws1 });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: ws1 });
  await run('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: ws1 });
  const ws2 = await aClone(origin);
  // The stale ref: r9-work at main, in ws2.
  await run('git', ['branch', 'r9-work', 'main'], { cwd: ws2 });
  // The real branch: one commit past main, pushed from ws1.
  await run('git', ['checkout', '-q', '-b', 'r9-work'], { cwd: ws1 });
  await writeFile(join(ws1, 'work.txt'), 'done elsewhere\n');
  await run('git', ['add', '.'], { cwd: ws1 });
  await run('git', ['commit', '-q', '-m', 'work'], { cwd: ws1 });
  await run('git', ['push', '-q', '-u', 'origin', 'r9-work'], { cwd: ws1 });
  t.after(async () => {
    await rm(origin, { recursive: true, force: true });
    await rm(ws1, { recursive: true, force: true });
  });

  const { platform, said } = await daemonWith(t, {
    name: 'test-workspaces-stale',
    workspaces: [ws2],
    offers: [codingRun('9', 'the card')],
  });

  const started = await platform.until((transitions) => transitions.some((each) => each.state === 'RUNNING'));
  assert.ok(started, `the run never started:\n${said()}`);

  const { stdout: inWs2 } = await run('git', ['rev-parse', 'HEAD'], { cwd: ws2 });
  const { stdout: pushed } = await run('git', ['rev-parse', 'r9-work'], { cwd: ws1 });
  assert.equal(inWs2.trim(), pushed.trim(), `ws2 started on stale code:\n${said()}`);
  assert.match(said(), /r9-work fast-forwarded to origin\/r9-work/);
});
