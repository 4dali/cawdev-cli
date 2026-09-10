// node --test tools/runner/required-capability.test.mjs
//
// R161, against the real daemon: what a REQUIRED capability actually costs.
//
// `harness-prompt.test.mjs` pins the wording and `tool-line.test.mjs` pins the
// reader. This pins the only part neither can show — the LOOP around them: that
// a stage which skipped a required capability is written one more user message
// and gets one more turn, that a stage which used it is left alone, that a
// stage which ignores the nudge is not asked twice and still ENDS, and that an
// expert the stage was never handed is not required of it.
//
// The third of those is the one worth the most. A nudge that could not be
// ignored would be a stage held open by a daemon waiting for a turn that is
// never coming, which is R22's forty-three minutes arriving through a new door
// — and it would look identical in every log to one that was simply slow.
//
//   env -u CAWDEV_URL -u CAWDEV_TOKEN node --test tools/runner/required-capability.test.mjs
//
// The unsets are not optional. Inside a cawdev run those two are in the
// environment, the daemon spawned below then talks to the REAL platform, and
// what comes back is sixteen unrelated failures that read exactly like a
// regression in this file.

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

const CODING = {
  id: 'run-required', projectSlug: 'board', label: 'the card',
  branch: 'r161-work', profile: 'CODE',
};

const DATAVIZ = {
  key: 'dataviz',
  name: 'Data visualisation',
  description: 'Charts that read as one system.',
  body: '# Dataviz\n\nUse a bar chart.\n',
  mode: 'REQUIRED',
};

async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-required-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

/**
 * An agent that counts the user messages it is handed and answers each one.
 *
 * <p>Written to a file rather than reached for in `stub-agent.mjs` for
 * `lifecycle.test.mjs`'s reason, which is the same one: these tests are about
 * the LOOP and want an agent with no platform in it at all. (`stub-agent.mjs`
 * reports through the API and needs a run behind its token, which the fake
 * platform does not give it — the two have never been used together.)
 *
 * <p>The counting is the point. Message one is the opening prompt; message two,
 * if it comes, is the nudge — so "did the daemon ask again" is a fact this
 * agent can answer by construction rather than by matching text.
 *
 * @param turns what to emit for each user message, in order. `'skip'` ends the
 *   turn having done nothing; `'use'` calls the required skill first.
 */
async function anAgentThat(home, name, turns) {
  const path = join(home, `${name}.mjs`);
  await writeFile(path, `#!/usr/bin/env node
const turns = ${JSON.stringify(turns)};
let at = 0;

const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');

emit({ type: 'system', subtype: 'init', session_id: '${name}' });

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const what = turns[at] ?? 'skip';
    at += 1;
    if (what === 'use') {
      emit({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'cawdev:dataviz' } }] },
      });
    }
    emit({ type: 'result', result: 'turn ' + at + ' over' });
  }
});
// R22: it leaves when its input closes, and not before.
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`, { mode: 0o755 });
  return path;
}

async function daemonWith(t, { name, agent, workflow, skills = [], expertAgents = [] }) {
  const workspace = await aRepository();
  const platform = await fakePlatform({
    offers: [CODING],
    workflow,
    skills,
    expertAgents,
    // The stage's own handling has to be what ends this child, not the reaper —
    // see lifecycle.test.mjs, where the same line is load-bearing for the same
    // reason.
    runLive: true,
  });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-required-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: agent,
    pollSeconds: 1,
    // Short, so the fallback timer's own arithmetic (2× this, in seconds) does
    // not make the anti-deadlock test outlive the suite.
    sessionExitSeconds: 2,
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

/** Waits for the daemon to have REPORTED a stage — see lifecycle.test.mjs. */
async function untilReported(platform, stage, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (platform.stageCalls.some((each) => each.stage === stage && each.what === 'report')) {
      return true;
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  return false;
}

/** The transcript as the PLATFORM received it, which is all a person ever sees. */
const bodies = (platform) => platform.outputs.map((line) => line.body ?? '');

const nudges = (platform) =>
  bodies(platform).filter((body) => /has not used .*which this project requires/.test(body));

test('a stage that skipped a required skill is nudged once, uses it, and ends DONE', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-required-agent-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const { platform, said } = await daemonWith(t, {
    name: 'test-required-nudged',
    agent: await anAgentThat(home, 'skips-the-skill', ['skip', 'use']),
    workflow: [{ stage: 'IMPLEMENT', gate: 'AUTO' }],
    skills: [DATAVIZ],
  });

  assert.ok(await untilReported(platform, 'IMPLEMENT'), said());

  // Nudged exactly once, and said on the RUN rather than only in a log on
  // somebody's laptop.
  assert.equal(nudges(platform).length, 1, bodies(platform).join('\n'));

  // And the skill was used AFTER the nudge, which is the whole claim: this is
  // an ordering assertion, not a presence one. A transcript holding both lines
  // in the other order would be a session that used it and was nudged anyway.
  const lines = bodies(platform);
  const nudgedAt = lines.findIndex((body) => /which this project requires/.test(body));
  const usedAt = lines.findIndex((body) => body.startsWith('Skill(cawdev:dataviz)'));
  assert.ok(usedAt > nudgedAt && nudgedAt !== -1,
    `nudge at ${nudgedAt}, use at ${usedAt}:\n${lines.join('\n')}`);

  // The stage finished. Nothing here refuses, fails or re-runs anything.
  const report = platform.stageCalls.find((each) => each.what === 'report');
  assert.equal(report.body.state, 'DONE', JSON.stringify(report.body));
});

test('a stage that used the required skill is never nudged', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-required-agent-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const { platform, said } = await daemonWith(t, {
    name: 'test-required-used',
    agent: await anAgentThat(home, 'uses-the-skill', ['use']),
    workflow: [{ stage: 'IMPLEMENT', gate: 'AUTO' }],
    skills: [DATAVIZ],
  });

  assert.ok(await untilReported(platform, 'IMPLEMENT'), said());
  assert.deepEqual(nudges(platform), [], bodies(platform).join('\n'));
  assert.ok(bodies(platform).some((body) => body.startsWith('Skill(cawdev:dataviz)')),
    bodies(platform).join('\n'));
});

test('a stage that ignores the nudge is not asked twice, and still ENDS', async (t) => {
  // The anti-loop test and the anti-deadlock test in one, and the reason both
  // are one test is that they are one failure: a daemon that kept asking would
  // also be a daemon that never closed the input.
  const home = await mkdtemp(join(tmpdir(), 'cawdev-required-agent-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const { platform, said } = await daemonWith(t, {
    name: 'test-required-ignored',
    agent: await anAgentThat(home, 'ignores-the-nudge', ['skip', 'skip']),
    workflow: [{ stage: 'IMPLEMENT', gate: 'AUTO' }],
    skills: [DATAVIZ],
  });

  assert.ok(await untilReported(platform, 'IMPLEMENT'), said());

  // Once. `child.cawdevNudged` is one line and this is the whole of what says
  // it is doing anything.
  assert.equal(nudges(platform).length, 1, bodies(platform).join('\n'));
  assert.ok(!bodies(platform).some((body) => body.startsWith('Skill(cawdev:dataviz)')),
    bodies(platform).join('\n'));

  const report = platform.stageCalls.find((each) => each.what === 'report');
  assert.equal(report.body.state, 'DONE', JSON.stringify(report.body));
});

test('an expert a read-only stage cannot reach is not required of it', async (t) => {
  // The rule this entry must never break. A PLAN stage is handed only the
  // experts that can change nothing; requiring one it was deliberately not
  // given would be this card widening what a run may do, which is the one thing
  // it must not do. The mode is read AFTER the narrowing, always.
  const home = await mkdtemp(join(tmpdir(), 'cawdev-required-agent-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const { platform, said } = await daemonWith(t, {
    name: 'test-required-unreachable',
    agent: await anAgentThat(home, 'plans-without-the-expert', ['skip', 'skip']),
    workflow: [{ stage: 'PLAN', gate: 'AUTO' }],
    expertAgents: [{
      key: 'architect',
      name: 'The architect',
      description: 'Designs how a change fits.',
      // A writer, so `readOnlyExpert` drops it from a PLAN stage.
      tools: 'Read, Write',
      body: '# Architect\n',
      mode: 'REQUIRED',
    }],
  });

  assert.ok(await untilReported(platform, 'PLAN'), said());
  assert.deepEqual(nudges(platform), [], bodies(platform).join('\n'));

  // And the existing explanation is still there, unchanged — the honest answer
  // to "why did my expert never get used?" in the other common case.
  assert.ok(bodies(platform).some((body) => /cannot reach it/.test(body)),
    bodies(platform).join('\n'));
});
