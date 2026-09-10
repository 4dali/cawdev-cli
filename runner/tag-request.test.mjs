// node --test tools/runner/tag-request.test.mjs
//
// R156's half of the daemon: a `TAG` workspace request, answered with
// `git ls-remote`.
//
// Against the real daemon rather than by calling the function, for
// `merge-request.test.mjs`'s reasons: the kind arriving from a claim and the
// path guard refusing a directory this machine does not serve are both outside
// the function, and a unit test of `tagOnTheRemote` proves neither.
//
// **A real remote, not a fake git.** The whole claim this makes is that it asks
// the REMOTE and not the clone — a local tag nobody pushed is exactly the state
// a release is trying to rule out, and `git tag --list` cannot tell the two
// apart. Faking `git` on PATH would assert the arguments and prove nothing
// about that, so the remote here is a second real repository on disk and the
// interesting test tags it locally WITHOUT pushing.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

/**
 * A checkout whose `origin` is a real bare repository on disk.
 *
 * `git ls-remote` against a path works exactly as it does against a host, which
 * is what makes "on the remote" testable without a network.
 */
async function aRepositoryWithARemote(t) {
  const remote = await mkdtemp(join(tmpdir(), 'cawdev-remote-'));
  await run('git', ['init', '-q', '--bare', remote]);

  const path = await mkdtemp(join(tmpdir(), 'cawdev-tag-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await run('git', ['remote', 'add', 'origin', remote], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  await run('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: path });

  t.after(() => rm(remote, { recursive: true, force: true }));
  return { path, remote };
}

async function daemonWith(t, { path, name, workspaceRequests, env = {} }) {
  const platform = await fakePlatform({ workspaceRequests });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: '/bin/echo',
    pollSeconds: 1,
    workspacePollSeconds: 1,
    projects: { board: path },
  }));

  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  daemon.stdout.on('data', (chunk) => (said += chunk));
  daemon.stderr.on('data', (chunk) => (said += chunk));

  t.after(async () => {
    daemon.kill('SIGKILL');
    platform.close();
    await rm(home, { recursive: true, force: true });
    await rm(socketPathFor(name), { force: true });
    await rm(path, { recursive: true, force: true });
  });

  return { platform, said: () => said, alive: () => daemon.exitCode === null };
}

test('a TAG that is on the remote reports ok with the sha on the first line', async (t) => {
  const { path } = await aRepositoryWithARemote(t);
  await run('git', ['tag', 'v0.6.2'], { cwd: path });
  await run('git', ['push', '-q', 'origin', 'v0.6.2'], { cwd: path });
  const head = (await run('git', ['rev-parse', 'v0.6.2'], { cwd: path })).stdout.trim();

  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-tag-there',
    workspaceRequests: [{ id: 'wr-tag', path, kind: 'TAG', message: 'v0.6.2' }],
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never checked the tag:\n${said()}`);

  const [done] = platform.finishedRequests;
  assert.equal(done.id, 'wr-tag');
  assert.equal(done.ok, true, done.result);

  // The first line is the evidence, and it is the ONLY thing that confirms a
  // release. The platform will not believe `ok: true` with prose under it —
  // `ReleaseRuns.shaIn` reads exactly this line — so a sentence arriving first
  // here would confirm nothing at all.
  assert.equal(done.result.split('\n')[0], head);
  assert.match(done.result.split('\n')[0], /^[0-9a-f]{7,40}$/);
  assert.match(done.result, /v0\.6\.2 is on the remote/);
});

test('a TAG that exists only locally is NOT on the remote', async (t) => {
  const { path } = await aRepositoryWithARemote(t);
  // Tagged, and deliberately never pushed. This is the whole point of the
  // feature: it is precisely the state a release is trying to rule out, and
  // `git tag --list` in this checkout would answer "yes".
  await run('git', ['tag', 'v0.6.2'], { cwd: path });

  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-tag-local-only',
    workspaceRequests: [{ id: 'wr-local', path, kind: 'TAG', message: 'v0.6.2' }],
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never answered:\n${said()}`);

  const [done] = platform.finishedRequests;
  assert.equal(done.ok, false);
  assert.match(done.result, /There is no tag v0\.6\.2 on the remote yet/);
});

test('a TAG for a version nobody has cut is an answer, and the daemon stays up', async (t) => {
  const { path } = await aRepositoryWithARemote(t);
  const { platform, said, alive } = await daemonWith(t, {
    path,
    name: 'test-tag-absent',
    workspaceRequests: [{ id: 'wr-absent', path, kind: 'TAG', message: 'v9.9.9' }],
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never answered:\n${said()}`);

  const [done] = platform.finishedRequests;
  // `ok: false` and a sentence — a LEGITIMATE answer rather than an error. The
  // release procedure pushes the tag last, so the check queued seconds after
  // somebody presses Release correctly finds nothing, and this sentence is what
  // a person reads mid-release.
  assert.equal(done.ok, false);
  assert.match(done.result, /There is no tag v9\.9\.9 on the remote yet/);
  assert.ok(alive(), 'a missing tag is not a reason for the daemon to fall over');
});

test('a TAG does not match a BRANCH of the same name', async (t) => {
  const { path } = await aRepositoryWithARemote(t);
  // A branch called v0.6.2, pushed. `ls-remote --tags` with the fully-qualified
  // `refs/tags/...` is what keeps these apart; a bare version string would
  // match the branch and confirm a release nobody tagged.
  await run('git', ['branch', 'v0.6.2'], { cwd: path });
  await run('git', ['push', '-q', 'origin', 'v0.6.2'], { cwd: path });

  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-tag-vs-branch',
    workspaceRequests: [{ id: 'wr-branch', path, kind: 'TAG', message: 'v0.6.2' }],
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never answered:\n${said()}`);

  const [done] = platform.finishedRequests;
  assert.equal(done.ok, false, done.result);
  assert.match(done.result, /There is no tag v0\.6\.2 on the remote yet/);
});

test('an annotated tag answers with a sha too', async (t) => {
  const { path } = await aRepositoryWithARemote(t);
  await run('git', ['tag', '-a', 'v0.6.3', '-m', 'Release v0.6.3'], { cwd: path });
  await run('git', ['push', '-q', 'origin', 'v0.6.3'], { cwd: path });

  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-tag-annotated',
    workspaceRequests: [{ id: 'wr-annotated', path, kind: 'TAG', message: 'v0.6.3' }],
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never answered:\n${said()}`);

  const [done] = platform.finishedRequests;
  assert.equal(done.ok, true, done.result);
  // An annotated tag also answers `refs/tags/v0.6.3^{}` — the commit it points
  // at. Either line proves the tag is on the remote; the plain ref is preferred
  // so the sha reported is the TAG object's, which is what `git show` resolves.
  const first = done.result.split('\n')[0];
  assert.match(first, /^[0-9a-f]{7,40}$/);
  const tagObject = (await run('git', ['rev-parse', 'v0.6.3'], { cwd: path })).stdout.trim();
  assert.equal(first, tagObject);
});

test('a TAG naming a path this daemon does not serve is refused', async (t) => {
  const { path } = await aRepositoryWithARemote(t);
  const elsewhere = await mkdtemp(join(tmpdir(), 'cawdev-elsewhere-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: elsewhere });
  t.after(() => rm(elsewhere, { recursive: true, force: true }));

  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-tag-elsewhere',
    workspaceRequests: [
      { id: 'wr-elsewhere', path: elsewhere, kind: 'TAG', message: 'v0.6.2' },
    ],
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never answered:\n${said()}`);

  const [done] = platform.finishedRequests;
  assert.equal(done.ok, false);
  // The platform checked the runner is yours; only this process knows which
  // directories it was actually given.
  assert.match(done.result, /does not serve/);
});

test('a TAG with no version checks nothing and says so', async (t) => {
  const { path } = await aRepositoryWithARemote(t);
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-tag-nameless',
    workspaceRequests: [{ id: 'wr-blank', path, kind: 'TAG', message: '  ' }],
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never answered:\n${said()}`);

  const [done] = platform.finishedRequests;
  assert.equal(done.ok, false);
  assert.match(done.result, /has to name a version/);
});
