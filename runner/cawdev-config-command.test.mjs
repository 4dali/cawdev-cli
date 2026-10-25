// node --test tools/runner/cawdev-config-command.test.mjs
//
// R283 — `cawdev config`'s own dispatch and menu, unit-tested with everything
// injected: `cawdev-command.test.mjs` next door is the real end-to-end
// version of this file's opposite number, and two heavy tests of the same
// thing would only disagree eventually.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { painter } from '../lib/ansi.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickAction, printConfig, runAction } from './cawdev.mjs';
import { runnerNameOf } from '../lib/runner-config.mjs';

const ink = painter(0);
const quiet = () => {};

function scriptedAsker(answers) {
  let at = 0;
  return {
    line() {
      if (at >= answers.length) throw new Error('asked one question too many');
      return Promise.resolve(answers[at++]);
    },
    close() {},
  };
}

// --- printConfig -------------------------------------------------------------

test('the token is redacted; everything else is shown', () => {
  const said = [];
  printConfig({ token: 'cawd_verysecret12345', name: 'laptop' }, ink, (line) => said.push(line));
  const text = said.join('\n');
  assert.doesNotMatch(text, /verysecret12345/);
  assert.match(text, /cawd_verys/);
  assert.match(text, /laptop/);
});

// --- pickAction ---------------------------------------------------------------

test('picking "add a project" needs nothing further', async () => {
  const action = await pickAction(scriptedAsker([]), quiet, () => Promise.resolve({ row: { id: 'add-project' } }));
  assert.deepEqual(action, ['add-project']);
});

test('picking an agent toggle asks which agent, and shapes the verb', async () => {
  const enable = await pickAction(
    scriptedAsker(['agy']), quiet, () => Promise.resolve({ row: { id: 'agent-enable' } }),
  );
  assert.deepEqual(enable, ['agent', 'enable', 'agy']);

  const disable = await pickAction(
    scriptedAsker(['claude']), quiet, () => Promise.resolve({ row: { id: 'agent-disable' } }),
  );
  assert.deepEqual(disable, ['agent', 'disable', 'claude']);
});

test('the two rules rows need no further question', async () => {
  assert.deepEqual(
    await pickAction(scriptedAsker([]), quiet, () => Promise.resolve({ row: { id: 'rules-on' } })),
    ['rules', 'on'],
  );
  assert.deepEqual(
    await pickAction(scriptedAsker([]), quiet, () => Promise.resolve({ row: { id: 'rules-off' } })),
    ['rules', 'off'],
  );
});

test("the two quality rows ask which project, and shape the verb — R300", async () => {
  assert.deepEqual(
    await pickAction(scriptedAsker(["cawdev"]), quiet, () => Promise.resolve({ row: { id: "quality-on" } })),
    ["quality", "on", "cawdev"],
  );
  assert.deepEqual(
    await pickAction(scriptedAsker(["cawdev"]), quiet, () => Promise.resolve({ row: { id: "quality-off" } })),
    ["quality", "off", "cawdev"],
  );
});

test("a quality action with no project is refused before calling anything", async () => {
  await assert.rejects(
    runAction(["quality", "on"], { file: {}, ink, say: quiet, ask: scriptedAsker([]) }),
    /Name a project/,
  );
});

// --- runAction -----------------------------------------------------------------

test('show prints the config and touches nothing', async () => {
  const said = [];
  await runAction(['show'], { file: { token: 'cawd_x', name: 'laptop' }, ink, say: (l) => said.push(l) });
  assert.match(said.join('\n'), /laptop/);
});

test('an agent action with no command is refused before calling anything', async () => {
  await assert.rejects(
    runAction(['agent', 'enable'], { file: {}, ink, say: quiet, ask: scriptedAsker([]) }),
    /Name an agent/,
  );
});

test('an unknown verb says so and names --help', async () => {
  await assert.rejects(
    runAction(['dance'], { file: {}, ink, say: quiet }),
    /Not a cawdev config command: dance/,
  );
});

// --- every change ends in the daemon's verdict — R294 ---------------------------

test('rules off ends by signalling the daemon and repeating what it said', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cawdev-config-cmd-'));
  const configPath = join(dir, 'runner.config.json');
  const file = { name: 'laptop', acceptsRulesFromConsole: true, projects: { cawdev: dir } };
  await writeFile(configPath, JSON.stringify(file));
  const said = [];
  let runner = { pid: 4242, configReadAt: 't0', restartNeeded: [] };
  const killed = [];
  await runAction(['rules', 'off'], {
    configPath, file, ink, say: (l) => said.push(l), ask: scriptedAsker([]),
    reloadOptions: {
      hello: async () => runner,
      kill: (pid, signal) => { killed.push([pid, signal]); runner = { ...runner, configReadAt: 't1' }; },
      tick: async () => {},
    },
  });
  assert.deepEqual(killed, [[4242, 'SIGHUP']]);
  assert.match(said.join('\n'), /applied, no restart needed/);
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('a daemon too old to answer is still "applied" after a hot-swappable change', async () => {
  // No `configReadAt` on the hello, so nothing to wait for: the door falls
  // back to its own `restartNeededFor(file, next)`, which for `rules` is
  // empty. The project case of that fallback is pinned in configure.test.mjs.
  const dir = await mkdtemp(join(tmpdir(), 'cawdev-config-cmd-'));
  const configPath = join(dir, 'runner.config.json');
  const file = { name: 'laptop', acceptsRulesFromConsole: true, projects: { cawdev: dir } };
  await writeFile(configPath, JSON.stringify(file));
  const said = [];
  await runAction(['rules', 'off'], {
    configPath, file, ink, say: (l) => said.push(l), ask: scriptedAsker([]),
    reloadOptions: { hello: async () => ({ pid: 4242 }), kill: () => {} },
  });
  assert.match(said.join('\n'), /applied, no restart needed/);
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// --- the planning limit — R577 ---------------------------------------------------

/** A session that records what it was asked and answers the two calls the verb makes. */
function recordingSession(runners = [{ id: 'r-1', name: 'test', yours: true }]) {
  const requests = [];
  return {
    requests,
    async request(path, options = {}) {
      requests.push({ path, method: options.method ?? 'GET', body: options.body });
      return path === '/api/runners' ? runners : { id: 'r-1', maxPlanningRuns: options.body?.maxPlanningRuns || null };
    },
  };
}

test('the planning-limit row asks once and shapes the verb', async () => {
  assert.deepEqual(
    await pickAction(scriptedAsker(['2']), quiet, () => Promise.resolve({ row: { id: 'planning-limit' } })),
    ['planning-limit', '2'],
  );
});

test('a planning limit that is not a number is refused before any request', async () => {
  const session = recordingSession();
  for (const bad of ['x', '51', '-1', '1.5', undefined]) {
    await assert.rejects(
      runAction(['planning-limit', bad].filter((each) => each !== undefined),
        { file: { name: 'test' }, session, ink, say: quiet }),
      /Name a number: cawdev config planning-limit/,
    );
  }
  assert.deepEqual(session.requests, []);
});

test('planning-limit finds this machine, posts the number and signals no daemon', async () => {
  const session = recordingSession();
  const said = [];
  let killed = false;
  await runAction(['planning-limit', '2'], {
    file: { name: 'test' }, session, ink, say: (l) => said.push(l),
    reloadOptions: { kill: () => { killed = true; }, hello: async () => { killed = true; } },
  });
  assert.deepEqual(session.requests, [
    { path: '/api/runners', method: 'GET', body: undefined },
    { path: '/api/runners/r-1/pause', method: 'POST', body: { maxPlanningRuns: 2 } },
  ]);
  assert.match(said.join('\n'), /planning runs at once: 2/);
  assert.equal(killed, false);
});

test('a machine the platform does not know is named, and nothing is posted', async () => {
  const session = recordingSession([{ id: 'r-9', name: 'other', yours: true }, { id: 'r-8', name: 'test', yours: false }]);
  await assert.rejects(
    runAction(['planning-limit', '2'], { file: { name: 'test' }, session, ink, say: quiet }),
    /no machine of yours called "test"/,
  );
  assert.equal(session.requests.length, 1);
});

test('CAWDEV_RUNNER_NAME wins over the file, and the file over the default', () => {
  assert.equal(runnerNameOf({ name: 'file' }, { CAWDEV_RUNNER_NAME: 'env' }), 'env');
  assert.equal(runnerNameOf({ name: 'file' }, {}), 'file');
  assert.equal(runnerNameOf({}, {}), 'this-machine');
  assert.equal(runnerNameOf(null, {}), 'this-machine');
});
