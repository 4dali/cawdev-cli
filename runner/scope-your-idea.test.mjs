// node --test tools/runner/scope-your-idea.test.mjs
//
// R227's half that lives on the machine: what a SCOPE session (named by R248,
// so that "stage" is the lifecycle's word alone) is allowed to
// do, read off the daemon's own `spawning:` line the way `release-action.test.mjs`
// reads its own.
//
// The card's claim is that SCOPE carries exactly an audit's permissions and a
// different prompt. So the assertions come in two halves: the tool list is the
// audit's, name for name — `propose_entry` among them, and no writer of any
// kind — and the prompt asks for a cutting rather than for findings. Delete
// `PROFILE_TOOLS.SCOPE` and the session falls through to `READ_ONLY_CAWDEV`,
// which is the list with no `propose_entry` in it: the first test goes red.
//
// The project config below permits `Bash(mvn *)`. That is the control: a
// coding run on this project WOULD be spawned with it, and a scoping session
// must not.

import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

const OPENING = 'Split "move the runner\'s tool rules into the database" into cards.';

const SCOPE_RUN = {
  id: 'run-scope',
  projectSlug: 'board',
  label: 'Scope your idea',
  branch: null,
  profile: 'SCOPE',
  kind: 'MANUAL',
  openingPrompt: OPENING,
};

const AUDIT_RUN = { ...SCOPE_RUN, id: 'run-audit', label: 'Audit', profile: 'AUDIT' };

async function untilSaid(said, pattern, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(said())) return true;
    await new Promise((wake) => setTimeout(wake, 100));
  }
  return false;
}

async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-scope-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

/**
 * An agent that writes what it was given on stdin, and lingers — the same
 * recorder `release-action.test.mjs` uses, for the same two reasons: the
 * prompt goes on stdin, and `/bin/echo` races the working-copy watcher.
 */
async function aRecorder(directory, record) {
  const path = join(directory, 'recorder.mjs');
  await writeFile(path, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let stdin = '';
process.stdin.on('data', (chunk) => {
  stdin += chunk;
  writeFileSync(${JSON.stringify(record)}, stdin);
});
setTimeout(() => process.exit(0), 60000);
`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

/** The prompt's text, out of the stream-json envelope stdin carries it in. */
async function untilWritten(path, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (text.trim()) {
      return text.split('\n').filter(Boolean).map((line) => {
        try {
          const message = JSON.parse(line);
          return (message.message?.content ?? []).map((part) => part.text ?? '').join('');
        } catch {
          return line;
        }
      }).join('\n');
    }
    await new Promise((wake) => setTimeout(wake, 100));
  }
  return '';
}

async function daemonWith(t, { name, offers = [SCOPE_RUN] }) {
  const path = await aRepository();
  const platform = await fakePlatform({ offers, runLive: true });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-scope-cfg-'));
  const record = join(home, 'prompt.txt');
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: await aRecorder(home, record),
    pollSeconds: 1,
    workspacePollSeconds: 1,
    // The control. A coding run here is spawned with `Bash(mvn *)`; a scoping
    // session must not be, whatever the project says it permits.
    projects: { board: { path, allowedTools: ['Bash(mvn *)'] } },
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
    await rm(path, { recursive: true, force: true });
    await rm(socketPathFor(name), { force: true });
  });

  assert.ok(await untilSaid(() => said, /spawning:/), `never spawned:\n${said}`);
  return {
    platform,
    path,
    record,
    said: () => said,
    untilSaid: (pattern) => untilSaid(() => said, pattern),
    spawnLines: () => said.split('\n').filter((each) => each.includes('spawning:')),
  };
}

/** The `--allowedTools` half of the spawn line, one tool per entry. */
function toolsOn(line) {
  const after = line.slice(line.indexOf('--allowedTools') + '--allowedTools'.length)
    .replace(/\(prompt on stdin\)\s*$/, '').trim();
  return after.match(/\S+\([^)]*\)|\S+/g) ?? [];
}

test('a scoping session takes no checkout and prepares nothing, like an audit', async (t) => {
  const { said, untilSaid } = await daemonWith(t, { name: 'test-scope-nothing-prepared' });
  assert.ok(await untilSaid(/a scope session: no branch, nothing prepared/), said());
  // The claim carried no branch and the daemon cut none.
  assert.match(said(), /claiming board Scope your idea on null/);
});

test('it is spawned with the audit\'s tool list, name for name', async (t) => {
  // Both profiles on one daemon, so the two lists come from the same code on
  // the same day and the comparison is between them rather than against a
  // list written down here — which would drift the first time the audit's
  // changed.
  const { spawnLines, untilSaid, said } = await daemonWith(t, {
    name: 'test-scope-tools',
    offers: [SCOPE_RUN, AUDIT_RUN],
  });
  assert.ok(await untilSaid(/spawning:[\s\S]*spawning:/), `only one spawned:\n${said()}`);
  const lines = spawnLines();
  assert.equal(lines.length, 2, said());
  const [first, second] = lines.map(toolsOn);
  assert.deepEqual([...first].sort(), [...second].sort(),
    `a scoping session and an audit were spawned with different lists:\n${lines.join('\n')}`);

  const tools = first;
  // What it has: the reads, `propose_entry`, the files.
  assert.ok(tools.includes('mcp__cawdev__propose_entry'), lines[0]);
  assert.ok(tools.includes('mcp__cawdev__roadmap_list'), lines[0]);
  assert.ok(tools.includes('mcp__cawdev__roadmap_get'), lines[0]);
  assert.ok(tools.includes('mcp__cawdev__report'), lines[0]);
  assert.ok(tools.includes('Read'), lines[0]);
  assert.ok(tools.includes('Grep'), lines[0]);
  assert.ok(tools.includes('Glob'), lines[0]);

  // What it has NOT — the half that proves the profile exists.
  for (const line of lines) {
    // No permission prompt and no permission mode: the list is the whole
    // permission. "Cannot" must not quietly become "not yet".
    assert.doesNotMatch(line, /--permission-prompt-tool/);
    assert.doesNotMatch(line, /--permission-mode/);
    assert.doesNotMatch(line, /bypassPermissions/);
    // Nothing that creates an entry directly, and nothing that writes a file
    // or runs anything — not even the project's own extras.
    assert.doesNotMatch(line, /mcp__cawdev__roadmap_create/);
    assert.doesNotMatch(line, /mcp__cawdev__roadmap_update/);
    assert.doesNotMatch(line, /mcp__cawdev__roadmap_set_status/);
    assert.doesNotMatch(line, /mcp__cawdev__issue_file/);
    const on = toolsOn(line);
    assert.ok(!on.includes('Write'), `a Write in:\n${line}`);
    assert.ok(!on.includes('Edit'), `an Edit in:\n${line}`);
    assert.ok(!on.some((each) => each.startsWith('Bash')), `a shell in:\n${line}`);
    assert.ok(!on.includes('Bash(mvn *)'),
      `a scoping session was spawned with the project's build tools:\n${line}`);
  }
});

test('the prompt asks for a cutting, not for findings', async (t) => {
  const { record } = await daemonWith(t, { name: 'test-scope-prompt' });
  const prompt = await untilWritten(record);
  assert.ok(prompt, 'the agent was never given a prompt on stdin');

  assert.match(prompt, /^You are scoping an idea for planning/);
  // Read first, cut second, file third, report the cutting last — in that order.
  const read = prompt.indexOf('**Read first.**');
  const cut = prompt.indexOf('**Then cut.**');
  const file = prompt.indexOf('**Then file.**');
  const report = prompt.indexOf('the cutting itself');
  assert.ok(read > 0 && cut > read && file > cut && report > file,
    `the prompt does not walk read → cut → file → report:\n${prompt}`);
  // Every card a roadmap proposal, all under one section, in build order.
  assert.match(prompt, /`propose_entry` with `kind: roadmap`/);
  assert.match(prompt, /one `section`/);
  assert.match(prompt, /build order/);
  // An issue is the exception and not the job.
  assert.match(prompt, /`kind: issue`/);
  assert.match(prompt, /the exception and not the job/);
  // And it is not the audit's prompt.
  assert.doesNotMatch(prompt, /You are auditing this repository/);
  // The question arrives whole.
  assert.ok(prompt.includes(OPENING), `the opening prompt was not handed over:\n${prompt}`);
});
