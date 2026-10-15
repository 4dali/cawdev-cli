// node --test tools/runner/codex-spawn.test.mjs
//
// A run whose agent is `codex`, against the real daemon and a fake platform.
//
// `lib/codex.test.mjs` pins the command line and the stream. This pins what
// neither shows: which runs get which sandbox, that a writing session is
// refused on a machine that has not allowed everything — before anything is
// spawned — that the run's token travels in the environment and never on the
// command line, that a STAGE never holds `report`, and that what it commits
// reaches the platform — without that the finish rules see a run that wrote
// nothing, and open no pull request.
//
//   env -u CAWDEV_URL -u CAWDEV_TOKEN node --test tools/runner/codex-spawn.test.mjs
//
// The unsets are not optional — see required-capability.test.mjs.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-codex-repo-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

/**
 * A `codex` that writes down how it was called — argv, the cawdev variables in
 * its environment, the prompt on stdin — one JSON line per call, then prints
 * what `codex exec --json` printed for a real one-turn session (trimmed), with
 * a credential in a command's output for the shield to take out.
 */
async function aCodex(home, { commits = false } = {}) {
  const bin = join(home, 'bin');
  await mkdir(bin, { recursive: true });
  const path = join(bin, 'codex');
  const calls = join(home, 'calls.jsonl');
  await writeFile(path, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
let prompt = '';
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('CAWDEV_')));
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), env, prompt }) + '\\n');
  if (${commits}) {
    const { execFileSync } = require('node:child_process');
    appendFileSync('work.txt', 'done\\n');
    execFileSync('git', ['add', 'work.txt']);
    execFileSync('git', ['commit', '-q', '-m', 'the work']);
  }
  const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  emit({ type: 'thread.started', thread_id: '01a0cdaf-dc54-78a0-9b7a-b1b92cbc7f12' });
  emit({ type: 'turn.started' });
  emit({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'cat .env', status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'cat .env',
    aggregated_output: 'AWS_KEY=AKIAABCDEFGHIJKLMNOP\\n', exit_code: 0, status: 'completed' } });
  emit({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'all done here' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 34 } });
});
`);
  await chmod(path, 0o755);
  return {
    path,
    async calls() {
      try {
        return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}

async function daemonWith(t, { name, offer, everything = false, workflow = [], commits = false }) {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-codex-'));
  const workspace = await aRepository();
  const codex = await aCodex(home, { commits });
  const platform = await fakePlatform({
    offers: [{ projectSlug: 'board', label: 'the card', branch: 'codex-work', agent: 'codex', ...offer }],
    workflow,
    runLive: true,
    machineRules: { rules: [], allowsEverything: everything },
  });
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommands: ['claude', codex.path],
    acceptsRulesFromConsole: true,
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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(socketPathFor(name), { force: true });
  });
  return { platform, codex, said: () => said };
}

/** The value after `-c` whose key is `key`, parsed back from TOML's list form. */
function configValue(argv, key) {
  const pair = argv.find((each, at) => argv[at - 1] === '-c' && each.startsWith(`${key}=`));
  return pair === undefined ? undefined : pair.slice(key.length + 1);
}

const toolList = (value) => (value === undefined ? undefined : JSON.parse(value));

test('an ASK run on Codex is sandboxed read-only and needs nothing from the machine', async (t) => {
  const { platform, codex, said } = await daemonWith(t, {
    name: 'test-codex-ask',
    offer: { id: 'run-codex-ask', profile: 'ASK', openingPrompt: 'What does this do?' },
  });

  assert.ok(await platform.until((all) => all.some((each) => each.state === 'FINISHED')), said());
  const [call] = await codex.calls();
  assert.ok(call, said());

  assert.equal(call.argv[call.argv.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(!call.argv.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(call.argv.at(-1), '-');
  assert.ok(call.prompt.length > 0, 'the prompt goes on stdin');

  // The token: in the environment the server reads, blanked for the shell,
  // and nowhere on a command line anybody on the machine can `ps`.
  assert.equal(call.env.CAWDEV_TOKEN, 'cawdr_fake');
  assert.ok(!call.argv.join(' ').includes('cawdr_fake'));
  assert.deepEqual(toolList(configValue(call.argv, 'mcp_servers.cawdev.env_vars')),
    ['CAWDEV_URL', 'CAWDEV_TOKEN', 'CAWDEV_PROJECT']);
  assert.match(configValue(call.argv, 'shell_environment_policy.set'), /CAWDEV_TOKEN = ""/);

  // ASK's own list, the one Claude Code is handed: reads and `report`, no writer.
  const tools = toolList(configValue(call.argv, 'mcp_servers.cawdev.enabled_tools'));
  assert.ok(tools.includes('report') && tools.includes('roadmap_get'), tools.join(', '));
  // Longer than ask_user's ten-minute wait: Codex's own default (60 s) cut a
  // question off before anybody could answer it.
  assert.equal(configValue(call.argv, 'mcp_servers.cawdev.tool_timeout_sec'), '660');
  assert.ok(!tools.includes('roadmap_create') && !tools.includes('roadmap_set_status'), tools.join(', '));

  const finished = platform.transitions.find((each) => each.state === 'FINISHED');
  assert.equal(finished.summary, 'all done here');
  assert.ok(platform.sessionIds.some((each) => each.agentSessionId === '01a0cdaf-dc54-78a0-9b7a-b1b92cbc7f12'));
  assert.ok(await platform.untilSaidOnTheRun(/^all done here$/));
  // R110's transcript half runs in the daemon, so it applies to Codex too.
  assert.ok(await platform.untilSaidOnTheRun(/cawdev removed an AWS access key id/),
    platform.outputs.map((line) => line.body).join('\n'));
  assert.ok(!platform.outputs.some((line) => (line.body ?? '').includes('AKIAABCDEFGHIJKLMNOP')));
});

test('a CODE run on Codex is refused, unspawned, where the machine has not allowed everything', async (t) => {
  const { platform, codex, said } = await daemonWith(t, {
    name: 'test-codex-refused',
    offer: { id: 'run-codex-refused', profile: 'CODE' },
  });

  assert.ok(await platform.until((all) => all.some((each) => each.state === 'FAILED')), said());
  const failed = platform.transitions.find((each) => each.state === 'FAILED');
  assert.match(failed.summary, /has not allowed everything/);
  assert.match(failed.summary, /To allow it:[\s\S]*\/settings\/runners → test-codex-refused → tick "Allow everything"/);
  assert.deepEqual(await codex.calls(), [], 'nothing may be spawned before the refusal');
  // Said on the run too, where the terminal and the run page show it.
  assert.ok(await platform.untilSaidOnTheRun(/tick "Allow everything"/),
    platform.outputs.map((line) => line.body).join('\n'));
});

test('a CODE run on Codex, where everything is allowed, runs without a sandbox', async (t) => {
  const { platform, codex, said } = await daemonWith(t, {
    name: 'test-codex-code',
    offer: { id: 'run-codex-code', profile: 'CODE' },
    everything: true,
  });

  assert.ok(await platform.until((all) => all.some((each) => each.state === 'FINISHED')), said());
  const [call] = await codex.calls();
  assert.ok(call.argv.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!call.argv.includes('--sandbox'));
  // A coding run with no lifecycle holds every cawdev tool, as on Claude Code.
  assert.equal(configValue(call.argv, 'mcp_servers.cawdev.enabled_tools'), undefined);
});

test('stages: PLAN is read-only, IMPLEMENT writes, and neither holds report', async (t) => {
  const { platform, codex, said } = await daemonWith(t, {
    name: 'test-codex-stages',
    offer: { id: 'run-codex-stages', profile: 'CODE' },
    everything: true,
    workflow: [{ stage: 'PLAN', gate: 'AUTO' }, { stage: 'IMPLEMENT', gate: 'AUTO' }],
  });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && (await codex.calls()).length < 2) {
    await new Promise((done) => setTimeout(done, 150));
  }
  const [plan, implement] = await codex.calls();
  assert.ok(plan && implement, said());

  assert.equal(plan.argv[plan.argv.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(implement.argv.includes('--dangerously-bypass-approvals-and-sandbox'));

  const planTools = toolList(configValue(plan.argv, 'mcp_servers.cawdev.enabled_tools'));
  const implementTools = toolList(configValue(implement.argv, 'mcp_servers.cawdev.enabled_tools'));
  // `report` "done" ends the RUN, so a stage that held it would end the walk.
  assert.ok(!planTools.includes('report'), planTools.join(', '));
  assert.ok(!implementTools.includes('report'), implementTools.join(', '));
  assert.ok(!planTools.includes('roadmap_set_status'), 'PLAN writes nothing');
  assert.ok(planTools.includes('roadmap_get'));
});

test('what a Codex session commits is reported to the platform, as on Claude Code', async (t) => {
  const { platform, said } = await daemonWith(t, {
    name: 'test-codex-commits',
    offer: { id: 'run-codex-commits', profile: 'CODE' },
    everything: true,
    commits: true,
  });

  const deadline = Date.now() + 20000;
  const reported = () => platform.commitReports.find((each) => each.runId === 'run-codex-commits'
    && each.commits?.some((commit) => /the work/.test(JSON.stringify(commit))));
  while (Date.now() < deadline && !reported()) {
    await new Promise((done) => setTimeout(done, 150));
  }
  assert.ok(reported(), `${JSON.stringify(platform.commitReports)}\n${said()}`);
  assert.ok(reported().baseCommit, 'the base is reported with them');
});
