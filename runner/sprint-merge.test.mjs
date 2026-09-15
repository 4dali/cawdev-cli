// node --test tools/runner/sprint-merge.test.mjs
//
// R261's half of the daemon: landing a sprint's branch on the default.
//
// Two workspace requests. `OPEN_PR` opens — or finds — the pull request from
// the sprint's branch to the default and reports its URL on the first line,
// which is what the platform reads before it queues the second half. `MERGE`
// with `mergeMethod: 'MERGE_COMMIT'` lands it with `--merge` rather than
// `--squash`, so nine card squashes stay nine commits on the default, and the
// second line says which happened.
//
// The regression half matters as much as the feature half: a `MERGE` with no
// `mergeMethod` has to produce byte for byte the `gh` argv it produced before,
// because that is every project that never opens a sprint — and every card's
// branch in a project that does.
//
// `gh` is faked on PATH, as merge-request.test.mjs fakes it, because the argv
// is the substance.

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

/** A checkout with a remote, so the lookups have something to read. */
async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-sprint-merge-'));
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
 * A `gh` that logs its argv. `pr view` answers a URL when `existing` is true
 * and fails otherwise; `pr create` answers a URL; `pr merge` succeeds. One
 * line per call, the body's newlines folded, so a multi-line `--body` cannot
 * read as three calls.
 */
async function fakeGh(t, { existing }) {
  const dir = await mkdtemp(join(tmpdir(), 'cawdev-bin-'));
  const log = join(dir, 'calls.txt');
  await writeFile(join(dir, 'gh'), [
    '#!/bin/sh',
    `printf '%s' "$*" | tr '\\n' ' ' >> ${log}; printf '\\n' >> ${log}`,
    'case "$1 $2" in',
    existing ? `  "pr view") printf '%s\\n' "${PR}"; exit 0 ;;` : '  "pr view") exit 1 ;;',
    `  "pr create") printf '%s\\n' "${PR}"; exit 0 ;;`,
    '  "pr merge") exit 0 ;;',
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

  return { platform, said: () => said };
}

test('a MERGE with mergeMethod MERGE_COMMIT runs gh pr merge --merge, and the second line says so', async (t) => {
  const path = await aRepository();
  const gh = await fakeGh(t, { existing: true });
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-sprint-merge-commit',
    workspaceRequests: [{
      id: 'wr-sprint-merge', path, kind: 'MERGE', message: 's1-notifications',
      defaultBranch: 'main', mergeMethod: 'MERGE_COMMIT',
    }],
    env: { PATH: `${gh.dir}:${process.env.PATH}` },
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never took the merge:\n${said()}`);

  const [done] = platform.finishedRequests;
  assert.equal(done.ok, true, done.result);
  // The URL first, as for every merge — the platform reads that line as the
  // evidence, and for a sprint item it is what `landed_in` records.
  assert.equal(done.result.split('\n')[0], PR);
  // The second line is quoted on every card of the sprint. It has to say
  // MERGE COMMIT, because a daemon that squashed would say the other thing.
  assert.match(done.result.split('\n')[1], /^merged with a merge commit/);
  assert.doesNotMatch(done.result, /squashed/);

  assert.deepEqual(await gh.calls(), [
    'pr view s1-notifications --json url --jq .url',
    `pr merge ${PR} --merge --delete-branch`,
  ]);
});

test('a MERGE with no mergeMethod still squashes — the regression test for every project with no sprint', async (t) => {
  const path = await aRepository();
  const gh = await fakeGh(t, { existing: true });
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-sprint-merge-squash',
    workspaceRequests: [
      { id: 'wr-plain', path, kind: 'MERGE', message: 'r134-work', defaultBranch: 'main' },
      // R260's shape: a card's branch merging INTO a sprint branch carries the
      // base and no method, and squashes exactly as it did.
      { id: 'wr-based', path, kind: 'MERGE', message: 'r1-in-s1', defaultBranch: 'main', baseBranch: 's1-notifications' },
    ],
    env: { PATH: `${gh.dir}:${process.env.PATH}` },
  });

  const came = await platform.untilFinished((finished) => finished.length === 2);
  assert.ok(came, `the runner never took both merges:\n${said()}`);

  for (const done of platform.finishedRequests) {
    assert.equal(done.ok, true, done.result);
    assert.equal(done.result.split('\n')[0], PR);
    assert.match(done.result, /squashed and merged/);
  }
  const calls = await gh.calls();
  assert.deepEqual(calls.filter((each) => each.startsWith('pr merge')), [
    `pr merge ${PR} --squash --delete-branch`,
    `pr merge ${PR} --squash --delete-branch`,
  ]);
});

test('an OPEN_PR runs gh pr create --head <branch> --base <default> --title <title> and reports the URL first', async (t) => {
  const path = await aRepository();
  const gh = await fakeGh(t, { existing: false });
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-sprint-open-pr',
    workspaceRequests: [{
      id: 'wr-open', path, kind: 'OPEN_PR', message: 's1-notifications',
      defaultBranch: 'main', title: 'S1 Notifications',
    }],
    env: { PATH: `${gh.dir}:${process.env.PATH}` },
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never took the OPEN_PR:\n${said()}`);

  const [done] = platform.finishedRequests;
  assert.equal(done.id, 'wr-open');
  assert.equal(done.ok, true, done.result);
  // The URL is the first line — the platform reads exactly this line before
  // it queues the MERGE, and a sentence arriving first would queue nothing.
  assert.equal(done.result.split('\n')[0], PR);

  const calls = await gh.calls();
  assert.equal(calls[0], 'pr view s1-notifications --json url --jq .url');
  const create = calls.find((each) => each.startsWith('pr create'));
  assert.ok(create, `no gh pr create in:\n${calls.join('\n')}`);
  assert.match(create, /^pr create --head s1-notifications --base main --title S1 Notifications --body /);
  assert.match(create, /Opened by cawdev for the sprint branch `s1-notifications` — S1 Notifications\./);
  assert.match(create, /Merging it lands every card of the sprint on main\./);
  // Nothing was pushed: the branch is on origin already, and this clone has
  // no such branch to push in any case.
  assert.match(said(), /OPENING a pull request for s1-notifications → main/);
});

test('an OPEN_PR for a branch that already has a pull request reports it ok, and creates nothing', async (t) => {
  const path = await aRepository();
  const gh = await fakeGh(t, { existing: true });
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-sprint-open-pr-existing',
    workspaceRequests: [
      { id: 'wr-open-again', path, kind: 'OPEN_PR', message: 's1-notifications', defaultBranch: 'main', title: 'S1 Notifications' },
      { id: 'wr-open-blank', path, kind: 'OPEN_PR', message: '  ', defaultBranch: 'main' },
    ],
    env: { PATH: `${gh.dir}:${process.env.PATH}` },
  });

  const came = await platform.untilFinished((finished) => finished.length === 2);
  assert.ok(came, `the runner never answered both:\n${said()}`);
  const byId = Object.fromEntries(platform.finishedRequests.map((each) => [each.id, each]));

  // The platform asks this every time, because it cannot know: an existing
  // pull request is the ordinary second press, and it is a success.
  assert.equal(byId['wr-open-again'].ok, true, byId['wr-open-again'].result);
  assert.equal(byId['wr-open-again'].result.split('\n')[0], PR);

  assert.equal(byId['wr-open-blank'].ok, false);
  assert.match(byId['wr-open-blank'].result, /has to name a branch/);

  assert.deepEqual(await gh.calls(), ['pr view s1-notifications --json url --jq .url']);
});
