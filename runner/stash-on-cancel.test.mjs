// node --test tools/runner/stash-on-cancel.test.mjs
//
// R217, against the real daemon: a cancelled run whose person said "stash the
// changes" has its checkout stashed by the machine — after the agent is dead,
// and nowhere else — and the transcript says how to get the work back.
//
// The fixture is a checkout that is DIRTY BEFORE THE RUN STARTS, standing in
// for the agent's edits: a stub agent that edited files would race the
// watcher's first reading, and the dirt is what the stash is about, not who
// put it there. `allowDirty` keeps the daemon from resetting it at prepare.
//
// Both directions are here. The negative alone would pass against a daemon
// that never stashes; the positive alone against one that stashes every
// cancelled run, which is the thing the person was asked precisely so it
// would not happen.

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

/** A checkout with uncommitted work: one tracked edit, one untracked file. */
async function aDirtyCheckout() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-stash-'));
  const git = (...args) => run('git', args, { cwd: path });

  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@cawdev.test');
  await git('config', 'user.name', 'Test');
  await writeFile(join(path, 'config.json'), '{\n  "top": "main"\n}\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'first');

  // Both kinds, because `--include-untracked` is the half of the stash that
  // a fixture with only a tracked edit would never exercise.
  await writeFile(join(path, 'config.json'), '{\n  "top": "the agent was editing this"\n}\n');
  await writeFile(join(path, 'notes.md'), 'and this is new and not committed\n');
  return path;
}

const status = (path) => run('git', ['status', '--porcelain'], { cwd: path }).then((r) => r.stdout);
const stashes = (path) => run('git', ['stash', 'list'], { cwd: path }).then((r) => r.stdout);

/**
 * An agent that stays up until it is killed. `/bin/echo` exits before the
 * watcher's first pass, and a child that is already gone when `reapCancelled`
 * looks is not the case: the stash has to be taken AFTER a kill, not instead
 * of one.
 */
async function anAgentThatLingers(home) {
  const script = join(home, 'agent.mjs');
  await writeFile(script, `#!/usr/bin/env node
console.log('working');
await new Promise((wake) => setTimeout(wake, 30000));
`);
  await chmod(script, 0o755);
  return script;
}

async function daemonWith(t, { path, name, stashOnCancel }) {
  const platform = await fakePlatform({
    offers: [{
      id: `run-${name}`, projectSlug: 'board', label: 'R217 work', branch: 'r217-work', profile: 'CODE',
    }],
    allowDirty: true,
    // Reaped on the first poll after the spawn — the run reads as over and
    // CANCELLED, which is exactly the moment under test.
    runLive: false,
    runState: 'CANCELLED',
    stashOnCancel,
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

async function untilSeen(platform, predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate(platform.seen)) return true;
    await new Promise((wake) => setTimeout(wake, 150));
  }
  return false;
}

const postedTheCommits = (seen) => seen.some((call) => call.startsWith('POST') && call.endsWith('/commits'));

test('cancelled with "stash the changes": the checkout is clean, the stash names the run, the transcript says how to pop it', async (t) => {
  const path = await aDirtyCheckout();
  const before = await status(path);
  assert.ok(before.trim(), 'the fixture should start dirty');

  const { platform, said } = await daemonWith(t, { path, name: 'test-stash-yes', stashOnCancel: true });

  const stashed = await platform.untilSaidOnTheRun(/stash pop/);
  assert.ok(stashed, `the daemon never said it stashed:\n${said()}\n${JSON.stringify(platform.outputs)}`);

  const line = platform.outputs.find((each) => /stash pop/.test(each.body ?? ''));
  assert.equal(line.kind, 'SYSTEM');
  assert.match(line.body, /Stashed 2 uncommitted file\(s\)/);
  assert.match(line.body, new RegExp(`git -C ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} stash pop`));

  assert.equal((await status(path)).trim(), '', 'the checkout should be clean after the stash');
  assert.match(await stashes(path), /cawdev: stashed when R217 work was cancelled/);

  // The page's count goes back to zero off this reading, not the next
  // start's — the watcher stopped with the child, so it has to be posted here.
  const clean = await (async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const last = platform.workingCopies[platform.workingCopies.length - 1];
      if (last && last.files === 0) return last;
      await new Promise((wake) => setTimeout(wake, 150));
    }
    return null;
  })();
  assert.ok(clean, `no clean working-copy reading was posted after the stash:\n${JSON.stringify(platform.workingCopies)}`);
});

test('cancelled without it: the checkout is left exactly as it was, and nothing is stashed', async (t) => {
  const path = await aDirtyCheckout();
  const before = await status(path);

  const { platform, said } = await daemonWith(t, { path, name: 'test-stash-no', stashOnCancel: false });

  // The last thing the close handler does is post the commits; once that has
  // happened the stash step — which comes before it — has had its chance.
  // If the reading never posts, the reap is still at most a couple of seconds
  // in and a few more is enough to have been sure.
  const reaped = await platform.until((moves) => moves.some((each) => each.state === 'RUNNING'));
  assert.ok(reaped, `the run never started:\n${said()}`);
  const settled = await untilSeen(platform, postedTheCommits, 10000);
  if (!settled) await new Promise((wake) => setTimeout(wake, 5000));

  assert.equal(await status(path), before, 'the checkout should be untouched');
  assert.equal((await stashes(path)).trim(), '', 'nothing should have been stashed');
  assert.ok(
    !platform.outputs.some((each) => /stash/i.test(each.body ?? '')),
    `the transcript mentions a stash nobody asked for:\n${JSON.stringify(platform.outputs)}`,
  );
});
