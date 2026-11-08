import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpuSecondsOf, groupsFromPs, scopeOf, cpuSecondsOfCpuStat, RunTracker, sample,
} from './run-resources.mjs';

test('cpu time reads both ps spellings', () => {
  assert.equal(cpuSecondsOf('2:36.51'), 156.51);      // macOS
  assert.equal(cpuSecondsOf('00:02:05'), 125);        // procps
  assert.equal(cpuSecondsOf('1-01:00:00'), 90_000);   // procps, a day in
  assert.equal(cpuSecondsOf(' 0:00.01 '), 0.01);
  assert.equal(cpuSecondsOf('abc'), null);
  assert.equal(cpuSecondsOf('1:2:3:4'), null);
  assert.equal(cpuSecondsOf(''), null);
});

test('ps output is summed per group asked about, nothing else', () => {
  const output = [
    '  100  2048   0:10.00',
    '  100  1024   0:05.50',
    '  200  4096   1:00.00',
    '  300  junk   0:01.00',
    'not a line',
  ].join('\n');
  const groups = groupsFromPs(output, [100, 300, 400]);
  assert.deepEqual([...groups.keys()], [100]);
  assert.deepEqual(groups.get(100), { cpuSeconds: 15.5, rssBytes: 3072 * 1024, processes: 2 });
});

test('only a transient systemd scope is the run\'s cgroup', () => {
  assert.equal(
    scopeOf('0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1a2b.scope\n'),
    '/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1a2b.scope',
  );
  assert.equal(scopeOf('0::/user.slice/user-1000.slice/session-3.scope'), null);
  assert.equal(scopeOf('0::/system.slice/cawdev.service'), null);
  assert.equal(scopeOf(null), null);
});

test('cpu.stat usage is read in seconds', () => {
  assert.equal(cpuSecondsOfCpuStat('usage_usec 2500000\nuser_usec 2000000\n'), 2.5);
  assert.equal(cpuSecondsOfCpuStat('nothing'), null);
});

test('the tracker adds CPU across stages and keeps the peak', () => {
  const tracker = new RunTracker();
  const at = new Date('2026-11-08T10:00:00Z');
  tracker.observe(10, { cpuSeconds: 4, rssBytes: 500, processes: 3, source: 'ps' }, at);
  // A child exits: ps reads lower, the total holds.
  let sent = tracker.observe(10, { cpuSeconds: 3, rssBytes: 200, processes: 2, source: 'ps' }, at);
  assert.equal(sent.cpuSeconds, 4);
  assert.equal(sent.rssBytes, 200);
  assert.equal(sent.peakRssBytes, 500);
  // The next stage is a new group, starting from zero.
  sent = tracker.observe(20, { cpuSeconds: 1.25, rssBytes: 300, processes: 1, source: 'ps' }, at);
  assert.equal(sent.cpuSeconds, 5.3);
  assert.equal(sent.peakRssBytes, 500);
  assert.equal(sent.processes, 1);
  assert.equal(sent.sampledAt, '2026-11-08T10:00:00.000Z');
  // A cgroup's own peak counts even when no sample saw it.
  sent = tracker.observe(20, { cpuSeconds: 2, rssBytes: 300, peakRssBytes: 900, processes: 1, source: 'cgroup' }, at);
  assert.equal(sent.peakRssBytes, 900);
});

test('sample reads this process\'s own group', async () => {
  const readings = await sample([process.pid, 999_999_999], { platform: 'darwin' });
  // The test runner is not necessarily a group leader; when it is, the reading is sane.
  for (const reading of readings.values()) {
    assert.equal(reading.source, 'ps');
    assert.ok(reading.processes >= 1);
    assert.ok(reading.rssBytes > 0);
  }
  assert.equal(readings.has(999_999_999), false);
  assert.equal((await sample([])).size, 0);
});
