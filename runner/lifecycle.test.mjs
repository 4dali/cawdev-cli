// node --test tools/runner/lifecycle.test.mjs
//
// R112, against the real daemon: the DAEMON walks the lifecycle.
//
// `stage-tools.test.mjs` pins the claim — a PLAN stage is spawned with nothing
// that can write. This pins the loop around it, which is the part no pure
// function can show: that there is one process per stage, that the daemon
// reports each one, that it STOPS at a gate and does not simply carry on, and
// that a run with no lifecycle is spawned exactly as it always was.
//
// The waiting is the half worth the most here. A daemon that raised a gate and
// then continued would look identical in every log to one that waited, right up
// until somebody's plan was implemented without being read.

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

async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-lifecycle-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

const CODING = {
  id: 'run-lifecycle', projectSlug: 'board', label: 'the card',
  branch: 'r1-work', profile: 'CODE',
};

async function daemonWith(t, { name, workflow, gateDecision }) {
  const workspace = await aRepository();
  const platform = await fakePlatform({
    offers: [CODING],
    workflow,
    gateDecision,
  });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-lifecycle-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    // `/bin/echo` exits 0 immediately and says nothing a stream parser can use,
    // which is exactly what this needs: the subject is the LOOP, not the agent.
    agentCommand: '/bin/echo',
    pollSeconds: 1,
    projects: { board: { workspaces: [workspace] } },
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
    await rm(socketPathFor(name), { force: true });
  });

  return { platform, said: () => said };
}

/** Waits for the daemon to have REPORTED a stage, rather than for it to say so. */
async function untilReported(platform, stage, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (platform.stageCalls.some((each) => each.stage === stage && each.what === 'report')) {
      return true;
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  return false;
}

async function until(said, pattern, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(said())) return true;
    await new Promise((done) => setTimeout(done, 150));
  }
  return false;
}

test('with no lifecycle, a run is spawned exactly as it always was', async (t) => {
  // Not a fallback: this is the ordinary case for ASK, ROADMAP and AUDIT, and
  // for every project that has not configured one. A change that quietly made
  // every run staged would be a change nobody asked for.
  const { platform, said } = await daemonWith(t, { name: 'test-no-lifecycle', workflow: [] });

  assert.ok(await until(said, /spawning/), said());
  assert.doesNotMatch(said(), /walking/, said());
  assert.equal(platform.stageCalls.length, 0);
});

test('with a lifecycle, the daemon walks it and reports every stage', async (t) => {
  const { platform, said } = await daemonWith(t, {
    name: 'test-walks',
    workflow: [
      { stage: 'PLAN', gate: 'AUTO', model: 'haiku' },
      { stage: 'IMPLEMENT', gate: 'AUTO', model: 'opus' },
    ],
  });

  assert.ok(await until(said, /walking 2 stage\(s\): PLAN → IMPLEMENT/), said());
  assert.ok(await until(said, /IMPLEMENT on opus/), said());

  // One process per stage, and the daemon said which model each got — the
  // thing R109's router could not do at all before this.
  assert.match(said(), /PLAN on haiku/);

  await until(said, /IMPLEMENT/);
  const reported = platform.stageCalls.map((each) => `${each.stage}:${each.what}`);
  assert.deepEqual(reported.slice(0, 4),
    ['PLAN:begin', 'PLAN:report', 'IMPLEMENT:begin', 'IMPLEMENT:report'], reported.join(' '));
});

test('the plan is stored as the PLAN stage report, not as prose in a transcript', async (t) => {
  const { platform, said } = await daemonWith(t, {
    name: 'test-plan-artefact',
    workflow: [{ stage: 'PLAN', gate: 'AUTO' }],
  });

  assert.ok(await until(said, /PLAN/), said());
  // Wait for the REPORT rather than for a log line: the report is sent after
  // the stage's process closes, and a test that raced it would fail on a busy
  // machine and pass on a quiet one — which is the worst kind of test.
  assert.ok(await untilReported(platform, 'PLAN'), said());
  const report = platform.stageCalls.find((each) => each.what === 'report');
  // `plan` is present on a PLAN report and is what the gate shows a person.
  assert.ok('plan' in report.body, JSON.stringify(report.body));
});

test('a gated stage STOPS, and does not carry on while nobody has answered', async (t) => {
  // The half that matters. A daemon that raised a gate and continued would look
  // identical in the log to one that waited, until somebody's plan had been
  // implemented without being read.
  const { platform, said } = await daemonWith(t, {
    name: 'test-gate-waits',
    workflow: [
      { stage: 'PLAN', gate: 'ASK' },
      { stage: 'IMPLEMENT', gate: 'AUTO' },
    ],
    gateDecision: null, // nobody answers
  });

  assert.ok(await until(said, /waiting at the PLAN gate/), said());
  assert.equal(platform.gates.length, 1, 'no approval was raised');

  // And it is still waiting several seconds later: IMPLEMENT has not begun.
  await new Promise((done) => setTimeout(done, 4000));
  const began = platform.stageCalls.filter((each) => each.stage === 'IMPLEMENT');
  assert.deepEqual(began, [], 'the daemon walked past a gate nobody answered');
});

test('the approval a gate raises carries the stage output, so a person reads the plan', async (t) => {
  const { platform, said } = await daemonWith(t, {
    name: 'test-gate-summary',
    workflow: [{ stage: 'PLAN', gate: 'ASK' }],
    gateDecision: null,
  });

  assert.ok(await until(said, /waiting at the PLAN gate/), said());
  const [gate] = platform.gates;
  // R51's approval, reused rather than a third way of waiting — which is what
  // brings the inbox row and the decision UI with it.
  assert.equal(gate.toolName, 'stage:PLAN');
  assert.ok(gate.summary, 'the gate asked a person to decide on nothing');
});

test('an allowed gate lets the next stage begin', async (t) => {
  const { platform, said } = await daemonWith(t, {
    name: 'test-gate-allowed',
    workflow: [
      { stage: 'PLAN', gate: 'ASK' },
      { stage: 'IMPLEMENT', gate: 'AUTO' },
    ],
    gateDecision: 'ALLOWED',
  });

  assert.ok(await until(said, /the PLAN gate was allowed/), said());
  assert.ok(await until(said, /IMPLEMENT/), said());
  assert.ok(platform.stageCalls.some((each) => each.stage === 'IMPLEMENT' && each.what === 'begin'),
    'IMPLEMENT never began after the gate opened');
});

test('a refused gate re-runs THAT stage rather than ending the run', async (t) => {
  // A rejected plan should cost one cheap stage, not a whole run — and the
  // reason for refusing is the point of refusing, so it goes into the retry.
  const { said } = await daemonWith(t, {
    name: 'test-gate-refused',
    workflow: [{ stage: 'PLAN', gate: 'ASK' }],
    gateDecision: 'DENIED',
  });

  assert.ok(await until(said, /the PLAN gate was refused/), said());
  assert.ok(await until(said, /again, after the gate refused it/), said());
});
