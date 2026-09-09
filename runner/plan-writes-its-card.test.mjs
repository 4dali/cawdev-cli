// node --test tools/runner/plan-writes-its-card.test.mjs
//
// R150's "a test that proves each half", on the machine where the permission is
// actually withheld.
//
// R112 built the plan stage as one that cannot write, and R147 leans on that
// when it delegates to read-only experts. R150 makes one exception, and an
// exception to a load-bearing claim is worth two tests rather than one: a plan
// session started with NO CARD may call `roadmap_create`, because the thing it
// is planning does not exist yet — and it still cannot write a file, run a
// command, or touch the card in any other way.
//
// The second half is the one that would fail quietly. `PROFILE_TOOLS.PLAN` is a
// function of the run now, and a predicate written the wrong way round hands
// every plan session the card write. So the with-a-card case is asserted too.
//
// The agent is `/bin/echo`, so the spawn line the daemon logs IS the argv —
// `interview.test.mjs`'s shape, for the claim it makes about the same file.
// `served-tools.test.mjs` cannot make this one: it compares two lists of
// strings read as text, and this is about what a run is spawned with.

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

async function untilSaid(said, pattern, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(said())) return true;
    await new Promise((wake) => setTimeout(wake, 100));
  }
  return false;
}

/** A checkout the plan run reads where it stands. It cuts no branch. */
async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-plan-card-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

/**
 * @param entryNumber null is the cardless plan run — which is how the runner
 *   knows, the claim carrying `presenter.of(run)`'s null rather than a new API
 *   field saying the same thing twice.
 */
async function daemonWith(t, { name, entryNumber }) {
  const path = await aRepository();
  const platform = await fakePlatform({
    offers: [{
      id: `run-${name}`,
      projectSlug: 'board',
      label: entryNumber ? 'R12 — a card to plan' : 'something new',
      branch: null,
      profile: 'PLAN',
      entryNumber,
    }],
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
    await rm(home, { recursive: true, force: true });
    await rm(path, { recursive: true, force: true });
    await rm(socketPathFor(name), { force: true });
  });

  await untilSaid(() => said, /spawning:/);
  return {
    said: () => said,
    spawnLine: () => said.split('\n').find((each) => each.includes('spawning:')) ?? '',
  };
}

/**
 * The `Bash(...)` patterns on a spawn line. Judged as patterns rather than by
 * the bare word, because `Bash(git diff *)` cannot change anything and
 * `Bash(npm *)` can — which is the distinction the whole claim turns on.
 */
function bashPatterns(line) {
  return [...line.matchAll(/Bash\([^)]*\)/g)].map((each) => each[0]);
}

const GIT_READS = ['Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)',
  'Bash(git status *)'];

test('a plan session with no card may write the card, and nothing else', async (t) => {
  const { spawnLine } = await daemonWith(t, { name: 'test-plan-no-card', entryNumber: null });
  const line = spawnLine();

  // The exception. It is planning something that does not exist, so writing it
  // is the first step of planning it.
  assert.match(line, /mcp__cawdev__roadmap_create/, line);

  // And the half of R112's claim that survives, item by item. Not "it looks
  // read-only" — the three names a session would actually reach for.
  assert.doesNotMatch(line, /\bWrite\b/, line);
  assert.doesNotMatch(line, /\bEdit\b/, line);
  assert.deepEqual(
    bashPatterns(line).filter((pattern) => !GIT_READS.includes(pattern)), [],
    `a plan stage was given a shell beyond the git reads:\n${line}`,
  );

  // The rest of the roadmap is still shut. `roadmap_create` is one tool, not a
  // door — the plan of record is the PLATFORM's to write, and the card it just
  // made is not its to edit, move or argue with.
  assert.doesNotMatch(line, /mcp__cawdev__roadmap_update/, line);
  assert.doesNotMatch(line, /mcp__cawdev__roadmap_set_status/, line);
  assert.doesNotMatch(line, /mcp__cawdev__roadmap_comment/, line);
});

test('a plan session that already has a card may write nothing at all', async (t) => {
  const { spawnLine } = await daemonWith(t, { name: 'test-plan-with-card', entryNumber: 12 });
  const line = spawnLine();

  // Asserted first, so nothing below can pass on an empty line: a spawn that
  // never happened would satisfy every `doesNotMatch` here and say nothing.
  assert.match(line, /--allowedTools/, line);
  assert.match(line, /mcp__cawdev__roadmap_get/, line);

  // The predicate, the right way round. The card exists, so there is nothing
  // for the exception to be an exception about, and this is exactly the list
  // R124 shipped.
  assert.doesNotMatch(line, /mcp__cawdev__roadmap_create/, line);
  assert.doesNotMatch(line, /\bWrite\b/, line);
  assert.doesNotMatch(line, /\bEdit\b/, line);
  assert.deepEqual(
    bashPatterns(line).filter((pattern) => !GIT_READS.includes(pattern)), [],
    `a plan stage was given a shell beyond the git reads:\n${line}`,
  );
});
