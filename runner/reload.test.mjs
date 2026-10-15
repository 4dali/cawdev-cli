// node --test tools/runner/reload.test.mjs
//
// `/reload`: quit and start again on the code on disk. The relaunch, the
// daemon's signal and "is it gone yet" are injected, so what is checked is
// the decision — the daemon goes only when nothing is running on it.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Attached } from './attach.mjs';

process.env.CAWDEV_HISTORY_FILE = join(mkdtempSync(join(tmpdir(), 'cawdev-history-')), 'h.json');

function client({ runs = [], pid = 4242, onQuit = null } = {}) {
  const relaunched = [];
  const signalled = [];
  let gone = false;
  const ui = new Attached('/tmp/none.sock', {
    url: 'http://localhost:8091', email: null, signedIn: false, request: async () => null, signOut: async () => {},
  }, {
    out: { write() {}, columns: 80, rows: 24, isTTY: false },
    relaunch: (argv, env) => relaunched.push({ argv, env }),
    stopDaemon: (each) => {
      signalled.push(each);
      gone = true;
    },
    alive: () => !gone,
    ...(onQuit ? { onQuit } : {}),
  });
  ui.runner = { name: 'laptop', pid };
  ui.runs = runs;
  return { ui, relaunched, signalled };
}

test('with nothing running, /reload stops the runner and starts again with the same arguments', async () => {
  const { ui, relaunched, signalled } = client();
  const before = process.argv;
  process.argv = [before[0], '/x/cawdev.mjs', '--config', '/x/c.json', '--setup'];
  try {
    await ui.runCommand('/reload');
  } finally {
    process.argv = before;
  }
  assert.deepEqual(signalled, [4242], 'the daemon goes, so the relaunch runs the new code too');
  assert.deepEqual(relaunched.map((each) => each.argv), [['/x/cawdev.mjs', '--config', '/x/c.json']],
    '--setup is not walked again');
  assert.equal(ui.stopped, true);
});

test('with a session live, the runner is kept and only the terminal is reloaded', async () => {
  const { ui, relaunched, signalled } = client({ runs: [{ id: 'r1', state: 'running' }] });
  await ui.runCommand('/reload');
  assert.deepEqual(signalled, [], 'restarting the runner would end the session');
  assert.equal(relaunched.length, 1);
});

test('under --attach the runner is this process, and /reload says so rather than half-doing it', async () => {
  const { ui, relaunched } = client({ onQuit: () => {} });
  await ui.runCommand('/reload');
  assert.deepEqual(relaunched, []);
  assert.match(ui.status, /runner is this process/);
});

test('/reload hands the state over, and a new terminal puts it back — advanced mode included', async () => {
  const { ui, relaunched } = client({ runs: [{ id: 'live-1', projectSlug: 'saasng', label: 'Live', state: 'running' }] });
  ui.trackSessions();
  // A plan that ended, one window closed, and advanced mode with the focus on the plan.
  ui.sessions.set('plan-1', { id: 'plan-1', projectSlug: 'saasng', label: 'Offline', profile: 'PLAN', ended: true });
  ui.sessions.set('gone-1', { id: 'gone-1', projectSlug: 'saasng', label: 'Old', profile: 'ASK', ended: true });
  ui.closed.add('gone-1');
  ui.split = { focus: 'plan-1', screen: { release() {} } };
  ui.watching = 'live-1';

  await ui.runCommand('/reload');
  const state = JSON.parse(relaunched[0].env.CAWDEV_RELOAD_STATE);
  assert.equal(state.advanced, true);
  assert.equal(state.focus, 'plan-1');
  assert.equal(state.watching, 'live-1');
  assert.deepEqual(state.closed, ['gone-1']);
  assert.deepEqual(state.ended.map((each) => each.id), ['plan-1'], 'a closed window stays closed');

  // The relaunched process.
  const next = new Attached('/tmp/none.sock', {
    url: 'http://localhost:8091', email: null, signedIn: false, request: async () => null, signOut: async () => {},
  }, { out: { write() {}, columns: 100, rows: 30, isTTY: true } });
  next.restore(state);
  assert.ok(next.split, 'back in advanced mode');
  assert.equal(next.split.focus, 'plan-1');
  assert.equal(next.watching, 'live-1');
  assert.deepEqual(next.windows().map((meta) => meta.id), ['plan-1'], 'the ended plan keeps its window');
  next.split.screen.release();
});

test('a reload into a terminal that cannot be drawn on restores everything but advanced mode', () => {
  const next = new Attached('/tmp/none.sock', {
    url: 'x', email: null, signedIn: false, request: async () => null, signOut: async () => {},
  }, { out: { write() {}, columns: 80, rows: 24, isTTY: false } });
  next.restore({ advanced: true, watching: 'r1', showLog: true, closed: [], ended: [] });
  assert.equal(next.split, null);
  assert.equal(next.watching, 'r1');
  assert.equal(next.showLog, true);
});
