// node --test tools/runner/merge-request.test.mjs
//
// R134's half of the daemon: a `MERGE` workspace request, done with `gh`.
//
// Against the real daemon rather than by calling the function, because the
// three things that can go wrong here are all outside the function — the kind
// arriving from a claim, the path guard refusing a directory this machine does
// not serve, and `gh` not being on the machine at all. A unit test of
// `mergePullRequest` proves none of them.
//
// `gh` is faked on `PATH`. It is the only way to assert the ARGUMENTS, and the
// arguments are the substance: `--squash --delete-branch` is what R134 inherited
// from `auto_merge` and deliberately did not change, and a test that only
// checked "it reported ok" would not notice the day one of them goes missing.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;
const PR = 'https://github.com/x/y/pull/7';

/** A checkout with a remote, so the no-gh fallback has something to read. */
async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-merge-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await run('git', ['remote', 'add', 'origin', 'https://github.com/x/y.git'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

/**
 * A `gh` that logs its argv and answers.
 *
 * One line per call, so the assertion is on what was asked rather than on how
 * many times something was asked.
 */
async function fakeGh(t, { mergeability = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cawdev-bin-'));
  const log = join(dir, 'calls.txt');
  const answers = join(dir, 'mergeability.txt');
  if (mergeability) {
    await writeFile(answers, mergeability.join('\n') + '\n');
  }
  await writeFile(join(dir, 'gh'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${log}`,
    // `pr view` is how the daemon finds the pull request; `pr merge` is the act.
    // R306: `pr view <url> --json mergeable,…` is the mergeability question,
    // answered from a scripted list when the test gave one — each answer
    // consumed in turn, the last one repeated — and with the bare URL (not
    // JSON, so the daemon does not wait) when it did not.
    'case "$1 $2" in',
    '  "pr view")',
    `    if [ -s ${answers} ] && [ "$5" = "mergeable,mergeStateStatus" ]; then`,
    `      answer=$(head -n 1 ${answers})`,
    `      if [ "$(wc -l < ${answers})" -gt 1 ]; then tail -n +2 ${answers} > ${answers}.next && mv ${answers}.next ${answers}; fi`,
    `      printf '{"mergeable":"%s","mergeStateStatus":"CLEAN"}\\n' "$answer"; exit 0;`,
    '    fi',
    `    printf '%s\\n' "${PR}"; exit 0 ;;`,
    '  "pr merge") exit 0 ;;',
    'esac',
    'exit 1',
    '',
  ].join('\n'));
  await chmod(join(dir, 'gh'), 0o755);
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return {
    dir,
    async calls() {
      return (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    },
  };
}

/** A PATH with git on it and no `gh` anywhere — an ordinary unconfigured machine. */
async function pathWithoutGh(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cawdev-nogh-'));
  const git = (await run('sh', ['-c', 'command -v git'])).stdout.trim();
  await symlink(git, join(dir, 'git'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(socketPathFor(name), { force: true });
    await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  return { platform, said: () => said, alive: () => daemon.exitCode === null };
}

test('a MERGE runs gh pr merge and reports the pull request on the first line', async (t) => {
  const path = await aRepository();
  const gh = await fakeGh(t);
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-merge-ok',
    workspaceRequests: [{ id: 'wr-merge', path, kind: 'MERGE', message: 'r134-work' }],
    env: { PATH: `${gh.dir}:${process.env.PATH}` },
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never took the merge:\n${said()}`);

  const [done] = platform.finishedRequests;
  assert.equal(done.id, 'wr-merge');
  assert.equal(done.ok, true, done.result);

  // The first line is the evidence. The platform reads exactly this line and
  // puts it on the card as the card's `merge`, which MERGED refuses to be
  // blank — so a sentence arriving first here would move no cards at all.
  assert.equal(done.result.split('\n')[0], PR);
  assert.match(done.result, /squashed and merged/);

  const calls = await gh.calls();
  assert.deepEqual(calls, [
    'pr view r134-work --json url --jq .url',
    // R306: the mergeability question before every merge. This fake answers
    // it with a bare URL, which is not JSON, so nothing waits and the merge
    // follows at once.
    `pr view ${PR} --json mergeable,mergeStateStatus`,
    `pr merge ${PR} --squash --delete-branch`,
  ]);

  assert.match(said(), /MERGING r134-work — asked for from the console/);
});

// R306. GitHub computes mergeability lazily, and a merge seconds after
// `gh pr create` — exactly when a rule's merge arrives — used to fail for no
// reason a person could act on. The daemon waits while the host says UNKNOWN,
// bounded, and merges once it says anything else.
test('a MERGE waits while the host says mergeability is UNKNOWN, then merges once', async (t) => {
  const path = await aRepository();
  const gh = await fakeGh(t, {
    // The first two mergeability questions answer UNKNOWN; the third MERGEABLE.
    mergeability: ['UNKNOWN', 'UNKNOWN', 'MERGEABLE'],
  });
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-merge-unknown',
    workspaceRequests: [{
      id: 'wr-rule', path, kind: 'MERGE', message: 'r306-work', requestedByRule: 'auto_merge',
    }],
    env: {
      PATH: `${gh.dir}:${process.env.PATH}`,
      // The wait is five seconds in production; the test is not that patient.
      CAWDEV_MERGEABILITY_WAIT_MS: '50',
    },
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never took the merge:\n${said()}`);

  const [done] = platform.finishedRequests;
  assert.equal(done.ok, true, done.result);
  assert.equal(done.result.split('\n')[0], PR);

  const calls = await gh.calls();
  const mergeabilityQuestions = calls.filter((each) => each.includes('--json mergeable'));
  assert.equal(mergeabilityQuestions.length, 3, calls.join('\n'));
  assert.deepEqual(calls.filter((each) => each.startsWith('pr merge')), [
    `pr merge ${PR} --squash --delete-branch`,
  ]);
  // The merge came after the last question, not between them.
  assert.equal(calls.at(-1), `pr merge ${PR} --squash --delete-branch`);

  // Whose idea it was is in the log — a rule's merge lands with nobody
  // reading the diff, and the operator's terminal is where that is seen.
  assert.match(said(), /MERGING r306-work — by auto_merge, nobody is reading this diff/);
  assert.match(said(), /mergeability known after/);
});

test('a MERGE naming a path this daemon does not serve is refused, and gh is never called', async (t) => {
  const path = await aRepository();
  const elsewhere = await mkdtemp(join(tmpdir(), 'cawdev-elsewhere-'));
  t.after(() => rm(elsewhere, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const gh = await fakeGh(t);
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-merge-elsewhere',
    workspaceRequests: [
      { id: 'wr-elsewhere', path: elsewhere, kind: 'MERGE', message: 'r134-work' },
    ],
    env: { PATH: `${gh.dir}:${process.env.PATH}` },
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never answered:\n${said()}`);

  const [done] = platform.finishedRequests;
  assert.equal(done.ok, false);
  assert.match(done.result, /does not serve/);
  // The guard that matters. The platform checked the runner is yours; only this
  // process knows which directories it was given, and merging out of one it was
  // not given is exactly the thing it must refuse rather than attempt.
  assert.deepEqual(await gh.calls(), []);
});

test('a MERGE with no branch merges nothing and says so', async (t) => {
  const path = await aRepository();
  const gh = await fakeGh(t);
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-merge-nameless',
    workspaceRequests: [{ id: 'wr-blank', path, kind: 'MERGE', message: '  ' }],
    env: { PATH: `${gh.dir}:${process.env.PATH}` },
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never answered:\n${said()}`);

  const [done] = platform.finishedRequests;
  assert.equal(done.ok, false);
  assert.match(done.result, /has to name a branch/);
  assert.deepEqual(await gh.calls(), []);
});

test('with no gh on the machine it reports failed and the daemon stays up', async (t) => {
  const path = await aRepository();
  const bare = await pathWithoutGh(t);
  const { platform, said, alive } = await daemonWith(t, {
    path,
    name: 'test-merge-no-gh',
    workspaceRequests: [{ id: 'wr-no-gh', path, kind: 'MERGE', message: 'r134-work' }],
    env: { PATH: bare },
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never answered:\n${said()}`);

  const [done] = platform.finishedRequests;
  assert.equal(done.ok, false);
  // Without `gh` there is no way to know a pull request exists, and the compare
  // URL the fallback builds is honestly not one — so this is the same sentence
  // a branch with no pull request gets, which is the right answer either way.
  assert.match(done.result, /no pull request/);

  // The whole point of this channel is that a machine answers. A daemon that
  // died on a missing binary answers nothing, for every request after it too.
  assert.ok(alive(), `the daemon exited:\n${said()}`);
});
