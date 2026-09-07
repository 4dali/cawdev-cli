// node --test tools/runner/answering.test.mjs
//
// R83 — answering in the CLI.
//
// The entry's complaint was that this was the one surface that threw the
// agent's options away and asked you to retype one of them, spelled correctly.
// So what is pinned here is not how the picker LOOKS — select.test.mjs does that
// — but what it RESOLVES: that a chosen option and a typed sentence post the
// same answer to the same question, that a watcher who does not own it is
// offered nothing, and that the ways out (esc, ctrl+c) do what they say.
//
// The client is driven by handing it keys, which is exactly what its stdin does.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripAnsi } from '../lib/ansi.mjs';
import { Attached, questionState, statusLine } from './attach.mjs';
import { WRITE_MY_OWN } from './select.mjs';

// Up-arrow's memory is a real file, and a test must not write to the operator's.
process.env.CAWDEV_HISTORY_FILE = join(mkdtempSync(join(tmpdir(), 'cawdev-history-')), 'h.json');

const ESC = '\x1b';
const ALICE = 'alice@cawdev.test';
const BOB = 'bob@cawdev.test';

const RUN = {
  id: 'run-1',
  label: 'R83 — answering in the CLI',
  projectSlug: 'cawdev',
  state: 'running',
  writesCode: true,
  startedAt: new Date(Date.now() - 252_000).toISOString(),
};

const asked = (over = {}) => ({
  id: 'q1',
  question: 'Postgres or SQLite?',
  options: ['Postgres', 'SQLite'],
  answered: false,
  waitingOnEmail: ALICE,
  shares: [],
  ...over,
});

const approval = (over = {}) => ({
  runId: RUN.id,
  projectSlug: 'cawdev',
  approval: {
    id: 'a1',
    toolName: 'Bash',
    summary: 'mvn -q -pl backend test',
    suggestion: 'Bash(mvn *)',
    askedAt: '2026-09-04T10:11:12Z',
    ...over,
  },
});

/** A client with a run selected, a fake screen, and every call recorded. */
function client({ email = ALICE, question = asked(), pending = null, tty = true } = {}) {
  const out = { write() {}, columns: 100, rows: 40, isTTY: tty };
  const calls = [];
  const session = {
    url: 'http://localhost:8091',
    email,
    signedIn: Boolean(email),
    async request(path, options = {}) {
      calls.push({ path, ...options });
      return null;
    },
    async signOut() {},
  };
  const quits = [];
  const ui = new Attached('/tmp/none.sock', session, { out, onQuit: () => quits.push('quit') });
  ui.runs = [RUN];
  ui.watching = RUN.id;
  if (question) {
    ui.questions.set(RUN.id, questionState([question], email));
  }
  if (pending) {
    ui.approvals.set(RUN.id, pending);
  }
  return { ui, calls, quits, out };
}

const type = (ui, text) => {
  for (const key of text) ui.onKey(key);
};
const settle = () => new Promise((done) => setImmediate(done));

/** For the few paths that wait on the history file before they act. */
async function until(is, what) {
  for (let tries = 0; tries < 200; tries++) {
    if (is()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.fail(what);
}
const overlay = (ui) => ui.overlayLines(100).map(stripAnsi).join('\n');
const said = (ui) => ui.pending.map(stripAnsi).join('\n');

// --- a question with options is a list ---------------------------------------

test('a question with options is a list, not a line to retype one into', () => {
  const { ui } = client();
  ui.onKey('a');
  assert.equal(ui.mode, 'select');
  const drawn = overlay(ui);
  assert.match(drawn, /Postgres or SQLite\?/, 'the question is above the options');
  assert.match(drawn, /1.*Postgres/);
  assert.match(drawn, /2.*SQLite/);
  assert.match(drawn, /Write my own answer/);
});

test('arrows move through it and enter answers with what the cursor is on', async () => {
  const { ui, calls } = client();
  ui.onKey('a');
  ui.onKey(`${ESC}[B`);
  ui.onKey('\r');
  await settle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path,
    '/api/projects/cawdev/runs/run-1/questions/q1/answer');
  assert.deepEqual(calls[0].body, { answer: 'SQLite' });
  assert.equal(ui.mode, 'keys', 'and the picker is gone');
});

test('a digit answers in one key', async () => {
  const { ui, calls } = client();
  ui.onKey('a');
  ui.onKey('1');
  await settle();
  assert.deepEqual(calls[0].body, { answer: 'Postgres' });
});

test('a question with no options goes straight to the line, as it always did', () => {
  const { ui } = client({ question: asked({ options: [] }) });
  ui.onKey('a');
  assert.equal(ui.mode, 'typing');
  assert.equal(ui.input.kind, 'answer');
});

// --- the last row, and the way back from it ----------------------------------

test('"write my own answer" is the last row and opens a line editor', () => {
  const { ui } = client();
  ui.onKey('a');
  assert.equal(ui.select.rows.at(-1).id, WRITE_MY_OWN);
  ui.onKey('3');
  assert.equal(ui.mode, 'typing');
  assert.equal(ui.input.kind, 'answer');
});

test('esc from the free-text line comes back to the list, not out of the question', () => {
  // The options are the agent's GUESS at the shape of the decision. Changing
  // your mind about writing prose should cost one key, not the question.
  const { ui } = client();
  ui.onKey('a');
  ui.onKey('3');
  type(ui, 'neither');
  ui.onKey(ESC);
  assert.equal(ui.mode, 'select');
  assert.equal(ui.select.kind, 'question');
});

test('free text resolves the same record as a chosen option, the same way', async () => {
  const { ui, calls } = client();
  ui.onKey('a');
  ui.onKey('3');
  type(ui, 'neither — the one already there');
  ui.onKey('\r');
  await settle();

  assert.equal(calls[0].path, '/api/projects/cawdev/runs/run-1/questions/q1/answer');
  assert.deepEqual(calls[0].body, { answer: 'neither — the one already there' });
  assert.equal(calls[0].method, 'POST', 'the endpoint the inbox and R78 post to');
});

test('an empty free-text line puts the question back rather than dropping it', () => {
  const { ui, calls } = client();
  ui.onKey('a');
  ui.onKey('3');
  ui.onKey('\r');
  assert.equal(calls.length, 0);
  assert.equal(ui.mode, 'select', 'nothing typed is not an answer');
});

// --- a permission request is the same widget ---------------------------------

test('a permission request offers R60s three, with the tool call readable above', () => {
  const { ui } = client({ question: null, pending: approval() });
  ui.announce();

  // Printed into the transcript, not clipped into a row: you are deciding about
  // something you can read.
  assert.match(said(ui), /permission/);
  assert.match(said(ui), /mvn -q -pl backend test/);

  const drawn = overlay(ui);
  assert.match(drawn, /Allow once/);
  assert.match(drawn, /rest of this run/);
  assert.match(drawn, /Always allow Bash\(mvn \*\) here/);
  assert.match(drawn, /Refuse/);
});

test('choosing a length of yes sends that scope, and refusing asks why first', async () => {
  const { ui, calls } = client({ question: null, pending: approval() });
  ui.announce();
  ui.onKey('2');
  await settle();
  assert.match(calls[0].path, /\/approvals\/a1\/decision$/);
  assert.deepEqual(calls[0].body, { allow: true, scope: 'SESSION', pattern: 'Bash(mvn *)' });

  const second = client({ question: null, pending: approval() });
  second.ui.announce();
  second.ui.onKey('4');
  assert.equal(second.ui.mode, 'typing', 'refusing says why');
  assert.equal(second.ui.input.kind, 'reason');
});

test('with no rule to write there is no row offering one', () => {
  const { ui } = client({ question: null, pending: approval({ suggestion: null }) });
  ui.announce();
  assert.doesNotMatch(overlay(ui), /Always allow/);
  assert.match(overlay(ui), /Allow every Bash for the rest of this run/);
});

test('the same choice is not written twice, one row above itself', () => {
  // Three keys under a list of the same three is six rows of footer over a
  // transcript this program exists to show.
  const { ui } = client({ question: null, pending: approval() });
  ui.announce();
  const footer = ui.footer().map(stripAnsi).join('\n');
  assert.doesNotMatch(footer, /y allow once/, 'the banner stands down while the picker is up');
  assert.match(footer, /mvn -q -pl backend test/, 'but the call is still on the title');
});

test('the run list is not the blocking thing, so the banner stays', () => {
  const { ui } = client();
  ui.onKey('L');
  assert.match(ui.footer().map(stripAnsi).join('\n'), /Postgres or SQLite\?/);
});

test('the single keys still work for anybody who has learned them', async () => {
  const { ui, calls } = client({ question: null, pending: approval() });
  ui.onKey('y');
  await settle();
  assert.deepEqual(calls[0].body, { allow: true, scope: 'ONCE' });
});

// --- R58 is unchanged ---------------------------------------------------------

test("a watcher who does not own the question is told whose it is and offered no picker", () => {
  const { ui } = client({ email: BOB });
  ui.announce();
  assert.match(said(ui), /Postgres or SQLite\?/, 'they still see what stopped it');
  assert.match(said(ui), new RegExp(`waiting on ${ALICE}`));
  assert.equal(ui.mode, 'keys', 'and nothing was opened');
  assert.equal(ui.select, null);
});

test('and pressing the key anyway is refused here rather than by the API', () => {
  const { ui, calls } = client({ email: BOB });
  ui.onKey('a');
  assert.equal(ui.select, null);
  assert.equal(calls.length, 0);
  assert.match(ui.status, new RegExp(ALICE));
});

test('a question is announced once, however many times it is polled', () => {
  const { ui } = client();
  ui.announce();
  const first = said(ui).length;
  ui.announce();
  ui.announce();
  assert.equal(said(ui).length, first);
});

test('nothing opens over a half-written prompt', () => {
  // Taking the keyboard away mid-sentence is how a client loses somebody's
  // paragraph. The banner and the `a` key are enough.
  const { ui } = client({ question: null });
  ui.onKey('\r');
  type(ui, 'half a thought');
  ui.questions.set(RUN.id, questionState([asked()], ALICE));
  ui.announce();
  assert.equal(ui.mode, 'typing');
  assert.equal(ui.input.line.text, 'half a thought');
});

// --- the input line -----------------------------------------------------------

test('typing a slash filters the command list as you go', () => {
  const { ui } = client({ question: null });
  ui.onKey('/');
  assert.equal(ui.mode, 'typing');
  assert.ok(ui.matching().rows.length > 3, 'a bare slash offers everything');
  type(ui, 'lo');
  const names = ui.matching().rows.map(([name]) => name);
  assert.deepEqual(names, ['/login', '/logout', '/log']);
});

test('enter takes the highlighted command, so guessing the name stops being a step', async () => {
  // `/q` was never a command. It is now the only one it could have been.
  const { ui, quits } = client({ question: null });
  // Nothing running: since R123 quitting takes the daemon with it and asks
  // twice while there is work, and the subject here is the KEY.
  ui.runs = [];
  ui.onKey('/');
  type(ui, 'q');
  ui.onKey('\r');
  await until(() => quits.length, '/q should have run /quit');
});

test('tab completes as far as the matches agree', () => {
  const { ui } = client({ question: null });
  ui.onKey('/');
  type(ui, 'l');
  ui.onKey('\t');
  assert.equal(ui.input.line.text, '/log');
});

test('up-arrow recalls what you last sent, and down comes back to the draft', async () => {
  const { ui } = client({ question: null });
  ui.onKey('\r');
  type(ui, 'fix the exporter');
  ui.onKey('\r');
  await settle();

  ui.onKey('\r');
  type(ui, 'half');
  ui.onKey(`${ESC}[A`);
  assert.equal(ui.input.line.text, 'fix the exporter');
  ui.onKey(`${ESC}[B`);
  assert.equal(ui.input.line.text, 'half', 'what you were writing is not lost');
});

test('a large paste is one placeholder line, and is sent in full', async () => {
  const { ui, calls } = client({ question: null });
  const pasted = Array.from({ length: 342 }, (_, at) => `line ${at}`).join('\n');
  ui.onKey({ paste: pasted });

  assert.equal(ui.mode, 'typing');
  assert.equal(ui.input.line.text, '[pasted, 342 lines]',
    'a paste must not bury the transcript this CLI exists to keep');
  ui.onKey('\r');
  await settle();
  assert.equal(calls[0].body.prompt, pasted, 'and all of it is what was sent');
});

// --- the ways out -------------------------------------------------------------

test('esc closes what is open without ending the session', () => {
  const { ui, quits } = client();
  ui.onKey('a');
  ui.onKey(ESC);
  assert.equal(ui.mode, 'keys');
  assert.deepEqual(quits, []);

  ui.onKey('L');
  assert.equal(ui.select.kind, 'runs');
  ui.onKey(ESC);
  assert.equal(ui.mode, 'keys');
  assert.deepEqual(quits, []);
});

test('ctrl+c once says press again; twice leaves', () => {
  const { ui, quits } = client();
  ui.runs = [];
  ui.onKey('\x03');
  assert.deepEqual(quits, []);
  assert.match(ui.status, /again/);
  ui.onKey('\x03');
  assert.deepEqual(quits, ['quit']);
});

test('and with a session running it costs one more press, because it stops it', () => {
  // R123. Leaving takes the daemon and its sessions with it, so the last press
  // is a decision rather than a keystroke.
  const { ui, quits } = client();
  ui.onKey('\x03');
  ui.onKey('\x03');
  assert.deepEqual(quits, [], 'this one only warns');
  assert.match(stripAnsi(ui.status), /1 session running here/);
  ui.onKey('\x03');
  assert.deepEqual(quits, ['quit']);
});

test('anything typed between the two presses disarms it', () => {
  const { ui, quits } = client();
  ui.onKey('\x03');
  ui.onKey('g');
  ui.onKey('\x03');
  assert.deepEqual(quits, [], 'a quit three keystrokes later is one nobody asked for');
});

test('the first ctrl+c also closes whatever was open', () => {
  const { ui, quits } = client();
  ui.onKey('a');
  ui.onKey('\x03');
  assert.equal(ui.mode, 'keys');
  assert.deepEqual(quits, []);
});

// --- the status line ----------------------------------------------------------

test('a status line names the run, how long it has been going, and what stops it', () => {
  const { ui } = client({ question: null });
  // Started NOW minus four minutes rather than at import: the shared fixture is
  // stamped when this file loads, and a suite that takes a second between the
  // two reads the clock over a tick and fails on 4m 13s.
  ui.runs = [{ ...RUN, startedAt: new Date(Date.now() - 252_000).toISOString() }];
  const footer = ui.footer().map(stripAnsi).join('\n');
  assert.match(footer, /R83 — answering in the CLI/);
  assert.match(footer, /4m 12s/);
  assert.match(footer, /x stops it/);
});

test('and it is absent when nothing is running', () => {
  assert.equal(statusLine({ state: 'queued', label: 'x' }, Date.now(), 80), null);
  assert.equal(statusLine(null, Date.now(), 80), null);
});

// --- where there is no cursor to move ----------------------------------------

test('through a pipe the picker is a numbered list and a line read from stdin', async () => {
  const { ui, calls } = client({ tty: false });
  assert.equal(ui.plain, true);
  ui.announce();

  const printed = said(ui);
  assert.match(printed, /1\) Postgres/);
  assert.match(printed, /3\) Write my own answer/);
  assert.equal(stripAnsi(printed), printed, 'and nothing was repainted');

  ui.onLine('2');
  await settle();
  assert.deepEqual(calls[0].body, { answer: 'SQLite' });
});

test('and anything that is not a number is the answer itself', async () => {
  const { ui, calls } = client({ tty: false });
  ui.announce();
  ui.onLine('neither, use what is there');
  await settle();
  assert.deepEqual(calls[0].body, { answer: 'neither, use what is there' });
});

test('a plain permission request asks again rather than guessing', () => {
  const { ui, calls } = client({ question: null, pending: approval(), tty: false });
  ui.announce();
  const before = ui.pending.length;
  ui.onLine('yes please');
  assert.equal(calls.length, 0, 'a permission request has no free text to fall back on');
  assert.ok(ui.pending.length > before, 'so the list is printed again');
});

// --- R119: the console is the other door onto the same question --------------

test('a question answered in the console closes the picker here', () => {
  // The complaint, exactly: answered from the web, and the terminal was still
  // sitting there waiting for the same answer a second time.
  const { ui } = client();
  ui.onKey('a');
  assert.equal(ui.mode, 'select');

  // What the next poll reads back once somebody has answered in the browser.
  const closed = ui.answeredElsewhere(RUN.id,
    [asked({ answered: true, answer: 'Postgres', answeredByEmail: ALICE })]);

  assert.equal(closed, true);
  assert.equal(ui.mode, 'keys', 'the picker is gone');
  assert.equal(ui.select, null);
});

test('and the half-written line too, saying who answered it', () => {
  const { ui } = client({ question: asked({ options: [] }) });
  ui.onKey('a');
  type(ui, 'Postg');
  assert.equal(ui.mode, 'typing');

  ui.answeredElsewhere(RUN.id, [asked({ options: [], answered: true, answeredByEmail: BOB })]);

  assert.equal(ui.mode, 'keys');
  assert.equal(ui.input, null);
  assert.match(stripAnsi(ui.status ?? ''), /answered by bob@cawdev.test/);
});

test('a question still open closes nothing', () => {
  const { ui } = client();
  ui.onKey('a');
  assert.equal(ui.answeredElsewhere(RUN.id, [asked()]), false);
  assert.equal(ui.mode, 'select', 'still being answered');
});

test('and news about another run leaves this question alone', () => {
  const { ui } = client();
  ui.onKey('a');
  assert.equal(ui.answeredElsewhere('run-2', [asked({ answered: true })]), false);
  assert.equal(ui.mode, 'select');
});

test('a permission request is not closed by a question being answered', () => {
  // Two different things stop a session, and only one of them is this poll's.
  const { ui } = client({ question: null, pending: approval() });
  ui.onKey('y');
  const before = ui.mode;
  ui.answeredElsewhere(RUN.id, [asked({ answered: true })]);
  assert.equal(ui.mode, before);
});

// --- R123: the machine goes when the window does -----------------------------

/** A client attached to a SEPARATE daemon, the way plain `cawdev` runs. */
function detached({ leaveRunning = false, runs = [{ ...RUN, state: 'running' }] } = {}) {
  const out = { write() {}, columns: 100, rows: 40, isTTY: true };
  const stopped = [];
  const session = {
    url: 'http://localhost:8091', email: ALICE, signedIn: true,
    async request() { return null; },
    async signOut() {},
  };
  const ui = new Attached('/tmp/none.sock', session,
    { out, leaveRunning, stopDaemon: (pid) => stopped.push(pid) });
  ui.runner = { name: 'macbook', pid: 4242 };
  ui.runs = runs;
  ui.watching = runs[0]?.id;
  // Nothing here should reach a real terminal or a real process.
  ui.screen = { update() {}, close() {} };
  ui.finish = () => {};
  return { ui, stopped };
}

test('quitting stops the daemon it attached to', () => {
  const { ui, stopped } = detached({ runs: [] });
  const exit = process.exit;
  process.exit = () => {};
  try {
    ui.quit();
  } finally {
    process.exit = exit;
  }
  assert.deepEqual(stopped, [4242]);
});

test('and asks twice first while a session is running', () => {
  const { ui, stopped } = detached();
  const exit = process.exit;
  process.exit = () => {};
  try {
    ui.quit();
    assert.deepEqual(stopped, [], 'the first press only warns');
    assert.match(stripAnsi(ui.status ?? ''), /1 session running here/);
    ui.quit();
  } finally {
    process.exit = exit;
  }
  assert.deepEqual(stopped, [4242]);
});

test('--leave-running is the old behaviour, and nothing is signalled', () => {
  const { ui, stopped } = detached({ leaveRunning: true });
  const exit = process.exit;
  process.exit = () => {};
  try {
    ui.quit();
  } finally {
    process.exit = exit;
  }
  assert.deepEqual(stopped, []);
  assert.match(stripAnsi(ui.goodbye().join('\n')), /keeps going/);
});

test('a daemon that never said its pid is left alone rather than guessed at', () => {
  const { ui, stopped } = detached({ runs: [] });
  ui.runner = { name: 'macbook' };
  const exit = process.exit;
  process.exit = () => {};
  try {
    ui.quit();
  } finally {
    process.exit = exit;
  }
  assert.deepEqual(stopped, []);
});
