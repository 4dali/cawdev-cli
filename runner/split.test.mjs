// node --test tools/runner/split.test.mjs
//
// Advanced mode: the layout, a window, the frame — pure, so they are rendered
// at several sizes and READ — and the client driving them: entering and
// leaving the alternate screen, focus, what an ended session offers, and the
// requests `/new`, `/develop` and `/pr` make.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { painter, stripAnsi, visibleWidth } from '../lib/ansi.mjs';
import { Attached } from './attach.mjs';
import { History } from './input.mjs';
import { loadPrefs } from './prefs.mjs';
import {
  MIN_ZONE_WIDTH, PROMPT_ROWS, actionsFor, branchForTask, carriesOnHere, composeFrame, parseNew,
  roadmapStrip, builtNothing, commandWords, wordsText, subtitleFor, cardTitleFor, modelLabel, agentModelFor, sessionTag, splitLayout, tabsLine, tailOf, titleFor, toneFor, visibleSessions, windowLines,
  readerFrame, wordsIn,
} from './split.mjs';

process.env.CAWDEV_HISTORY_FILE = join(mkdtempSync(join(tmpdir(), 'cawdev-history-')), 'h.json');
process.env.CAWDEV_PREFS_FILE = join(mkdtempSync(join(tmpdir(), 'cawdev-prefs-')), 'p.json');

const ink = painter(0);
const ESC = '\x1b';

// --- the layout ----------------------------------------------------------------

test('no session is the prompt alone, over the whole screen', () => {
  assert.deepEqual(splitLayout(100, 30, 0), {
    zones: [], prompt: { top: 0, left: 0, width: 100, height: 30 }, hidden: 0,
  });
});

test('one session sits on top and the prompt under it', () => {
  const { zones, prompt } = splitLayout(100, 30, 1);
  assert.deepEqual(zones, [{ top: 0, left: 0, width: 100, height: 30 - PROMPT_ROWS }]);
  assert.deepEqual(prompt, { top: 30 - PROMPT_ROWS, left: 0, width: 100, height: PROMPT_ROWS });
});

test('several sessions fill the screen above the prompt, which stays at the bottom', () => {
  for (const count of [2, 3, 4, 5]) {
    const { zones, prompt, hidden } = splitLayout(120, 40, count);
    assert.equal(hidden, 0);
    assert.equal(prompt.top + prompt.height, 40, `the prompt is the last rows (${count} sessions)`);
    assert.ok(zones.every((z) => z.top + z.height <= prompt.top), 'every window is above it');
    // Every row belongs to exactly one thing: the windows of column 0, then the prompt.
    const rows = new Array(40).fill(0);
    for (const rect of [...zones.filter((z) => z.left === 0), prompt]) {
      for (let y = rect.top; y < rect.top + rect.height; y++) rows[y] += 1;
    }
    assert.deepEqual(rows, new Array(40).fill(1), `${count} sessions`);
  }
  // Two sessions side by side; five in two rows.
  assert.deepEqual(splitLayout(120, 40, 2).zones.map((z) => [z.top, z.left]), [[0, 0], [0, 60]]);
  assert.equal(new Set(splitLayout(120, 40, 5).zones.map((z) => z.top)).size, 2);
});

test('what does not fit at a readable width is counted, not squeezed', () => {
  const { zones, hidden } = splitLayout(80, 40, 9);
  const perRow = Math.floor(80 / MIN_ZONE_WIDTH);
  assert.equal(zones.length, perRow * 2);
  assert.equal(hidden, 9 - perRow * 2);
  assert.ok(zones.every((z) => z.width >= MIN_ZONE_WIDTH));
});

test('a screen too short for a window is the prompt alone, saying how many are hidden', () => {
  const { zones, hidden, prompt } = splitLayout(80, 10, 2);
  assert.deepEqual(zones, []);
  assert.equal(hidden, 2);
  assert.equal(prompt.height, 10);
});

// --- one window ----------------------------------------------------------------

test('a window is exactly its rectangle, at every width', () => {
  for (const width of [28, 40, 61, 120]) {
    const rect = { top: 0, left: 0, width, height: 7 };
    const lines = windowLines(rect, {
      title: '1 cawdev · R3 Push notifications on the mobile app · plan · running',
      body: ['a line', 'a very long line '.repeat(20), `${ESC}[32mgreen${ESC}[0m`],
      footer: '/develop starts R3 · /close',
    }, ink);
    assert.equal(lines.length, 7, `height at ${width}`);
    for (const line of lines) {
      assert.equal(visibleWidth(line), width, `width at ${width}: ${JSON.stringify(stripAnsi(line))}`);
    }
  }
});

test('the body is the TAIL of the output, and the focused window is heavy', () => {
  const lines = windowLines({ top: 0, left: 0, width: 30, height: 5 }, {
    title: 'x', body: ['one', 'two', 'three', 'four'], focused: true,
  }, ink).map(stripAnsi);
  assert.match(lines[0], /^┏━ x ━+┓$/);
  assert.deepEqual(lines.slice(1, 4).map((line) => line.slice(1, -1).trim()), ['two', 'three', 'four']);
  assert.match(lines[4], /^┗━+┛$/);
});

test('tailOf wraps and keeps only what shows', () => {
  assert.deepEqual(tailOf(['abcdefgh', 'ij'], 4, 3), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(tailOf(['abcdefgh', 'ij'], 4, 2), ['efgh', 'ij']);
});

test('a frame is the screen: every row exactly the width', () => {
  const layout = splitLayout(90, 24, 3);
  const pieces = [...layout.zones, layout.prompt].map((rect) => ({
    rect, lines: windowLines(rect, { title: 't', body: ['hello'] }, ink),
  }));
  const rows = composeFrame(90, 24, pieces);
  assert.equal(rows.length, 24);
  for (const row of rows) assert.equal(visibleWidth(row), 90);
});

// --- what a window says about its session ------------------------------------

test('the title says the kind of session and where it stands first, then the card — the project is not in it', () => {
  const meta = { projectSlug: 'saasng', label: 'Push notifications', profile: 'PLAN', state: 'running' };
  assert.equal(titleFor(meta), 'plan · running · Push notifications');
  meta.view = { entryRef: 'R2', entryTitle: 'Push notifications', profile: 'CODE' };
  assert.equal(titleFor(meta, 'waiting for an answer'), 'dev · waiting for an answer · R2 Push notifications');
  Object.assign(meta, { ended: true, view: { ...meta.view, state: 'USAGE_LIMITED' } });
  assert.equal(titleFor(meta), 'dev · usage limited · R2 Push notifications');
});

test('a frame is red while its session runs, green once it finished, amber if it stopped otherwise', () => {
  assert.equal(toneFor({ ended: false }), 'live');
  assert.equal(toneFor({ ended: true, view: { state: 'FINISHED', live: false } }), 'done');
  assert.equal(toneFor({ ended: true, view: { state: 'FAILED', live: false } }), 'stopped');
  assert.equal(toneFor({ ended: true, view: { state: 'CANCELLED', live: false } }), 'stopped');
  assert.equal(toneFor({ ended: true, view: null }), null, 'no success claimed before it is read');
  assert.equal(toneFor({ ended: true, view: { state: 'RUNNING', live: true } }), null);

  const colour = painter(3);
  const top = (tone, focused = false) => windowLines({ top: 0, left: 0, width: 20, height: 3 },
    { title: 't', tone, focused }, colour)[0];
  assert.ok(top('live').startsWith(colour.danger('┌─')), 'red');
  assert.ok(top('done').startsWith(colour.success('┌─')), 'green');
  assert.ok(top('stopped').startsWith(colour.warn('┌─')), 'amber');
  // Focus is the heavy line, in the state's colour — the two never share a channel.
  assert.ok(top('done', true).startsWith(colour.success('┏━')));
});

test('a window can carry a fixed subtitle, which the output never scrolls away', () => {
  const lines = windowLines({ top: 0, left: 0, width: 30, height: 6 }, {
    title: 't', subtitle: '▸ saasng', body: ['1', '2', '3', '4', '5'],
  }, ink).map(stripAnsi);
  assert.equal(lines.length, 6);
  assert.equal(lines[1].slice(1, -1).trim(), '▸ saasng');
  assert.deepEqual(lines.slice(2, 5).map((line) => line.slice(1, -1).trim()), ['3', '4', '5']);
});

test('a session is named by its window number, kind, card and project', () => {
  assert.equal(sessionTag(2, { projectSlug: 'saasng', view: { profile: 'PLAN', entryRef: 'R3', entryTitle: 'Offline mode' } }),
    '2 · plan · R3 Offline mode — saasng');
  assert.equal(sessionTag(4, { projectSlug: 'ngsign', profile: 'ASK', label: 'What is this?' }),
    '4 · ask · What is this? — ngsign');
  const long = sessionTag(2, { projectSlug: 'saasng', view: { profile: 'CODE', entryRef: 'R3',
    entryTitle: 'Client mail intégré dans saasng avec IA activée et règles de tri' } });
  assert.ok(visibleWidth(long) <= '2 · dev · '.length + 32 + ' — saasng'.length, 'a long card is cut');
  assert.match(long, /— saasng$/, 'and the project survives the cut');
});

test('an ended plan offers its development; an ended dev offers the pull request until there is one', () => {
  assert.equal(actionsFor({ ended: false, view: { profile: 'PLAN', state: 'RUNNING' } }), '');
  assert.equal(actionsFor({ ended: true, view: { profile: 'PLAN', state: 'FINISHED', entryRef: 'R3' } }),
    'd develops R3 here, in place of this plan · /open reads the plan on cawdev · /close');
  const dev = { ended: true, view: { profile: 'CODE', state: 'FINISHED', branch: 'r3-x', prUrl: null } };
  assert.equal(actionsFor(dev), '/pr opens the pull request · /close');
  dev.view.prUrl = 'https://github.com/x/y/compare/main...r3-x';
  assert.equal(actionsFor(dev), '/pr opens the pull request · /close', 'a compare link is not a pull request');
  dev.view.prUrl = 'https://github.com/x/y/pull/9';
  assert.equal(actionsFor(dev), 'PR https://github.com/x/y/pull/9 · /open · /close');
  assert.equal(actionsFor({ ended: true, view: { profile: 'CODE', state: 'FAILED', branch: 'r3-x' } }), '/close');
});

test('/new plan|dev with words is the task in words, not a card', () => {
  const one = { projects: ['saasng'] };
  assert.deepEqual(parseNew(['plan', 'add', 'a', 'CSV', 'export', '@saasng'], one),
    { kind: 'plan', slug: 'saasng', text: 'add a CSV export' });
  assert.deepEqual(parseNew(['dev', 'fix', 'the', 'sort', '@saasng'], one),
    { kind: 'dev', slug: 'saasng', text: 'fix the sort' });
  // A reference followed by words is words: the card is only a card on its own.
  assert.deepEqual(parseNew(['dev', 'R3', 'but', 'faster', '@saasng'], one),
    { kind: 'dev', slug: 'saasng', text: 'R3 but faster' });
});

test('a dev from words gets a branch of its own, never the default one', () => {
  assert.equal(branchForTask('Corrige le tri de la liste des clients', 'k3f9'),
    'task-corrige-le-tri-de-la-liste-des-clients-k3f9');
  assert.equal(branchForTask('Ajoute l’export CSV des factures — vite !', 'a1b2'),
    'task-ajoute-l-export-csv-des-factures-vite-a1b2');
  const long = branchForTask('refactor the whole notification pipeline so that pushes and mails share one queue', 'zz99');
  assert.ok(long.length <= 'task-'.length + 40 + '-zz99'.length, long);
  assert.match(long, /^task-refactor-the-whole-notification-[a-z-]*zz99$/);
  assert.doesNotMatch(long, /--/);
  assert.equal(branchForTask('!!!', 'x1'), 'task-session-x1');
  assert.match(branchForTask('same words'), /^task-same-words-[a-z0-9]{1,4}$/);
});

test('/new reads a kind, a card or a question, and a project', () => {
  const one = { projects: ['saasng'] };
  assert.deepEqual(parseNew(['plan', 'R3', '@saasng'], one), { kind: 'plan', slug: 'saasng', ref: 'R3' });
  assert.deepEqual(parseNew(['dev', '3', '@saasng'], one), { kind: 'dev', slug: 'saasng', ref: 'R3' });
  assert.deepEqual(parseNew(['dev', 'I4', '@saasng'], one), { kind: 'dev', slug: 'saasng', ref: 'i4' });
  assert.deepEqual(parseNew(['ask', 'what', 'is', 'this?', '@saasng'], one), { kind: 'ask', slug: 'saasng', text: 'what is this?' });
  // Never guessed: one project served is still asked for.
  assert.deepEqual(parseNew(['dev', 'R3'], one).needsProject, true);

  const two = { projects: ['saasng', 'ngsign'] };
  assert.deepEqual(parseNew(['plan', 'R3'], two).needsProject, true);
  assert.deepEqual(parseNew(['plan', 'R3'], two).projects, ['saasng', 'ngsign']);
  assert.deepEqual(parseNew(['plan', 'R3', '@ngsign'], two), { kind: 'plan', slug: 'ngsign', ref: 'R3' });
  assert.match(parseNew(['plan', 'R3', '@else'], two).error, /does not serve else/);
  assert.match(parseNew(['dev'], one).error, /dev what\?/);
  assert.match(parseNew(['ask'], one).error, /ask what\?/);
  assert.match(parseNew(['build', 'R3'], one).error, /no such session kind/);
  assert.match(parseNew([], one).error, /\/new plan R3/);
});

// --- the roadmap strip -----------------------------------------------------------

const card = (slug, status, n, title, live = false) => ({ slug, status, ref: `R${n}`, title, live });
const SAASNG = [
  card('saasng', 'IN_DEVELOPMENT', 5, 'Tasks board — drag to reorder columns', true),
  card('saasng', 'IN_DEVELOPMENT', 6, 'Messaging as a module'),
  card('saasng', 'IN_DEVELOPMENT', 7, 'Meetings list'),
  card('saasng', 'IN_DEVELOPMENT', 8, 'Clone action'),
  card('saasng', 'PLANNED', 10, 'Invoices export'),
  card('saasng', 'CONSIDERING', 11, 'Dark mode'),
  card('saasng', 'MERGED', 4, 'Client mail with AI'),
  card('saasng', 'SHIPPED', 1, 'x'), card('saasng', 'SHIPPED', 2, 'y'), card('saasng', 'DECLINED', 3, 'z'),
];

test('the strip is every column of the roadmap, one line per card, at the full width', () => {
  for (const width of [50, 80, 120, 180]) {
    for (const line of roadmapStrip(width, 8, SAASNG, ink, ['saasng'])) {
      assert.equal(visibleWidth(line), width, `width ${width}`);
    }
  }
  const lines = roadmapStrip(180, 8, SAASNG, ink, ['saasng']).map(stripAnsi);
  assert.match(lines[0], /^saasng · 1 merged · 2 shipped · 1 declined/,
    'the work that is over is counted beside the project, not drawn as columns');
  assert.match(lines[1], /Considering 1 +Planned 1 +In development 4/);
  assert.doesNotMatch(lines[1], /Merged/, 'no Merged column');
  const body = lines.slice(2).join('\n');
  for (const ref of ['R11', 'R10', 'R5', 'R6', 'R7', 'R8']) assert.match(body, new RegExp(`${ref} `));
  assert.match(body, /●R5 Tasks board/, 'a card with a session running now is marked');
  assert.doesNotMatch(body, /R1 |R2 |R3 |R4 /, 'merged, shipped and declined cards are counted, not listed');
  assert.equal(lines.length, 2 + 4, 'as tall as the fullest column, no taller');
});

test('more cards than rows: the column ends in +N more, and the header keeps the true count', () => {
  const lines = roadmapStrip(180, 4, SAASNG, ink, ['saasng']).map(stripAnsi);
  assert.equal(lines.length, 4);
  assert.match(lines[1], /In development 4/);
  const body = lines.slice(2).join('\n');
  assert.match(body, /R5 /);
  assert.match(body, /\+3 more/, 'one card and the count of the other three');
  assert.doesNotMatch(body, /R6 /);
});

test('more columns than width: empty ones go, then the ideas, and the header says what is hidden', () => {
  const two = [...SAASNG, card('ngsign', 'PLANNED', 1, 'ngsignshell --reply')];
  const wide = roadmapStrip(180, 6, two, ink, ['saasng', 'ngsign']).map(stripAnsi);
  assert.match(wide[0], /^saasng .*│ ngsign/, 'both projects, a rule between them');

  const narrow = roadmapStrip(60, 6, two, ink, ['saasng', 'ngsign']).map(stripAnsi);
  assert.doesNotMatch(narrow[1], /Considering 0/, "ngsign's empty columns went first");
  assert.match(narrow[1], /In development 4/, 'what is being built stays longest');
  assert.match(narrow[0], /considering 1 hidden/, 'a column dropped with cards in it is named');

  const tiny = roadmapStrip(40, 6, two, ink, ['saasng', 'ngsign', 'quiet']).map(stripAnsi);
  assert.equal(tiny.every((line) => visibleWidth(line) === 40), true);
  assert.match(tiny[0], /│ ngsign/, 'two one-column projects fit in 40');
  assert.match(tiny[0], /\+1 proje/, 'the third, which does not, is counted');
  assert.match(tiny[1], /In development 4/);
});

test('a title too long for its column ends in …, and no project at all is one line', () => {
  const lines = roadmapStrip(80, 6, SAASNG, ink, ['saasng']).map(stripAnsi);
  const r5 = lines.slice(2).join('\n').match(/●R5 [^ ].*?…/);
  assert.ok(r5, 'R5 is cut, and says so');
  assert.equal(roadmapStrip(80, 6, [], ink).length, 1);
});

test('a card title breaks between words, and says when it had to stop', () => {
  assert.deepEqual(wordsIn('Offline mode for the mobile app', 24, 2), ['Offline mode for the', 'mobile app']);
  assert.deepEqual(wordsIn('Push notifications on the mobile app, same rules as the web', 24, 2),
    ['Push notifications on', 'the mobile app, same…']);
  assert.deepEqual(wordsIn('Short', 24, 2), ['Short']);
  assert.deepEqual(wordsIn('Supercalifragilisticexpialidocious word', 10, 2), ['Supercali…', 'word']);
});

test('past four, the focused session and the live ones get the windows', () => {
  const metas = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ({ id, ended: i === 1 }));
  const ids = (list) => list.map((meta) => meta.id);
  assert.deepEqual(ids(visibleSessions(metas.slice(0, 4), [], 'a')), ['a', 'b', 'c', 'd'], 'four fit');
  // b has ended: the live ones come first.
  assert.deepEqual(ids(visibleSessions(metas, [], 'a')), ['a', 'c', 'd', 'e']);
  // Focus on f brings it up, in its place in the list.
  assert.deepEqual(ids(visibleSessions(metas, ['f'], 'f')), ['a', 'c', 'd', 'f']);
  // An ended session focused is shown too.
  assert.deepEqual(ids(visibleSessions(metas, ['b'], 'b')), ['a', 'b', 'c', 'd']);
});

test('the tab line names each hidden session by its number, and fits its width', () => {
  const hidden = [5, 6, 7, 8, 9].map((n) => ({
    n, meta: { id: `s${n}`, profile: 'CODE', state: 'running', label: `Card ${n} with a long name` },
  }));
  const line = stripAnsi(tabsLine(hidden, 80, ink));
  assert.equal(visibleWidth(line), 80);
  assert.match(line, /^ also ▸ 5 dev · running · Card 5/);
  assert.match(line, /\+\d+ more — tab reaches them/);
});

// --- the client ------------------------------------------------------------------

/** A client on a fake screen, every request recorded, GETs answered from `replies`. */
function client(replies = {}) {
  const writes = [];
  const out = { write: (text) => writes.push(text), columns: 100, rows: 30, isTTY: true };
  const calls = [];
  const session = {
    url: 'http://localhost:8091',
    email: 'ben@cawdev.test',
    signedIn: true,
    async request(path, options = {}) {
      calls.push({ path, ...options });
      const reply = replies[`${options.method ?? 'GET'} ${path}`];
      return typeof reply === 'function' ? reply() : reply ?? null;
    },
    async signOut() {},
  };
  const ui = new Attached('/tmp/none.sock', session, { out, onQuit: () => {} });
  ui.runner = { id: 'runner-1', name: 'laptop', projects: ['saasng'] };
  ui.connected = false;
  return { ui, calls, writes };
}

const settle = () => new Promise((done) => setTimeout(done, 10));

/** Settles until `check` holds, up to two seconds — a fixed beat is too short on a loaded CI runner. */
async function settleUntil(check) {
  for (let waited = 0; waited < 2000 && !check(); waited += 10) {
    await settle();
  }
}
/** Until `ready()` holds — for what waits on a file being written — or a second has gone. */
async function until(ready) {
  for (let i = 0; i < 100 && !(await ready()); i++) await settle();
}
const PLAN = { id: 'run-plan', projectSlug: 'saasng', label: 'Push notifications', profile: 'PLAN', state: 'running' };
const DEV = { id: 'run-dev', projectSlug: 'saasng', label: 'Payments', profile: 'CODE', state: 'running' };

test('advanced mode takes the alternate screen and gives it back', async () => {
  const { ui, writes } = client();
  ui.onEvent({ type: 'runs', runs: [PLAN] });
  await ui.runCommand('/advanced-mode');
  assert.ok(ui.split);
  assert.ok(writes.join('').includes(`${ESC}[?1049h`), 'entered the alternate screen');
  assert.ok(writes.join('').includes(`${ESC}[?7l${ESC}[?1007h`),
    'no auto-wrap and the wheel sent to the program — the screen holds still, as in nano');
  ui.flush();
  const frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(frame, /1 plan · running · Push notifications /);
  assert.match(frame, /[│┃]▸ saasng +[│┃]/, 'the project on a line of its own, under the title');
  assert.match(frame, /cawdev ▸ laptop · ben@cawdev\.test/);

  await ui.runCommand('/advanced-mode');
  assert.equal(ui.split, null);
  assert.ok(writes.join('').includes(`${ESC}[?1049l`), 'left it');
  assert.ok(writes.join('').includes(`${ESC}[?1007l${ESC}[?7h${ESC}[?1049l`),
    'both put back before the normal screen returns');
});

test('output goes to the session\'s window, not the scrollback, and tab moves the focus', async () => {
  const { ui } = client();
  ui.onEvent({ type: 'runs', runs: [PLAN, DEV] });
  ui.watching = PLAN.id;
  await ui.runCommand('/advanced-mode');
  ui.onEvent({ type: 'output', runId: PLAN.id, line: { kind: 'ASSISTANT', body: 'reading the schema' } });
  assert.deepEqual(ui.pending.filter((line) => /reading the schema/.test(line)), []);
  ui.flush();
  assert.match(ui.split.screen.last.map(stripAnsi).join('\n'), /reading the schema/);

  assert.equal(ui.split.focus, PLAN.id);
  ui.onKey('\t');
  assert.equal(ui.split.focus, DEV.id);
  assert.equal(ui.watching, DEV.id, 'the prompt talks to the focused session');
  ui.onKey(`${ESC}[Z`);
  assert.equal(ui.split.focus, PLAN.id);
  ui.onKey('2');
  assert.equal(ui.split.focus, DEV.id);
});

test('an ended plan stays in its window, and /develop starts its card on this machine', async () => {
  const { ui, calls } = client({
    'GET /api/projects/saasng/runs/run-plan': () => ({
      profile: 'PLAN', state: 'FINISHED', live: false, entryRef: 'R2', entryTitle: 'Push notifications',
    }),
  });
  ui.onEvent({ type: 'runs', runs: [PLAN] });
  await ui.runCommand('/advanced-mode');
  ui.onEvent({ type: 'runs', runs: [] });
  await settle();
  ui.flush();
  const frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(frame, /plan · finished · R2 Push notifications/);
  assert.match(frame, /d develops R2 here, in place of this plan · \/open reads the plan on cawdev · \/close/);

  await ui.runCommand('/develop');
  const post = calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/api/projects/saasng/runs');
  assert.deepEqual(post.body, { entryNumber: 'R2', targetRunnerId: 'runner-1' });
});

test('/develop takes the agent: --codex, a named card, and /agent\'s choice — never the default in silence', async () => {
  const { ui, calls } = client({
    'GET /api/projects/saasng/runs/run-plan': () => ({
      profile: 'PLAN', state: 'FINISHED', live: false, entryRef: 'R2', entryTitle: 'Push notifications',
    }),
  });
  ui.onEvent({ type: 'runs', runs: [PLAN] });
  await ui.runCommand('/advanced-mode');
  ui.onEvent({ type: 'runs', runs: [] });
  await settle();
  const posts = () => calls.filter((call) => call.method === 'POST').map((call) => call.body);

  // What was typed: the window's own hint, a card, and the agent.
  await ui.runCommand('/develop starts R30 --codex');
  assert.deepEqual(posts().at(-1), { entryNumber: 'R30', agent: 'codex', targetRunnerId: 'runner-1' });

  await ui.runCommand('/develop --codex');
  assert.deepEqual(posts().at(-1), { entryNumber: 'R2', agent: 'codex', targetRunnerId: 'runner-1' });

  ui.agent = 'codex';
  await ui.runCommand('/develop 31');
  assert.deepEqual(posts().at(-1), { entryNumber: 'R31', agent: 'codex', targetRunnerId: 'runner-1' });
  clearInterval(ui.split.plannedTimer);
});

test('d on a finished plan develops its card with the plan\'s agent, and the development replaces its window', async () => {
  const { ui, calls } = client({
    'GET /api/projects/saasng/runs/run-plan': () => ({
      profile: 'PLAN', state: 'FINISHED', live: false, entryRef: 'R2', entryTitle: 'Push notifications',
    }),
  });
  ui.agent = 'claude';
  ui.onEvent({ type: 'runs', runs: [{ ...PLAN, agent: 'codex' }] });
  await ui.runCommand('/advanced-mode');
  ui.onEvent({ type: 'runs', runs: [] });
  await settle();
  assert.equal(ui.split.focus, PLAN.id);

  ui.onKey('d');
  await settle();
  assert.notEqual(ui.mode, 'select', 'no list: the focused plan says which card');
  const post = calls.filter((call) => call.method === 'POST').at(-1);
  assert.deepEqual(post, {
    path: '/api/projects/saasng/runs', method: 'POST',
    body: { entryNumber: 'R2', agent: 'codex', targetRunnerId: 'runner-1' },
  }, 'the agent that planned it, over /agent\'s');
  assert.ok(ui.closed.has(PLAN.id), 'the plan\'s window gives way');
  assert.ok(!ui.windows().some((meta) => meta.id === PLAN.id));

  ui.onEvent({ type: 'runs', runs: [{ ...DEV, label: 'Push notifications', agent: 'codex' }] });
  await settle();
  assert.equal(ui.split.focus, DEV.id, 'the development takes the plan\'s place');
  clearInterval(ui.split.plannedTimer);
});

test('a named agent still wins over the plan\'s, and a refused start keeps the plan\'s window', async () => {
  const { ui, calls } = client({
    'GET /api/projects/saasng/runs/run-plan': () => ({
      profile: 'PLAN', state: 'FINISHED', live: false, entryRef: 'R2', entryTitle: 'Push notifications',
    }),
    'POST /api/projects/saasng/runs': () => {
      throw new Error('R2 is already in development');
    },
  });
  ui.onEvent({ type: 'runs', runs: [{ ...PLAN, agent: 'codex' }] });
  await ui.runCommand('/advanced-mode');
  ui.onEvent({ type: 'runs', runs: [] });
  await settle();
  await ui.runCommand('/develop --agy');
  assert.equal(calls.filter((call) => call.method === 'POST').at(-1).body.agent, 'agy');
  assert.ok(!ui.closed.has(PLAN.id), 'nothing started, nothing replaced');
  assert.match(ui.status, /already in development/);
  clearInterval(ui.split.plannedTimer);
});

test('/open on a finished plan opens its card on cawdev, on the plan', async () => {
  const opened = [];
  const { ui } = client({
    'GET /api/projects/saasng/runs/run-plan': () => ({
      profile: 'PLAN', state: 'FINISHED', live: false, entryRef: 'R2', entryTitle: 'Push notifications',
    }),
  });
  ui.options.openUrl = (url) => opened.push(url);
  ui.onEvent({ type: 'runs', runs: [PLAN] });
  await ui.runCommand('/advanced-mode');
  ui.onEvent({ type: 'runs', runs: [] });
  await settle();
  await ui.runCommand('/open');
  assert.deepEqual(opened, ['http://localhost:8091/projects/saasng/roadmap/R2?show=plan']);
  clearInterval(ui.split.plannedTimer);
});

test('/pr asks for the pull request through the run, and shows the URL when it lands', async () => {
  let prUrl = null;
  const { ui, calls } = client({
    'GET /api/projects/saasng/runs/run-dev': () => ({
      profile: 'CODE', state: 'FINISHED', live: false, branch: 'r5-payments', prUrl,
    }),
    'POST /api/projects/saasng/runs/run-dev/pull-request': () => {
      prUrl = 'https://github.com/x/y/pull/12';
      return {};
    },
  });
  ui.onEvent({ type: 'runs', runs: [DEV] });
  await ui.runCommand('/advanced-mode');
  ui.onEvent({ type: 'runs', runs: [] });
  await settle();
  ui.flush();
  assert.match(ui.split.screen.last.map(stripAnsi).join('\n'), /\/pr opens the pull request/);

  await ui.runCommand('/pr');
  assert.ok(calls.some((call) => call.method === 'POST'
    && call.path === '/api/projects/saasng/runs/run-dev/pull-request'));
  await settle();
  ui.flush();
  assert.match(ui.split.screen.last.map(stripAnsi).join('\n'), /PR https:\/\/github\.com\/x\/y\/pull\/12/);
});

test('/new starts a session aimed at this machine, and says what went wrong in words', async () => {
  const { ui, calls } = client({
    'POST /api/projects/saasng/roadmap': () => ({ ref: 'R12', number: 12, title: 'fix the sort on the client list' }),
  });
  await ui.runCommand('/new plan R7');
  assert.equal(ui.mode, 'select', 'no @project: asked, even with one project served');
  assert.deepEqual(ui.select.rows.map((row) => row.id), ['saasng']);
  assert.deepEqual(calls.filter((call) => call.method === 'POST'), []);
  ui.onKey('\x1b');
  await ui.runCommand('/new plan R7 @saasng');
  assert.deepEqual(calls.at(-1), {
    path: '/api/projects/saasng/runs/plan', method: 'POST',
    body: { entryNumber: 'R7', targetRunnerId: 'runner-1' },
  });
  await ui.runCommand('/new ask what does the importer do? --anyway @saasng');
  assert.deepEqual(calls.at(-1).body, {
    prompt: 'what does the importer do?', targetRunnerId: 'runner-1', acknowledgeUsage: true,
  });
  // R369: `--again` answers "a session already finished here", and is not sent
  // as a word of the prompt.
  await ui.runCommand('/new plan R12 --again @saasng');
  assert.deepEqual(calls.at(-1), {
    path: '/api/projects/saasng/runs/plan', method: 'POST',
    body: { entryNumber: 'R12', targetRunnerId: 'runner-1', again: true },
  });
  await ui.runCommand('/new plan add a CSV export of the invoices @saasng');
  assert.deepEqual(calls.at(-1), {
    path: '/api/projects/saasng/runs/plan', method: 'POST',
    body: { prompt: 'add a CSV export of the invoices', targetRunnerId: 'runner-1' },
  });
  // A dev from words writes its card first — a number, and a row on the
  // development board — then develops it exactly as `/new dev R12` would.
  await ui.runCommand('/new dev fix the sort on the client list @saasng');
  await settle();
  const [card, dev] = calls.filter((call) => call.method === 'POST').slice(-2);
  assert.deepEqual(card, {
    path: '/api/projects/saasng/roadmap', method: 'POST',
    body: { title: 'fix the sort on the client list', body: 'fix the sort on the client list' },
  });
  assert.deepEqual(dev, {
    path: '/api/projects/saasng/runs', method: 'POST',
    body: { entryNumber: 'R12', targetRunnerId: 'runner-1' },
  });
  const said = ui.pending.map(stripAnsi).join('\n');
  assert.match(said, /wrote R12 fix the sort on the client list on saasng/);
  assert.match(said, /started the development of R12/);
  await ui.runCommand('/new dev');
  await settle();
  assert.match(ui.status, /nothing planned/, '/new dev alone lists the planned cards — none here');
});

test('/new names --again when the platform says a session already finished', async () => {
  const { ui } = client({
    'POST /api/projects/saasng/runs/plan': () => {
      const failure = new Error('R12 already had a planning session that finished at 2026-10-12 13:20 UTC.');
      failure.status = 409;
      throw failure;
    },
  });
  await ui.runCommand('/new plan R12 @saasng');
  await settle();
  assert.match(ui.status, /session that finished.*add --again to start it regardless/);
});

test('/new on a machine serving several projects asks which, then starts it there', async () => {
  const { ui, calls } = client();
  ui.runner.projects = ['saasng', 'ngsign'];
  await ui.runCommand('/new plan add a CSV export');
  assert.equal(ui.mode, 'select', 'a picker, not a sentence to retype the command');
  assert.deepEqual(ui.select.rows.map((row) => row.id), ['saasng', 'ngsign']);
  assert.deepEqual(calls.filter((call) => call.method === 'POST'), []);

  ui.onKey('2');
  ui.onKey('\r');
  await settle();
  assert.deepEqual(calls.at(-1), {
    path: '/api/projects/ngsign/runs/plan', method: 'POST',
    body: { prompt: 'add a CSV export', targetRunnerId: 'runner-1' },
  });
});

test('advanced mode shows the roadmap on top, and d develops one of its planned cards', async () => {
  const { ui, calls } = client({
    'GET /api/projects/saasng/roadmap?brief=true': [
      { ref: 'R3', title: 'Offline mode for the mobile app', status: 'PLANNED' },
      { ref: 'R4', title: 'Invoices export', status: 'PLANNED' },
      { ref: 'R2', title: 'Payments', status: 'IN_DEVELOPMENT', activeRun: { id: 'run-dev' } },
      { ref: 'R1', title: 'Sign-in', status: 'SHIPPED' },
    ],
  });
  ui.onEvent({ type: 'runs', runs: [PLAN] });
  await ui.runCommand('/advanced-mode');
  await settle();
  ui.flush();
  const top = ui.split.screen.last.slice(0, 5).map(stripAnsi).join('\n');
  assert.match(top, /R3 Offline mode/);
  assert.match(top, /R4/);
  assert.match(top, /●R2 Payments/, 'every status, and the live session marked');
  assert.match(top, /1 shipped/);

  ui.onKey('d');
  await settle();
  assert.equal(ui.mode, 'select');
  assert.deepEqual(ui.select.rows.map((row) => row.label), ['R3 Offline mode for the mobile app', 'R4 Invoices export']);
  ui.onKey('2');
  ui.onKey('\r');
  await settle();
  const post = calls.filter((call) => call.method === 'POST').at(-1);
  assert.deepEqual(post, {
    path: '/api/projects/saasng/runs', method: 'POST', body: { entryNumber: 'R4', targetRunnerId: 'runner-1' },
  });
  clearInterval(ui.split.plannedTimer);
});

test('a served project cawdev no longer has is not offered, and is said once', async () => {
  const gone = () => {
    const failure = new Error('No project ngsign');
    failure.status = 404;
    throw failure;
  };
  const { ui } = client({
    'GET /api/projects/saasng/roadmap?brief=true': [{ ref: 'R1', title: 'Offline mode', status: 'PLANNED' }],
    'GET /api/projects/ngsign/roadmap?brief=true': gone,
  });
  ui.runner.projects = ['saasng', 'ngsign'];
  await ui.runCommand('/advanced-mode');
  await settle();
  assert.notEqual(ui.mode, 'select', 'one project left: nothing to pick between');
  assert.deepEqual(ui.shownProjects(), ['saasng']);
  assert.deepEqual([...ui.split.projects], ['saasng']);
  const said = ui.pending.map(stripAnsi).join(' ');
  assert.equal(said.match(/cawdev has no such project/g)?.length, 1);
  assert.match(said, /c → Stop serving ngsign/);

  await ui.runCommand('/refresh');
  await settle();
  const again = ui.pending.map(stripAnsi).join(' ');
  assert.equal(again.match(/cawdev has no such project/g)?.length, 1, 'said once, not every thirty seconds');
  assert.doesNotMatch(ui.status, /could not be read/, 'gone is not a failed read');
  clearInterval(ui.split.plannedTimer);
});

test('/refresh reads the cards again; a project that cannot be read does not blank the others', async () => {
  let saasng = [{ ref: 'R1', title: 'Offline mode', status: 'CONSIDERING' }];
  const { ui, calls } = client({
    'GET /api/projects/saasng/roadmap?brief=true': () => saasng,
    'GET /api/projects/ngsign/roadmap?brief=true': () => {
      throw new Error('No project ngsign');
    },
  });
  ui.runner.projects = ['saasng', 'ngsign'];
  await ui.runCommand('/advanced-mode @saasng @ngsign');
  await settle();
  assert.deepEqual(ui.cards.map((card) => card.ref), ['R1'],
    'one unreadable project used to leave every column at 0');

  saasng = [
    { ref: 'R1', title: 'Offline mode', status: 'CONSIDERING' },
    { ref: 'R2', title: 'Invoices export', status: 'CONSIDERING' },
    { ref: 'R3', title: 'Payments', status: 'PLANNED' },
  ];
  const before = calls.length;
  await ui.runCommand('/refresh');
  await settle();
  assert.ok(calls.slice(before).some((call) => call.path === '/api/projects/saasng/roadmap?brief=true'),
    'read now, not on the next tick of the timer');
  assert.match(ui.status, /saasng: 2 considering · 1 planned · 0 in development/);
  assert.match(ui.status, /1 could not be read/);
  assert.match(ui.pending.map(stripAnsi).join('\n'), /could not read the roadmap of ngsign: No project ngsign/);
  ui.flush();
  assert.match(ui.split.screen.last.slice(0, 6).map(stripAnsi).join('\n'), /Considering 2/);
  clearInterval(ui.split.plannedTimer);
});

test('a rule separates the roadmap on top from the windows under it', async () => {
  const { ui } = client({
    'GET /api/projects/saasng/roadmap?brief=true': [{ ref: 'R3', title: 'Offline mode', status: 'PLANNED' }],
  });
  ui.onEvent({ type: 'runs', runs: [PLAN] });
  await ui.runCommand('/advanced-mode');
  await settle();
  ui.flush();
  const frame = ui.split.screen.last.map(stripAnsi);
  const rule = frame.findIndex((line) => /^─+$/.test(line));
  assert.ok(rule > 0, 'a full-width rule');
  assert.equal(frame[rule].length, 100, 'as wide as the terminal');
  assert.ok(frame.slice(0, rule).some((line) => /R3 Offline mode/.test(line)), 'the roadmap above it');
  assert.match(frame[rule + 1], /^[╭┏┌]/, 'a window straight under it');
  clearInterval(ui.split.plannedTimer);
});

test('a question in the prompt says which window it came from', async () => {
  const { ui } = client({
    'GET /api/projects/saasng/runs/run-dev': () => ({ profile: 'CODE', state: 'RUNNING', live: true, entryRef: 'R5', entryTitle: 'Payments' }),
  });
  ui.onEvent({ type: 'runs', runs: [PLAN, DEV] });
  await ui.runCommand('/advanced-mode');
  await settle();
  ui.focusWindow(DEV.id);
  ui.questions.set(DEV.id, { question: { id: 'q1', question: 'Stripe or Adyen?', options: ['Stripe', 'Adyen'] }, yours: true });
  ui.announce();
  ui.flush();
  const said = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(said, /2 · dev · R5 Payments — saasng asks: Stripe or Adyen\?/, 'the picker names the window');
  assert.match(ui.select.title, /^2 · dev · R5 Payments — saasng asks: Stripe or Adyen\?/);
  clearInterval(ui.split.plannedTimer);
});

test('/open opens the pull request; /drop deletes a finished on-demand checkout, asking first', async () => {
  const opened = [];
  const removed = [];
  const signalled = [];
  const { ui } = client({
    'GET /api/projects/saasng/runs/run-dev': () => ({
      profile: 'CODE', state: 'FINISHED', live: false, branch: 'r5-payments',
      prUrl: 'https://github.com/x/y/pull/12', workspace: '/code/saasng-auto-2', holdsACheckout: false,
    }),
  });
  Object.assign(ui.options, {
    openUrl: (url) => opened.push(url),
    removeDir: async (dir) => removed.push(dir),
    signalDaemon: (pid) => signalled.push(pid),
    checkoutState: async () => null,
  });
  ui.runner.pid = 999;
  ui.onEvent({ type: 'runs', runs: [DEV] });
  await ui.runCommand('/advanced-mode');
  ui.onEvent({ type: 'runs', runs: [] });
  await settle();
  ui.flush();
  assert.match(ui.split.screen.last.map(stripAnsi).join('\n'), /\/drop deletes its checkout/);

  await ui.openInBrowser();
  assert.deepEqual(opened, ['https://github.com/x/y/pull/12']);

  await ui.dropCheckout();
  assert.equal(ui.mode, 'select', 'it asks first');
  assert.match(ui.select.title, /\/code\/saasng-auto-2/);
  ui.onKey('1');
  ui.onKey('\r');
  await settle();
  assert.deepEqual(removed, ['/code/saasng-auto-2']);
  assert.deepEqual(signalled, [999], 'the daemon is told to look again');
  clearInterval(ui.split.plannedTimer);
});

test('/drop refuses a configured checkout, and one with work not on origin', async () => {
  const views = {
    'run-dev': { profile: 'CODE', state: 'FINISHED', live: false, branch: 'r5', workspace: '/code/saasng', holdsACheckout: false },
  };
  const { ui } = client({ 'GET /api/projects/saasng/runs/run-dev': () => views['run-dev'] });
  ui.onEvent({ type: 'runs', runs: [DEV] });
  ui.watching = DEV.id;
  ui.onEvent({ type: 'runs', runs: [] });
  await settle();
  await ui.dropCheckout();
  assert.match(ui.status, /made on demand/, 'the project always keeps the checkouts in the config');

  views['run-dev'] = { ...views['run-dev'], workspace: '/code/saasng-auto-2' };
  await ui.readView(ui.sessions.get(DEV.id));
  ui.options.checkoutState = async () => '2 commit(s) are not on origin — /pr pushes the branch';
  await ui.dropCheckout();
  assert.match(ui.status, /not on origin/);
  assert.equal(ui.mode, 'keys', 'nothing was offered');
});

test('a live session\'s window cannot be closed; an ended one can', async () => {
  const { ui } = client();
  ui.onEvent({ type: 'runs', runs: [PLAN] });
  await ui.runCommand('/advanced-mode');
  ui.closeWindow();
  assert.match(ui.status, /still running/);
  ui.onEvent({ type: 'runs', runs: [] });
  ui.closeWindow();
  assert.deepEqual(ui.windows(), []);
});

// --- carry-on --------------------------------------------------------------------

test('a stopped session offers /carry-on, and says so once it is asked for', () => {
  const failed = { ended: true, view: { profile: 'CODE', state: 'FAILED', branch: 'r3-x', canCarryOn: true } };
  assert.equal(actionsFor(failed), '/continue picks it back up here · /close');
  assert.equal(actionsFor({ ...failed, carryAsked: true }),
    'continue asked for — back when this machine takes it · /close');
  assert.equal(actionsFor({ ended: true, view: { ...failed.view, canCarryOn: false } }), '/close',
    'discarded, or nothing to go on from: nothing offered');
});

test('carriesOnHere is the API\'s refusals read in advance', () => {
  const view = { canCarryOn: true, startedByEmail: 'ben@cawdev.test', runnerId: 'runner-1' };
  assert.equal(carriesOnHere(view, 'runner-1', 'ben@cawdev.test'), true);
  assert.equal(carriesOnHere({ ...view, runnerId: null }, 'runner-1', 'ben@cawdev.test'), true,
    'a run holding no machine may carry on anywhere');
  assert.equal(carriesOnHere(view, 'runner-2', 'ben@cawdev.test'), false, 'its checkout is elsewhere');
  assert.equal(carriesOnHere(view, 'runner-1', 'ali@cawdev.test'), false, "somebody else's session");
  assert.equal(carriesOnHere(view, 'runner-1', null), false, 'not signed in');
  assert.equal(carriesOnHere({ ...view, canCarryOn: false }, 'runner-1', 'ben@cawdev.test'), false);
});

test('a session that failed before this terminal attached gets a window, and /carry-on picks it up here', async () => {
  const failed = {
    id: 'run-failed', profile: 'CODE', state: 'FAILED', live: false, label: 'Messaging as a module',
    branch: 'task-messaging', canCarryOn: true, startedByEmail: 'ben@cawdev.test', runnerId: 'runner-1',
    exitSummary: '/work/saasng has uncommitted changes',
  };
  const { ui, calls } = client({
    'GET /api/projects/saasng/runs?limit=50': () => [
      failed,
      { ...failed, id: 'run-theirs', startedByEmail: 'ali@cawdev.test' },
      { ...failed, id: 'run-finished', state: 'FINISHED', canCarryOn: false },
    ],
    'POST /api/projects/saasng/runs/run-failed/carry-on': () => ({ ...failed, state: 'QUEUED', canCarryOn: false }),
  });
  ui.session.email = 'ben@cawdev.test';
  await ui.findStopped();
  assert.deepEqual([...ui.sessions.keys()], ['run-failed'], 'only the one this person can carry on here');
  assert.ok(ui.pending.some((line) => /1 session\(s\) stopped here and can be carried on/.test(stripAnsi(line))));

  await ui.runCommand('/advanced-mode');
  ui.flush();
  const frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(frame, /dev · failed · Messaging as a module/);
  assert.match(frame, /stopped: \/work\/saasng has uncommitted changes/, 'the window opens on why');
  assert.match(frame, /\/continue picks it back up here/);

  await ui.runCommand('/continue');
  const post = calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/api/projects/saasng/runs/run-failed/carry-on');
  assert.deepEqual(post.body, { runnerId: 'runner-1' }, 'on THIS machine, where its checkout is');

  // The daemon takes it: the same window comes back to life.
  ui.onEvent({ type: 'runs', runs: [{ id: 'run-failed', projectSlug: 'saasng', label: 'Messaging as a module', profile: 'CODE', state: 'running' }] });
  assert.equal(ui.sessions.get('run-failed').ended, false);
  assert.equal(ui.sessions.get('run-failed').carryAsked, false);
  ui.flush();
  assert.doesNotMatch(ui.split.screen.last.map(stripAnsi).join('\n'), /stopped: \/work\/saasng/,
    'back to life: the old failure no longer heads the window');
});

// --- /pr follows the machine's answer ---------------------------------------------

/** A finished dev session in its window, and a platform that answers /pr with the request. */
async function aFinishedDevAsked(request) {
  const { ui, calls } = client({
    'GET /api/projects/saasng/runs/run-dev': () => ({
      profile: 'CODE', state: 'FINISHED', live: false, branch: 'r5-payments', prUrl: null,
    }),
    'POST /api/projects/saasng/runs/run-dev/pull-request': () => ({
      id: 'req-1', runnerId: 'runner-1', kind: 'OPEN_PR', state: 'QUEUED',
    }),
    'GET /api/runners/runner-1/workspace-requests/req-1': request,
  });
  ui.onEvent({ type: 'runs', runs: [DEV] });
  await ui.runCommand('/advanced-mode');
  ui.onEvent({ type: 'runs', runs: [] });
  await settle();
  await ui.runCommand('/pr');
  await settle();
  // What was printed, read before the flush hands it to the prompt's window.
  const said = ui.pending.map(stripAnsi).join('\n');
  ui.flush();
  return { ui, calls, said, frame: ui.split.screen.last.map(stripAnsi).join('\n') };
}

test('/pr shows the URL the machine confirmed, read off the request and not the run', async () => {
  const { calls, said, frame } = await aFinishedDevAsked(() => ({
    id: 'req-1', state: 'DONE', result: 'https://github.com/x/y/pull/12\npushed r5-payments first',
  }));
  assert.ok(calls.some((call) => call.path === '/api/runners/runner-1/workspace-requests/req-1'));
  assert.match(frame, /PR https:\/\/github\.com\/x\/y\/pull\/12 · \/open/);
  assert.match(said, /pull request: https:\/\/github\.com\/x\/y\/pull\/12$/m);
});

test('/pr says why there is no pull request, in the machine\'s words, instead of waiting for ever', async () => {
  const { said, frame } = await aFinishedDevAsked(() => ({
    id: 'req-1', state: 'FAILED',
    result: 'gh is not installed on this machine, so it cannot talk to the git host. Install it and sign in '
      + '(brew install gh && gh auth login), then ask again — or open it yourself: https://github.com/x/y/compare/r5-payments',
  }));
  assert.match(said, /no pull request for r5-payments/);
  assert.match(said, /brew install gh && gh auth login/);
  assert.match(said, /compare\/r5-payments/, 'the link to open it by hand meanwhile');
  assert.match(frame, /no pull request — gh is not installed/);
  assert.doesNotMatch(frame, /pull request asked for/);
});

// --- a question leaves the prompt once it is answered --------------------------

test('a question is shown whole in the prompt, and its lines leave once it is answered', async () => {
  const { ui, calls } = client({
    'POST /api/projects/saasng/runs/run-plan/questions/q-1/answer': () => ({}),
  });
  ui.onEvent({ type: 'runs', runs: [PLAN] });
  ui.watching = PLAN.id;
  await ui.runCommand('/advanced-mode');
  const long = 'Should the export include archived invoices as well, or only the ones from the current fiscal year?';
  ui.questions.set(PLAN.id, { question: { id: 'q-1', question: long, options: [] }, yours: true });
  ui.announce();
  ui.flush();
  const asked = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(asked, /from 1 · plan/);
  assert.match(asked, /│ +fiscal year\? +│/, 'every word of it, the rest on the next line under the label');
  assert.doesNotMatch(asked, /fiscal ye\s*│\s*│ar/, 'wrapped between words');
  assert.equal((asked.match(/archived invoices/g) ?? []).length, 1, 'once, not twice');

  await ui.answer('only this year');
  assert.ok(calls.some((call) => call.path.endsWith('/questions/q-1/answer')));
  ui.flush();
  const after = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.doesNotMatch(after, /archived invoices/, 'answered: the question is no longer on screen');
  assert.doesNotMatch(after, / question /);
});

test('a question answered in the console leaves the prompt too', async () => {
  const { ui } = client();
  ui.onEvent({ type: 'runs', runs: [PLAN] });
  ui.watching = PLAN.id;
  await ui.runCommand('/advanced-mode');
  ui.questions.set(PLAN.id, { question: { id: 'q-2', question: 'Which bucket?', options: [] }, yours: true });
  ui.announce();
  ui.say('  something else that happened');
  ui.flush();
  assert.match(ui.split.screen.last.map(stripAnsi).join('\n'), /Which bucket\?/);

  // What the poll does when the platform says the question is closed.
  ui.questions.delete(PLAN.id);
  ui.flush();
  const after = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.doesNotMatch(after, /Which bucket\?/);
  assert.match(after, /something else that happened/, 'only the question\'s own lines go');
});

// --- where a dev session is working ---------------------------------------------

test('a dev window names the absolute path of its checkout, cut from the left when it must be', () => {
  const dev = { projectSlug: 'saasng', profile: 'CODE', workspace: '/Users/ben/dev/cawdev-workspaces/saasng-auto-2' };
  assert.equal(subtitleFor(dev, 80), '▸ saasng · /Users/ben/dev/cawdev-workspaces/saasng-auto-2');
  const narrow = subtitleFor(dev, 40);
  assert.equal(narrow.length <= 40, true);
  assert.match(narrow, /^▸ saasng · …/);
  assert.match(narrow, /saasng-auto-2$/, 'the end of the path is what tells two checkouts apart');
  assert.equal(subtitleFor({ ...dev, profile: 'PLAN' }, 80), '▸ saasng', 'only a dev session writes in one');
  assert.equal(subtitleFor({ projectSlug: 'saasng', view: { profile: 'CODE', workspace: '/w/saasng' } }, 80),
    '▸ saasng · /w/saasng', 'an ended session: where the platform says it was');
  assert.equal(subtitleFor({ projectSlug: 'saasng', profile: 'CODE' }, 80), '▸ saasng', 'no checkout yet: nothing invented');
});

test('the window of a running dev session shows where its changes are being made', async () => {
  const { ui } = client();
  ui.onEvent({ type: 'runs', runs: [{ ...DEV, workspace: '/Users/ben/dev/cawdev-workspaces/saasng-auto-2' }] });
  await ui.runCommand('/advanced-mode');
  ui.flush();
  assert.match(ui.split.screen.last.map(stripAnsi).join('\n'),
    /▸ saasng · \/Users\/ben\/dev\/cawdev-workspaces\/saasng-auto-2/);
  clearInterval(ui.split.plannedTimer);
});

test('a card written from a long sentence is titled by its words, cut between them', () => {
  assert.equal(cardTitleFor('fix the sort'), 'fix the sort');
  const long = 'Dans /tasks, la vue Tags, permet l\'ajout d\'une tâche depuis n\'importe quelle colonne, '
    + 'y compris Sans tag, avec le bouton en haut de la colonne et pas seulement en bas';
  const title = cardTitleFor(long);
  assert.ok(title.length <= 100, title);
  assert.match(title, /…$/);
  assert.ok(long.startsWith(title.slice(0, -1)), 'a prefix of what was typed');
  assert.equal(cardTitleFor('first line\nsecond line'), 'first line');
});

// --- advanced mode shows the projects you pick --------------------------------

test('/advanced-mode on a machine serving several projects asks which, and shows only those', async () => {
  const { ui } = client();
  ui.runner = { id: 'runner-1', name: 'laptop', projects: ['saasng', 'ngsign', 'quiet'] };
  const SIGN = { id: 'run-sign', projectSlug: 'ngsign', label: 'Reply option', profile: 'CODE', state: 'running' };
  ui.onEvent({ type: 'runs', runs: [PLAN, SIGN] });

  await ui.runCommand('/advanced-mode');
  assert.equal(ui.split, null, 'not entered before the projects are chosen');
  assert.equal(ui.select.kind, 'split-projects');
  assert.deepEqual([...ui.select.picked], ['saasng', 'ngsign', 'quiet'], 'every one ticked to start with');

  ui.onKey('a');                        // none
  ui.onKey('2');                        // ngsign
  ui.onKey('\r');
  assert.ok(ui.split);
  assert.deepEqual([...ui.split.projects], ['ngsign']);
  assert.deepEqual(ui.windows().map((meta) => meta.id), ['run-sign'], "saasng's session is not drawn");
  ui.flush();
  const frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(frame, /Reply option/);
  assert.doesNotMatch(frame, /Push notifications/);
  assert.match(frame.split('\n')[0], /^ngsign/, 'the roadmap on top is the chosen project alone');

  // /projects asks again, with what is shown ticked.
  await ui.runCommand('/projects');
  assert.deepEqual([...ui.select.picked], ['ngsign']);
  ui.onKey(' ');                        // untick ngsign (the cursor is on it)
  ui.onKey('1');                        // tick saasng
  ui.onKey('\r');
  assert.deepEqual([...ui.split.projects], ['saasng']);
  assert.deepEqual(ui.windows().map((meta) => meta.id), ['run-plan']);
  assert.equal(ui.split.focus, 'run-plan', 'the focus follows onto a window that is shown');
  clearInterval(ui.split.plannedTimer);
});

test('/advanced-mode @slug names the projects and asks nothing; enter alone keeps them all', async () => {
  const { ui } = client();
  ui.runner = { id: 'runner-1', name: 'laptop', projects: ['saasng', 'ngsign'] };
  await ui.runCommand('/advanced-mode @ngsign');
  assert.deepEqual([...ui.split.projects], ['ngsign']);
  clearInterval(ui.split.plannedTimer);
  await ui.runCommand('/advanced-mode off');

  await ui.runCommand('/advanced-mode');
  ui.onKey('\r');
  assert.deepEqual([...ui.split.projects], ['saasng', 'ngsign']);
  clearInterval(ui.split.plannedTimer);
});

test('advanced mode narrowed to one project: /new asks no project, it is that one', async () => {
  const { ui, calls } = client({
    'POST /api/projects/ngsign/roadmap': () => ({ ref: 'R3', number: 3, title: 'reply option' }),
  });
  ui.runner = { id: 'runner-1', name: 'laptop', projects: ['saasng', 'ngsign'] };
  await ui.runCommand('/advanced-mode @ngsign');
  await ui.runCommand('/new dev reply option');
  await settle();
  assert.notEqual(ui.select?.kind, 'project', 'no project question');
  const posts = calls.filter((call) => call.method === 'POST').map((call) => call.path);
  assert.deepEqual(posts, ['/api/projects/ngsign/roadmap', '/api/projects/ngsign/runs']);
  // Two projects shown: the question is back.
  await ui.runCommand('/projects');
  ui.onKey('a');
  ui.onKey('\r');
  await ui.runCommand('/new dev something else');
  assert.equal(ui.select.kind, 'project');
  clearInterval(ui.split.plannedTimer);
});

test('the focused window is heavy and solid, every other session window dotted', async () => {
  const { ui } = client();
  ui.onEvent({ type: 'runs', runs: [PLAN, DEV] });
  ui.watching = PLAN.id;
  await ui.runCommand('/advanced-mode');
  ui.flush();
  const frame = ui.split.screen.last.map(stripAnsi);
  const top = frame.find((line) => line.includes('Push notifications') && line.includes('Payments'));
  assert.ok(top, frame.join('\n'));
  assert.match(top, /┏━ 1 plan · running · Push notifications ━+┓/, 'focused: heavy');
  assert.match(top, /┌┄ 2 dev · running · Payments ┄+┐/, 'not focused: dotted');
  assert.ok(frame.some((line) => /^┆.*┆$/.test(line.slice(line.indexOf('┆')))), 'dotted sides too');
  assert.match(frame.join('\n'), /┌─ cawdev ▸ laptop/, 'the prompt keeps its solid line');
  ui.onKey('\t');
  ui.flush();
  const after = ui.split.screen.last.map(stripAnsi).find((line) => line.includes('Payments'));
  assert.match(after, /┏━ 2 dev/, 'tab moves the heavy line with the focus');
  assert.match(after, /┌┄ 1 plan/);
  clearInterval(ui.split.plannedTimer);
});

// --- which agent, which model ---------------------------------------------------

test('a model is named the way a person says it, and never hidden', () => {
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('claude-opus-5-5[1m]'), 'Opus 5.5');
  assert.equal(modelLabel('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelLabel('sonnet'), 'Sonnet');
  assert.equal(modelLabel('gpt-5-codex'), 'GPT-5-codex');
  assert.equal(modelLabel('o4-mini'), 'o4-mini', 'unknown: as it came');
  assert.equal(modelLabel(null), null);
  assert.equal(agentModelFor({ agent: 'codex', model: 'gpt-5-codex' }), 'Codex · GPT-5-codex');
  assert.equal(agentModelFor({ agent: 'codex', model: null }), 'Codex · default model');
  assert.equal(agentModelFor({ view: { agent: null, model: 'claude-sonnet-5' } }), 'Claude · Sonnet 5',
    'an ended session: the platform says; no agent is Claude, as the runner reads it');
  assert.equal(agentModelFor({}), '', 'nothing known: nothing invented');
});

test('a window names its agent and model, bold and underlined, and follows the stage it is on', async () => {
  const colours = painter(3);
  const { ui } = client();
  ui.onEvent({ type: 'runs', runs: [{ ...DEV, agent: 'claude', model: 'claude-opus-5-5' }] });
  await ui.runCommand('/advanced-mode');
  ui.flush();
  let frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(frame, /Claude · Opus 5\.5 ▸ saasng/);
  const raw = windowLines({ top: 0, left: 0, width: 60, height: 4 },
    { subtitle: colours.strong(agentModelFor(ui.sessions.get(DEV.id))) }, colours).join('');
  assert.ok(raw.includes('\x1b[1;4mClaude · Opus 5.5'), 'bold and underlined');

  // The next stage runs on another model: the window follows.
  ui.onEvent({ type: 'runs', runs: [{ ...DEV, agent: 'claude', model: 'claude-sonnet-5' }] });
  ui.flush();
  frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(frame, /Claude · Sonnet 5 ▸ saasng/);
  assert.doesNotMatch(frame, /Opus/);
  clearInterval(ui.split.plannedTimer);
});

// --- /card: an idea in Considering, no session ----------------------------------

test('/card writes a card in Considering and starts nothing', async () => {
  const { ui, calls } = client({
    'POST /api/projects/saasng/roadmap': () => ({ ref: 'R14', number: 14, title: 'dark mode for the portal' }),
  });
  await ui.runCommand('/card dark mode for the portal @saasng');
  await settle();
  const posts = calls.filter((call) => call.method === 'POST');
  assert.deepEqual(posts, [{
    path: '/api/projects/saasng/roadmap', method: 'POST',
    body: { title: 'dark mode for the portal', body: 'dark mode for the portal', status: 'CONSIDERING' },
  }], 'one card, no run');
  assert.match(ui.pending.map(stripAnsi).join('\n'), /wrote R14 dark mode for the portal in Considering on saasng/);
});

test('/card asks which project unless it is named or advanced mode shows one', async () => {
  const { ui, calls } = client({
    'POST /api/projects/ngsign/roadmap': () => ({ ref: 'R2', number: 2, title: 'batch signing' }),
  });
  ui.runner = { id: 'runner-1', name: 'laptop', projects: ['saasng', 'ngsign'] };
  await ui.runCommand('/card batch signing');
  assert.equal(ui.select.kind, 'card-project');
  assert.deepEqual(ui.select.rows.map((row) => row.id), ['saasng', 'ngsign']);
  assert.deepEqual(calls.filter((call) => call.method === 'POST'), [], 'nothing written before the project is known');
  ui.onKey('2');
  await settle();
  assert.equal(calls.filter((call) => call.method === 'POST').at(-1).path, '/api/projects/ngsign/roadmap');

  await ui.runCommand('/advanced-mode @ngsign');
  await ui.runCommand('/card another idea');
  await settle();
  assert.notEqual(ui.select?.kind, 'card-project', 'one project shown: that is the project');
  assert.equal(calls.filter((call) => call.method === 'POST').at(-1).body.status, 'CONSIDERING');
  clearInterval(ui.split.plannedTimer);
});

test('/card with nothing to write, or a project this machine does not serve, says so', async () => {
  const { ui, calls } = client();
  await ui.runCommand('/card');
  assert.match(ui.status, /\/card what\?/);
  await ui.runCommand('/card an idea @elsewhere');
  assert.match(ui.status, /does not serve elsewhere/);
  assert.deepEqual(calls.filter((call) => call.method === 'POST'), []);
});

// --- the arrows walk what was typed ---------------------------------------------

const UP = '\x1b[A';
const DOWN = '\x1b[B';

test('on a command line, ↑ walks the commands typed before, and enter sends the one recalled', async () => {
  const { ui } = client();
  ui.history = new History(['/card an idea @saasng', 'hello session', '/new dev R12 @saasng']);
  const ran = [];
  ui.runCommand = async (typed) => { ran.push(typed); };
  ui.onKey('/');
  assert.equal(ui.input.line.text, '/');
  ui.onKey(UP);
  assert.equal(ui.input.line.text, '/new dev R12 @saasng', '↑ on the bare / is history, not the command list');
  ui.onKey(UP);
  assert.equal(ui.input.line.text, '/card an idea @saasng', 'a prompt sent to a session is skipped on a command line');
  ui.onKey(DOWN);
  assert.equal(ui.input.line.text, '/new dev R12 @saasng');
  ui.onKey('\r');
  await until(() => ran.length > 0);
  assert.deepEqual(ran, ['/new dev R12 @saasng'], 'sent as recalled, not swapped for a completion');
});

test('once something is typed, the arrows move in the command list again', () => {
  const { ui } = client();
  ui.history = new History(['/card an idea']);
  ui.onKey('/');
  ui.onKey('n');
  const before = ui.input.line.text;
  ui.onKey(UP);
  assert.equal(ui.input.line.text, before, 'typed "/n": ↑ is the completions, the line is untouched');
});

test('on a prompt line ↑ recalls anything sent; outside advanced mode ↑ opens the line with it', async () => {
  const { ui } = client();
  ui.onEvent({ type: 'runs', runs: [PLAN] });
  ui.watching = PLAN.id;
  ui.history = new History(['/runs', 'please add tests']);
  ui.onKey(UP);
  assert.equal(ui.mode, 'typing');
  assert.equal(ui.input.kind, 'prompt', 'the last entry was a prompt, so a prompt line');
  assert.equal(ui.input.line.text, 'please add tests');
  ui.onKey(UP);
  assert.equal(ui.input.line.text, '/runs', 'and further back from there');
  ui.onKey('\x1b');

  // Advanced mode: the wheel arrives as arrows, so ↑ with no line open does nothing.
  await ui.runCommand('/advanced-mode');
  ui.onKey(UP);
  assert.equal(ui.mode, 'keys');
  clearInterval(ui.split.plannedTimer);
});

// --- /view: the session on cawdev -------------------------------------------------

test('/view opens the focused session on cawdev; /view card prints its card here', async () => {
  const opened = [];
  const { ui } = client({
    'GET /api/projects/saasng/runs/run-dev': () => ({ profile: 'CODE', state: 'RUNNING', live: true, entryRef: 'R12' }),
    'GET /api/projects/saasng/roadmap/R12': () => ({ ref: 'R12', title: 'Payments', status: 'IN_DEVELOPMENT', statusDisplay: 'In development' }),
  });
  Object.assign(ui.options, { openUrl: (url) => opened.push(url) });
  ui.onEvent({ type: 'runs', runs: [DEV] });
  await ui.runCommand('/advanced-mode');
  await settle();
  await ui.runCommand('/view');
  await ui.runCommand('/view card');
  await settle();
  assert.deepEqual(opened, ['http://localhost:8091/projects/saasng/runs/run-dev'], '/view card opens no browser');
  const said = ui.pending.map(stripAnsi).join('\n');
  assert.match(said, /R12 Payments/);
  assert.match(said, /status +In development/);
  clearInterval(ui.split.plannedTimer);
});

test('/view R29 prints the card: status, branch, pull request, who has it, and its body', async () => {
  const { ui, calls } = client({
    'GET /api/projects/saasng/roadmap/R29': () => ({
      ref: 'R29', title: 'Subscriber interface: transform to a contact', status: 'IN_DEVELOPMENT',
      statusDisplay: 'In development', kind: 'ROADMAP', section: 'Subscribers', tags: ['ui', 'contacts'],
      branch: 'r29-subscriber', relatedRefs: ['R12', 'i4'],
      workItem: { branch: 'r29-subscriber', status: 'REVIEW', statusDisplay: 'Review', prUrl: 'https://github.com/x/y/pull/31' },
      codingBy: { email: 'ben@cawdev.test' },
      body: 'Add a "Transform to a contact" action.\n\n- searchable picker',
    }),
  });
  await ui.runCommand('/view r29');
  await settle();
  assert.ok(calls.some((call) => call.path === '/api/projects/saasng/roadmap/R29'), 'r29 is asked as R29');
  const said = ui.pending.map(stripAnsi).join('\n');
  for (const want of [/R29 Subscriber interface: transform to a contact/, /status +In development/,
    /section +Subscribers/, /tags +ui, contacts/, /branch +r29-subscriber/, /work +Review/,
    /pr +https:\/\/github\.com\/x\/y\/pull\/31/, /coding +ben@cawdev\.test/, /related +R12, i4/,
    /web +http:\/\/localhost:8091\/projects\/saasng\/roadmap\/R29/, /Transform to a contact" action/, /- searchable picker/]) {
    assert.match(said, want);
  }
  assert.doesNotMatch(said, /declined|merged|version/, 'an empty field draws no line');
});

test('/view <words> finds the card by its title, and asks when several match', async () => {
  const { ui } = client({
    'GET /api/projects/saasng/roadmap?brief=true': [
      { ref: 'R3', title: 'Offline mode for the mobile app', status: 'PLANNED' },
      { ref: 'R4', title: 'Invoices export', status: 'CONSIDERING' },
      { ref: 'R5', title: 'Invoices reminders', status: 'CONSIDERING' },
    ],
    'GET /api/projects/saasng/roadmap/R3': () => ({ ref: 'R3', title: 'Offline mode for the mobile app', status: 'PLANNED' }),
    'GET /api/projects/saasng/roadmap/R5': () => ({ ref: 'R5', title: 'Invoices reminders', status: 'CONSIDERING' }),
  });
  await ui.runCommand('/view offline MODE');
  await settle();
  assert.match(ui.pending.map(stripAnsi).join('\n'), /R3 Offline mode for the mobile app/);

  await ui.runCommand('/view invoices');
  await settle();
  assert.equal(ui.mode, 'select');
  assert.deepEqual(ui.select.rows.map((row) => row.label), ['R4 Invoices export', 'R5 Invoices reminders']);
  ui.onKey('2');
  ui.onKey('\r');
  await settle();
  assert.match(ui.pending.map(stripAnsi).join('\n'), /R5 Invoices reminders/);

  await ui.runCommand('/view nothing like this');
  await settle();
  assert.match(ui.status, /no card titled like "nothing like this"/);
});

test('/open reads the pull request again — it is recorded after the run finished — or takes the card\'s', async () => {
  const opened = [];
  let prUrl = null;
  const { ui } = client({
    'GET /api/projects/saasng/runs/run-dev': () => ({ profile: 'CODE', state: 'FINISHED', live: false, entryRef: 'R29', prUrl }),
    'GET /api/projects/saasng/roadmap/R29': () => ({ ref: 'R29', workItem: { prUrl: 'https://github.com/x/y/pull/77' } }),
  });
  Object.assign(ui.options, { openUrl: (url) => opened.push(url), commitRereadMs: 1 });
  ui.onEvent({ type: 'runs', runs: [DEV] });
  ui.watching = DEV.id;
  await settle();
  prUrl = 'https://github.com/x/y/pull/76';
  await ui.runCommand('/open');
  await settle();
  prUrl = null;
  await ui.runCommand('/open');
  await settle();
  assert.deepEqual(opened, ['https://github.com/x/y/pull/76', 'https://github.com/x/y/pull/77']);
});

test('/view card on a session with no card, or /view with no session, says so', async () => {
  const opened = [];
  const { ui } = client({
    'GET /api/projects/saasng/runs/run-plan': () => ({ profile: 'PLAN', state: 'RUNNING', live: true }),
  });
  Object.assign(ui.options, { openUrl: (url) => opened.push(url) });
  await ui.runCommand('/view');
  assert.match(ui.status, /needs a session/);
  ui.onEvent({ type: 'runs', runs: [PLAN] });
  ui.watching = PLAN.id;
  await settle();
  await ui.runCommand('/view card');
  assert.match(ui.status, /has no card/);
  assert.deepEqual(opened, []);
});

// --- which agent /new asks for ---------------------------------------------------

test('--codex on /new names the agent for that session', async () => {
  const { ui, calls } = client();
  await ui.runCommand('/new dev R12 --codex @saasng');
  await settle();
  assert.deepEqual(calls.filter((call) => call.method === 'POST').at(-1), {
    path: '/api/projects/saasng/runs', method: 'POST',
    body: { entryNumber: 'R12', agent: 'codex', targetRunnerId: 'runner-1' },
  });
  assert.match(ui.pending.map(stripAnsi).join('\n'), /started the development of R12 with codex/);
  await ui.runCommand('/new plan R3 @saasng');
  assert.equal(calls.at(-1).body.agent, undefined, 'no flag, no /agent: nothing named — the project decides');
});

test('/agent is remembered, used by every /new, beaten by a flag, and undone by /agent default', async () => {
  const { ui, calls } = client({
    'POST /api/projects/saasng/roadmap': () => ({ ref: 'R20', number: 20, title: 'x' }),
  });
  await ui.runCommand('/agent codex');
  await until(async () => (await loadPrefs('http://localhost:8091')).agent === 'codex');
  assert.equal(ui.agent, 'codex');
  assert.equal((await loadPrefs('http://localhost:8091')).agent, 'codex', 'kept for the next launch');

  await ui.runCommand('/new plan R3 @saasng');
  assert.equal(calls.at(-1).body.agent, 'codex');
  await ui.runCommand('/new dev an idea @saasng');
  await settle();
  assert.equal(calls.filter((call) => call.path.endsWith('/runs')).at(-1).body.agent, 'codex',
    'a dev from words: its card, then codex develops it');
  await ui.runCommand('/new dev R3 --claude @saasng');
  assert.equal(calls.at(-1).body.agent, 'claude', 'a flag beats /agent');

  await ui.runCommand('/agent default');
  await until(async () => (await loadPrefs('http://localhost:8091')).agent === undefined);
  assert.equal(ui.agent, null);
  assert.equal((await loadPrefs('http://localhost:8091')).agent, undefined);
  await ui.runCommand('/new dev R3 @saasng');
  assert.equal(calls.at(-1).body.agent, undefined);
});

test('/agent refuses a name no runner spawns, and warns when this machine does not spawn it', async () => {
  const { ui } = client();
  await ui.runCommand('/agent netflix');
  await settle();
  assert.match(ui.status, /no agent called netflix — claude, agy, codex/);
  assert.equal(ui.agent ?? null, null);
  ui.runner = { id: 'runner-1', name: 'laptop', projects: ['saasng'], agents: ['claude'] };
  await ui.runCommand('/agent codex');
  await until(() => /does not spawn/.test(ui.status ?? ''));
  assert.match(ui.status, /this machine does not spawn it: c → Enable codex/);
  await ui.runCommand('/agent');
  assert.match(ui.status, /\/new uses codex/);
  await ui.runCommand('/agent default');
  await until(async () => (await loadPrefs('http://localhost:8091')).agent === undefined);
});

test("advanced mode's prompt says which agent /new will use", async () => {
  const { ui } = client();
  await ui.runCommand('/agent codex');
  await until(() => ui.agent === 'codex');
  await ui.runCommand('/advanced-mode');
  ui.flush();
  assert.match(ui.split.screen.last.map(stripAnsi).join('\n'), /cawdev ▸ laptop · ben@cawdev\.test · codex/);
  clearInterval(ui.split.plannedTimer);
  await ui.runCommand('/agent default');
  await until(async () => (await loadPrefs('http://localhost:8091')).agent === undefined);
});

// --- a long input reaches the session whole ---------------------------------------

test('a command keeps its line breaks as words, and its text comes back with them', () => {
  assert.deepEqual(commandWords('new plan @p - one\n- two\t three'), ['new', 'plan', '@p', '-', 'one', '\n', '-', 'two', 'three']);
  assert.equal(wordsText(['-', 'one', '\n', '-', 'two']), '- one\n- two');
  assert.equal(wordsText(['a', 'b']), 'a b');
});

test('a multi-line paste into /new or /card is sent whole, not as its placeholder', async () => {
  const { KeyStream } = await import('./input.mjs');
  const lines = Array.from({ length: 12 }, (_, i) => `- requirement ${i}: ${'detail '.repeat(8).trim()}`).join('\n');
  const paste = (ui) => { for (const key of new KeyStream().push(`\x1b[200~${lines}\x1b[201~`)) ui.onKey(key); };
  const typeIn = (ui, text) => { for (const c of text) ui.onKey(c); };

  const { ui, calls } = client({
    'POST /api/projects/saasng/roadmap': () => ({ ref: 'R30', number: 30, title: 'x' }),
  });
  ui.onKey('/');
  typeIn(ui, 'new plan @saasng ');
  paste(ui);
  assert.match(ui.input.line.text, /\[pasted, 12 lines\]/, 'the line shows the placeholder');
  ui.onKey('\r');
  await until(() => calls.some((call) => call.path.endsWith('/runs/plan')));
  const planned = calls.find((call) => call.path.endsWith('/runs/plan')).body.prompt;
  assert.equal(planned, lines, 'the twelve lines, as pasted — line breaks included');

  ui.onKey('/');
  typeIn(ui, 'card @saasng ');
  paste(ui);
  ui.onKey('\r');
  await until(() => calls.some((call) => call.path.endsWith('/roadmap')));
  const card = calls.find((call) => call.path.endsWith('/roadmap')).body;
  assert.equal(card.body, lines);
  assert.doesNotMatch(card.title, /\[pasted/);
});

// --- the prompt says which window a command acts on ----------------------------

test('the prompt names the window a command will act on, and the answer names the window it was about', async () => {
  const { ui } = client({
    'GET /api/projects/saasng/runs/run-dev': () => ({ profile: 'CODE', state: 'FINISHED', live: false, branch: 'r18-feed', entryRef: 'R18' }),
    'POST /api/projects/saasng/runs/run-dev/pull-request': () => {
      throw new Error('A session on r18-feed is running. Wait for it to finish before proposing the branch.');
    },
  });
  ui.onEvent({ type: 'runs', runs: [PLAN, DEV] });
  await ui.runCommand('/advanced-mode');
  ui.onEvent({ type: 'runs', runs: [PLAN] });
  await settle();
  ui.focusWindow(DEV.id);
  ui.flush();
  let frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(frame, /\[2\] enter prompts/, 'idle: which window enter will prompt');

  ui.onKey('/');
  for (const c of 'pr') ui.onKey(c);
  ui.flush();
  frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(frame, /\[2\] cawdev ▸ \/pr/, 'typing: which window the command acts on');

  ui.onKey('\r');
  await until(() => /is running/.test(ui.status ?? ''));
  ui.flush();
  frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(frame, /\[2\] A session on r18-feed is running/, 'the answer says which window it was about');
  clearInterval(ui.split.plannedTimer);
});

// --- a failed session says why, in its window ---------------------------------

test('a session that ends FAILED shows why in its window, once', async () => {
  const why = 'Codex CLI cannot write code on this machine yet: …\n\nTo allow it:\n  2. On cawdev: http://x/settings/runners → laptop → tick "Allow everything".';
  const { ui } = client({
    'GET /api/projects/saasng/runs/run-dev': () => ({ profile: 'CODE', state: 'FAILED', live: false, exitSummary: why }),
  });
  ui.onEvent({ type: 'runs', runs: [DEV] });
  await ui.runCommand('/advanced-mode');
  ui.onEvent({ type: 'runs', runs: [] });
  await until(() => ui.sessions.get(DEV.id)?.failureSaid);
  ui.flush();
  const frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(frame, /failed:/);
  assert.match(frame, /tick "Allow everything"/);
  await ui.readView(ui.sessions.get(DEV.id));
  assert.equal(ui.lines.get(DEV.id).filter((line) => line.body === 'failed:').length, 1, 'said once, not per read');
  clearInterval(ui.split.plannedTimer);
});

// --- finished, having built nothing --------------------------------------------

test('a dev session that finished with no commit is "nothing built", amber, and offers no /pr', () => {
  const meta = { ended: true, commits: 0, view: { profile: 'CODE', state: 'FINISHED', branch: 'r24-x', entryRef: 'R24', entryTitle: 'Signature' } };
  assert.equal(builtNothing(meta), true);
  assert.equal(titleFor(meta), 'dev · finished · nothing built · R24 Signature');
  assert.equal(toneFor(meta), 'stopped', 'amber, not the green of work done');
  assert.equal(actionsFor(meta), 'nothing was committed — /new plan R24 to re-plan it · /close');

  const built = { ...meta, commits: 2 };
  assert.equal(builtNothing(built), false);
  assert.equal(titleFor(built), 'dev · finished · R24 Signature');
  assert.equal(toneFor(built), 'done');
  assert.match(actionsFor(built), /\/pr opens the pull request/);

  const unknown = { ...meta, commits: undefined };
  assert.equal(builtNothing(unknown), false, 'commits not read yet: nothing claimed');
  assert.equal(builtNothing({ ...meta, view: { ...meta.view, profile: 'PLAN' } }), false, 'a plan writes no commit by design');
});

test('commits that land after FINISHED are not "nothing built" — a zero is read again first', async () => {
  const briefing = 'Branch briefing: `r29-x`\n- Implementation `59e390f` pushed to origin.';
  let reads = 0;
  const { ui } = client({
    'GET /api/projects/saasng/runs/run-dev': () => ({ profile: 'CODE', state: 'FINISHED', live: false, branch: 'r29-x', entryRef: 'R29', exitSummary: briefing }),
    // The runner's last reading arrives after the run is FINISHED: the first
    // read answers none, the next the two the session committed and pushed.
    'GET /api/projects/saasng/runs/run-dev/commits': () => (++reads === 1 ? [] : [{ sha: '59e390f' }, { sha: '04e2330' }]),
  });
  ui.options.commitRereadMs = 1;
  ui.onEvent({ type: 'runs', runs: [DEV] });
  await ui.runCommand('/advanced-mode');
  ui.onEvent({ type: 'runs', runs: [] });
  await until(() => ui.sessions.get(DEV.id)?.commits !== undefined);
  assert.equal(ui.sessions.get(DEV.id).commits, 2);
  ui.flush();
  const frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.doesNotMatch(frame, /nothing built|nothing was committed/);
  assert.match(frame, /dev · finished · R29/);
  clearInterval(ui.split.plannedTimer);
});

test('its window says why it built nothing, from its summary', async () => {
  const why = 'R24 non implémentée.\nIMPLEMENT s’est arrêté parce que le plan était incomplet.';
  const { ui } = client({
    'GET /api/projects/saasng/runs/run-dev': () => ({ profile: 'CODE', state: 'FINISHED', live: false, branch: 'r24-x', entryRef: 'R24', exitSummary: why }),
    'GET /api/projects/saasng/runs/run-dev/commits': () => [],
  });
  ui.options.commitRereadMs = 1;
  ui.onEvent({ type: 'runs', runs: [DEV] });
  await ui.runCommand('/advanced-mode');
  ui.onEvent({ type: 'runs', runs: [] });
  await until(() => ui.sessions.get(DEV.id)?.failureSaid);
  ui.flush();
  const frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(frame, /dev · finished · nothing built · R24/);
  assert.match(frame, /nothing built:/);
  assert.match(frame, /le plan était incomplet/);
  assert.match(frame, /nothing was committed — \/new plan R24 to re-plan it/);
  assert.doesNotMatch(frame, /\/pr opens the pull request/);
  clearInterval(ui.split.plannedTimer);
});

test('in advanced mode the matching commands are drawn, and tab reaches /login past /log', async () => {
  const { ui } = client();
  ui.onEvent({ type: 'runs', runs: [PLAN] });
  await ui.runCommand('/advanced-mode');
  for (const key of '/lo') ui.onKey(key);
  ui.flush();
  let frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(frame, /❯ \/login +sign in through the browser/);
  assert.match(frame, /\/logout/);

  ui.onKey('\t');
  assert.equal(ui.input.line.text, '/log', 'completed as far as the names agree');
  ui.onKey('\t');
  ui.flush();
  frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.equal(ui.input.line.text, '/log');
  assert.match(frame, /❯ \/login/, 'the second tab moves down the list');
  assert.equal(ui.matching().rows[ui.matching().at][0], '/login');
  ui.leaveSplit();
});

test('/login from advanced mode stays in advanced mode', async () => {
  const { ui } = client();
  ui.onEvent({ type: 'runs', runs: [PLAN] });
  await ui.runCommand('/advanced-mode');
  await ui.runCommand('/login');
  assert.ok(ui.split, 'still in advanced mode');
  ui.leaveSplit();
  ui.stopped = true; // the fake session is always signed in, so the polls started
});

// --- the reader: /view and /open on a session waiting for you -------------------

const LONG_PLAN = Array.from({ length: 60 }, (_, i) => `step ${i + 1} of the plan`).join('\n');

function waitingClient() {
  const opened = [];
  const made = client();
  made.ui.options.openUrl = (url) => opened.push(url);
  made.ui.onEvent({ type: 'runs', runs: [PLAN] });
  made.ui.watching = PLAN.id;
  made.ui.lines.set(PLAN.id, [{ kind: 'ASSISTANT', body: 'here is what I will do' }]);
  made.ui.approvals.set(PLAN.id, {
    runId: PLAN.id,
    approval: { id: 'ap-1', toolName: 'stage gate', summary: LONG_PLAN, askedAt: '2026-10-11T10:00:00Z' },
  });
  return { ...made, opened };
}

test('readerFrame starts at the request and clamps what it is asked for', () => {
  const lines = ['out 1', 'out 2', 'request', ...Array.from({ length: 30 }, (_, i) => `r${i}`)];
  const ink = painter(1);
  const first = readerFrame(40, 12, { title: 'x', lines, requestAt: 2, footer: 'keys' }, ink);
  assert.equal(first.top, 2);
  assert.equal(first.room, 9);
  assert.match(stripAnsi(first.lines[0]), /3–11 of 33/);
  assert.match(stripAnsi(first.lines[1]), /request/);
  assert.equal(readerFrame(40, 12, { lines, top: 999 }, ink).top, 33 - 10);
  assert.equal(readerFrame(40, 12, { lines, top: -5 }, ink).top, 0);
});

test('/view on a session waiting for you reads it whole, and the arrows scroll it', async () => {
  const { ui } = waitingClient();
  await ui.runCommand('/advanced-mode');
  ui.flush();
  assert.match(ui.split.screen.last.map(stripAnsi).join('\n'), /\/view reads it all · \/open answers it on cawdev/);

  await ui.runCommand('/view');
  assert.ok(ui.reader, 'the reader is open');
  ui.flush();
  let frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(frame, /permission/);
  assert.match(frame, /step 1 of the plan/);
  assert.match(frame, /esc close/);
  assert.doesNotMatch(frame, /step 60 of the plan/, 'longer than the screen');

  ui.onKey('G');
  ui.flush();
  frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(frame, /step 60 of the plan/, 'G reaches the end');
  assert.match(frame, /n refuse/);

  ui.onKey('g');
  ui.flush();
  assert.match(ui.split.screen.last.map(stripAnsi).join('\n'), /here is what I will do/, 'g reaches the output above it');

  ui.onKey(ESC);
  assert.equal(ui.reader, null);
  ui.leaveSplit();
});

test('a key the reader does not use closes it and does its usual thing', async () => {
  const { ui } = waitingClient();
  await ui.runCommand('/advanced-mode');
  await ui.runCommand('/view');
  ui.onKey('n');
  assert.equal(ui.reader, null);
  assert.equal(ui.mode, 'typing');
  assert.equal(ui.input.kind, 'reason', 'n opened the refusal line');
  ui.leaveSplit();
});

test('/open on a session waiting for you opens its page on cawdev', async () => {
  const { ui, opened } = waitingClient();
  await ui.runCommand('/advanced-mode');
  await ui.runCommand('/open');
  assert.deepEqual(opened, [`http://localhost:8091/projects/saasng/runs/${PLAN.id}`]);
  ui.leaveSplit();
});

test('/view outside advanced mode prints the request whole into the scrollback', async () => {
  const { ui } = waitingClient();
  await ui.runCommand('/view');
  const said = ui.pending.map(stripAnsi).join('\n');
  assert.match(said, /step 1 of the plan/);
  assert.match(said, /step 60 of the plan/);
  assert.equal(ui.reader ?? null, null);
});

test('from a question\'s list, / opens the command line and /view reads the question whole', async () => {
  const { ui } = client();
  ui.onEvent({ type: 'runs', runs: [PLAN] });
  ui.watching = PLAN.id;
  await ui.runCommand('/advanced-mode');
  const long = `Which one is meant?\n${'a long explanation '.repeat(40)}`;
  ui.questions.set(PLAN.id, {
    question: { id: 'q-1', runId: PLAN.id, question: long, options: ['Messagerie', 'Communications', 'Les deux'] },
    yours: true,
    waitingOn: 'ben@cawdev.test',
  });
  ui.askTheQuestion(ui.questions.get(PLAN.id));
  ui.flush();
  const frame = ui.split.screen.last.map(stripAnsi).join('\n');
  assert.match(frame, /asks: Which one is meant\?/);
  assert.match(frame, /\/view reads it all/, 'the list says how to read it whole');

  ui.onKey('/');
  assert.equal(ui.mode, 'typing');
  for (const key of 'view') ui.onKey(key);
  ui.onKey('\r');
  await settleUntil(() => ui.reader);
  assert.ok(ui.reader, 'the reader opened');
  ui.flush();
  assert.match(ui.split.screen.last.map(stripAnsi).join('\n'), /1 Messagerie/);
  ui.onKey(ESC);
  ui.leaveSplit();
});

test('the strip draws the issues too: NEW beside the ideas, CONFIRMED beside the planned, worst first', () => {
  const cards = [
    { ref: 'R1', title: 'Offline mode', slug: 'saasng', status: 'CONSIDERING' },
    { ref: 'i4', title: 'Typo on the footer', slug: 'saasng', status: 'NEW', severity: 'MINOR' },
    { ref: 'i5', title: 'Login loops', slug: 'saasng', status: 'NEW', severity: 'CRITICAL' },
    { ref: 'R2', title: 'Invoices export', slug: 'saasng', status: 'PLANNED' },
    { ref: 'i6', title: 'Double charge', slug: 'saasng', status: 'CONFIRMED', severity: 'MEDIUM' },
    { ref: 'i7', title: 'Old fix', slug: 'saasng', status: 'MERGED', severity: 'MINOR' },
    { ref: 'i8', title: 'Just reported', slug: 'saasng', status: 'BACKLOG', severity: 'MEDIUM' },
    { ref: 'R9', title: 'Someday', slug: 'saasng', status: 'BACKLOG' },
  ];
  const lines = roadmapStrip(180, 8, cards, ink, ['saasng']).map(stripAnsi);
  assert.match(lines[0], /2 backlog · 1 merged/, 'the backlog, where a new issue lands, is counted first');
  assert.match(lines[1], /Considering 3 +Planned 2/);
  assert.match(lines[2], /i5 Login loops.*i6 Double charge/, 'a critical issue heads its column');
  assert.match(lines[3], /i4 Typo on the footer.*R2 Invoices export/);
  assert.match(lines[4], /R1 Offline mode/);
  const coloured = roadmapStrip(180, 8, cards, painter(1), ['saasng']).join('\n');
  assert.match(coloured, /\x1b\[31mi5/, 'the ref in the colour of its severity');
});

test('advanced mode reads the issues, and d offers a confirmed one', async () => {
  const { ui, calls } = client({
    'GET /api/projects/saasng/roadmap?brief=true': [{ ref: 'R3', title: 'Offline mode', status: 'PLANNED' }],
    'GET /api/projects/saasng/issues?brief=true': [
      { ref: 'i9', title: 'Login loops', status: 'CONFIRMED', severity: 'CRITICAL' },
      { ref: 'i8', title: 'Typo', status: 'NEW', severity: 'MINOR' },
    ],
  });
  ui.onEvent({ type: 'runs', runs: [PLAN] });
  await ui.runCommand('/advanced-mode');
  await settle();
  ui.flush();
  const top = ui.split.screen.last.slice(0, 5).map(stripAnsi).join('\n');
  assert.match(top, /i9 Login loops/);
  assert.match(top, /i8 Typo/);

  await ui.runCommand('/refresh');
  await settle();
  assert.match(ui.status, /saasng: 1 considering · 2 planned · 0 in development/);

  ui.onKey('d');
  await settle();
  assert.deepEqual(ui.select.rows.map((row) => row.label), ['R3 Offline mode', 'i9 Login loops']);
  ui.onKey('2');
  ui.onKey('\r');
  await settle();
  const post = calls.filter((call) => call.method === 'POST').at(-1);
  assert.equal(post.body.entryNumber, 'i9');
  clearInterval(ui.split.plannedTimer);
});
