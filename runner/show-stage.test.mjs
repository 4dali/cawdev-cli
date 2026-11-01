// node --test tools/runner/show-stage.test.mjs
//
// R604, against the real daemon and a fake platform: a card that asked to be
// shown walks IMPLEMENT → TEST → SHOW → MEMORY, uploads what SHOW left with the
// MACHINE's token, raises the gate with the round in it, and reports SHOW DONE
// only once a person accepted. A refusal walks IMPLEMENT and TEST again with
// the comments leading, with no cap. A SHOW that touches the tree fails.

import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

const CODING = {
  id: 'run-show', projectSlug: 'board', label: 'the card',
  branch: 'r604-work', profile: 'CODE',
};

const STAGES = (...names) => names.map((stage) => ({
  stage, gate: stage === 'SHOW' ? 'ASK' : 'AUTO', agent: 'claude',
}));
const WITH_SHOW = STAGES('IMPLEMENT', 'TEST', 'SHOW', 'MEMORY');
const REWORK = STAGES('IMPLEMENT', 'TEST', 'SHOW');

async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-show-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

/**
 * An agent that logs each prompt (one JSON line per stage) and, in SHOW, does
 * what `misbehaves` says: leaves its screenshots (the default), also writes a
 * stray file, makes a commit, or leaves no shots.json.
 */
async function aShowingAgent(home, misbehaves = null) {
  const path = join(home, 'showing-agent.mjs');
  const log = join(home, 'prompts.jsonl');
  await writeFile(path, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
let input = '';
let timer = null;
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'showing' }) + '\\n');
process.stdin.on('data', (chunk) => {
  input += chunk;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const stage = [...input.matchAll(/## This is the (\\w+) stage/g)].pop()?.[1];
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ stage, prompt: input }) + '\\n');
    if (stage === 'SHOW') {
      mkdirSync('.cawdev/shots', { recursive: true });
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
      writeFileSync('.cawdev/shots/a.png', png);
      writeFileSync('.cawdev/shots/b.png', png);
      if (${JSON.stringify(misbehaves)} !== 'no-manifest') {
        writeFileSync('.cawdev/shots/shots.json', JSON.stringify([
          { file: 'a.png', caption: 'the new page' }, { file: 'b.png', caption: 'the empty state' }]));
      }
      if (${JSON.stringify(misbehaves)} === 'stray') writeFileSync('stray.txt', 'oops');
      if (${JSON.stringify(misbehaves)} === 'commit') {
        writeFileSync('c.txt', 'x');
        execFileSync('git', ['add', 'c.txt']);
        execFileSync('git', ['commit', '-q', '-m', 'sneaky']);
      }
    }
    input = '';
    process.stdout.write(JSON.stringify({ type: 'result', result: 'did ' + stage }) + '\\n');
  }, 300);
});
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o755 });
  return { path, log };
}

async function daemonWith(t, { name, workflow, misbehaves = null, ...platformOptions }) {
  const workspace = await aRepository();
  const home = await mkdtemp(join(tmpdir(), 'cawdev-show-cfg-'));
  const agent = await aShowingAgent(home, misbehaves);
  const platform = await fakePlatform({
    offers: [CODING], workflow, runLive: true, ...platformOptions,
  });
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url, agentCommand: agent.path, name, pollSeconds: 1,
    projects: { board: { workspaces: [workspace] } },
  }));
  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env(), stdio: ['ignore', 'pipe', 'pipe'],
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
  const prompts = async () => (await readFile(agent.log, 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { platform, said: () => said, workspace, prompts };
}

async function until(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((done) => setTimeout(done, 150));
  }
  return false;
}

const finished = (platform) => platform.until((transitions) => transitions.some(
  (each) => each.state === 'FINISHED' || each.state === 'FAILED'), 120000);

test('SHOW walks after TEST, uploads, and is DONE only after Accept; comments re-walk with no cap', async (t) => {
  const { platform, said, workspace, prompts } = await daemonWith(t, {
    name: 'show-walk',
    workflow: WITH_SHOW,
    rework: REWORK,
    gateDecisions: [
      { state: 'DENIED', reason: 'make the header blue' },
      { state: 'DENIED', reason: 'now the footer' },
      { state: 'ALLOWED' },
    ],
  });
  assert.ok(await finished(platform), said());
  assert.deepEqual(platform.transitions.filter((each) => each.state === 'FAILED'), [], said());

  assert.deepEqual((await prompts()).map((each) => each.stage), [
    'IMPLEMENT', 'TEST', 'SHOW', 'IMPLEMENT', 'TEST', 'SHOW', 'IMPLEMENT', 'TEST', 'SHOW', 'MEMORY',
  ], said());

  // Round 2's IMPLEMENT leads with the comments, ahead of its instruction.
  const second = (await prompts()).filter((each) => each.stage === 'IMPLEMENT')[1].prompt;
  const heading = second.indexOf('### What the person asked to change after round 1');
  assert.ok(heading >= 0, 'the comments never reached IMPLEMENT');
  assert.ok(second.includes('make the header blue'));
  assert.ok(heading < second.indexOf('This card has no plan'), 'the comments do not lead the stage');

  // Three rounds went up, each sealed with its captions, through the machine door.
  assert.equal(platform.sealed.length, 3);
  assert.deepEqual(platform.sealed[0].files, [
    { name: 'a.png', caption: 'the new page' }, { name: 'b.png', caption: 'the empty state' }]);
  assert.equal(platform.uploads.length, 6);

  // The gate names its round and its shots.
  assert.equal(platform.gates.length, 3);
  assert.equal(platform.gates[0].toolName, 'stage:SHOW');
  assert.deepEqual(JSON.parse(platform.gates[0].toolInput), {
    stage: 'SHOW', round: 1, attachments: ['shot-1-1', 'shot-1-2'],
  });
  assert.match(platform.gates[0].summary, /^2 screenshots to look at/);

  // SHOW is DONE once, and after the last gate was allowed — never before.
  const done = platform.stageCalls.filter((each) => each.stage === 'SHOW'
    && each.what === 'report' && each.body.state === 'DONE');
  assert.equal(done.length, 1);

  // Never committed, and not left lying about.
  assert.match(await readFile(join(workspace, '.git', 'info', 'exclude'), 'utf8'), /\.cawdev\/shots\//);
  await assert.rejects(stat(join(workspace, '.cawdev', 'shots')));
});

test('SHOW is spawned with no permission mode but keeps the permission prompt', async (t) => {
  const { platform, said } = await daemonWith(t, {
    name: 'show-args', workflow: WITH_SHOW, rework: REWORK, gateDecision: 'ALLOWED',
  });
  assert.ok(await finished(platform), said());
  const spawns = said().split('\n').filter((line) => line.includes('spawning:'));
  assert.equal(spawns.length, 4, said());
  assert.match(spawns[0], /--permission-mode/);
  assert.doesNotMatch(spawns[2], /--permission-mode/);
  assert.match(spawns[2], /--permission-prompt-tool/);
  assert.match(spawns[2], /Edit\(\.\/\.cawdev\/shots\/\*\*\)/);
  assert.doesNotMatch(spawns[2], /\sWrite\s|\sMultiEdit\s/);
});

for (const [misbehaves, pattern] of [
  ['stray', /stray\.txt/],
  ['commit', /a commit/],
]) {
  test(`SHOW that leaves ${misbehaves} changes fails, naming them, and raises no gate`, async (t) => {
    const { platform, said } = await daemonWith(t, {
      name: `show-${misbehaves}`, workflow: WITH_SHOW, rework: REWORK, misbehaves,
    });
    assert.ok(await platform.until((transitions) => transitions.some((each) => each.state === 'FAILED')), said());
    assert.match(platform.transitions.find((each) => each.state === 'FAILED').summary, pattern);
    assert.equal(platform.gates.length, 0);
    assert.equal(platform.uploads.length, 0);
  });
}

test('SHOW with no shots.json fails', async (t) => {
  const { platform, said } = await daemonWith(t, {
    name: 'show-no-manifest', workflow: WITH_SHOW, rework: REWORK, misbehaves: 'no-manifest',
  });
  assert.ok(await platform.until((transitions) => transitions.some((each) => each.state === 'FAILED')), said());
  assert.match(platform.transitions.find((each) => each.state === 'FAILED').summary, /shots\.json/);
  assert.equal(platform.gates.length, 0);
});

test("the platform's refusal of a screenshot fails SHOW with its sentence", async (t) => {
  const { platform, said } = await daemonWith(t, {
    name: 'show-refused', workflow: WITH_SHOW, rework: REWORK,
    refuseAttachments: '`a.png` is 3.1 MB; a screenshot must be 2 MB or smaller.',
  });
  assert.ok(await platform.until((transitions) => transitions.some((each) => each.state === 'FAILED')), said());
  assert.match(platform.transitions.find((each) => each.state === 'FAILED').summary,
    /`a\.png` is 3\.1 MB; a screenshot must be 2 MB or smaller\./);
});

test('a gate that cannot be raised fails SHOW instead of re-running IMPLEMENT', async (t) => {
  const { platform, said, prompts } = await daemonWith(t, {
    name: 'show-gate-broken', workflow: WITH_SHOW, rework: REWORK, gateBroken: true,
  });
  assert.ok(await platform.until((transitions) => transitions.some((each) => each.state === 'FAILED')), said());
  assert.deepEqual((await prompts()).map((each) => each.stage), ['IMPLEMENT', 'TEST', 'SHOW']);
  assert.ok(await until(() => platform.stageCalls.some((each) => each.stage === 'SHOW'
    && each.what === 'report' && each.body.state === 'FAILED')));
});

test('a run without the switch walks three stages, exactly as before', async (t) => {
  const { platform, said, prompts } = await daemonWith(t, {
    name: 'show-off', workflow: STAGES('IMPLEMENT', 'TEST', 'MEMORY'),
  });
  assert.ok(await finished(platform), said());
  assert.deepEqual((await prompts()).map((each) => each.stage), ['IMPLEMENT', 'TEST', 'MEMORY']);
  assert.equal(platform.uploads.length, 0);
  assert.equal(platform.gates.length, 0);
});
