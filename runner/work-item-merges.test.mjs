// node --test tools/runner/work-item-merges.test.mjs
//
// R346's half of the daemon: the merge pass also asks `gh` about hand-taken
// work items, because a squash or rebase merge leaves no head on the default
// branch for R334's git reading to find. Against the real daemon with a real
// checkout and a `gh` on PATH that answers `pr list` with a fixed array.

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
const BRANCH = 'r9-by-hand';
const OPENED = '2026-01-01T00:00:00Z';
const SHA = 'a'.repeat(40);

async function aCheckout() {
  const root = await mkdtemp(join(tmpdir(), 'cawdev-wim-'));
  const path = join(root, 'checkout');
  await run('git', ['init', '-q', '-b', 'main', path]);
  await run('git', ['-C', path, 'config', 'user.email', 'test@cawdev.test']);
  await run('git', ['-C', path, 'config', 'user.name', 'Test']);
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['-C', path, 'add', '.']);
  await run('git', ['-C', path, 'commit', '-q', '-m', 'first']);
  return { root, path };
}

/** A `gh` that logs its argv and answers `pr list` with `rows`. */
async function fakeGh(t, rows) {
  const dir = await mkdtemp(join(tmpdir(), 'cawdev-bin-'));
  const log = join(dir, 'calls.txt');
  await writeFile(join(dir, 'answer.json'), JSON.stringify(rows));
  await writeFile(join(dir, 'gh'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${log}`,
    `case "$1 $2" in "pr list") cat ${join(dir, 'answer.json')}; exit 0 ;; esac`,
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

async function daemonWith(t, { workItemBranches, gh }) {
  const repo = await aCheckout();
  const platform = await fakePlatform({ workItemBranches });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const config = join(home, 'config.json');
  const name = 'test-wim';
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: '/bin/echo',
    pollSeconds: 1,
    workspacePollSeconds: 1,
    projects: { board: repo.path },
  }));
  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env({ PATH: `${gh.dir}:${process.env.PATH}` }),
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
    await rm(repo.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { platform, said: () => said, alive: () => daemon.exitCode === null };
}

const row = { workItemId: 'wi-1', projectSlug: 'board', branch: BRANCH, baseBranch: null,
  defaultBranch: 'main', openedAt: OPENED };

function pr(number, state, extra = {}) {
  return {
    number, url: `https://github.com/o/r/pull/${number}`, state,
    mergedAt: state === 'MERGED' ? '2026-02-01T00:00:00Z' : null,
    mergeCommit: state === 'MERGED' ? { oid: SHA } : null,
    baseRefName: 'main', headRefName: BRANCH, isCrossRepository: false, ...extra,
  };
}

async function untilReading(platform, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (platform.workItemMergeReadings.length) return platform.workItemMergeReadings[0];
    await new Promise((wake) => setTimeout(wake, 150));
  }
  return null;
}

test('a merged pull request is read off gh pr list --head and reported', async (t) => {
  const gh = await fakeGh(t, [pr(12, 'MERGED')]);
  const { platform, said } = await daemonWith(t, { workItemBranches: [row], gh });
  const body = await untilReading(platform);
  assert.ok(body, `no reading was posted:\n${said()}`);
  assert.deepEqual(body.readings, [{
    workItemId: 'wi-1', state: 'MERGED', prUrl: 'https://github.com/o/r/pull/12',
    mergeCommit: SHA, mergedAt: '2026-02-01T00:00:00Z', baseRefName: 'main',
  }]);
  const calls = await gh.calls();
  assert.ok(calls.some((c) => c.startsWith(`pr list --head ${BRANCH} --state all`)),
    `no pr list --head in:\n${calls.join('\n')}`);
});

test('a fork pull request is ignored beside an open one of our own', async (t) => {
  const gh = await fakeGh(t, [pr(30, 'MERGED', { isCrossRepository: true }), pr(5, 'OPEN')]);
  const { platform, said } = await daemonWith(t, { workItemBranches: [row], gh });
  const body = await untilReading(platform);
  assert.ok(body, said());
  assert.equal(body.readings[0].state, 'OPEN');
  assert.equal(body.readings[0].prUrl, 'https://github.com/o/r/pull/5');
});

test('a merge after the item opened beats a higher-numbered open pull request', async (t) => {
  const gh = await fakeGh(t, [pr(40, 'OPEN'), pr(12, 'MERGED')]);
  const { platform, said } = await daemonWith(t, { workItemBranches: [row], gh });
  const body = await untilReading(platform);
  assert.ok(body, said());
  assert.equal(body.readings[0].state, 'MERGED');
  assert.equal(body.readings[0].prUrl, 'https://github.com/o/r/pull/12');
});

test('a merge from before the item opened is reported UNKNOWN, not MERGED', async (t) => {
  const gh = await fakeGh(t, [pr(3, 'MERGED', { mergedAt: '2025-01-01T00:00:00Z' })]);
  const { platform, said } = await daemonWith(t, { workItemBranches: [row], gh });
  const body = await untilReading(platform);
  assert.ok(body, said());
  assert.equal(body.readings[0].state, 'UNKNOWN');
});

test('the item pass runs with no pending runs at all', async (t) => {
  const gh = await fakeGh(t, [pr(12, 'MERGED')]);
  // fakePlatform answers `{}` to /branches: no run is pending.
  const { platform, said } = await daemonWith(t, { workItemBranches: [row], gh });
  assert.ok(await untilReading(platform), said());
});

test('a platform without the endpoint posts nothing and the daemon keeps polling', async (t) => {
  const gh = await fakeGh(t, [pr(12, 'MERGED')]);
  const { platform, alive } = await daemonWith(t, { workItemBranches: null, gh });
  await new Promise((wake) => setTimeout(wake, 3000));
  assert.deepEqual(platform.workItemMergeReadings, []);
  assert.ok(alive());
});
