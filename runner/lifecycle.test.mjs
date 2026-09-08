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

/**
 * An agent that behaves like the real `claude` in the one way that matters
 * here: it says its turn is over and then STAYS, because its stdin is open and
 * it is waiting for whatever gets typed next (R22). It leaves when its input
 * closes — or, with `deaf`, not even then.
 *
 * Written to a file rather than reached for in stub-agent.mjs because these
 * tests are about the LOOP and want an agent with no platform in it at all.
 */
async function anAgentThatLingers(home, { deaf = false } = {}) {
  const path = join(home, deaf ? 'deaf-agent.mjs' : 'lingering-agent.mjs');
  await writeFile(path, `#!/usr/bin/env node
process.stdout.write(JSON.stringify(
  { type: 'system', subtype: 'init', session_id: 'lingering' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', result: 'the stage is done' }) + '\\n');
${deaf
    ? "// Ignores EOF entirely — the case the escalation exists for.\nsetTimeout(() => {}, 600000);"
    : "process.stdin.on('end', () => process.exit(0));"}
process.stdin.resume();
`, { mode: 0o755 });
  return path;
}

/**
 * An agent that never ends its turn — R122.
 *
 * <p>It says hello and then works for ever, so nothing it does ends the stage:
 * the only thing that stops it is the daemon's own reaper, which takes down the
 * process group of any run the platform no longer calls live. That is the real
 * shape of a run whose agent reported done in the middle of its lifecycle, and
 * it is the case the walk used to read as a dead stage.
 */
async function anAgentThatIsReaped(home) {
  const path = join(home, 'working-agent.mjs');
  await writeFile(path, `#!/usr/bin/env node
process.stdout.write(JSON.stringify(
  { type: 'system', subtype: 'init', session_id: 'working' }) + '\\n');
// No result, ever. The turn does not end; the reaper ends the process.
setTimeout(() => {}, 600000);
process.stdin.resume();
`, { mode: 0o755 });
  return path;
}

/** Exits non-zero having said nothing — what a stopped child looks like. */
async function anAgentThatFails(home) {
  const path = join(home, 'failing-agent.mjs');
  await writeFile(path, '#!/usr/bin/env node\nprocess.exit(1);\n', { mode: 0o755 });
  return path;
}

async function daemonWith(t,
    { name, workflow, gateDecision, agent, sessionExitSeconds, runLive = false,
      runState = null }) {
  const workspace = await aRepository();
  const platform = await fakePlatform({
    offers: [CODING],
    workflow,
    gateDecision,
    runState,
    // A run the fake platform calls FINISHED is reaped, and a reaped child is
    // indistinguishable from one that left of its own accord — which is the
    // whole subject of the two tests that pass an agent. They need the run to
    // stay live so that nothing but the daemon's own stage handling ends it.
    runLive,
  });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-lifecycle-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    // `/bin/echo` exits 0 immediately and says nothing a stream parser can use,
    // which is exactly what most of this needs: the subject is the LOOP, not
    // the agent. It is also the reason the walk could deadlock for months with
    // every test here green — see the two that pass an agent of their own.
    // Named directly, never as an argument to `node`: the runner puts
    // `--mcp-config` first, and node would exit on a flag it does not know.
    // The shebang runs it and the cawdev flags land in an argv it ignores —
    // which is what the real CLI does with the ones it does not need either.
    agentCommand: agent ?? '/bin/echo',
    pollSeconds: 1,
    ...(sessionExitSeconds ? { sessionExitSeconds } : {}),
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

  // Wait for the REPORT rather than for a log line. A log line saying
  // IMPLEMENT means the stage started; the reports arrive when each process
  // closes, and asserting on them straight after the log is a race that passes
  // on a quiet machine and fails under a full suite — which is exactly how it
  // behaved before this line.
  assert.ok(await untilReported(platform, 'IMPLEMENT'), said());
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

test('a stage whose agent does not exit by itself is still walked past', async (t) => {
  // The bug this file could not see. `/bin/echo` leaves the moment it is
  // spawned, so every test above walked its lifecycle against an agent that
  // ended itself — while the real CLI, spawned with `--input-format
  // stream-json` and its stdin held open by R22, says its turn is over and then
  // waits for the next one. The walk advances on the child's `close`, so it
  // waited for an event nothing was going to cause: PLAN finished, its plan was
  // written, and the run sat RUNNING holding the project's only checkout.
  //
  // So: an agent that lingers, and the assertion is simply that the SECOND
  // stage happens.
  const home = await mkdtemp(join(tmpdir(), 'cawdev-lingering-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const { platform, said } = await daemonWith(t, {
    name: 'test-lingering-agent',
    agent: await anAgentThatLingers(home),
    runLive: true,
    workflow: [
      { stage: 'PLAN', gate: 'AUTO' },
      { stage: 'IMPLEMENT', gate: 'AUTO' },
    ],
  });

  assert.ok(await untilReported(platform, 'IMPLEMENT'), said());
  // And it got there as work done, not as a run that failed on the way.
  assert.deepEqual(platform.transitions.filter((each) => each.state === 'FAILED'), [], said());
});

test('an agent that ignores the closed input is stopped rather than waited on', async (t) => {
  // Closing stdin is a request, and the deadlock comes back in full if a CLI
  // declines it. Nothing about this run may depend on the agent's cooperation,
  // so the wait is bounded — and a stage forced out after its turn ended is
  // DONE, because the daemon is the one that forced it.
  const home = await mkdtemp(join(tmpdir(), 'cawdev-deaf-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const { platform, said } = await daemonWith(t, {
    name: 'test-deaf-agent',
    agent: await anAgentThatLingers(home, { deaf: true }),
    runLive: true,
    sessionExitSeconds: 2,
    workflow: [
      { stage: 'PLAN', gate: 'AUTO' },
      { stage: 'IMPLEMENT', gate: 'AUTO' },
    ],
  });

  assert.ok(await until(said, /has not exited 2s after its input closed/), said());
  assert.ok(await untilReported(platform, 'IMPLEMENT'), said());
  const plan = platform.stageCalls.find(
    (each) => each.stage === 'PLAN' && each.what === 'report');
  assert.equal(plan.body.state, 'DONE', JSON.stringify(plan.body));
  assert.deepEqual(platform.transitions.filter((each) => each.state === 'FAILED'), [], said());
});

test('a stage stopped because the run already ended is not a failed stage', async (t) => {
  // R117, exactly: the agent reported done inside VERIFY, the reaper took the
  // child down because the run was no longer live, and the walk read its own
  // daemon's kill as a stage that died. The run was FINISHED and the console
  // drew it stuck in VERIFY, with every stage behind it PENDING for ever.
  //
  // `runLive: false` is that state — the fake platform answers FINISHED, which
  // is what the platform says once an agent has reported.
  const home = await mkdtemp(join(tmpdir(), 'cawdev-reaped-'));
  t.after(async () => rm(home, { recursive: true, force: true }));

  const { platform, said } = await daemonWith(t, {
    name: 'test-reaped-mid-lifecycle',
    agent: await anAgentThatIsReaped(home),
    workflow: [
      { stage: 'PLAN', gate: 'AUTO' },
      { stage: 'IMPLEMENT', gate: 'AUTO' },
      { stage: 'MEMORY', gate: 'AUTO' },
    ],
  });

  assert.ok(await untilReported(platform, 'PLAN'), said());
  const plan = platform.stageCalls.find((each) => each.stage === 'PLAN' && each.what === 'report');
  assert.equal(plan.body.state, 'DONE', JSON.stringify(plan.body));

  // And the stages that will never run say so, rather than sitting at PENDING
  // on a run that is over. SKIPPED is the state that means *not going to*.
  assert.ok(await untilReported(platform, 'MEMORY'), said());
  for (const stage of ['IMPLEMENT', 'MEMORY']) {
    const report = platform.stageCalls
      .find((each) => each.stage === stage && each.what === 'report');
    assert.equal(report.body.state, 'SKIPPED', `${stage}: ${JSON.stringify(report?.body)}`);
  }

  // The one thing that must not happen: a run that finished being failed by
  // the daemon that stopped it.
  const failed = platform.transitions.filter((each) => each.state === 'FAILED');
  assert.deepEqual(failed, [], JSON.stringify(failed));
});

test('a run stopped by the usage limit is not then failed by the walk', async (t) => {
  // The bug, and it needed both halves to bite. The CLI said "You've hit your
  // session limit"; `usageLimitOf` did not know the word "session" and
  // returned null, so nothing transitioned the run — and even once it did,
  // this walk would have overwritten it.
  //
  // USAGE_LIMITED and PAUSED are LIVE states that hold no process, so R122's
  // guard — which bails when the run is over — does not catch them. The child
  // exiting under one is the consequence of the stop, not a stage that died,
  // and calling it FAILED puts the word for a crash on a clock running out.
  const home = await mkdtemp(join(tmpdir(), 'cawdev-limited-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const { platform, said } = await daemonWith(t, {
    name: 'test-usage-limited',
    // Exits non-zero having said nothing, which is what the walk reads as a
    // dead stage unless it asks the platform first.
    agent: await anAgentThatFails(home),
    runLive: true,
    runState: 'USAGE_LIMITED',
    workflow: [
      { stage: 'PLAN', gate: 'AUTO' },
      { stage: 'IMPLEMENT', gate: 'AUTO' },
    ],
  });

  assert.ok(await until(said, /was usage limited during the PLAN stage/), said());

  // Nothing was failed. That is the whole assertion: R73 says a clock is not
  // a crash, and this is the door it was arriving through.
  await new Promise((done) => setTimeout(done, 1500));
  assert.deepEqual(platform.transitions.filter((each) => each.state === 'FAILED'), [],
    `the walk failed a usage-limited run:\n${said()}`);

  // And the stage says SKIPPED rather than FAILED: nobody claims it finished,
  // and nobody should record that it broke.
  const report = platform.stageCalls.find(
    (each) => each.stage === 'PLAN' && each.what === 'report');
  assert.equal(report.body.state, 'SKIPPED', JSON.stringify(report.body));
});
