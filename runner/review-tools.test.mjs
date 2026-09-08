// node --test tools/runner/review-tools.test.mjs
//
// R104/R117's review run, against the real daemon: it can file what it found.
//
// The review profile's entire output is its findings, and the prompt the daemon
// writes tells the session to file them with `roadmap_comment`. That tool was in
// the MCP server, in its README and in that prompt, and in NO allow-list — so
// every review run ever started was instructed to use a tool it could not call.
//
// It failed silently in the worst available way. A non-coding profile is spawned
// WITHOUT `--permission-prompt-tool` (`argsForProfile` drops it deliberately, so
// a person cannot grant an ASK session the shell), which means there was not
// even a question to answer: the call was refused outright, the session reported
// done, and the findings existed only in a transcript.
//
// So this is a test about a list of strings, run against the daemon that builds
// it. The agent is `/bin/echo`, so the spawn line the daemon logs IS the argv.

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

async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-review-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

async function daemonWith(t, { name, profile, branch = null }) {
  const path = await aRepository();
  const platform = await fakePlatform({
    offers: [{
      id: `run-${name}`,
      projectSlug: 'board',
      label: 'the card',
      entryNumber: 129,
      entryTitle: 'something to read',
      branch,
      profile,
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

test('a review run can file the findings its own prompt asks it for', async (t) => {
  const { spawnLine, said } = await daemonWith(t, {
    name: 'test-review-can-comment',
    profile: 'REVIEW',
    branch: 'r129-something',
  });
  const line = spawnLine();

  // THE defect. Without this the profile's whole output is unreachable.
  assert.match(line, /mcp__cawdev__roadmap_comment/, said());

  // The rest of the review, unchanged: it reads the code and the diff.
  assert.match(line, /\bRead\b/);
  assert.match(line, /Bash\(git diff \*\)/);
});

test('and it still cannot change the code, the card or the verdict', async (t) => {
  // The regression adding one write tool could have caused. A reviewer that
  // could commit could fix what it was asked to judge; one that could move the
  // card would be giving the verdict R74 reserves for a person.
  const { spawnLine } = await daemonWith(t, {
    name: 'test-review-writes-nothing-else',
    profile: 'REVIEW',
    branch: 'r129-something',
  });
  const line = spawnLine();

  assert.doesNotMatch(line, /mcp__cawdev__roadmap_set_status/);
  assert.doesNotMatch(line, /mcp__cawdev__roadmap_create/);
  assert.doesNotMatch(line, /mcp__cawdev__roadmap_update/);
  assert.doesNotMatch(line, /\bWrite\b/);
  assert.doesNotMatch(line, /\bEdit\b/);
  assert.doesNotMatch(line, /Bash\(git \*\)/);
  // And no way to be granted any of it in the moment, which is the reason the
  // missing tool was a hard refusal rather than a question.
  assert.doesNotMatch(line, /--permission-prompt-tool/);
});

test('the profiles that must not write the roadmap did not quietly gain it', async (t) => {
  // `roadmap_comment` is in the defaults now, so it reaches every profile that
  // takes the read-only cawdev list unless that list says otherwise. An ASK
  // session's own prompt tells it that it cannot change the roadmap, and a
  // comment on a card is a change to the roadmap that nobody can delete.
  const { spawnLine } = await daemonWith(t, {
    name: 'test-ask-cannot-comment',
    profile: 'ASK',
  });
  assert.doesNotMatch(spawnLine(), /mcp__cawdev__roadmap_comment/);
});

test('a plan run writes nothing, still including the discussion', async (t) => {
  // R124: "it reads the repository and the card, and writes NOTHING — not the
  // code, not the roadmap, not even the plan."
  const { spawnLine } = await daemonWith(t, {
    name: 'test-plan-cannot-comment',
    profile: 'PLAN',
  });
  assert.doesNotMatch(spawnLine(), /mcp__cawdev__roadmap_comment/);
});
