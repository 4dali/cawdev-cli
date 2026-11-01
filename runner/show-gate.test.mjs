// node --test tools/runner/show-gate.test.mjs
//
// R605 — a run stopped at SHOW is something to look at, not a permission: the
// window says so, `a` opens one picker, the screenshots open from a cache the
// terminal alone writes, and the decision is Accept or comments. A stub session
// stands in for the platform; `openFiles` and `openUrl` stand in for the OS.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stripAnsi } from '../lib/ansi.mjs';
import { Attached } from './attach.mjs';
import { WRITE_MY_OWN } from './select.mjs';
import { showWaitingLine } from './split.mjs';

process.env.CAWDEV_HISTORY_FILE = join(mkdtempSync(join(tmpdir(), 'cawdev-history-')), 'h.json');
process.env.CAWDEV_PREFS_FILE = join(mkdtempSync(join(tmpdir(), 'cawdev-prefs-')), 'p.json');
process.env.CAWDEV_SHOTS_DIR = mkdtempSync(join(tmpdir(), 'cawdev-shots-'));

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytesOf = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, n, n, n]);
const RUN = { id: 'r', projectSlug: 'p', label: 'R12 Payments', profile: 'CODE', state: 'running' };

const shot = (n, extra = {}) => ({
  id: `shot-${n}`, round: 2, name: `s${n}.png`, contentType: 'image/png', size: 7,
  sha256: sha(bytesOf(n)), caption: `caption ${n}`, ...extra,
});

/**
 * An Attached at a SHOW gate of round 2 naming `shots`. Every request is
 * recorded; `bytesCalls` counts the downloads.
 */
function atShow({ shots = [shot(1), shot(2), shot(3)], gateIds = shots.map((each) => each.id), extra = {} } = {}) {
  const calls = [];
  const bytesCalls = [];
  const opened = { files: [], urls: [] };
  const writes = [];
  const out = { write: (text) => writes.push(text), columns: 100, rows: 30, isTTY: true };
  const earlier = [
    { id: 'old', toolName: 'stage:SHOW', state: 'DENIED', decidedByEmail: 'ben@cawdev.test',
      reason: 'Header is off.\nOn `s1.png` — caption 1: too tall',
      toolInput: JSON.stringify({ round: 1, attachments: ['old-1'] }) },
    { id: 'ap-1', toolName: 'stage:SHOW', state: 'PENDING', pending: true,
      toolInput: JSON.stringify({ round: 2, attachments: gateIds }) },
  ];
  const replies = {
    'GET /api/projects/p/runs/r/attachments': () => [
      { id: 'old-1', round: 1, name: 'before.png', contentType: 'image/png', size: 7, sha256: sha(bytesOf(9)), caption: 'before' },
      ...shots,
    ],
    'GET /api/projects/p/runs/r/approvals': () => earlier,
    'GET /api/projects/p/runs/r': () => ({ live: true, state: 'RUNNING', entryRef: 'R12' }),
    ...extra,
  };
  const session = {
    url: 'http://localhost:8091',
    email: 'ben@cawdev.test',
    signedIn: true,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      const reply = replies[`${options.method ?? 'GET'} ${path}`];
      return typeof reply === 'function' ? reply() : reply ?? null;
    },
    async requestBytes(path) {
      bytesCalls.push(path);
      if (path.endsWith('/old-1')) return bytesOf(9);
      const found = shots.find((each) => path.endsWith(`/${each.id}`));
      return bytesOf(Number(found.id.slice(5)));
    },
    async signOut() {},
  };
  const ui = new Attached('/tmp/none.sock', session, {
    out, onQuit: () => {},
    openFiles: (paths) => opened.files.push(paths),
    openUrl: (url) => opened.urls.push(url),
  });
  ui.runner = { id: 'runner-1', name: 'laptop', projects: ['p'] };
  ui.connected = false;
  ui.onEvent({ type: 'runs', runs: [RUN] });
  ui.watching = RUN.id;
  ui.approvals.set(RUN.id, {
    runId: RUN.id, projectSlug: 'p',
    approval: {
      id: 'ap-1', toolName: 'stage:SHOW', askedAt: '2026-10-28T10:00:00Z', summary: 'look',
      toolInput: JSON.stringify({ stage: 'SHOW', round: 2, attachments: gateIds }),
    },
  });
  return { ui, calls, bytesCalls, opened, writes };
}

const settle = () => new Promise((done) => setTimeout(done, 10));
async function settleUntil(check) {
  for (let waited = 0; waited < 2000 && !check(); waited += 10) await settle();
}
/** A command, and the beat its un-awaited work needs. */
async function command(ui, text) {
  await ui.runCommand(text);
  await settle();
  await settle();
}
const said = (ui) => ui.pending.map(stripAnsi).join('\n');
const decisions = (calls) => calls.filter((call) => call.method === 'POST');
const row = (ui, id) => ui.select.rows.find((each) => each.id === id);
function typeLine(ui, text) {
  for (const ch of text) ui.onKey(ch);
  ui.onKey('\r');
}

test('the wait line is singular for one and plural for the rest', () => {
  assert.equal(showWaitingLine({ round: 2 }, 3), 'waiting for you — 3 screenshots, round 2 · a to look and decide');
  assert.equal(showWaitingLine({ round: 1 }, 1), 'waiting for you — 1 screenshot, round 1 · a to look and decide');
});

test('a window at SHOW says it is waiting for you, and the wait line is its subtitle', async () => {
  const { ui } = atShow();
  await ui.runCommand('/advanced-mode');
  ui.flush();
  const frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(frame, /waiting for you/);
  assert.match(frame, /waiting for you — 3 screenshots, round 2 · a to look and decide/);
  assert.doesNotMatch(frame, /y once|s session|n refuse/, 'it is not asking to allow a call');
  ui.leaveSplit();
});

test('a lists the round, numbered, with captions in gate order, and the rest of the rows', async () => {
  const { ui } = atShow({ shots: [shot(1, { caption: 'home\x1b[2J' }), shot(2), shot(3)] });
  ui.onKey('a');
  await settleUntil(() => ui.select?.kind === 'show');
  assert.equal(ui.select.kind, 'show');
  const labels = ui.select.rows.map((each) => each.label);
  assert.equal(labels[0], '1  s1.png — home');
  assert.ok(!labels[0].includes('\x1b'));
  assert.match(labels[1], /^2 {2}s2\.png — caption 2$/);
  assert.match(labels[2], /^3 {2}s3\.png — caption 3$/);
  assert.deepEqual(labels.slice(3).map((each) => each.split(' — ')[0]),
    ['Open all', 'Accept', 'Round 1', 'Send comments…']);
  assert.equal(ui.select.rows.at(-1).id, WRITE_MY_OWN);
});

test('Open all opens every image once, from a private cache; the second look downloads nothing', async () => {
  const { ui, bytesCalls, opened } = atShow();
  ui.onKey('a');
  await settleUntil(() => ui.select?.kind === 'show');
  ui.chose(ui.select, row(ui, 'all'));
  await settleUntil(() => opened.files.length === 1);
  assert.equal(opened.files.length, 1, 'one call with every path');
  assert.equal(opened.files[0].length, 3);
  assert.equal(bytesCalls.length, 3);
  assert.match(ui.status, /opened 3 in the viewer \(downloaded 3 into/);
  assert.deepEqual(readdirSync(join(process.env.CAWDEV_SHOTS_DIR, 'r', '2')).sort(),
    [1, 2, 3].map((n) => `${sha(bytesOf(n))}.png`).sort());

  await settleUntil(() => ui.select?.kind === 'show');
  ui.chose(ui.select, row(ui, 'all'));
  await settleUntil(() => opened.files.length === 2);
  assert.equal(bytesCalls.length, 3, 'nothing downloaded again');
  assert.match(ui.status, /from /);
});

test('an html screenshot opens at its platform URL and is never written to disk', async () => {
  const page = shot(2, { name: 'mock.html', contentType: 'text/html', sha256: sha('<p>') });
  const { ui, opened, bytesCalls } = atShow({ shots: [shot(1), page] });
  ui.onKey('a');
  await settleUntil(() => ui.select?.kind === 'show');
  assert.equal(row(ui, 'shot:1').hint, 'html — opens on cawdev');
  ui.chose(ui.select, row(ui, 'shot:1'));
  await settleUntil(() => opened.urls.length === 1);
  assert.deepEqual(opened.urls, ['http://localhost:8091/api/projects/p/runs/r/attachments/shot-2']);
  assert.deepEqual(opened.files, []);
  assert.deepEqual(bytesCalls, []);
  assert.match(ui.status, /sign in there in your browser/);
});

test('Accept and /accept decide the gate allow-once', async () => {
  for (const how of ['picker', 'command']) {
    const { ui, calls } = atShow();
    if (how === 'picker') {
      ui.onKey('a');
      await settleUntil(() => ui.select?.kind === 'show');
      ui.chose(ui.select, row(ui, 'accept'));
    } else {
      await command(ui, '/accept');
    }
    await settleUntil(() => decisions(calls).length === 1);
    assert.deepEqual(decisions(calls).map((call) => [call.path, call.body]), [
      ['/api/projects/p/runs/r/approvals/ap-1/decision', { allow: true, scope: 'ONCE' }],
    ], how);
    assert.match(ui.status, /accepted/);
    assert.equal(ui.pendingOn(RUN), null, 'the gate is settled here');
  }
});

test('Send comments: a round note and a note on screenshot 2, sent on an empty line', async () => {
  const { ui, calls } = atShow();
  ui.onKey('a');
  await settleUntil(() => ui.select?.kind === 'show');
  ui.chose(ui.select, row(ui, WRITE_MY_OWN));
  assert.equal(ui.input.kind, 'comments');
  typeLine(ui, 'too dark');
  typeLine(ui, '#2 overlaps');
  assert.equal(decisions(calls).length, 0, 'held until an empty line');
  assert.match(ui.input.label, /2 lines · empty line sends/);
  ui.onKey('\r');
  await settleUntil(() => decisions(calls).length === 1);
  assert.deepEqual(decisions(calls)[0].body,
    { allow: false, scope: 'ONCE', reason: 'too dark', notes: { 'shot-2': 'overlaps' } });
  assert.equal(ui.status, 'sent — R12 goes back to coding (round 3)');
});

test('a run that ended after the comments is not said to be going back to coding', async () => {
  const { ui } = atShow({ extra: { 'GET /api/projects/p/runs/r': () => ({ live: false, state: 'FAILED', entryRef: 'R12' }) } });
  await command(ui, '/comments too dark');
  assert.equal(ui.status, 'sent');
});

test('/comments with an unknown screenshot sends nothing and says why', async () => {
  const { ui, calls } = atShow();
  await command(ui, '/comments #9 x');
  assert.equal(decisions(calls).length, 0);
  assert.match(ui.status, /no screenshot 9/);
  await command(ui, '/comments');
  assert.equal(decisions(calls).length, 0);
  assert.match(ui.status, /write a note/);
});

test('/comments #1 dark #2 blue is two notes', async () => {
  const { ui, calls } = atShow();
  await command(ui, '/comments too dark #1 dark #2 blue');
  assert.deepEqual(decisions(calls)[0].body.notes, { 'shot-1': 'dark', 'shot-2': 'blue' });
  assert.equal(decisions(calls)[0].body.reason, 'too dark');
});

test('accepting after writing comments says they are dropped', async () => {
  const { ui, calls } = atShow();
  ui.onKey('a');
  await settleUntil(() => ui.select?.kind === 'show');
  ui.chose(ui.select, row(ui, WRITE_MY_OWN));
  typeLine(ui, 'too dark');
  ui.onKey(String.fromCharCode(27));
  assert.equal(ui.select.kind, 'show', 'Esc goes back to the picker');
  ui.chose(ui.select, row(ui, 'accept'));
  await settleUntil(() => decisions(calls).length === 1);
  assert.match(ui.status, /the comments you wrote are dropped — accepting/);
  assert.equal(decisions(calls)[0].body.allow, true);
});

test('y, s, Y, M and n on a SHOW gate send nothing and point at a, /accept and /comments', async () => {
  const { ui, calls } = atShow();
  for (const key of ['y', 's', 'Y', 'M', 'n']) {
    ui.onKey(key);
    await settle();
    assert.match(ui.status, /a, \/accept or \/comments/, key);
  }
  assert.equal(decisions(calls).length, 0);
  assert.equal(ui.mode, 'keys');
});

test('/shots, /accept and /comments on a session that is not at SHOW say why and do nothing', async () => {
  const { ui, calls } = atShow();
  ui.approvals.delete(RUN.id);
  for (const command of ['/shots', '/accept', '/comments x', '/shots all']) {
    await ui.runCommand(command);
    assert.match(ui.status, /is not waiting at SHOW — nothing to look at/, command);
  }
  assert.deepEqual(decisions(calls), []);
});

test('a gate naming screenshots that were never sealed offers no Accept', async () => {
  const { ui, calls } = atShow({ gateIds: ['shot-1', 'shot-2', 'forged'] });
  ui.onKey('a');
  await settleUntil(() => ui.select?.kind === 'show');
  assert.equal(row(ui, 'accept'), undefined);
  assert.match(ui.select.title, /never sealed/);
  await command(ui, '/accept');
  assert.match(ui.status, /never sealed/);
  assert.equal(decisions(calls).length, 0);
});

test('/shots prints the round numbered, and an escape in a caption does not reach the terminal', async () => {
  const { ui } = atShow({ shots: [shot(1, { caption: 'home\x1b[2J' }), shot(2), shot(3)] });
  await command(ui, '/shots');
  const lines = said(ui);
  assert.match(lines, /1 {2}s1\.png — home/);
  assert.match(lines, /3 {2}s3\.png — caption 3/);
  assert.ok(!ui.pending.join('').includes('\x1b[2J'));
});

test('/shots 2 and /shots all open from the cache', async () => {
  const { ui, opened } = atShow();
  await command(ui, '/shots 2');
  assert.equal(opened.files[0].length, 1);
  await command(ui, '/shots all');
  assert.equal(opened.files[1].length, 3);
  await command(ui, '/shots 7');
  assert.match(ui.status, /no screenshot 7/);
  await command(ui, '/shots nonsense');
  assert.match(ui.status, /\/shots 2/);
});

test('Round 1 prints what was sent on it once, and /shots round 1 does the same', async () => {
  const { ui } = atShow();
  ui.onKey('a');
  await settleUntil(() => ui.select?.kind === 'show');
  ui.chose(ui.select, row(ui, 'round:1'));
  const printed = said(ui);
  assert.equal(printed.split('too tall').length - 1, 1, 'the note is in the reason, which is printed once');
  assert.match(printed, /Header is off\./);
  assert.equal(ui.select.kind, 'show-round');

  const again = atShow();
  await command(again.ui, '/shots round 1');
  assert.equal(said(again.ui).split('too tall').length - 1, 1);
  await command(again.ui, '/shots round 1 all');
  assert.equal(again.opened.files.length, 1);
});

test('a gate decided elsewhere closes the picker', async () => {
  const { ui } = atShow({ extra: {
    'GET /api/projects/p/runs/r/approvals': () => [
      { id: 'ap-1', toolName: 'stage:SHOW', state: 'ALLOWED', decidedByEmail: 'ana@cawdev.test', pending: false },
    ],
  } });
  ui.onKey('a');
  await settleUntil(() => ui.select?.kind === 'show');
  ui.approvals.get(RUN.id);
  await ui.decidedElsewhere(RUN);
  assert.equal(ui.select, null);
  assert.equal(ui.mode, 'keys');
  assert.match(ui.status, /ana@cawdev\.test/);
});

test('a gate that names only some of the sealed round, none, or one twice is not confirmed', async () => {
  for (const gateIds of [['shot-1'], [], ['shot-1', 'shot-1', 'shot-2', 'shot-3']]) {
    const { ui, calls } = atShow({ gateIds });
    await command(ui, '/accept');
    assert.match(ui.status, /never sealed/, JSON.stringify(gateIds));
    assert.equal(decisions(calls).length, 0);
  }
});

test('a picker is not opened over a gate that was decided while the round loaded', async () => {
  const { ui } = atShow();
  const loading = ui.lookAndDecide(RUN);
  ui.approvals.delete(RUN.id);
  await loading;
  assert.equal(ui.select, null);
  assert.equal(ui.mode, 'keys');
});

test('settling a gate leaves a prompt being typed alone', async () => {
  const { ui } = atShow();
  await command(ui, '/accept');
  ui.type('prompt', 'prompt ▸', 'hello');
  ui.settleGate(RUN, 'ap-zzz');
  assert.equal(ui.mode, 'typing');
});

test('/shots prints inline thumbnails only in a terminal that draws them, and never in advanced mode', async () => {
  const before = process.env.TERM_PROGRAM;
  try {
    process.env.TERM_PROGRAM = 'iTerm.app';
    const drawn = atShow();
    await command(drawn.ui, '/shots');
    assert.equal(drawn.ui.pending.filter((line) => line.startsWith('\x1b]1337;File=inline=1')).length, 3);

    process.env.TERM_PROGRAM = 'Apple_Terminal';
    const plain = atShow();
    await command(plain.ui, '/shots');
    assert.ok(!plain.ui.pending.join('').includes('\x1b]1337'));

    process.env.TERM_PROGRAM = 'iTerm.app';
    const split = atShow();
    await split.ui.runCommand('/advanced-mode');
    await command(split.ui, '/shots');
    assert.ok(![...split.ui.pending, ...split.ui.split.messages.map((m) => m.text ?? m)].join('').includes('\x1b]1337'));
    split.ui.leaveSplit();
  } finally {
    if (before === undefined) delete process.env.TERM_PROGRAM; else process.env.TERM_PROGRAM = before;
  }
});
