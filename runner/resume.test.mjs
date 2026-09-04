// node --test tools/runner/resume.test.mjs
//
// R69's half that lives on the machine: spawning `claude --resume` and saying
// the follow-up into it rather than the original question.
//
// The agent is a recorder — a three-line script that writes its argv and its
// stdin to a file and stops — because those two are exactly what this entry is
// about. `/bin/echo` (which browser.test.mjs uses) shows the argv but throws
// stdin away, and stdin is where the follow-up goes.
//
// What is deliberately NOT tested here is whether the CLI actually remembers
// the first exchange. That is Claude Code's promise, not this daemon's, and a
// test of it would be a test of a program we do not ship.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

/** Waits for a file to exist and have something in it. */
async function untilWritten(path, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (text.trim()) return text;
    await new Promise((wake) => setTimeout(wake, 100));
  }
  return '';
}

/**
 * An agent that records rather than thinks.
 *
 * It announces a session id on `init` the way the real CLI does — that is the
 * handle the whole entry turns on, and a stand-in that never emitted one would
 * make the reporting path untestable.
 */
async function aRecorder(directory, record) {
  const path = join(directory, 'recorder.mjs');
  await writeFile(
    path,
    `#!/usr/bin/env node
import { writeFileSync, readFileSync } from 'node:fs';
process.stdout.write(JSON.stringify({
  type: 'system', subtype: 'init', session_id: 'sess-from-init', model: 'recorder',
}) + '\\n');
let stdin = '';
process.stdin.on('data', (chunk) => {
  stdin += chunk;
  writeFileSync(${JSON.stringify(record)},
    JSON.stringify({ argv: process.argv.slice(2), stdin }));
});
// Held open, like the real thing under --input-format stream-json.
setTimeout(() => process.exit(0), 60000);
`,
    { mode: 0o755 },
  );
  await chmod(path, 0o755);
  return path;
}

async function daemonWith(t, { name, resume }) {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-resume-'));
  const record = join(home, 'recorded.json');
  const agent = await aRecorder(home, record);

  const platform = await fakePlatform({
    resume,
    // The recorder is held open on purpose, so the reaper must not take it down
    // before it has written what this test came to read.
    runLive: true,
    offers: [{
      id: 'run-resume',
      projectSlug: 'board',
      label: 'what does the runner do with a question?',
      branch: null,
      profile: 'ASK',
      kind: 'MANUAL',
      openingPrompt: 'What does the runner do with a question?',
    }],
  });

  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: agent,
    agentArgs: [],
    pollSeconds: 1,
    projects: { board: home },
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
  });

  const written = await untilWritten(record);
  assert.ok(written, `the agent recorded nothing:\n${said}`);
  return { platform, recorded: JSON.parse(written), said: () => said };
}

test('a claim that carries a resume spawns --resume with that session', async (t) => {
  const { recorded } = await daemonWith(t, {
    name: 'test-resume-yes',
    resume: { agentSessionId: 'sess-first-time', prompt: 'no, I meant the runner side' },
  });

  const at = recorded.argv.indexOf('--resume');
  assert.notEqual(at, -1, `no --resume in ${JSON.stringify(recorded.argv)}`);
  assert.equal(recorded.argv[at + 1], 'sess-first-time');
});

test('the resumed session is told the follow-up, not the question again', async (t) => {
  const { recorded } = await daemonWith(t, {
    name: 'test-resume-prompt',
    resume: { agentSessionId: 'sess-first-time', prompt: 'no, I meant the runner side' },
  });

  // The whole point of resuming: the session already has the first exchange, so
  // re-sending the opening prompt would be a repeat wearing a resume's clothes.
  assert.match(recorded.stdin, /no, I meant the runner side/);
  assert.doesNotMatch(recorded.stdin, /What does the runner do with a question\?/);
});

test('an ordinary claim spawns no --resume and asks the opening question', async (t) => {
  const { recorded } = await daemonWith(t, { name: 'test-resume-none', resume: null });

  assert.equal(recorded.argv.includes('--resume'), false, JSON.stringify(recorded.argv));
  assert.match(recorded.stdin, /What does the runner do with a question\?/);
});

test('the session id off the init event is reported to the platform', async (t) => {
  const { platform } = await daemonWith(t, { name: 'test-resume-id', resume: null });

  // Reported rather than derived: the CLI announces it on `init` and nowhere
  // else, and without it a finished session cannot be picked back up at all.
  assert.ok(
    await platform.untilSessionId((seen) =>
      seen.some((each) => each.agentSessionId === 'sess-from-init')),
    JSON.stringify(platform.sessionIds),
  );
});
