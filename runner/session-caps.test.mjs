// node --test tools/runner/session-caps.test.mjs
//
// R70's "Done when", against the real daemon — and since R109 there is ONE cap
// rather than two.
//
// A project's workspaces bound its CODING runs and nothing else, because a
// workspace is a checkout and only a coding run is given one. Getting it wrong
// is expensive in a way a reader cannot see: too tight and asking "what did
// that card decide?" queues behind an hour of work.
//
// `maxSessions` bounded the MACHINE and is gone. It counted processes, and a
// delegated expert (R104) runs inside its parent's session and costs none — so
// the number it capped had stopped being the number anybody was worried about.
// What replaced it is nothing, deliberately: an operator who wants a ceiling
// sets one by giving a project fewer checkouts.

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

/** A checkout a coding run can actually be prepared in. */
async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-caps-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

const coding = (id, label) => ({
  id, projectSlug: 'board', label, branch: `${id}-work`, profile: 'CODE',
});
const asking = (id, label, profile) => ({
  id, projectSlug: 'board', label, branch: null, profile,
});

async function daemonWith(t, { workspaces, offers, name, maxSessions }) {
  const platform = await fakePlatform({ offers });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: '/bin/echo',
    pollSeconds: 1,
    ...(maxSessions ? { maxSessions } : {}),
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

/** Waits for a line to appear in the daemon's log. */
async function until(said, pattern, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(said())) return true;
    await new Promise((done) => setTimeout(done, 150));
  }
  return false;
}

test('a project at its cap still starts an ASK, a ROADMAP, an AUDIT and a PLAN', async (t) => {
  // R124 added the fourth, and it is the one the entry exists for. A plan phase
  // that queued behind a coding run would put thinking about one card back on
  // the critical path of building another — which is the whole thing the split
  // was for, undone by the queue rather than by the lifecycle.
  const workspaces = [await aRepository()];
  const { platform, said } = await daemonWith(t, {
    name: 'test-caps-noncoding',
    workspaces,
    offers: [
      coding('run-code', 'the card'),
      asking('run-ask', 'what did R12 decide?', 'ASK'),
      asking('run-roadmap', 'file that as an entry', 'ROADMAP'),
      asking('run-audit', 'read the tools directory', 'AUDIT'),
      asking('run-plan', 'work out what to do about R12', 'PLAN'),
    ],
  });

  // All five, on one checkout. The one checkout is the coding cap and four of
  // these five never touch it.
  const all = await platform.until(
    (transitions) => transitions.filter((each) => each.state === 'RUNNING').length === 5,
  );
  assert.ok(all, `something queued behind the coding run:\n${said()}`);

  const started = platform.transitions.filter((each) => each.state === 'RUNNING');
  for (const id of ['run-ask', 'run-roadmap', 'run-audit', 'run-plan']) {
    // Took no checkout, and says so rather than claiming one it is not in.
    assert.equal(started.find((each) => each.runId === id).workspace, null);
  }
  assert.equal(started.find((each) => each.runId === 'run-code').workspace, workspaces[0]);
});

test('a coding run is still refused while the project is at its cap', async (t) => {
  const workspaces = [await aRepository()];
  const { platform, said } = await daemonWith(t, {
    name: 'test-caps-coding-refused',
    workspaces,
    offers: [
      coding('run-first', 'first card'),
      coding('run-second', 'second card'),
      asking('run-question', 'what did R12 decide?', 'ASK'),
    ],
  });

  // The question goes; the second coding run does not, and the reason names the
  // gate that held it — the checkouts, not the machine.
  const refused = await until(said, /no free workspace in board \(1 here, all busy\)/);
  assert.ok(refused, `nothing said why the second coding run waited:\n${said()}`);
  assert.ok(
    await platform.until((t2) => t2.some((e) => e.state === 'RUNNING' && e.runId === 'run-question')),
    `the question queued behind coding:\n${said()}`,
  );
});

test('nothing bounds a machine any more, whatever the profile', async (t) => {
  const workspaces = [await aRepository(), await aRepository()];
  const { said, platform } = await daemonWith(t, {
    name: 'test-caps-machine',
    workspaces,
    offers: [
      coding('run-one', 'the card'),
      // Neither of these needs a checkout, and there is a spare one anyway. The
      // machine's own ceiling used to hold them back at `maxSessions: 1`; R109
      // removed it, so all three go.
      asking('run-two', 'what did R12 decide?', 'ASK'),
      asking('run-three', 'read the tools directory', 'AUDIT'),
    ],
  });

  await until(said, /claiming/);
  // Nothing may be refused for the reason that no longer exists.
  assert.doesNotMatch(said(), /on this machine \(every profile counts\)/,
    `the machine cap is still holding something back:\n${said()}`);
  assert.ok(platform, 'the daemon reached the platform');
});
