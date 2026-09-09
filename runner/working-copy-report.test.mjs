// node --test tools/runner/working-copy-report.test.mjs
//
// R141, against the real daemon: whose uncommitted work the runner reports.
//
// `watchWorkingCopy` starts for EVERY run, and it must — the same loop claims
// the console's COMMIT/PUSH/OPEN_PR/MERGE actions and reports commits as they
// land. But a run that is not CODE prepares no working copy and cuts no branch:
// it is simply standing in a checkout somebody else is using. What
// `readWorkingCopy` sees there is that other person's work, and posting it
// attributes it to a session that has touched nothing.
//
// So the fixture is a checkout that is DIRTY BEFORE THE RUN STARTS, which is
// the whole case. Against a clean one the ASK assertion passes with or without
// the fix, for the wrong reason.
//
// Both directions are here on purpose. The negative alone would pass against a
// daemon that reports nothing at all, which is a different bug and one this
// change could plausibly cause.

import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

/** A checkout with work in it that no run under test put there. */
async function aCheckoutSomebodyElseIsUsing() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-wc-'));
  const git = (...args) => run('git', args, { cwd: path });

  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@cawdev.test');
  await git('config', 'user.name', 'Test');
  await writeFile(join(path, 'config.json'), '{\n  "top": "main"\n}\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'first');

  // The uncommitted work. One tracked file edited and one untracked file added,
  // because `readWorkingCopy` counts the two by different means and a fixture
  // that exercised one of them would only half stand in for a real checkout.
  await writeFile(join(path, 'config.json'), '{\n  "top": "someone is editing this"\n}\n');
  await writeFile(join(path, 'notes.md'), 'and this is not committed either\n');
  return path;
}

/**
 * An agent that stays up.
 *
 * The watcher's first pass is immediate but it checks `stopped` after reading
 * the checkout, and `workingCopy.stop()` runs on the child's `close`. A stub
 * that exits at once races the POST this test is about — in both directions,
 * so the CODE half would flake rather than fail honestly.
 */
async function anAgentThatLingers(home) {
  const script = join(home, 'agent.mjs');
  await writeFile(script, `#!/usr/bin/env node
console.log('working');
await new Promise((wake) => setTimeout(wake, 12000));
`);
  // `agentCommand` is spawned as an executable, not run through a shell, so it
  // has to be the file itself and the file has to be runnable.
  await chmod(script, 0o755);
  return script;
}

async function daemonWith(t, { path, name, offers }) {
  const platform = await fakePlatform({
    offers,
    // The uncommitted work is the point of the fixture: without this the
    // daemon resets the checkout before the CODE run and there is nothing
    // left to misreport.
    allowDirty: true,
    // The child has to outlive the reaper, or the watcher is stopped before it
    // has had a pass and the negative assertion proves nothing.
    runLive: true,
  });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: await anAgentThatLingers(home),
    pollSeconds: 1,
    workspacePollSeconds: 1,
    projects: { board: path },
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
    await rm(path, { recursive: true, force: true });
  });

  return { platform, said: () => said };
}

/** Waits for the daemon to have had time for a pass of the watcher. */
async function untilSeen(platform, predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate(platform.seen)) return true;
    await new Promise((wake) => setTimeout(wake, 150));
  }
  return false;
}

const reportsTheWorkingCopy = (seen) => seen.some((call) => call.endsWith('/working-copy'));

test('a session that is not coding does not report the checkout it stands in', async (t) => {
  const path = await aCheckoutSomebodyElseIsUsing();
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-wc-ask',
    // No branch, because a non-coding run has none — this is the run the
    // console was drawing "12 files +… −…" under.
    offers: [{
      id: 'run-ask', projectSlug: 'board', label: 'a question', branch: null, profile: 'ASK',
    }],
  });

  // Waiting on the run being underway rather than on a timeout: the assertion
  // below is a negative, so it is only worth anything once the daemon has got
  // far enough to have posted had it been going to.
  const started = await platform.until((moves) => moves.some((each) => each.state === 'RUNNING'));
  assert.ok(started, `the run never started:\n${said()}`);

  // And past the watcher's first pass, which happens after the spawn.
  await untilSeen(platform, reportsTheWorkingCopy, 6000);

  assert.ok(
    !reportsTheWorkingCopy(platform.seen),
    `an ASK run reported a checkout it did not prepare:\n${platform.seen.join(' | ')}`,
  );
});

test('a coding session still reports its own', async (t) => {
  const path = await aCheckoutSomebodyElseIsUsing();
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-wc-code',
    offers: [{
      id: 'run-code', projectSlug: 'board', label: 'a card', branch: 'r141-work', profile: 'CODE',
    }],
  });

  // The other half of the guard. Without this the test above passes against a
  // daemon that has stopped reporting the working copy for anybody.
  const reported = await untilSeen(platform, reportsTheWorkingCopy);
  assert.ok(reported, `a CODE run reported nothing:\n${said()}\n${platform.seen.join(' | ')}`);
});
