// `/review` (attach.mjs): a branch's diff in the terminal, and Done, changes
// requested and merge from it, each the platform's own endpoint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripAnsi } from '../lib/ansi.mjs';
import { Attached } from './attach.mjs';

const ESC = '\x1b';
const settle = () => new Promise((done) => setTimeout(done, 10));
async function until(check) {
  for (let waited = 0; waited < 3000 && !check(); waited += 10) await settle();
}

/** A repository with `main` and a branch `r12-pay` that changes two files. */
function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'review-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(join(dir, 'pay.js'), 'export const fee = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'r12-pay');
  writeFileSync(join(dir, 'pay.js'), 'export const fee = 2;\n');
  writeFileSync(join(dir, 'refund.js'), 'export const refund = true;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'pay');
  git('switch', '-q', 'main');
  return dir;
}

/** A client whose card R12 is being built on `r12-pay`, the session's checkout `dir`. */
function client(dir, { privileges = ['VIEW', 'EDIT_CARDS', 'MERGE'] } = {}) {
  const writes = [];
  const out = { write: (text) => writes.push(text), columns: 100, rows: 30, isTTY: true };
  const calls = [];
  const card = {
    ref: 'R12', title: 'Payments', status: 'IN_DEVELOPMENT',
    workItem: { id: 'wi-1', branch: 'r12-pay', baseBranch: 'main', status: 'TEST', statusDisplay: 'Test' },
  };
  const replies = {
    'GET /api/projects/saasng/runs/run-dev': () => ({ profile: 'CODE', state: 'FINISHED', entryRef: 'R12', workspace: dir }),
    'GET /api/projects/saasng/roadmap/R12': () => structuredClone(card),
    'GET /api/projects/saasng': () => ({ slug: 'saasng', defaultBranch: 'main', yourPrivileges: privileges }),
    'POST /api/projects/saasng/work-items/wi-1/verdict': (body) => {
      card.workItem.status = body.verdict === 'APPROVED' ? 'DONE' : 'NOT_DONE';
      return {};
    },
    'POST /api/projects/saasng/work-items/wi-1/merge': () => {
      card.workItem.merge = { state: 'QUEUED' };
      return {};
    },
    'POST /api/projects/saasng/runs': () => ({ id: 'run-dev-2' }),
  };
  const session = {
    url: 'http://localhost:8091',
    email: 'ben@cawdev.test',
    signedIn: true,
    async request(path, options = {}) {
      calls.push({ path, ...options });
      const reply = replies[`${options.method ?? 'GET'} ${path}`];
      return typeof reply === 'function' ? reply(options.body) : reply ?? null;
    },
    async signOut() {},
  };
  const ui = new Attached('/tmp/none.sock', session, { out, onQuit: () => {}, reviewFollowMs: 10 });
  ui.runner = { id: 'runner-1', name: 'laptop', projects: ['saasng'] };
  ui.connected = false;
  return { ui, calls, card, writes };
}

const posts = (calls) => calls.filter((call) => call.method === 'POST').map((call) => [call.path, call.body ?? null]);
const frameOf = (ui) => {
  ui.flush();
  return ui.split.screen.last.map(stripAnsi).join('\n');
};

test('/review draws the branch diff over the screen; n and f move between and fold files', async () => {
  const dir = repository();
  try {
    const { ui } = client(dir);
    ui.onEvent({ type: 'runs', runs: [{ id: 'run-dev', projectSlug: 'saasng', label: 'Payments', profile: 'CODE', state: 'running' }] });
    await ui.runCommand('/advanced-mode');
    await until(() => ui.sessions.get('run-dev')?.view?.workspace);
    await ui.runCommand('/review');
    await until(() => ui.reader?.kind === 'review');
    let frame = frameOf(ui);
    assert.match(frame, /review R12 Payments · Test/);
    assert.match(frame, /r12-pay into main +2 files \+2 −1/);
    assert.match(frame, /▾ pay\.js/);
    assert.match(frame, /\+export const fee = 2;/);
    assert.match(frame, /d done · c changes/);
    assert.doesNotMatch(frame, /m merge/, 'not Done yet: merge is not offered');

    ui.onKey('n');
    const first = ui.reader.top;
    ui.onKey('f');
    frame = frameOf(ui);
    assert.match(frame, /▸ pay\.js/, 'f folds the file the reader is on');
    assert.doesNotMatch(frame, /\+export const fee = 2;/);
    assert.equal(ui.reader.top, first, 'and stays on it');

    ui.onKey(ESC);
    assert.equal(ui.reader, null);
    ui.leaveSplit();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('d says Done; m asks, and only the second m merges, then the landing is said', async () => {
  const dir = repository();
  try {
    const { ui, calls, card } = client(dir);
    ui.onEvent({ type: 'runs', runs: [{ id: 'run-dev', projectSlug: 'saasng', label: 'Payments', profile: 'CODE', state: 'running' }] });
    await ui.runCommand('/advanced-mode');
    await until(() => ui.sessions.get('run-dev')?.view?.workspace);
    await ui.runCommand('/review');
    await until(() => ui.reader?.kind === 'review');

    ui.onKey('d');
    await until(() => ui.reviewing.item.status === 'DONE');
    assert.deepEqual(posts(calls), [['/api/projects/saasng/work-items/wi-1/verdict', { verdict: 'APPROVED' }]]);
    assert.match(frameOf(ui), /m merge/);

    ui.onKey('m');
    await settle();
    assert.match(ui.status, /merge r12-pay into main\? m again lands it/);
    assert.equal(posts(calls).length, 1, 'one m merges nothing');
    ui.onKey('j');
    ui.onKey('m');
    await settle();
    assert.equal(posts(calls).length, 1, 'another key in between took the question back');

    ui.onKey('m');
    await until(() => posts(calls).length === 2);
    assert.deepEqual(posts(calls)[1], ['/api/projects/saasng/work-items/wi-1/merge', null]);
    assert.equal(ui.reader, null, 'the diff closes once the merge is asked of a machine');

    card.status = 'MERGED';
    await until(() => /R12 merged/.test(ui.status ?? ''));
    assert.match(ui.pending.map(stripAnsi).join('\n'), /R12 landed: r12-pay is in main/);
    ui.leaveSplit();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('c asks for the note in the prompt and sends the branch back with it', async () => {
  const dir = repository();
  try {
    const { ui, calls } = client(dir);
    ui.onEvent({ type: 'runs', runs: [{ id: 'run-dev', projectSlug: 'saasng', label: 'Payments', profile: 'CODE', state: 'running' }] });
    await ui.runCommand('/advanced-mode');
    await until(() => ui.sessions.get('run-dev')?.view?.workspace);
    await ui.runCommand('/review');
    await until(() => ui.reader?.kind === 'review');

    ui.onKey('c');
    assert.equal(ui.reader, null);
    assert.equal(ui.input.kind, 'review-note');
    ui.onKey('\r');
    assert.equal(ui.reader?.kind, 'review', 'an empty note goes back to the diff');

    ui.onKey('c');
    ui.onKey({ paste: 'refunds need a test' });
    ui.onKey('\r');
    await until(() => posts(calls).length === 1);
    assert.deepEqual(posts(calls)[0], ['/api/projects/saasng/work-items/wi-1/verdict',
      { verdict: 'CHANGES_REQUESTED', note: 'refunds need a test' }]);
    ui.leaveSplit();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside advanced mode the diff is printed and the acts are commands; merge needs Merge', async () => {
  const dir = repository();
  try {
    const { ui, calls, writes } = client(dir, { privileges: ['VIEW', 'EDIT_CARDS'] });
    ui.onEvent({ type: 'runs', runs: [{ id: 'run-dev', projectSlug: 'saasng', label: 'Payments', profile: 'CODE', state: 'running' }] });
    ui.watching = 'run-dev';
    await until(() => ui.sessions.get('run-dev')?.view?.workspace);
    await ui.runCommand('/review');
    await until(() => ui.reviewing);
    ui.flush();
    const said = stripAnsi([...writes, ...ui.pending].join('\n'));
    assert.match(said, /review R12 Payments/);
    assert.match(said, /\+export const refund = true;/);
    assert.match(said, /\/review done approves · \/review changes <note> sends it back/);

    await ui.runCommand('/review done');
    await until(() => ui.reviewing.item.status === 'DONE');
    await ui.runCommand('/review merge');
    await until(() => /needs Merge/.test(ui.status ?? ''));
    assert.match(ui.status, /needs Merge on saasng/);
    assert.equal(posts(calls).length, 1, 'only the verdict');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a confirmed merge greys its card out as merging, refuses acts on it, and closes it once it lands', async () => {
  const dir = repository();
  try {
    const { ui, card } = client(dir);
    ui.onEvent({ type: 'runs', runs: [{ id: 'run-dev', projectSlug: 'saasng', label: 'Payments', profile: 'CODE', state: 'running' }] });
    await ui.runCommand('/advanced-mode');
    await until(() => ui.sessions.get('run-dev')?.view?.workspace);
    // The development has finished: the branch is what is reviewed now.
    ui.onEvent({ type: 'runs', runs: [] });
    await until(() => ui.sessions.get('run-dev')?.ended && ui.sessions.get('run-dev')?.view);
    await ui.runCommand('/review');
    await until(() => ui.reader?.kind === 'review');
    ui.onKey('d');
    await until(() => ui.reviewing.item.status === 'DONE');
    ui.onKey('m');
    await settle();
    ui.onKey('m');
    await until(() => ui.sessions.get('run-dev').merging);

    let frame = frameOf(ui);
    assert.match(frame, /1  DEV  R12 Payments [─━]+ ⇢ merging [─━]/);
    assert.match(frame, /r12-pay → main/);
    assert.match(frame, /\[>_>\]/, 'the merging robot, not the rain');
    assert.match(frame, /▶ main/);

    ui.onKey('\r');
    assert.match(ui.status, /R12 is merging into main — its card closes by itself once it lands/);
    assert.equal(ui.mode, 'keys', 'no prompt is opened on it');
    await ui.runCommand('/close');
    assert.match(ui.status, /R12 is merging/, '/close too: it closes itself');
    assert.ok(ui.windows().some((meta) => meta.id === 'run-dev'));

    card.status = 'MERGED';
    await until(() => ui.sessions.get('run-dev').merging?.state === 'landed');
    ui.flush();
    frame = frameOf(ui);
    assert.match(frame, /✓ merged · closes in \ds/, 'landed: the robot waves and the card counts down');
    assert.match(frame, /\[\^_\^\]/);
    await ui.runCommand('/close now');
    assert.equal(ui.windows().length, 0, '/close now closes it without waiting');
    frame = frameOf(ui);
    assert.doesNotMatch(frame, /merging/);
    ui.leaveSplit();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Advanced mode with the finished development of R12 confirmed for merging. */
async function mergeConfirmed(dir) {
  const ctx = client(dir);
  const { ui } = ctx;
  ui.onEvent({ type: 'runs', runs: [{ id: 'run-dev', projectSlug: 'saasng', label: 'Payments', profile: 'CODE', state: 'running', agent: 'codex' }] });
  await ui.runCommand('/advanced-mode');
  await until(() => ui.sessions.get('run-dev')?.view?.workspace);
  ui.onEvent({ type: 'runs', runs: [] });
  await until(() => ui.sessions.get('run-dev')?.ended);
  await ui.runCommand('/review');
  await until(() => ui.reader?.kind === 'review');
  ui.onKey('d');
  await until(() => ui.reviewing.item.status === 'DONE');
  ui.onKey('m');
  await settle();
  ui.onKey('m');
  await until(() => ui.sessions.get('run-dev').merging);
  return ctx;
}

test('a merge that hits a conflict sends the branch back with the order and starts its development again here', async () => {
  const dir = repository();
  try {
    const { ui, calls, card } = await mergeConfirmed(dir);
    card.workItem.merge = { state: 'FAILED', failure: 'CONFLICT', result: 'CONFLICT (content): Merge conflict in pay.js' };
    await until(() => posts(calls).some(([path]) => path === '/api/projects/saasng/runs'));
    const [, , verdict, start] = posts(calls);
    assert.equal(verdict[0], '/api/projects/saasng/work-items/wi-1/verdict');
    assert.equal(verdict[1].verdict, 'CHANGES_REQUESTED', 'Not done: the next session on the card is handed the note');
    assert.match(verdict[1].note, /stopped on a conflict: CONFLICT \(content\): Merge conflict in pay\.js/);
    assert.match(verdict[1].note, /Merge origin\/main into r12-pay and resolve every conflict/);
    assert.deepEqual(start, ['/api/projects/saasng/runs',
      { entryNumber: 'R12', agent: 'codex', targetRunnerId: 'runner-1', again: true }],
    'the development again, on this machine, with the agent that built it');
    await until(() => !ui.windows().some((meta) => meta.id === 'run-dev'));
    assert.match(ui.status, /R12 is back in development/);

    // The new development's card takes the focus when this machine claims it.
    ui.onEvent({ type: 'runs', runs: [{ id: 'run-dev-2', projectSlug: 'saasng', label: 'Payments', profile: 'CODE', state: 'running' }] });
    assert.equal(ui.split.focus, 'run-dev-2');
    ui.leaveSplit();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a merge that fails another way gives the card back, red, saying why', async () => {
  const dir = repository();
  try {
    const { ui, calls, card } = client(dir);
    ui.onEvent({ type: 'runs', runs: [{ id: 'run-dev', projectSlug: 'saasng', label: 'Payments', profile: 'CODE', state: 'running' }] });
    await ui.runCommand('/advanced-mode');
    await until(() => ui.sessions.get('run-dev')?.view?.workspace);
    ui.onEvent({ type: 'runs', runs: [] });
    await until(() => ui.sessions.get('run-dev')?.ended);
    await ui.runCommand('/review');
    await until(() => ui.reader?.kind === 'review');
    ui.onKey('d');
    await until(() => ui.reviewing.item.status === 'DONE');
    ui.onKey('m');
    await settle();
    ui.onKey('m');
    await until(() => ui.sessions.get('run-dev').merging);
    card.workItem.merge = { state: 'FAILED', failure: 'NOT_PERMITTED', result: 'push to main refused: protected branch' };
    await until(() => ui.sessions.get('run-dev').merging?.state === 'failed');
    const frame = frameOf(ui);
    assert.match(frame, /✕ merge failed/);
    assert.match(frame, /why: push to main refused: protected branch/, 'the machine\'s words, not the kind');
    assert.match(frame, /\/review to look again/);
    assert.ok(!posts(calls).some(([path]) => path === '/api/projects/saasng/runs'), 'no agent can fix that: nothing started');
    ui.status = null;
    await ui.runCommand('/close');
    assert.doesNotMatch(ui.status ?? '', /is merging/, 'the acts are back');
    ui.leaveSplit();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
