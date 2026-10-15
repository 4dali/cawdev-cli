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
 * `anAgentThatLingers` whose result says what it used — R305.
 *
 * <p>100 in and 7 out per PROCESS, in the shape the real CLI's `result` event
 * carries (`modelUsage`, summed by `tools/lib/usage.mjs`). Each stage is its
 * own process, so two stages of this agent are the arithmetic the tests below
 * check: 100 and 100 on the stages, 200 on the run.
 */
async function anAgentThatSpends(home) {
  const path = join(home, 'spending-agent.mjs');
  await writeFile(path, `#!/usr/bin/env node
process.stdout.write(JSON.stringify(
  { type: 'system', subtype: 'init', session_id: 'spending' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', result: 'the stage is done',
  modelUsage: { 'claude-opus-5': { inputTokens: 100, cacheCreationInputTokens: 0, outputTokens: 7 } },
}) + '\\n');
process.stdin.on('end', () => process.exit(0));
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
      runState = null, offer = CODING, stageTokens = null }) {
  const workspace = await aRepository();
  const platform = await fakePlatform({
    offers: [offer],
    workflow,
    stageTokens,
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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
  // The log line can come a beat before the platform hears the begin — wait for
  // the call itself rather than checking the instant the line is said.
  const began = () => platform.stageCalls.some((each) => each.stage === 'IMPLEMENT' && each.what === 'begin');
  for (let waited = 0; waited < 5000 && !began(); waited += 50) {
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.ok(began(), 'IMPLEMENT never began after the gate opened');
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

test('R339: an EXPIRED gate is unread, not refused — the stage is not re-run, the run stops there', async (t) => {
  // A platform from before R339 still expires a gate after fifteen minutes.
  // Treating that as a refusal re-ran the stage with "nobody answered in
  // time" as its reason — a second stage spent on a plan nobody had read.
  const { platform, said } = await daemonWith(t, {
    name: 'test-gate-expired',
    workflow: [
      { stage: 'PLAN', gate: 'ASK' },
      { stage: 'IMPLEMENT', gate: 'AUTO' },
    ],
    gateDecision: 'EXPIRED',
  });

  assert.ok(await until(said, /the PLAN gate expired unread/), said());
  assert.ok(await platform.until((transitions) => transitions.some(
    (each) => each.state === 'FINISHED')), said());
  const finished = platform.transitions.find((each) => each.state === 'FINISHED');
  assert.match(finished.summary, /Nothing was refused/);
  assert.doesNotMatch(said(), /again, after the gate refused it/);
  assert.ok(!platform.stageCalls.some((each) => each.stage === 'IMPLEMENT' && each.what === 'begin'),
    'IMPLEMENT began after a gate nobody read');
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
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

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
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

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
  t.after(async () => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

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
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

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

// --- R305: what each stage cost, and the run as their sum ---------------------

/** Waits for the daemon to have filed a usage reading on a stage. */
async function untilStageUsage(platform, stage, count = 1, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (platform.usage.filter((each) => each.stage === stage).length >= count) {
      return true;
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  return false;
}

test('each stage reports its own tokens, and the run total is their SUM', async (t) => {
  // The bug. Each stage is its own process and the CLI's counters are
  // cumulative per process; the daemon added each child's total to a base it
  // read once from the claim, so the second stage reported 0 + its own
  // total, the platform read that as going backwards and ignored it, and a
  // staged run's stored total was its largest stage rather than the sum.
  const home = await mkdtemp(join(tmpdir(), 'cawdev-spending-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  const { platform, said } = await daemonWith(t, {
    name: 'test-stage-usage',
    agent: await anAgentThatSpends(home),
    runLive: true,
    workflow: [
      { stage: 'PLAN', gate: 'AUTO' },
      { stage: 'IMPLEMENT', gate: 'AUTO' },
    ],
  });

  assert.ok(await untilReported(platform, 'IMPLEMENT'), said());
  assert.ok(await untilStageUsage(platform, 'IMPLEMENT'), said());

  const stages = platform.usage.filter((each) => each.stage)
    .map(({ stage, tokensIn, tokensOut }) => ({ stage, tokensIn, tokensOut }));
  assert.deepEqual(stages, [
    { stage: 'PLAN', tokensIn: 100, tokensOut: 7 },
    { stage: 'IMPLEMENT', tokensIn: 100, tokensOut: 7 },
  ], JSON.stringify(platform.usage));

  // The run-level readings: the first child's total, then the base moved.
  const run = platform.usage.filter((each) => !each.stage)
    .map(({ tokensIn, tokensOut }) => ({ tokensIn, tokensOut }));
  assert.deepEqual(run, [
    { tokensIn: 100, tokensOut: 7 },
    { tokensIn: 200, tokensOut: 14 },
  ], JSON.stringify(platform.usage));
});

test('a stage re-run after a refused gate accumulates rather than resetting', async (t) => {
  // `run_stage` is one row per (run, stage) and keeps the larger reading, so
  // the second attempt's process — counting from its own zero — has to be
  // reported on top of the first attempt's total, or the row would hold
  // max(attempt) and the stages would no longer add up to the run.
  const home = await mkdtemp(join(tmpdir(), 'cawdev-spending-again-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  const { platform, said } = await daemonWith(t, {
    name: 'test-stage-usage-refused',
    agent: await anAgentThatSpends(home),
    runLive: true,
    workflow: [{ stage: 'PLAN', gate: 'ASK' }],
    gateDecision: 'DENIED',
  });

  assert.ok(await until(said, /again, after the gate refused it/), said());
  assert.ok(await untilStageUsage(platform, 'PLAN', 2), said());

  const plan = platform.usage.filter((each) => each.stage === 'PLAN')
    .map(({ tokensIn, tokensOut }) => ({ tokensIn, tokensOut }));
  assert.deepEqual(plan, [
    { tokensIn: 100, tokensOut: 7 },
    { tokensIn: 200, tokensOut: 14 },
  ], JSON.stringify(platform.usage));
});

test('a claim that already carries tokens is the base the first stage adds to', async (t) => {
  // A run picked back up (R80) arrives with what its earlier sessions spent
  // on the claim itself; the walk starts counting from there, not from zero.
  const home = await mkdtemp(join(tmpdir(), 'cawdev-spending-base-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  const { platform, said } = await daemonWith(t, {
    name: 'test-stage-usage-base',
    agent: await anAgentThatSpends(home),
    runLive: true,
    offer: { ...CODING, tokensIn: 1000, tokensOut: 50 },
    workflow: [{ stage: 'PLAN', gate: 'AUTO' }],
  });

  assert.ok(await untilStageUsage(platform, 'PLAN'), said());
  const first = platform.usage.find((each) => !each.stage);
  assert.ok(first, JSON.stringify(platform.usage));
  assert.equal(first.tokensIn, 1100, JSON.stringify(first));
  assert.equal(first.tokensOut, 57, JSON.stringify(first));
  // The stage's own reading carries none of that: the base is the RUN's.
  const stage = platform.usage.find((each) => each.stage === 'PLAN');
  assert.equal(stage.tokensIn, 100, JSON.stringify(stage));
});

test('a run walked again in a fresh session adds to what its stage rows already hold', async (t) => {
  // A handed-off run claimed by another machine, or one whose CLI died before
  // it said its session id, is claimed without a resume and re-walks the SAME
  // `run_stage` rows. The claim's total already holds the first walk, so the
  // stage has to start from what its row holds too, or the platform keeps
  // max(walk) on the stage while the run keeps the sum.
  const home = await mkdtemp(join(tmpdir(), 'cawdev-spending-rewalk-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  const { platform, said } = await daemonWith(t, {
    name: 'test-stage-usage-rewalk',
    agent: await anAgentThatSpends(home),
    runLive: true,
    offer: { ...CODING, tokensIn: 1000, tokensOut: 50 },
    stageTokens: { PLAN: { tokensIn: 1000, tokensOut: 50 } },
    workflow: [{ stage: 'PLAN', gate: 'AUTO' }],
  });

  assert.ok(await untilStageUsage(platform, 'PLAN'), said());
  const stage = platform.usage.find((each) => each.stage === 'PLAN');
  assert.equal(stage.tokensIn, 1100, JSON.stringify(stage));
  assert.equal(stage.tokensOut, 57, JSON.stringify(stage));
  const run = platform.usage.find((each) => !each.stage);
  assert.equal(run.tokensIn, 1100, JSON.stringify(run));
});

// --- a stage that ends with its commands still running ----------------------------

/**
 * An agent whose turn starts a command in the background and ends without
 * waiting for it — the R15 shape. With `reads`, it reads the command to its
 * end first. With `promptTo`, it writes what it was asked into that file.
 */
async function anAgentThatBackgrounds(home, { reads = false, promptTo = null, delegates = false } = {}) {
  const path = join(home, reads ? 'waiting-agent.mjs' : delegates ? 'delegating-agent.mjs' : 'backgrounding-agent.mjs');
  const started = delegates
    ? [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'R6 backend offline endpoint', prompt: 'build it', run_in_background: true } },
      'Async agent launched successfully. agentId: ac64d435b50cbdaab']
    : [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npx ng test', run_in_background: true } },
      'Command running in background with ID: bash_1'];
  const say = (event) => `process.stdout.write(JSON.stringify(${JSON.stringify(event)}) + '\\n');`;
  await writeFile(path, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let asked = '';
process.stdin.on('data', (chunk) => {
  asked += chunk;
  ${promptTo ? `appendFileSync(${JSON.stringify(promptTo)}, String(chunk));` : ''}
});
${say({ type: 'system', subtype: 'init', session_id: 'bg' })}
${say({ type: 'assistant', message: { content: [started[0]] } })}
${say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: started[1] }] } })}
${reads ? say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'BashOutput', input: { bash_id: 'bash_1' } }] } }) : ''}
${reads ? say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: '<status>completed</status><exit_code>0</exit_code>' }] } }) : ''}
${say({ type: 'result', result: 'tests are running' })}
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`, { mode: 0o755 });
  return path;
}

test('a TEST stage that ends with a command still in the background fails the run, and MEMORY never runs', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-bg-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const { platform, said } = await daemonWith(t, {
    name: 'test-stage-backgrounded',
    agent: await anAgentThatBackgrounds(home),
    runLive: true,
    workflow: [{ stage: 'TEST', gate: 'AUTO' }, { stage: 'MEMORY', gate: 'AUTO' }],
  });
  assert.ok(await untilReported(platform, 'TEST'), said());
  const failedRun = await platform.until((transitions) => transitions.some((each) => each.state === 'FAILED'));
  assert.ok(failedRun, said());
  const report = platform.stageCalls.find((each) => each.stage === 'TEST' && each.what === 'report');
  assert.equal(report.body.state, 'FAILED');
  assert.match(report.body.outcome, /still running in the background, or finished and never read: `npx ng test`/);
  assert.match(platform.transitions.find((each) => each.state === 'FAILED').summary, /\/continue runs this stage again/);
  assert.ok(!platform.stageCalls.some((each) => each.stage === 'MEMORY' && each.what === 'begin'),
    'the walk stopped at TEST');
});

test('an IMPLEMENT stage that leaves an agent working in the background fails the run (R6)', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-bg-agent-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const { platform, said } = await daemonWith(t, {
    name: 'implement-stage-delegated',
    agent: await anAgentThatBackgrounds(home, { delegates: true }),
    runLive: true,
    workflow: [{ stage: 'IMPLEMENT', gate: 'AUTO' }, { stage: 'TEST', gate: 'AUTO' }],
  });
  assert.ok(await untilReported(platform, 'IMPLEMENT'), said());
  assert.ok(await platform.until((transitions) => transitions.some((each) => each.state === 'FAILED')), said());
  const report = platform.stageCalls.find((each) => each.stage === 'IMPLEMENT' && each.what === 'report');
  assert.equal(report.body.state, 'FAILED');
  assert.match(report.body.outcome, /never read: `Agent: R6 backend offline endpoint`/);
  assert.ok(!platform.stageCalls.some((each) => each.stage === 'TEST' && each.what === 'begin'),
    'the walk stopped at IMPLEMENT, not at a TEST with nothing to test');
});

test('a TEST stage that waits for its background command to end is done', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-bg-read-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const { platform, said } = await daemonWith(t, {
    name: 'test-stage-bg-read',
    agent: await anAgentThatBackgrounds(home, { reads: true }),
    runLive: true,
    workflow: [{ stage: 'TEST', gate: 'AUTO' }],
  });
  assert.ok(await untilReported(platform, 'TEST'), said());
  assert.equal(platform.stageCalls.find((each) => each.stage === 'TEST' && each.what === 'report').body.state, 'DONE');
});

test('/continue: the stage that stopped is run again and told why', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-bg-resume-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const prompts = join(home, 'prompts.txt');
  await writeFile(prompts, '');
  const { platform, said } = await daemonWith(t, {
    name: 'test-stage-bg-resume',
    agent: await anAgentThatBackgrounds(home, { reads: true, promptTo: prompts }),
    runLive: true,
    // As the platform claims a carried-on run since R263: its lifecycle starts
    // at the first stage not DONE, so IMPLEMENT is not in it.
    workflow: [{ stage: 'TEST', gate: 'AUTO' }],
    stageTokens: {
      TEST: { state: 'FAILED', outcome: 'The TEST stage ended with 1 command(s) still running: `npx ng test`.' },
    },
  });
  assert.ok(await untilReported(platform, 'TEST'), said());
  const asked = (await import('node:fs')).readFileSync(prompts, 'utf8');
  assert.match(asked, /TEST \(the attempt that stopped\)[\s\S]*npx ng test[\s\S]*IN THE FOREGROUND/, 'the re-run is told why');
  assert.match(asked, /run every command in the foreground and wait for it to finish/);
  assert.match(asked, /Then commit the branch/);
});

// --- IMPLEMENT with and without a plan -------------------------------------------

test('IMPLEMENT on a card nobody planned is told the card is the task, not to stop', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-noplan-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const prompts = join(home, 'prompts.txt');
  await writeFile(prompts, '');
  const { platform, said } = await daemonWith(t, {
    name: 'test-implement-no-plan',
    agent: await anAgentThatBackgrounds(home, { reads: true, promptTo: prompts }),
    runLive: true,
    workflow: [{ stage: 'IMPLEMENT', gate: 'AUTO' }],
  });
  assert.ok(await untilReported(platform, 'IMPLEMENT'), said());
  const asked = (await import('node:fs')).readFileSync(prompts, 'utf8');
  assert.match(asked, /This card has no plan, and it does not need one/);
  assert.match(asked, /the CARD's text is the task/);
  assert.match(asked, /Never stop because a plan is missing/);
  assert.match(asked, /ASK it with `ask_user`/);
  assert.doesNotMatch(asked, /Do the work in the plan/, 'no pointer to a plan that is not there');
});

test('IMPLEMENT on a planned card still follows the plan it was given', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-plan-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const prompts = join(home, 'prompts.txt');
  await writeFile(prompts, '');
  const { platform, said } = await daemonWith(t, {
    name: 'test-implement-plan',
    agent: await anAgentThatBackgrounds(home, { reads: true, promptTo: prompts }),
    runLive: true,
    offer: { ...CODING, plan: { body: 'Change the badge link to open in a new tab.' } },
    workflow: [{ stage: 'IMPLEMENT', gate: 'AUTO' }],
  });
  assert.ok(await untilReported(platform, 'IMPLEMENT'), said());
  const asked = (await import('node:fs')).readFileSync(prompts, 'utf8');
  assert.match(asked, /## The plan for this card[\s\S]*open in a new tab/);
  assert.match(asked, /Do the work in the plan/);
  assert.doesNotMatch(asked, /This card has no plan/);
  // Wrong or incomplete: ask, do not stop (R19, R24).
  assert.match(asked, /If it turns out to be wrong or incomplete, ask what to do instead of stopping/);
  assert.match(asked, /ASK it with `ask_user`[\s\S]*Never end this stage on an open question/);
  assert.doesNotMatch(asked, /say so and stop/);
});

test('PLAN is told to ask the open decisions before writing, not to leave them in the plan', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-plan-asks-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const prompts = join(home, 'prompts.txt');
  await writeFile(prompts, '');
  const { platform, said } = await daemonWith(t, {
    name: 'test-plan-asks',
    agent: await anAgentThatBackgrounds(home, { reads: true, promptTo: prompts }),
    runLive: true,
    offer: { ...CODING, profile: 'PLAN' },
    workflow: [{ stage: 'PLAN', gate: 'AUTO' }],
  });
  assert.ok(await untilReported(platform, 'PLAN'), said());
  const asked = (await import('node:fs')).readFileSync(prompts, 'utf8');
  assert.match(asked, /with every decision in it already made/);
  assert.match(asked, /Never end this stage on an open question/);
});
