// node --test tools/runner/plan-considers-unfinished.test.mjs
//
// R576. A plan looks at the other unfinished cards before it settles — and
// still writes nothing. The platform acts on what the plan says when it
// records it, which is why the PLAN tool lists are pinned here beside the
// paragraph that asks for the sections: asking a session to "put a comment on
// the other card" must not have become giving it the tool.

import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';
import { toolsForStage } from '../lib/stage-tools.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

const PLAN_RUN = {
  id: 'run-plan',
  projectSlug: 'board',
  label: 'R12 — a card to plan',
  branch: null,
  profile: 'PLAN',
  entryNumber: 12,
};

const CODE_RUN = {
  id: 'run-code',
  projectSlug: 'board',
  label: 'R12 — a card to build',
  branch: 'r12-work',
  profile: 'CODE',
  entryNumber: 12,
};

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

async function daemonWith(t, { name, offers }) {
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
    // The agent the daemon spawned is in a process group of its own and
    // outlives a SIGKILL'd parent for a moment, still writing into `home` —
    // an rmdir that races it is ENOTEMPTY, which failed CI's gate once.
    const gone = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
    await rm(home, gone);
    await rm(path, gone);
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

test('a plan run is told to look at the other unfinished cards', async (t) => {
  const { record, spawnLines } = await daemonWith(t, {
    name: 'test-consider-plan', offers: [PLAN_RUN],
  });
  const prompt = await untilWritten(record);
  assert.match(prompt, /\*\*Comes after:\*\*/, prompt);
  assert.match(prompt, /\*\*Conflicts decided:\*\*/, prompt);
  assert.match(prompt, /\*\*Conflicts undecided:\*\*/, prompt);
  assert.match(prompt, /one question\s+per conflicting card/, prompt);
  // Once, and before the Done-when list it must precede.
  assert.equal(prompt.split('**Look at the other unfinished cards.**').length, 2);
  assert.ok(prompt.indexOf('**Comes after:**') < prompt.indexOf('**End with a Done-when list.**'));

  // The write-nothing rule stands: the paragraph says what to write, and the
  // session is still given no way to write it anywhere but the plan.
  const line = spawnLines()[0];
  assert.match(line, /mcp__cawdev__ask_user/, line);
  assert.doesNotMatch(line, /mcp__cawdev__roadmap_update/, line);
  assert.doesNotMatch(line, /mcp__cawdev__roadmap_comment/, line);
  assert.ok(!toolsOn(line).includes('mcp__cawdev__roadmap_update'));
});

test('a coding run is not told to, whatever it is planning', async (t) => {
  const { record } = await daemonWith(t, { name: 'test-consider-code', offers: [CODE_RUN] });
  const prompt = await untilWritten(record);
  assert.ok(prompt.length > 0);
  assert.doesNotMatch(prompt, /Comes after/, prompt);
  assert.doesNotMatch(prompt, /Conflicts decided/, prompt);
});

test('the PLAN stage of a coding walk holds neither roadmap_update nor roadmap_comment', () => {
  const coding = ['Read', 'mcp__cawdev__task_current', 'mcp__cawdev__ask_user',
    'mcp__cawdev__roadmap_update', 'mcp__cawdev__roadmap_comment'];
  const plan = toolsForStage('PLAN', coding);
  assert.ok(!plan.includes('mcp__cawdev__roadmap_update'));
  assert.ok(!plan.includes('mcp__cawdev__roadmap_comment'));
  assert.ok(plan.includes('mcp__cawdev__ask_user'));
});
