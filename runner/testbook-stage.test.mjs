// node --test tools/runner/testbook-stage.test.mjs
//
// R129, against the real daemon: what a TESTBOOK stage is actually SPAWNED
// with, and what it is actually TOLD.
//
// `stage-tools.test.mjs` pins the claim as a claim about a list of strings —
// `toolsForStage('TEST', …, 'TESTBOOK')` keeps nothing that can run. This pins
// the half a pure function cannot show: that the list the daemon builds from
// the project's own tool rules, and prints on its `spawning:` line, is that
// list. R129's plan called that step a manual one needing a stack somebody
// owns — `docker rm -f cawdev-db && ./run.sh`, then read the log. It is not:
// the daemon walks a lifecycle against `fakePlatform` with no database at all,
// and the line it prints is the enforcement, visible.
//
// The prompt matters as much as the list. A tool list cannot make a stage
// write a testbook — only the prompt can ask it to — so the last test here
// keeps what the daemon put on the session's stdin and reads it.

import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

const CODING = {
  id: 'run-testbook', projectSlug: 'board', label: 'the card',
  branch: 'r129-work', profile: 'CODE',
};

/**
 * Where a shell that could run the suite comes from in real life: not the
 * defaults, which are git only, but the project's own tool rules.
 */
const A_PROJECT_THAT_ADDED_A_SHELL = ['Bash(npm *)', 'Agent'];

async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-testbook-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

/**
 * An agent that writes down the prompt it was handed.
 *
 * It does NOT wait for the end of its stdin: R22 keeps that open so a person
 * can prompt the session again, and it closes only once the stage is over — so
 * an agent that wrote its file at `end` would deadlock against the very thing
 * it is trying to observe. It debounces instead.
 */
async function anAgentThatKeepsItsPrompt(home) {
  const path = join(home, 'keeps-prompt.mjs');
  const kept = join(home, 'prompt.txt');
  await writeFile(path, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let input = '';
let timer = null;
process.stdout.write(JSON.stringify(
  { type: 'system', subtype: 'init', session_id: 'keeper' }) + '\\n');
process.stdin.on('data', (chunk) => {
  input += chunk;
  clearTimeout(timer);
  timer = setTimeout(() => {
    writeFileSync(${JSON.stringify(kept)}, input);
    process.stdout.write(JSON.stringify({ type: 'result', result: 'done' }) + '\\n');
  }, 300);
});
// Lingers, like the real CLI with its stdin open.
setTimeout(() => {}, 60000);
`);
  await run('chmod', ['+x', path]);
  return { path, kept };
}

async function daemonWith(t, { name, workflow, allowedTools, agent = false }) {
  const workspace = await aRepository();
  const home = await mkdtemp(join(tmpdir(), 'cawdev-testbook-cfg-'));
  const keeper = agent ? await anAgentThatKeepsItsPrompt(home) : null;
  // A run the fake platform calls FINISHED is reaped, and a reaped child never
  // gets as far as writing anything down — so the test that reads the prompt
  // needs the run left live.
  const platform = await fakePlatform({ offers: [CODING], workflow, runLive: agent });

  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    // `/bin/echo` exits 0 and says nothing a stream parser can use, which is
    // all the tool-list tests need: their subject is the line the daemon
    // prints BEFORE it spawns anything.
    agentCommand: keeper?.path ?? '/bin/echo',
    name,
    pollSeconds: 1,
    projects: { board: { workspaces: [workspace], ...(allowedTools ? { allowedTools } : {}) } },
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

  return { platform, said: () => said, keeper };
}

async function until(said, pattern, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(said())) return true;
    await new Promise((done) => setTimeout(done, 150));
  }
  return false;
}

/** The `--allowedTools` half of the daemon's own `spawning:` line. */
function spawnedTools(said) {
  const line = said.split('\n').find((each) => each.includes('spawning:'));
  assert.ok(line, `the daemon never said what it spawned:\n${said}`);
  const after = line.slice(line.indexOf('--allowedTools') + '--allowedTools'.length)
    .replace(/\(prompt on stdin\)\s*$/, '').trim();
  // A tool string CONTAINS spaces — `Bash(git diff *)` is one tool and not
  // three, so splitting the line on whitespace reads a passing list as a
  // failing one. The first version of this helper did exactly that.
  return after.match(/\S+\([^)]*\)|\S+/g) ?? [];
}

test('the daemon spawns a TESTBOOK stage with nothing that can run anything', async (t) => {
  const { said } = await daemonWith(t, {
    name: 'testbook-spawn',
    workflow: [{ stage: 'TEST', gate: 'AUTO', testMode: 'TESTBOOK' }],
    allowedTools: A_PROJECT_THAT_ADDED_A_SHELL,
  });

  assert.ok(await until(said, /spawning:/), said());
  const tools = spawnedTools(said());

  for (const forbidden of ['Bash(git *)', 'Bash(npm *)', 'Agent', 'Task']) {
    assert.ok(!tools.includes(forbidden),
      `a TESTBOOK stage was spawned with ${forbidden}:\n${tools.join(' ')}`);
  }
  // Recognised by shape and not by name: the only shell left is a git READ,
  // and `git diff` is how the stage finds out what the run changed.
  assert.deepEqual(
    tools.filter((each) => each.startsWith('Bash')).sort(),
    ['Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git status *)'],
    `a TESTBOOK stage was spawned with a shell that can run something:\n${tools.join(' ')}`);
  // It keeps the cawdev tools it reads the run through — but NOT `report`,
  // whose premise this assertion used to carry. A stage does not announce
  // itself: its turn ends, the walk advances on `close`, and the daemon records
  // the stage's own final text as the outcome. A stage that COULD report would
  // end the whole run from inside the walk, which is how MEMORY came to run
  // once in fifty.
  assert.ok(tools.includes('mcp__cawdev__task_current'),
    `a TESTBOOK stage lost the MCP tools:\n${tools.join(' ')}`);
  assert.ok(!tools.includes('mcp__cawdev__report'),
    'a TESTBOOK stage kept report, which ends the run rather than the stage');
});

test('a RUN-mode TEST stage is spawned with the profile untouched', async (t) => {
  const { said } = await daemonWith(t, {
    name: 'testbook-run-mode',
    workflow: [{ stage: 'TEST', gate: 'AUTO', testMode: 'RUN' }],
    allowedTools: A_PROJECT_THAT_ADDED_A_SHELL,
  });

  assert.ok(await until(said, /spawning:/), said());
  const tools = spawnedTools(said());
  for (const needed of ['Bash(git *)', 'Bash(npm *)', 'Agent']) {
    assert.ok(tools.includes(needed),
      `a RUN-mode TEST stage lost ${needed}, which is how it runs the suite`);
  }
});

test('a project that never set a mode is spawned exactly as it always was', async (t) => {
  // The default is a default. A change that quietly narrowed every TEST stage
  // would be a change nobody asked for.
  const { said } = await daemonWith(t, {
    name: 'testbook-no-mode',
    workflow: [{ stage: 'TEST', gate: 'AUTO' }],
    allowedTools: A_PROJECT_THAT_ADDED_A_SHELL,
  });

  assert.ok(await until(said, /spawning:/), said());
  const tools = spawnedTools(said());
  for (const needed of ['Bash(git *)', 'Bash(npm *)', 'Agent']) {
    assert.ok(tools.includes(needed), `an unconfigured TEST stage lost ${needed}`);
  }
});

test('the daemon tells a TESTBOOK stage to write the testbook', async (t) => {
  const { said, keeper } = await daemonWith(t, {
    name: 'testbook-prompt',
    workflow: [{ stage: 'TEST', gate: 'AUTO', testMode: 'TESTBOOK' }],
    agent: true,
  });

  assert.ok(await until(said, /spawning:/), said());
  let prompt = '';
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    prompt = await readFile(keeper.kept, 'utf8').catch(() => '');
    if (prompt) break;
    await new Promise((done) => setTimeout(done, 150));
  }
  assert.ok(prompt, `the session was never handed a prompt. The daemon said:\n${said()}`);

  // The five things the stage has to be told, since none of them can be
  // enforced by a list of strings.
  for (const required of [
    'TESTBOOK.md',
    'ADD A SECTION FOR THIS CARD',
    'the exact command',
    'you have no shell that could',
    'not a failure of this stage',
  ]) {
    assert.ok(prompt.includes(required),
      `the TESTBOOK prompt never says ${JSON.stringify(required)}`);
  }
  assert.ok(!prompt.includes('Run what proves the work. Report what passed'),
    'a TESTBOOK stage was told to run the tests after all');

  // And the steps list says what this step is going to do, so a person reading
  // the transcript does not have to know the project's settings to follow it.
  assert.match(prompt, /TEST[^\n]*writing the testbook, not running it/,
    'the steps list does not say the TEST step writes the testbook');
});
