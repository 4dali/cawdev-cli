// node --test tools/runner/sprint-branch.test.mjs
//
// R260's half of the daemon: a claim that carries `baseBranch` — the branch of
// the sprint the card is in — is cut from it, opens its pull request against
// it, and a `CUT_BRANCH` workspace request puts a sprint's branch on origin.
//
// The regression half matters as much as the feature half: a claim with NO
// `baseBranch` has to produce byte for byte the git and `gh` argv it produced
// before, because that is every project that never opens a sprint.
//
// Against the real daemon with a REAL bare origin on disk, so `push` and
// `ls-remote` work offline and the assertions are on refs rather than on log
// lines. `gh` is faked on PATH, as merge-request.test.mjs fakes it, because
// the argv is the substance.

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
const PR = 'https://github.com/x/y/pull/7';

async function git(cwd, args) {
  return (await run('git', args, { cwd })).stdout.trim();
}

/**
 * A bare origin with `main` and `s1-notifications` on it — s1 one commit
 * ahead — and a checkout cloned from it. Everything the daemon does to the
 * remote lands in the bare repository, where a test can read it back.
 */
async function aRepositoryWithASprintBranch() {
  const root = await mkdtemp(join(tmpdir(), 'cawdev-sprint-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  await run('git', ['init', '-q', '--bare', origin]);
  await run('git', ['init', '-q', '-b', 'main', seed]);
  await git(seed, ['config', 'user.email', 'test@cawdev.test']);
  await git(seed, ['config', 'user.name', 'Test']);
  await writeFile(join(seed, 'README.md'), '# a project\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-q', '-m', 'first']);
  await git(seed, ['checkout', '-q', '-b', 's1-notifications']);
  await writeFile(join(seed, 'SPRINT.md'), '# S1\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-q', '-m', 'sprint branch']);
  await git(seed, ['push', '-q', origin, 'main', 's1-notifications']);

  const path = join(root, 'checkout');
  await run('git', ['clone', '-q', origin, path]);
  await git(path, ['config', 'user.email', 'test@cawdev.test']);
  await git(path, ['config', 'user.name', 'Test']);
  return {
    root,
    origin,
    path,
    mainTip: await git(seed, ['rev-parse', 'main']),
    s1Tip: await git(seed, ['rev-parse', 's1-notifications']),
  };
}

/**
 * A `gh` that logs its argv: no pull request exists, and creating one answers
 * a URL. One line per call — the body's own newlines are folded to `⏎` so a
 * multi-line `--body` cannot read as three calls.
 */
async function fakeGh(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cawdev-bin-'));
  const log = join(dir, 'calls.txt');
  await writeFile(join(dir, 'gh'), [
    '#!/bin/sh',
    `printf '%s' "$*" | tr '\\n' ' ' >> ${log}; printf '\\n' >> ${log}`,
    'case "$1 $2" in',
    '  "pr view") exit 1 ;;',
    `  "pr create") printf '%s\\n' "${PR}"; exit 0 ;;`,
    'esac',
    'exit 1',
    '',
  ].join('\n'));
  await chmod(join(dir, 'gh'), 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    dir,
    async calls() {
      return (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    },
  };
}

async function daemonWith(t, { repo, name, offers = [], workspaceRequests = [], actions = [], env = {} }) {
  const platform = await fakePlatform({ offers, workspaceRequests, actions });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: '/bin/echo',
    pollSeconds: 1,
    workspacePollSeconds: 1,
    projects: { board: repo.path },
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
    await rm(repo.root, { recursive: true, force: true });
  });

  return { platform, said: () => said, alive: () => daemon.exitCode === null };
}

function codingRun(id, branch, baseBranch = null) {
  return {
    id, projectSlug: 'board', label: 'a card', branch, profile: 'CODE',
    ...(baseBranch ? { baseBranch } : {}),
  };
}

/** Every `gh` call that is not the create is the lookup for this branch — at least one. */
function assertOnlyLookups(calls, branch) {
  const lookups = calls.filter((each) => !each.startsWith('pr create'));
  assert.ok(lookups.length >= 1, `no gh pr view in:\n${calls.join('\n')}`);
  assert.deepEqual([...new Set(lookups)], [`pr view ${branch} --json url --jq .url`]);
}

const openPr = { id: 'act-pr', kind: 'OPEN_PR', message: 'A card', requestedByRule: 'auto_pr' };

test('a claim with baseBranch is cut from origin/<base>, and the PR is opened --base <base>', async (t) => {
  const repo = await aRepositoryWithASprintBranch();
  const gh = await fakeGh(t);
  const { platform, said } = await daemonWith(t, {
    repo,
    name: 'test-sprint-based',
    offers: [codingRun('run-based', 'r40-in-s1', 's1-notifications')],
    actions: [openPr],
    env: { PATH: `${gh.dir}:${process.env.PATH}` },
  });

  const opened = await platform.untilActionFinished((done) => done.length === 1);
  assert.ok(opened, `the pull request was never opened:\n${said()}`);

  // Cut from the sprint's branch: HEAD is the run's branch and its commit is
  // s1's tip, not main's. The whole card in two refs.
  assert.equal(await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'r40-in-s1');
  assert.equal(await git(repo.path, ['rev-parse', 'HEAD']), repo.s1Tip);
  assert.notEqual(repo.s1Tip, repo.mainTip);
  assert.match(said(), /cut from s1-notifications \(the sprint's branch\)/);

  const [done] = platform.finishedActions;
  assert.equal(done.ok, true, done.result);
  assert.equal(done.result, PR);
  const calls = await gh.calls();
  const create = calls.find((each) => each.startsWith('pr create'));
  assert.ok(create, `no gh pr create in:\n${calls.join('\n')}`);
  assert.match(create, /^pr create --head r40-in-s1 --base s1-notifications --title /);
  assert.match(create, /Its base is `s1-notifications`, the branch of its sprint\./);
  // Nothing but lookups beside the create: the one before it, and the one
  // `reportCommits` makes when the run ends after the push — which is a race
  // between the session's action poll and its closing actions, so the count
  // is one or two and the assertion is on what they are, not how many.
  assertOnlyLookups(calls, 'r40-in-s1');
});

test('a claim with no baseBranch is cut from origin/main and opens the PR with no --base — as before', async (t) => {
  const repo = await aRepositoryWithASprintBranch();
  const gh = await fakeGh(t);
  const { platform, said } = await daemonWith(t, {
    repo,
    name: 'test-sprint-unbased',
    offers: [codingRun('run-plain', 'r41-plain')],
    actions: [openPr],
    env: { PATH: `${gh.dir}:${process.env.PATH}` },
  });

  const opened = await platform.untilActionFinished((done) => done.length === 1);
  assert.ok(opened, `the pull request was never opened:\n${said()}`);

  assert.equal(await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'r41-plain');
  assert.equal(await git(repo.path, ['rev-parse', 'HEAD']), repo.mainTip);
  assert.doesNotMatch(said(), /cut from/);

  // The regression half: the argv is exactly what it was before R260 — no
  // `--base`, and the title straight after the head.
  const calls = await gh.calls();
  const create = calls.find((each) => each.startsWith('pr create'));
  assert.ok(create, `no gh pr create in:\n${calls.join('\n')}`);
  assert.doesNotMatch(create, /--base/);
  assert.doesNotMatch(create, /Its base is/);
  assert.equal(
    create,
    "pr create --head r41-plain --title A card --body Opened by cawdev's `auto_pr` rule for "
      + '**a card**.  Nobody clicked anything: this project\'s rules say a finished run opens a '
      + "pull request. The session's transcript, commits and reports are on the run in the "
      + 'cawdev console.',
  );
  assertOnlyLookups(calls, 'r41-plain');
});

test('a baseBranch that is not on origin fails the run and cuts nothing under that name', async (t) => {
  const repo = await aRepositoryWithASprintBranch();
  const { platform, said } = await daemonWith(t, {
    repo,
    name: 'test-sprint-missing-base',
    offers: [codingRun('run-missing', 'r42-in-s3', 's3-nowhere')],
  });

  const failed = await platform.until(
    (transitions) => transitions.some((each) => each.state === 'FAILED'),
  );
  assert.ok(failed, `the run never failed:\n${said()}`);
  const transition = platform.transitions.find((each) => each.state === 'FAILED');
  assert.match(transition.summary ?? '', /s3-nowhere is not on origin, so r42-in-s3 cannot be cut from it/);
  assert.match(transition.summary ?? '', /has to be cut before its cards are started/);
  // Not silently put on main's tip under the sprint-branch name — the local
  // fallback is for the default and for no-remote experiments only.
  assert.equal(await git(repo.path, ['branch', '--list', 'r42-in-s3']), '');
  assert.doesNotMatch(said(), /\bRUNNING\b/);
});

test('a CUT_BRANCH pushes origin/main to the new name; again is "already on origin"', async (t) => {
  const repo = await aRepositoryWithASprintBranch();
  const { platform, said } = await daemonWith(t, {
    repo,
    name: 'test-sprint-cut',
    workspaceRequests: [
      { id: 'wr-cut', path: repo.path, kind: 'CUT_BRANCH', message: 's2-mail', defaultBranch: 'main' },
      { id: 'wr-cut-again', path: repo.path, kind: 'CUT_BRANCH', message: 's2-mail', defaultBranch: 'main' },
      { id: 'wr-cut-blank', path: repo.path, kind: 'CUT_BRANCH', message: '  ', defaultBranch: 'main' },
      { id: 'wr-old-kind', path: repo.path, kind: 'REBASE_ONTO', message: 's2-mail' },
    ],
  });

  const came = await platform.untilFinished((finished) => finished.length === 4);
  assert.ok(came, `the runner never answered all four:\n${said()}`);
  const byId = Object.fromEntries(platform.finishedRequests.map((each) => [each.id, each]));

  assert.equal(byId['wr-cut'].ok, true, byId['wr-cut'].result);
  // The sha on the first line, the way TAG and MERGE report theirs.
  assert.equal(byId['wr-cut'].result.split('\n')[0], repo.mainTip);
  assert.match(byId['wr-cut'].result, /s2-mail cut from origin\/main at/);
  // On the REMOTE, at main's tip — not s1's, and not a local branch nobody pushed.
  const onOrigin = await git(repo.origin, ['rev-parse', 'refs/heads/s2-mail']);
  assert.equal(onOrigin, repo.mainTip);
  assert.equal(await git(repo.path, ['branch', '--list', 's2-mail']), '');
  // The checkout did not move.
  assert.equal(await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');

  assert.equal(byId['wr-cut-again'].ok, true, byId['wr-cut-again'].result);
  assert.match(byId['wr-cut-again'].result, /s2-mail is already on origin at/);

  assert.equal(byId['wr-cut-blank'].ok, false);
  assert.match(byId['wr-cut-blank'].result, /has to name a branch/);

  assert.equal(byId['wr-old-kind'].ok, false);
  assert.match(byId['wr-old-kind'].result, /does not know how to REBASE_ONTO/);
});

test('the daemon says baseBranches: true about itself', async (t) => {
  const repo = await aRepositoryWithASprintBranch();
  const { platform, said } = await daemonWith(t, { repo, name: 'test-sprint-capabilities' });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !platform.registrations.length) {
    await new Promise((wake) => setTimeout(wake, 150));
  }
  assert.ok(platform.registrations.length, `the daemon never registered:\n${said()}`);
  const capabilities = JSON.parse(platform.registrations[0].capabilities);
  // The whole of how the platform tells an old daemon from a new one.
  assert.equal(capabilities.baseBranches, true);
  assert.deepEqual(capabilities.projects, ['board']);
});
