// node --test tools/runner/interview.test.mjs
//
// R96's half that lives on the machine: what a CTO Interview is allowed to do.
//
// The interview is the first profile that both takes a checkout AND is not a
// coding run, and those two facts were one question until now — `writesCode`
// meant "is a branch cut" and "may write anything" at the same time. So the
// two are tested apart: an interview gets a working copy and a branch like a
// coding run, and is spawned with a tool list that lets it write the brief and
// nothing else.
//
// The agent is `/bin/echo`, so the spawn line the daemon logs IS the argv.

import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
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

/** @param withBrief whether the repository already has one, for the git survey. */
async function aRepository({ withBrief = false } = {}) {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-interview-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  if (withBrief) {
    await mkdir(join(path, 'docs', 'brief'), { recursive: true });
    await writeFile(join(path, 'docs', 'brief', 'README.md'), '# the brief\n');
  }
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

async function daemonWith(t, { name, profile, branch = 'cto-interview', withBrief = false }) {
  const path = await aRepository({ withBrief });
  const platform = await fakePlatform({
    offers: [{
      id: `run-${name}`,
      projectSlug: 'board',
      label: 'CTO Interview',
      branch: profile === 'ASK' ? null : branch,
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
    platform,
    path,
    said: () => said,
    untilSaid: (pattern) => untilSaid(() => said, pattern),
    spawnLine: () => said.split('\n').find((each) => each.includes('spawning:')) ?? '',
  };
}

test('an interview is prepared a working copy and a branch, like a coding run', async (t) => {
  const { said, untilSaid } = await daemonWith(t, {
    name: 'test-interview-branch',
    profile: 'INTERVIEW',
  });
  // The branch is the point: the brief is committed and read before it lands,
  // so it goes out through the project's finish rules like any other work.
  assert.ok(await untilSaid(/working copy .* is on cto-interview/), said());
  assert.doesNotMatch(said(), /nothing prepared/);
});

test('it may write the brief and nothing else', async (t) => {
  const { spawnLine } = await daemonWith(t, {
    name: 'test-interview-tools',
    profile: 'INTERVIEW',
  });
  const line = spawnLine();

  // What it may write, scoped to the brief. This is the whole reason the
  // interview is a profile and not a coding run with a careful prompt.
  assert.match(line, /Write\(docs\/brief\/\*\*\)/);
  assert.match(line, /Edit\(docs\/brief\/\*\*\)/);
  // It commits what it wrote, so git — and git alone.
  assert.match(line, /Bash\(git \*\)/);
  // Reading is the first half of the job.
  assert.match(line, /\bRead\b/);
  // Rounds, which is how it asks at all.
  assert.match(line, /mcp__cawdev__ask_group/);

  // And NOT the coding set: an interview that could create roadmap entries or
  // be granted the shell by a permission prompt is a coding run wearing an
  // interview's name.
  assert.doesNotMatch(line, /mcp__cawdev__roadmap_create/);
  assert.doesNotMatch(line, /--permission-prompt-tool/);
  assert.doesNotMatch(line, /--permission-mode/);
});

test('an ASK session still has nothing prepared', async (t) => {
  // The regression this entry could have caused: `writesCodeProfile` decides
  // whether a checkout is taken, and widening it for the interview must not
  // start cutting branches for the profiles that never had one.
  const { said, untilSaid } = await daemonWith(t, {
    name: 'test-interview-ask-untouched',
    profile: 'ASK',
  });
  assert.ok(await untilSaid(/no branch, nothing prepared/), said());
});

test('the git survey says whether the repository already has a brief', async (t) => {
  // What the console reads to decide whether to OFFER an interview. cawdev
  // holds no repository contents, so a machine looking is the only way it can
  // know — and a project that already has a brief must not be asked for one.
  const withOne = await daemonWith(t, {
    name: 'test-interview-brief-seen',
    profile: 'ASK',
    withBrief: true,
  });
  assert.ok(await withOne.untilSaid(/spawning:/), withOne.said());
  const seen = await withOne.platform.untilGit();
  assert.equal(seen.brief, true);

  const without = await daemonWith(t, {
    name: 'test-interview-brief-absent',
    profile: 'ASK',
  });
  assert.ok(await without.untilSaid(/spawning:/), without.said());
  const unseen = await without.platform.untilGit();
  assert.equal(unseen.brief, false);
});
