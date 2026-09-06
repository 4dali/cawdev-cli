// node --test tools/runner/terminal.test.mjs
//
// R62 — what the runner's terminal says about itself.
//
// The banner and the bar are the two places a person looks to answer "why did
// that not happen", so what is pinned here is that they say the things that
// answer it, and that they still say them with the colour taken away.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { painter, stripAnsi } from '../lib/ansi.mjs';
import { bannerLines, tintLog } from './banner.mjs';
import { mark, oneLine } from './brand.mjs';
import { sessionCounts, settingsBar } from './attach.mjs';

const config = {
  url: 'http://localhost:8091',
  name: 'macbook',
  maxSessions: 4,
  browser: false,
  projects: {
    dycrypt: { workspaces: ['/a'] },
    cawdev: { workspaces: ['/b', '/c'] },
  },
};

const plainBanner = (c, depth = 3) =>
  stripAnsi(bannerLines(c, painter(depth)).join('\n'));

// --- the launch banner --------------------------------------------------------

test('the banner carries the settings that decide what the machine does', () => {
  const said = plainBanner(config);
  assert.match(said, /http:\/\/localhost:8091/, 'which cawdev this is');
  assert.match(said, /macbook/, 'the name runs are claimed under');
  assert.match(said, /dycrypt\s+1 checkout/);
  assert.match(said, /cawdev\s+2 checkouts/, "R47's per-project ceiling");
  // R70's second number is gone with R109's `maxSessions` — it bounded
  // PROCESSES, and a delegated expert runs inside its parent's session and
  // costs none. The line outlived the setting and printed `undefined sessions`
  // on every config that did not still carry one, which is most of them and
  // all of the ones R93 generates.
  assert.match(said, /2 checkouts, so 2 coding runs/, 'what the per-project number caps');
  assert.match(said, /1 checkout, so 1 coding run\b/, 'and it counts in ones too');
  assert.match(said, /one coding run per checkout/, 'the only gate there is');
});

test('the banner says nothing about a setting that no longer exists', () => {
  // The failure this replaces: `String(undefined)` reads as a misconfiguration
  // on a machine that has none, and it was the first line of a log that ended
  // in a run dying for an unrelated reason.
  for (const c of [config, { ...config, maxSessions: undefined }]) {
    assert.doesNotMatch(plainBanner(c), /undefined/,
      'a banner is what somebody reads first when something is wrong');
  }
});

test('the browser line is there when it is off, because that is the question', () => {
  // A line that only appears when enabled cannot answer "why did the run say
  // it could not look at the page".
  assert.match(plainBanner(config), /browser\s+off/);
  assert.match(plainBanner({ ...config, browser: true }), /browser\s+allowed/);
});

test('a machine serving nothing says so rather than showing a gap', () => {
  assert.match(plainBanner({ ...config, projects: {} }), /serving\s+nothing/);
});

test('with colour off the banner is still the same information', () => {
  const said = bannerLines(config, painter(0)).join('\n');
  assert.equal(stripAnsi(said), said, 'no escapes should survive');
  assert.match(said, /http:\/\/localhost:8091/);
  assert.match(said, /cawdev\s+2 checkouts/);
  // The mark cannot be drawn in one colour, so it says the name instead.
  assert.match(said, /cawdev — the runner/);
});

test('the mark is a glyph and the wordmark, on one line', () => {
  // Deliberately not ASCII art. The crow was drawn in half blocks first, three
  // rows tall, rendered and looked at: at cell resolution the rows do not
  // touch, so it reads as three violet bars, and the eye punches a hole that
  // splits it in two. One line is what a character cell can honestly hold.
  const drawn = mark(painter(3));
  assert.equal(drawn.length, 1);
  assert.match(stripAnsi(drawn[0]), /●▸\s+cawdev/);
  assert.match(stripAnsi(mark(painter(3), { tagline: 'the runner' })[0]), /the runner$/);
});

test('without colour the mark says its name instead of drawing a dot', () => {
  assert.equal(oneLine(painter(0)), 'cawdev');
  assert.deepEqual(mark(painter(0)), ['cawdev']);
  assert.deepEqual(mark(painter(0), { tagline: 'the runner' }), ['cawdev — the runner']);
});

// --- the log's colour ---------------------------------------------------------

const tint = (line) => {
  const ink = painter(3);
  const painted = tintLog(line, ink);
  for (const [name, sample] of Object.entries({
    danger: ink.danger('x'), warn: ink.warn('x'), accent: ink.accent('x'),
    success: ink.success('x'), muted: ink.muted('x'),
  })) {
    if (painted.startsWith(sample.slice(0, sample.indexOf('x')))) return name;
  }
  return 'none';
};

test('a benign line that contains the word "failed" is not painted as a failure', () => {
  // `fetch skipped: git fetch --prune origin failed: no origin` happens on
  // every survey of every scratch checkout, and it is fine. Painting it red
  // teaches people that red means nothing, which costs more than no colour.
  assert.equal(tint('  git survey: fetch skipped: git fetch --prune origin failed'), 'muted');
  assert.equal(tint('  agent exited (code 0, signal none)'), 'muted');
});

test('a real failure is', () => {
  assert.equal(tint('  failed: git checkout r62 failed'), 'danger');
  assert.equal(tint('  agent exited (code 1, signal none)'), 'danger');
  assert.equal(tint('  could not read the working copy'), 'danger');
});

test('waiting is a warning, not a failure', () => {
  assert.equal(tint('  no free workspace in cawdev (2 here, all busy)'), 'warn');
  assert.equal(tint('  at 4 sessions'), 'muted');
});

test('every line still reads with the colour taken away', () => {
  const ink = painter(0);
  for (const line of ['failed: x', 'no free workspace', 'claiming cawdev']) {
    assert.equal(tintLog(line, ink), line);
  }
});

// --- what the top bar counts --------------------------------------------------

const runner = {
  url: 'http://localhost:8091',
  projects: ['dycrypt', 'cawdev'],
  workspaces: { dycrypt: 1, cawdev: 2 },
  maxSessions: 4,
};

test('a queued run is not a session, which is the whole point of the count', () => {
  // Counting it would make the bar say the machine is full at the moment it is
  // not — and "full" is the answer to "why is mine queued".
  const counts = sessionCounts(runner, [
    { projectSlug: 'cawdev', state: 'running' },
    { projectSlug: 'cawdev', state: 'queued' },
  ]);
  assert.equal(counts.total, 1);
  assert.equal(counts.projects.find((p) => p.slug === 'cawdev').count, 1);
  assert.equal(counts.projects.find((p) => p.slug === 'cawdev').full, false);
});

test('a project is full when its checkouts are, not when the machine is', () => {
  const counts = sessionCounts(runner, [
    { projectSlug: 'cawdev', state: 'running' },
    { projectSlug: 'cawdev', state: 'running' },
  ]);
  const cawdev = counts.projects.find((p) => p.slug === 'cawdev');
  assert.equal(cawdev.full, true, 'both checkouts are busy');
  assert.equal(counts.total, 2, 'but the machine has room for four');
  assert.equal(counts.projects.find((p) => p.slug === 'dycrypt').count, 0);
});

test('a question is a session on this machine, and not one of the checkouts', () => {
  // R70. The per-project number is a count of checkouts, and an ASK is given
  // none — so counting it there rendered `cawdev 2/1` in warning colour, a
  // project over a limit it was never measured against. It still counts on the
  // right, because `maxSessions` is what it IS held back by.
  const counts = sessionCounts(runner, [
    { projectSlug: 'cawdev', state: 'running', writesCode: true },
    { projectSlug: 'cawdev', state: 'running', writesCode: false },
    { projectSlug: 'cawdev', state: 'claiming', writesCode: false },
  ]);
  const cawdev = counts.projects.find((p) => p.slug === 'cawdev');
  assert.equal(cawdev.count, 1, 'one coding session, in one of the two checkouts');
  assert.equal(cawdev.full, false, 'the spare checkout is still spare');
  assert.equal(counts.total, 3, 'but three sessions are running here');
});

test('an older daemon sends no workspace counts, and nothing is invented', () => {
  // Talking to a daemon from before R62. There is nothing to compare against,
  // so the count stands alone rather than being shown over a guess.
  const counts = sessionCounts({ projects: ['cawdev'], maxSessions: 4 }, [
    { projectSlug: 'cawdev', state: 'running' },
  ]);
  assert.equal(counts.projects[0].room, undefined);
  assert.equal(counts.projects[0].full, false);
});

test('a machine with nothing running reads as empty, not as unknown', () => {
  const counts = sessionCounts(runner, []);
  assert.equal(counts.total, 0);
  assert.deepEqual(counts.projects.map((p) => p.count), [0, 0]);
});

// --- the bar's arithmetic, which is where the bugs are ------------------------

const bar = (width, runs = [], who = runner) =>
  stripAnsi(settingsBar(who, runs, width, painter(3)));

test('the bar is exactly the width it was given, coloured or not', () => {
  // Everything on this row is coloured, and a coloured string is about ten
  // characters longer than it looks. Padding by `length` is what put
  // "2/2sessions" on screen with no space the first time this was rendered.
  for (const width of [120, 100, 80, 64, 40, 24]) {
    assert.equal(bar(width).length, width, `at ${width} columns`);
  }
});

test('a wide bar shows the URL, every project, and the total', () => {
  const line = bar(100, [{ projectSlug: 'cawdev', state: 'running' }]);
  assert.match(line, /http:\/\/localhost:8091/);
  assert.match(line, /dycrypt 0\/1/);
  assert.match(line, /cawdev 1\/2/);
  assert.match(line, /sessions 1\/4\s*$/);
});

test('a narrow bar drops projects, never the total', () => {
  // The total is the number that answers "why is mine waiting" on a machine at
  // its cap, so it is the last thing to go.
  const line = bar(46, [{ projectSlug: 'cawdev', state: 'running' }]);
  assert.match(line, /sessions 1\/4/, 'the total survived');
  assert.equal(line.length, 46);
});

test('a truncated project list says it was truncated', () => {
  const wide = bar(100);
  const narrow = bar(58);
  assert.ok(!wide.includes('…'), 'nothing was dropped at 100 columns');
  assert.ok(narrow.includes('…'), `expected an ellipsis at 58 columns: ${narrow}`);
});
