// node --test tools/runner/allow-everything.test.mjs
//
// i138: "Allow everything" is enabled for my runner but it's still asking for
// permission — bash permission, mcp_report permission.
//
// Every one of those questions came from a PLAN run walked as stages. R126's
// setting is coding-only, correctly: it is a decision about what an unattended
// agent may RUN in a checkout, and a plan session is spawned with nothing that
// can write. But R112's stage path was built on `argsBefore`, which kept the
// coding defaults' `--permission-mode acceptEdits` and
// `--permission-prompt-tool` — the two arguments `argsForProfile` strips from
// every non-coding profile — so a staged plan session had a person to ask and
// asked them, about every shell command and about the `report` its own prompt
// told it to finish with. The same session spawned as ONE process asked nobody.
//
// The claim here is about what a run is spawned with, so the agent is
// `/bin/echo` and the spawn line the daemon logs IS the argv —
// `plan-writes-its-card.test.mjs`'s shape. Three cases: the plan run that was
// asking, the coding run "everything" is FOR, and its read-only stage, which
// "everything" must not reach either.

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

const EVERYTHING = { rules: [], allowsEverything: true };

async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-everything-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

async function until(said, pattern, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(said())) return true;
    await new Promise((wake) => setTimeout(wake, 100));
  }
  return false;
}

/**
 * @param accepts the machine's own `acceptsRulesFromConsole` — the agreement
 *   without which the daemon does not even ask what the console granted.
 */
async function daemonWith(t, { name, offer, workflow, accepts = true }) {
  const workspace = await aRepository();
  const platform = await fakePlatform({
    offers: [offer],
    workflow,
    machineRules: EVERYTHING,
  });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-everything-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: '/bin/echo',
    pollSeconds: 1,
    acceptsRulesFromConsole: accepts,
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

  return {
    platform,
    said: () => said,
    /** One per stage, in the order the walk spawned them. */
    spawnLines: () => said.split('\n').filter((each) => each.includes('spawning:')),
  };
}

/** Everything before `--allowedTools`: the arguments that are not the list. */
function beforeTheList(line) {
  return line.split(' --allowedTools ')[0];
}

test('a plan run walked as stages holds its list and nothing past it, whatever the machine allows',
    async (t) => {
      const { said, spawnLines } = await daemonWith(t, {
        name: 'test-everything-plan',
        offer: {
          id: 'run-plan', projectSlug: 'board', label: 'R12 — a card to plan',
          branch: null, profile: 'PLAN', entryNumber: 12,
        },
        workflow: [{ stage: 'PLAN', gate: 'AUTO' }, { stage: 'VERIFY', gate: 'AUTO' }],
      });
      assert.ok(await until(said, /spawning:.*\n[\s\S]*spawning:/), said());
      const [plan, verify] = spawnLines();

      for (const line of [plan, verify]) {
        // No permission mode: `acceptEdits` writes files the list does not
        // name, and `bypassPermissions` does anything at all.
        assert.doesNotMatch(beforeTheList(line), /--permission-mode/, line);
        assert.doesNotMatch(line, /bypassPermissions/, line);
        // And nobody to ask. This is the line i138 is about: with a prompt
        // tool, every `python3` and every `report` the planner reached for was
        // a question on the inbox, and "allow everything" could not answer it.
        assert.doesNotMatch(beforeTheList(line), /--permission-prompt-tool/, line);
        assert.doesNotMatch(line, /mcp__cawdev__report\b/, line);
      }
      // The daemon read the setting and says why it did not apply, so the
      // operator who turned it on is not left guessing whether it arrived.
      assert.match(said(), /allows everything, and that is coding-only: a PLAN session/);
      assert.doesNotMatch(said(), /allows EVERYTHING/);
    });

test('a coding run on that machine bypasses permissions where it writes, and not in MEMORY',
    async (t) => {
      const { said, spawnLines } = await daemonWith(t, {
        name: 'test-everything-code',
        offer: {
          id: 'run-code', projectSlug: 'board', label: 'the card',
          branch: 'r1-work', profile: 'CODE',
        },
        workflow: [{ stage: 'IMPLEMENT', gate: 'AUTO' }, { stage: 'MEMORY', gate: 'AUTO' }],
      });
      assert.ok(await until(said, /spawning:.*\n[\s\S]*spawning:/), said());
      const [implement, memory] = spawnLines();

      // The stage "everything" is FOR. R126 in the CLI's own words, and the
      // prompt tool kept beside it — the mode answers first and the tool is
      // never reached, but a run that loses it would ask nobody if the mode
      // were ever refused.
      assert.match(beforeTheList(implement), /--permission-mode bypassPermissions/, implement);
      assert.match(beforeTheList(implement), /--permission-prompt-tool mcp__cawdev__approve/,
        implement);
      assert.match(said(), /!! this machine allows EVERYTHING/);

      // And the read-only stage of the same run. `toolsForStage` narrows its
      // list to reads; a mode that reaches past the list would widen it back,
      // and "everything" is not a decision that MEMORY may write files.
      assert.doesNotMatch(beforeTheList(memory), /--permission-mode/, memory);
      assert.doesNotMatch(memory, /bypassPermissions/, memory);
      assert.doesNotMatch(beforeTheList(memory), /--permission-prompt-tool/, memory);
      assert.doesNotMatch(memory, /\bWrite\b/, memory);
      assert.doesNotMatch(memory, /\bEdit\b/, memory);
    });

test('a machine that has not agreed to console rules is not widened by one', async (t) => {
  // R126's guard, restated from this side: the console says "everything", the
  // config does not say `acceptsRulesFromConsole`, and the daemon does not ask
  // — not asking is the enforcement.
  const { platform, said, spawnLines } = await daemonWith(t, {
    name: 'test-everything-refused',
    accepts: false,
    offer: {
      id: 'run-code-refused', projectSlug: 'board', label: 'the card',
      branch: 'r1-work', profile: 'CODE',
    },
    workflow: [{ stage: 'IMPLEMENT', gate: 'AUTO' }],
  });
  assert.ok(await until(said, /spawning:/), said());
  const [implement] = spawnLines();
  assert.match(beforeTheList(implement), /--permission-mode acceptEdits/, implement);
  assert.doesNotMatch(implement, /bypassPermissions/, implement);
  assert.ok(!platform.seen.some((each) => /\/api\/runners\/.*\/tool-rules/.test(each)),
    `the daemon asked what the console granted without agreeing to apply it:\n${platform.seen.join('\n')}`);
});
