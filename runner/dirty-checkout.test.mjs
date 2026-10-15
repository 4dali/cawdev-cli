// node --test tools/runner/dirty-checkout.test.mjs
//
// R57, against the real daemon: a dirty checkout you can start on top of, look
// at, park, or keep.
//
// The first two tests are the bug R46 shipped with. Its own "Done when" says
// "*Start anyway* reaches the runner and the agent branches on top of the
// edits" — and it did not, because `git checkout <branch>` refuses when a local
// change would be overwritten. The flag travelled, the runner accepted it, and
// the run failed one step later than the refusal the feature existed to remove.
//
// So the fixture is the case that was reported, and it is a specific one: the
// branch already exists, and the file somebody has edited is a file that
// *differs between the two commits*. That is exactly when git refuses — not
// when the tree is merely dirty. A fixture without that passes with or without
// the fix.
//
// Whether the carried edit then applies is a second question, and the two tests
// are the two answers: different lines carry across, and the same line cannot.

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

/** Long enough that "the same line" and "a different line" are different cases. */
function settings(top, bottom) {
  const middle = Array.from({ length: 18 }, (_, at) => `  "setting${at}": ${at},`);
  return ['{', `  "top": "${top}",`, ...middle, `  "bottom": "${bottom}"`, '}', ''].join('\n');
}

/**
 * A checkout where the branch the run wants already exists and has moved the
 * same file the person is editing. Precisely the tree git refuses to switch.
 *
 * @param editing which line is uncommitted here: the one the branch changed, or
 *   another one.
 */
async function aCheckoutGitWillRefuseToSwitch(branch, editing) {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-dirty-'));
  const git = (...args) => run('git', args, { cwd: path });
  const write = (text) => writeFile(join(path, 'config.json'), text);

  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@cawdev.test');
  await git('config', 'user.name', 'Test');
  await write(settings('main', 'main'));
  await git('add', '.');
  await git('commit', '-q', '-m', 'first');

  // The branch moved the top line. That is what makes `git checkout` refuse
  // below: the file is locally modified *and* differs between the commits.
  await git('checkout', '-q', '-b', branch);
  await write(settings('branch', 'main'));
  await git('commit', '-q', '-am', 'on the branch');
  await git('checkout', '-q', 'main');

  // And the edit somebody has open right now.
  await write(editing === 'the same line'
    ? settings('mine, and not committed', 'main')
    : settings('main', 'mine, and not committed'));
  return path;
}

/**
 * What the checkout actually looked like, for a failure message.
 *
 * This test failed once in CI with "a branch named 'r57-work' already exists"
 * from the `checkout -b` path — which the daemon only takes when
 * `git branch --list` says the branch is NOT there. Both cannot be true, and
 * neither the daemon's log nor the assertion said which repository it was
 * looking at. It could not be reproduced locally, under load, or with the
 * child-process race that first looked like the cause. So the state travels
 * with the failure now: the next occurrence answers it rather than starting
 * this again.
 */
async function stateOf(path) {
  const say = async (label, args) => {
    const shown = await run('git', args, { cwd: path })
      .then(({ stdout }) => stdout.trim() || '(nothing)')
      .catch((failure) => `FAILED: ${failure.message.split('\n')[0]}`);
    return `${label}:\n${shown}`;
  };
  return [
    `path: ${path}`,
    await say('branch --list', ['branch', '--list']),
    await say('branch --list r57-work', ['branch', '--list', 'r57-work']),
    await say('status --porcelain', ['status', '--porcelain']),
    await say('log --oneline --all', ['log', '--oneline', '--all']),
    await say('stash list', ['stash', 'list']),
  ].join('\n');
}

async function daemonWith(t, { path, name, offers = [], allowDirty = false, workspaceRequests = [] }) {
  // R270's tests need two checkouts of the one project to choose between —
  // `path` as an array is `{ workspaces: [...] }`, the pool form; a single
  // path is R47's bare-path form, unchanged for the tests already here.
  const paths = Array.isArray(path) ? path : [path];
  const platform = await fakePlatform({ offers, allowDirty, workspaceRequests });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: '/bin/echo',
    pollSeconds: 1,
    workspacePollSeconds: 1,
    projects: { board: Array.isArray(path) ? { workspaces: path } : path },
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
    await rm(socketPathFor(name), { force: true });
    await Promise.all(paths.map((each) => rm(each, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  });

  return { platform, said: () => said };
}

function codingRun(branch) {
  return { id: 'run-dirty', projectSlug: 'board', label: 'a card', branch, profile: 'CODE' };
}

test('Start anyway starts, and the branch carries the uncommitted work', async (t) => {
  const path = await aCheckoutGitWillRefuseToSwitch('r57-work', 'another line');
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-dirty-carry',
    allowDirty: true,
    offers: [codingRun('r57-work')],
  });

  const started = await platform.until(
    (transitions) => transitions.some((each) => each.state === 'RUNNING'),
  );
  const failed = platform.transitions.find((each) => each.state === 'FAILED');
  // Before R57 this is where it stopped, in git's own words: "Your local
  // changes to the following files would be overwritten by checkout".
  assert.equal(
    failed,
    undefined,
    `the run failed: ${failed?.summary}\n${said()}\n${await stateOf(path)}`,
  );
  assert.ok(started, `the run never started:\n${said()}`);

  const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path }))
    .stdout.trim();
  assert.equal(branch, 'r57-work');

  const content = await readFile(join(path, 'config.json'), 'utf8');
  // Both halves. The branch's own change is there, which is what a checkout is
  // for; and the edit came with it, which is what the flag promised. A
  // checkout that quietly dropped the second would have "succeeded".
  assert.match(content, /"top": "branch"/, `the branch's own work is missing:\n${said()}`);
  assert.match(content, /mine, and not committed/, `the uncommitted work was lost:\n${said()}`);

  // And nothing is left parked: a stash the person was never told about is the
  // same as losing it, only slower.
  const stashes = (await run('git', ['stash', 'list'], { cwd: path })).stdout.trim();
  assert.equal(stashes, '', `work was left in the stash:\n${stashes}`);
});

test('an edit on the same line cannot be carried, and the run says where it is', async (t) => {
  const path = await aCheckoutGitWillRefuseToSwitch('r57-work', 'the same line');
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-dirty-conflict',
    allowDirty: true,
    offers: [codingRun('r57-work')],
  });

  // Nothing can carry an edit onto a branch that rewrote the same line — git
  // would have to guess which one is meant, and a merge marker left in
  // somebody's uncommitted work and called success is the worse answer.
  const stopped = await platform.until(
    (transitions) => transitions.some((each) => each.state === 'FAILED'),
  );
  assert.ok(stopped, `the run did not stop:\n${said()}`);

  const failed = platform.transitions.find((each) => each.state === 'FAILED');
  // The whole of the requirement: it is not lost, and the message says the two
  // things somebody needs — that it is in the stash, and the command to get it
  // back. A run that failed *and* ate the work would be worse than R46's
  // refusal, not better.
  assert.match(failed.summary, /stash/);
  assert.match(failed.summary, /git -C .* stash pop/);

  const stashes = (await run('git', ['stash', 'list'], { cwd: path })).stdout.trim();
  assert.match(stashes, /cawdev: carried across/, 'the work was not parked anywhere');
});

test('Stash empties the checkout and says how to get it back', async (t) => {
  const path = await aCheckoutGitWillRefuseToSwitch('r57-unused', 'another line');
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-dirty-stash',
    workspaceRequests: [{ id: 'wr-1', path, kind: 'STASH', message: null }],
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never took the request:\n${said()}`);

  const [done] = platform.finishedRequests;
  assert.equal(done.id, 'wr-1');
  assert.equal(done.ok, true, done.result);
  // The handle somebody needs to undo this, said out loud rather than left for
  // them to work out.
  assert.match(done.result, /stash pop/);

  // R218. By the time it said "done", it had already told the platform the
  // tree is empty — the reading the console's row draws, not the answer.
  const reread = platform.workspaceReports.filter((each) => each.path === path).at(-1);
  assert.ok(reread, 'the daemon answered without re-reading its checkouts');
  assert.equal(reread.dirtyFiles, 0, `the last reading still says the tree is dirty: ${JSON.stringify(reread)}`);

  const dirty = (await run('git', ['status', '--porcelain'], { cwd: path })).stdout.trim();
  assert.equal(dirty, '', 'the checkout is still dirty');
});

test('Show reads the diff, and a path this machine does not serve is refused', async (t) => {
  const path = await aCheckoutGitWillRefuseToSwitch('r57-unused', 'another line');
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-dirty-show',
    workspaceRequests: [
      { id: 'wr-show', path, kind: 'SHOW', message: null },
      // The platform checked that the runner is yours. Only this process knows
      // which directories it was actually given, so a request naming another
      // one is something to say no to rather than run git in.
      { id: 'wr-elsewhere', path: '/tmp/not-served-by-this-runner', kind: 'SHOW', message: null },
    ],
  });

  const both = await platform.untilFinished((finished) => finished.length === 2);
  assert.ok(both, `the runner did not answer both:\n${said()}`);

  const shown = platform.finishedRequests.find((each) => each.id === 'wr-show');
  assert.equal(shown.ok, true, shown.result);
  assert.match(shown.result, /config\.json/);
  assert.match(shown.result, /mine, and not committed/);

  const refused = platform.finishedRequests.find((each) => each.id === 'wr-elsewhere');
  assert.equal(refused.ok, false);
  assert.match(refused.result, /does not serve/);
});

/**
 * The checkout a carried-on run left behind: on its own branch, with the
 * edits it made and never committed. The platform NAMES it (`mustUse`,
 * offered as `workspace`), because R80 held it for exactly this work.
 */
async function aCheckoutHeldForItsBranch(branch) {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-held-'));
  const git = (...args) => run('git', args, { cwd: path });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@cawdev.test');
  await git('config', 'user.name', 'Test');
  await writeFile(join(path, 'config.json'), settings('main', 'main'));
  await git('add', '.');
  await git('commit', '-q', '-m', 'first');
  await git('checkout', '-q', '-b', branch);
  await writeFile(join(path, 'config.json'), settings('main', 'the run wrote this'));
  await writeFile(join(path, 'new-file.txt'), 'the run created this\n');
  return path;
}

test('a carried-on run takes back its own uncommitted work instead of refusing it', async (t) => {
  const path = await aCheckoutHeldForItsBranch('r80-held');
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-dirty-held',
    offers: [{ ...codingRun('r80-held'), mustUse: path }],
  });

  const started = await platform.until(
    (transitions) => transitions.some((each) => each.state === 'RUNNING'),
  );
  const failed = platform.transitions.find((each) => each.state === 'FAILED');
  // Before this, Carry on failed here with "has uncommitted changes … Commit
  // or stash them first" — about work that was the run's own.
  assert.equal(failed, undefined, `the run failed: ${failed?.summary}\n${said()}`);
  assert.ok(started, `the run never started:\n${said()}`);

  assert.match(await readFile(join(path, 'config.json'), 'utf8'), /the run wrote this/);
  // Untracked, so `git clean -fd` — the reset a fresh run gets — would have
  // deleted it.
  assert.equal(await readFile(join(path, 'new-file.txt'), 'utf8'), 'the run created this\n');
});

test('a named checkout on ANOTHER branch is still refused when dirty', async (t) => {
  const path = await aCheckoutHeldForItsBranch('somebody-elses');
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-dirty-held-elsewhere',
    offers: [{ ...codingRun('r80-other'), mustUse: path }],
  });

  const stopped = await platform.until(
    (transitions) => transitions.some((each) => each.state === 'FAILED'),
  );
  assert.ok(stopped, `the run did not stop:\n${said()}`);
  const failed = platform.transitions.find((each) => each.state === 'FAILED');
  assert.match(failed.summary, /has uncommitted changes/);
});

// R270: "Queue for a clean checkout" — a run whose offer carries
// `waitForClean` is never claimed onto a dirty tree, not even the one that
// `pickWorkspace` would otherwise fall back to as "everything is dirty, take
// the first free one anyway".

/** A checkout with one commit, nothing uncommitted. */
async function aCleanCheckout() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-clean-'));
  const git = (...args) => run('git', args, { cwd: path });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@cawdev.test');
  await git('config', 'user.name', 'Test');
  await writeFile(join(path, 'README.md'), 'clean\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'first');
  return path;
}

/** The same, plus a file nobody has committed. */
async function aDirtyCheckout() {
  const path = await aCleanCheckout();
  await writeFile(join(path, 'README.md'), 'somebody is mid-edit\n');
  return path;
}

test('waitForClean leaves the run queued rather than take the one dirty checkout', async (t) => {
  const path = await aDirtyCheckout();
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-wait-for-clean-alone',
    offers: [{ ...codingRun('r270-wait'), waitForClean: true }],
  });

  const queued = await platform.untilQueued(
    (reasons) => reasons.some((reason) => reason.runId === 'run-dirty'
      && /waiting for a clean checkout/.test(reason.why)),
  );
  assert.ok(queued, `the runner never said why it is waiting:\n${said()}`);
  assert.equal(
    platform.transitions.length, 0,
    `the run was claimed when it should have kept waiting:\n${said()}`,
  );

  // Cleaning the checkout — the panel's own Stash button does this — unblocks
  // the next poll without anything else changing.
  await run('git', ['stash'], { cwd: path });

  const started = await platform.until(
    (transitions) => transitions.some((each) => each.state === 'RUNNING'),
  );
  assert.ok(started, `the run never started once the checkout was clean:\n${said()}`);
});

test('waitForClean skips a dirty preferred checkout for a clean free one', async (t) => {
  const dirty = await aDirtyCheckout();
  const clean = await aCleanCheckout();
  const { platform, said } = await daemonWith(t, {
    path: [dirty, clean],
    name: 'test-wait-for-clean-preferred',
    offers: [{ ...codingRun('r270-preferred'), waitForClean: true, prefers: dirty }],
  });

  const started = await platform.until(
    (transitions) => transitions.some((each) => each.state === 'RUNNING'),
  );
  assert.ok(started, `the run never started:\n${said()}`);
  const failed = platform.transitions.find((each) => each.state === 'FAILED');
  assert.equal(failed, undefined, `the run failed: ${failed?.summary}\n${said()}`);

  const dirtyStill = (await run('git', ['status', '--porcelain'], { cwd: dirty })).stdout.trim();
  assert.notEqual(dirtyStill, '', 'the dirty checkout was touched, and it should not have been');
  const branchInClean = (
    await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: clean })
  ).stdout.trim();
  assert.equal(branchInClean, 'r270-preferred', 'the run did not land in the clean checkout');
});

test('without waitForClean the same dirty checkout is still claimed, and still refused', async (t) => {
  const path = await aDirtyCheckout();
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-wait-for-clean-regression',
    offers: [codingRun('r270-regression')],
  });

  const stopped = await platform.until(
    (transitions) => transitions.some((each) => each.state === 'FAILED'),
  );
  assert.ok(stopped, `the run did not stop:\n${said()}`);
  const failed = platform.transitions.find((each) => each.state === 'FAILED');
  assert.match(failed.summary, /has uncommitted changes/);
});

test('the daemon says waitForClean: true about itself', async (t) => {
  const path = await aCleanCheckout();
  const { platform, said } = await daemonWith(t, { path, name: 'test-wait-for-clean-capability' });

  const registered = await new Promise((resolve) => {
    const deadline = Date.now() + 20000;
    const check = () => {
      if (platform.registrations.length) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(check, 150);
    };
    check();
  });
  assert.ok(registered, `the daemon never registered:\n${said()}`);
  const capabilities = JSON.parse(platform.registrations[0].capabilities);
  assert.equal(capabilities.waitForClean, true);
});
