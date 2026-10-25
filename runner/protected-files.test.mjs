// node --test tools/runner/protected-files.test.mjs
//
// R562: what a run is spawned with, and told, when the project protects files.
//
// The agent is a recorder script — it keeps the first line of stdin, which is
// the prompt in its stream-json envelope — and the spawn line the daemon logs
// IS the argv. Every profile and both paths (one process, and walked stages).

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { socketPathFor } from './control.mjs';
import { fakePlatform } from './test-platform.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

async function until(said, pattern, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(said())) return true;
    await new Promise((wake) => setTimeout(wake, 100));
  }
  return false;
}

async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-protected-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

async function daemonWith(t, { name, offer, workflow, shield, live = true, echo = false }) {
  const workspace = await aRepository();
  const home = await mkdtemp(join(tmpdir(), 'cawdev-protected-cfg-'));
  const recorded = join(home, 'prompt.txt');
  const agent = join(home, 'agent.mjs');
  // Writes what it was given on stdin, copies the settings file the daemon
  // passed (it is deleted with the run), and lingers: `/bin/echo` races the
  // working-copy watcher.
  await writeFile(agent, `#!/usr/bin/env node
import { copyFileSync, writeFileSync } from 'node:fs';
for (const each of process.argv.slice(2)) {
  if (each.endsWith('protected-settings.json')) copyFileSync(each, ${JSON.stringify(join(home, 'settings.json'))});
}
let stdin = '';
process.stdin.on('data', (chunk) => {
  stdin += chunk;
  writeFileSync(${JSON.stringify(recorded)}, stdin);
});
setTimeout(() => process.exit(0), ${live ? 60000 : 50});
`);
  await chmod(agent, 0o755);
  const platform = await fakePlatform({ offers: [offer], workflow, shield, runLive: live });
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: echo ? '/bin/echo' : agent,
    pollSeconds: 1,
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
  return {
    said: () => said,
    spawnLines: () => said.split('\n').filter((each) => each.includes('spawning:')),
    prompt: async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const text = await readFile(recorded, 'utf8').catch(() => '');
        if (text.trim()) {
          return text.split('\n').filter(Boolean).map((line) => {
            try {
              return (JSON.parse(line).message?.content ?? []).map((part) => part.text ?? '').join('');
            } catch {
              return line;
            }
          }).join('\n');
        }
        await new Promise((wake) => setTimeout(wake, 100));
      }
      return '';
    },
    settings: () => readFile(join(home, 'settings.json'), 'utf8'),
  };
}

const REFUSE = { protectedPaths: ['secret/**', 'pom.xml'], protectedMode: 'REFUSE',
  protectedAllowed: [] };
const ASK = { ...REFUSE, protectedMode: 'ASK' };
const DENY = '--disallowedTools Edit(./secret/**) Edit(./pom.xml) --allowedTools';

test('CODE in REFUSE mode is spawned with the deny list ahead of --allowedTools', async (t) => {
  const { said, spawnLines, prompt } = await daemonWith(t, {
    name: 'test-protected-code',
    shield: REFUSE,
    offer: { id: 'run-code', projectSlug: 'board', label: 'the card', branch: 'r1-work',
      profile: 'CODE' },
  });
  assert.ok(await until(said, /spawning:/), said());
  const [line] = spawnLines();
  assert.ok(line.includes(DENY), line);
  assert.match(said(), /protected paths \(REFUSE\): secret\/\*\*, pom\.xml/);
  assert.doesNotMatch(line, /protected-settings/);

  await new Promise((wake) => setTimeout(wake, 1500));
  const text = await prompt();
  assert.match(text, /Protected files\./);
  assert.match(text, /An agent never changes them/);
});

test('CODE in ASK mode asks through a settings file instead of denying', async (t) => {
  const { said, spawnLines, settings } = await daemonWith(t, {
    name: 'test-protected-ask',
    shield: ASK,
    offer: { id: 'run-ask', projectSlug: 'board', label: 'the card', branch: 'r1-work',
      profile: 'CODE' },
  });
  assert.ok(await until(said, /spawning:/), said());
  const [line] = spawnLines();
  assert.match(line, /--settings \S*protected-settings\.json --disallowedTools Bash\(gh \*\) Bash\(glab \*\) --allowedTools/, line);
  assert.equal((line.match(/--settings/g) ?? []).length, 1, line);
  assert.doesNotMatch(line, /Edit\(/, line);
  await new Promise((wake) => setTimeout(wake, 1500));
  assert.deepEqual(JSON.parse(await settings()).permissions,
    { ask: ['Edit(./secret/**)', 'Edit(./pom.xml)'] });
  assert.ok(JSON.parse(await settings()).hooks.PreToolUse, 'the guard hook shares the file');
});

test('a CODE run walked as stages keeps the deny list on the stage that writes', async (t) => {
  const { said, spawnLines } = await daemonWith(t, {
    name: 'test-protected-staged',
    shield: REFUSE,
    offer: { id: 'run-staged', projectSlug: 'board', label: 'the card', branch: 'r1-work',
      profile: 'CODE' },
    workflow: [{ stage: 'IMPLEMENT', gate: 'AUTO' }, { stage: 'MEMORY', gate: 'AUTO' }],
    // Not live, and /bin/echo: a lingering agent would hold the first stage
    // open for ever, and a script loses the race to the run's FINISHED.
    live: false,
    echo: true,
  });
  assert.ok(await until(said, /spawning:.*\n[\s\S]*spawning:/), said());
  for (const line of spawnLines()) {
    assert.ok(line.includes(DENY), line);
  }
});

test('a profile with no prompt tool gets the deny list even in ASK mode', async (t) => {
  const { said, spawnLines } = await daemonWith(t, {
    name: 'test-protected-plan',
    shield: ASK,
    offer: { id: 'run-plan', projectSlug: 'board', label: 'R12 — a card to plan', branch: null,
      profile: 'PLAN', entryNumber: 12 },
  });
  assert.ok(await until(said, /spawning:/), said());
  const [line] = spawnLines();
  assert.ok(line.includes(DENY), line);
  assert.doesNotMatch(line, /protected-settings/, line);
});

test('a project that protects nothing is spawned exactly as before', async (t) => {
  const { said, spawnLines } = await daemonWith(t, {
    name: 'test-protected-none',
    shield: { protectedPaths: null, protectedMode: 'REFUSE', protectedAllowed: [] },
    offer: { id: 'run-none', projectSlug: 'board', label: 'the card', branch: 'r1-work',
      profile: 'CODE' },
  });
  assert.ok(await until(said, /spawning:/), said());
  assert.doesNotMatch(spawnLines()[0], /Edit\(|protected-settings/);
  assert.doesNotMatch(said(), /protected paths/);
});
