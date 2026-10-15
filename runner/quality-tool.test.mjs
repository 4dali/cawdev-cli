// node --test tools/runner/quality-tool.test.mjs
//
// R302, against the real daemon: which spawns are handed `quality_get`.
//
// `stage-tools.test.mjs` pins the pure claim — PLAN and IMPLEMENT are not
// offered it, the rest keep it. This pins what a MACHINE does with that: a
// REVIEW and an AUDIT run's argv carry the tool, a PLAN run's does not, and in
// a walk the PLAN stage's spawn line lacks it while the TEST stage's has it.
// The daemon derives every profile list from DEFAULTS.agentArgs and narrows
// per stage in two different code paths (`argsForProfile` for one process,
// `toolsForStage` for a walk), and a name filtered in one and not the other is
// exactly the drift `AFTER_THE_WORK_EXISTS` exists to prevent — so both paths
// are driven here.
//
// review-tools.test.mjs's harness: the agent is `/bin/echo`, so the spawn line
// the daemon logs IS the argv.

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
const QUALITY = /mcp__cawdev__quality_get/;

async function untilSaid(said, pattern, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(said())) return true;
    await new Promise((wake) => setTimeout(wake, 100));
  }
  return false;
}

async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-quality-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

async function daemonWith(t, { name, profile, branch = null, workflow = [] }) {
  const path = await aRepository();
  const platform = await fakePlatform({
    offers: [{
      id: `run-${name}`,
      projectSlug: 'board',
      label: 'the card',
      entryNumber: 302,
      entryTitle: 'something to read',
      branch,
      profile,
    }],
    workflow,
  });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: '/bin/echo',
    pollSeconds: 1,
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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(socketPathFor(name), { force: true });
  });

  await untilSaid(() => said, /spawning:/);
  return {
    said: () => said,
    spawnLine: () => said.split('\n').find((each) => each.includes('spawning:')) ?? '',
    /** Every `spawning:` line, in the order the daemon wrote them — one per stage in a walk. */
    spawnLines: () => said.split('\n').filter((each) => each.includes('spawning:')),
  };
}

test('a REVIEW run is handed quality_get — the branch\'s gate belongs in its comment', async (t) => {
  const { spawnLine, said } = await daemonWith(t, {
    name: 'test-review-reads-quality',
    profile: 'REVIEW',
    branch: 'r302-something',
  });
  assert.match(spawnLine(), QUALITY, said());
});

test('an AUDIT run is handed it too', async (t) => {
  const { spawnLine, said } = await daemonWith(t, {
    name: 'test-audit-reads-quality',
    profile: 'AUDIT',
  });
  assert.match(spawnLine(), QUALITY, said());
});

test('a PLAN run spawned as one process is not offered it', async (t) => {
  // This spawn goes through `argsForProfile`, not `toolsForStage` — the
  // second reader of AFTER_THE_WORK_EXISTS, and the one a stage test misses.
  const { spawnLine, said } = await daemonWith(t, {
    name: 'test-plan-not-offered-quality',
    profile: 'PLAN',
  });
  assert.doesNotMatch(spawnLine(), QUALITY, said());
  // And it is still a plan run with its reads intact.
  assert.match(spawnLine(), /mcp__cawdev__code_map/);
});

test('in a walk, the PLAN stage lacks it and the TEST stage has it', async (t) => {
  const { said, spawnLines } = await daemonWith(t, {
    name: 'test-walk-quality-per-stage',
    profile: 'CODE',
    branch: 'r302-something',
    workflow: [{ stage: 'PLAN', gate: 'AUTO' }, { stage: 'TEST', gate: 'AUTO' }],
  });

  // Two processes, one per stage. `/bin/echo` exits at once, so the second
  // spawn follows the first within the poll; wait for it rather than assume.
  assert.ok(await untilSaid(said, /walking 2 stage\(s\): PLAN → TEST/), said());
  assert.ok(await untilSaid(() => String(spawnLines().length), /^2$/), said());
  const [plan, testStage] = spawnLines();

  assert.doesNotMatch(plan, QUALITY, `PLAN was offered quality_get:\n${plan}`);
  assert.match(testStage, QUALITY, `TEST was not offered quality_get:\n${testStage}`);
  // The stage before it kept everything else a read-only stage has.
  assert.match(plan, /mcp__cawdev__code_map/);
});
