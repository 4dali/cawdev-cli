// node --test tools/runner/restart.test.mjs
//
// R339: the note a daemon leaves about what it is driving, what the next one
// makes of it, and the memory ceiling's command line.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  drivingPath, killedByRestart, leftBehind, memoryMaxOf, probeScope, readDriving, restartSummary,
  scoped, snapshotOf, writeDriving,
} from './restart.mjs';

test('the note names each run, its project, its child and the child\'s command', () => {
  const running = new Map([
    ['run-1', { pid: 4242, cawdevProjectSlug: 'cawdev', cawdevCommand: '/usr/bin/claude' }],
    ['run-2', { cawdevProjectSlug: 'saasng' }],
  ]);
  assert.deepEqual(snapshotOf(100, running), {
    pid: 100,
    runs: [
      { id: 'run-1', projectSlug: 'cawdev', childPid: 4242, command: 'claude' },
      { id: 'run-2', projectSlug: 'saasng', childPid: null, command: null },
    ],
  });
});

test('written and read back, and a missing or broken note is nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cawdev-driving-'));
  try {
    assert.equal(drivingPath('r1', { CAWDEV_RUN_DIR: join(dir, 'run') }), join(dir, 'run-driving', 'r1.json'),
      'beside the run directory, which holds sockets and nothing else');
    const path = drivingPath('r1', { CAWDEV_DRIVING_DIR: dir });
    assert.equal(path, join(dir, 'r1.json'));
    assert.equal(await readDriving(path), null);
    await writeDriving(path, { pid: 7, runs: [{ id: 'a', projectSlug: 'p' }] });
    assert.deepEqual(await readDriving(path), { pid: 7, runs: [{ id: 'a', projectSlug: 'p' }] });
    await writeDriving(path, { pid: 7, runs: [] });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).runs.length, 0);
    assert.equal(await readDriving(join(dir, 'nope.json')), null);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('only a DEAD previous daemon left anything behind', () => {
  const note = { pid: 50, runs: [{ id: 'a', projectSlug: 'p' }, { id: 'b' }] };
  assert.deepEqual(leftBehind(note, 60, () => false), [{ id: 'a', projectSlug: 'p' }],
    'a run with no project cannot be addressed, so it is dropped');
  assert.deepEqual(leftBehind(note, 60, () => true), [],
    'its writer is alive: a second daemon on this runner id, and its runs are its own');
  assert.deepEqual(leftBehind(note, 50, () => false), [], 'my own note is not a restart');
  assert.deepEqual(leftBehind(null, 60, () => false), []);
});

test('a restart killed a run that was live, holding a process, and still this runner\'s', () => {
  assert.equal(killedByRestart({ live: true, state: 'RUNNING', runnerId: 'me' }, 'me'), true);
  assert.equal(killedByRestart({ live: true, state: 'WAITING_ON_USER', runnerId: 'me' }, 'me'), true,
    'a session waiting on a person died too — answering it would reach nothing');
  assert.equal(killedByRestart({ live: true, state: 'UNREACHABLE' }, 'me'), true);
  assert.equal(killedByRestart({ live: false, state: 'FINISHED', runnerId: 'me' }, 'me'), false);
  assert.equal(killedByRestart({ live: true, state: 'PAUSED', runnerId: 'me' }, 'me'), false);
  assert.equal(killedByRestart({ live: true, state: 'QUEUED' }, 'me'), false);
  assert.equal(killedByRestart({ live: true, state: 'RUNNING', runnerId: 'other' }, 'me'), false,
    'carried on elsewhere in the meantime');
});

test('the summary names the cause, the evidence and the way out', () => {
  const said = restartSummary({ name: 'dali-vm', previousPid: 10, pid: 20, orphanStopped: true });
  assert.match(said, /daemon on dali-vm restarted/);
  assert.match(said, /pid 10.*pid 20/);
  assert.match(said, /journalctl/);
  assert.match(said, /sessionMemoryMax/);
  assert.match(said, /has been stopped/);
  assert.doesNotMatch(restartSummary({ name: 'x', previousPid: 1, pid: 2 }), /has been stopped/);
  const asked = restartSummary({ name: 'x', previousPid: 1, pid: 2, stopped: 'SIGTERM' });
  assert.match(asked, /It was stopped \(SIGTERM\)/);
  assert.doesNotMatch(asked, /memory/, 'a stop somebody asked for is not blamed on memory');
});

test('sessionMemoryMax is what systemd reads, or nothing', () => {
  assert.equal(memoryMaxOf('6g'), '6G');
  assert.equal(memoryMaxOf('512M'), '512M');
  assert.equal(memoryMaxOf('75%'), '75%');
  assert.equal(memoryMaxOf(4096), '4096');
  assert.equal(memoryMaxOf('lots'), null);
  assert.equal(memoryMaxOf(undefined), null);
});

test('the scope wraps the command in place, and no ceiling changes nothing', () => {
  assert.deepEqual(scoped('claude', ['-p'], null), { command: 'claude', args: ['-p'] });
  const wrapped = scoped('claude', ['-p', '--verbose'], { manager: 'user', memoryMax: '6G' });
  assert.equal(wrapped.command, 'systemd-run');
  assert.deepEqual(wrapped.args.slice(-4), ['--', 'claude', '-p', '--verbose']);
  assert.ok(wrapped.args.includes('--user') && wrapped.args.includes('MemoryMax=6G'));
});

test('the probe says why when the ceiling cannot apply here', async () => {
  assert.deepEqual(await probeScope(null), { scope: null, why: null });
  assert.match((await probeScope('6G', { platform: 'darwin' })).why, /needs Linux/);
  const tried = [];
  const userless = await probeScope('6G', {
    platform: 'linux',
    run: async (command, args) => { tried.push(args[0]); return args[0] === '--system' ? 0 : 1; },
  });
  assert.deepEqual(tried, ['--user', '--system']);
  assert.deepEqual(userless.scope, { manager: 'system', memoryMax: '6G' });
  const none = await probeScope('6G', { platform: 'linux', run: async () => 1 });
  assert.equal(none.scope, null);
  assert.match(none.why, /enable-linger/);
});
