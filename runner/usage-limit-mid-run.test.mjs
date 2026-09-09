// node --test tools/runner/usage-limit-mid-run.test.mjs
//
// R73, at the moment the window is actually said.
//
// The daemon asked `usageLimitOf` in exactly one place: the child's `close`
// handler, and only when the child exited NON-ZERO. A session that hits its
// limit part-way through a run does neither of those things. The CLI prints
//
//     You've hit your session limit · resets 4am (Africa/Tunis)
//
// ends the turn with SUCCESS, and then — because R22 holds its stdin open so a
// person can prompt it — sits there. Observed on a real machine: forty-three
// minutes of a run stuck RUNNING, the runner's only slot held, three queued
// runs behind it, and an idle watchdog correctly saying so and correctly doing
// nothing about it.
//
// The recovery then hid the cause. Carrying the run on put it back to QUEUED,
// and when the process was finally killed the daemon DID recognise the window
// and the platform refused the report — "a run that is QUEUED cannot move to
// USAGE_LIMITED" — so the one moment the daemon knew a window was closed was
// spent on a state the run had already left. It re-claimed and spawned a fresh
// session straight back into the same closed window.
//
// So the subject here is a turn, not an exit. The agents below never exit.

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
  const path = await mkdtemp(join(tmpdir(), 'cawdev-limit-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

/**
 * An agent that ends its turn saying `what`, and then stays — no exit, no
 * error code, nothing for a close handler to read.
 *
 * That last part is the whole test. An agent that exited here would be caught
 * by the code that was already there, and would prove nothing about the case
 * that hung.
 */
async function anAgentThatSays(home, what, file) {
  const path = join(home, file);
  await writeFile(path, `#!/usr/bin/env node
process.stdout.write(JSON.stringify(
  { type: 'system', subtype: 'init', session_id: 'limited' }) + '\\n');
process.stdout.write(JSON.stringify(
  { type: 'result', subtype: 'success', result: ${JSON.stringify(what)} }) + '\\n');
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`, { mode: 0o755 });
  return path;
}

async function untilSaid(said, pattern, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(said())) return true;
    await new Promise((wake) => setTimeout(wake, 100));
  }
  return false;
}

async function daemonWith(t, { name, says, file }) {
  const workspace = await aRepository();
  const home = await mkdtemp(join(tmpdir(), 'cawdev-limit-cfg-'));
  const agent = await anAgentThatSays(home, says, file);
  const platform = await fakePlatform({
    offers: [{ id: `run-${name}`, projectSlug: 'board', label: 'the card', profile: 'ASK' }],
    // The run has to stay live, or the daemon reaps the child for a reason
    // that has nothing to do with this.
    runLive: true,
  });
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: agent,
    pollSeconds: 1,
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

  return { platform, said: () => said, untilSaid: (p, ms) => untilSaid(() => said, p, ms) };
}

test('a window that closes mid-turn is reported without waiting for an exit', async (t) => {
  const { platform, said, untilSaid } = await daemonWith(t, {
    name: 'test-limit-mid-turn',
    file: 'limited-agent.mjs',
    says: "You've hit your session limit · resets 4am (Africa/Tunis)",
  });

  assert.ok(await untilSaid(/usage window closed mid-run/), said());

  // THE assertion. Before this, the transition came only from a non-zero exit,
  // and this agent — like the real one — never exits at all.
  const parked = await platform.until(
    (all) => all.some((each) => each.state === 'USAGE_LIMITED'),
  );
  assert.ok(parked, `the run was never parked:\n${said()}`);

  const limited = platform.transitions.find((each) => each.state === 'USAGE_LIMITED');
  assert.equal(limited.limitWindow, 'FIVE_HOUR');
  // The reset the CLI stated, carried through, because that is what decides
  // when AutoResumer may pick the run back up.
  assert.ok(limited.limitResetsAt, 'no reset time, so nothing knows when to retry');
});

test('and the session is asked to leave, because a parked run holds no process', async (t) => {
  // R73 says USAGE_LIMITED holds no process. Reporting the window and leaving
  // the child running is the forty-three minutes again with a better label on
  // it — the slot stays taken either way.
  const { said, untilSaid } = await daemonWith(t, {
    name: 'test-limit-ends-session',
    file: 'limited-agent-2.mjs',
    says: "You've hit your session limit · resets 4am (Africa/Tunis)",
  });

  assert.ok(await untilSaid(/usage window closed/), said());
  assert.ok(await untilSaid(/agent exited/, 25000), `the process was left behind:\n${said()}`);
});

test('an ordinary turn is not a closed window, and its session stays open', async (t) => {
  // The false positive that would matter, and R22's rule intact: a run whose
  // turn ended normally keeps its process, because somebody may prompt it.
  const { platform, said, untilSaid } = await daemonWith(t, {
    name: 'test-limit-ordinary-turn',
    file: 'ordinary-agent.mjs',
    says: 'I read the diff and it looks fine.',
  });

  assert.ok(await untilSaid(/spawning:/), said());
  await new Promise((wake) => setTimeout(wake, 4000));

  assert.doesNotMatch(said(), /usage window/);
  assert.doesNotMatch(said(), /agent exited/);
  assert.ok(!platform.transitions.some((each) => each.state === 'USAGE_LIMITED'),
    'an ordinary answer was read as a closed window');
});
