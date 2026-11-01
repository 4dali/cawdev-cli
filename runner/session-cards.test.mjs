// node --test tools/runner/session-cards.test.mjs
//
// Advanced mode's cards (session-cards.mjs): the grid, one card at several
// sizes, what a card says about where its session stands, and the rain —
// pure, so each is rendered and READ.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { painter, stripAnsi, visibleWidth } from '../lib/ansi.mjs';
import {
  CARD_MAX_HEIGHT, CARD_MIN_HEIGHT, ROBOT_SIGN, cardGrid, cardStatus, elapsed, mergingRobotLines, nowLine, rainLines, robotLines,
  seedOf, sessionCardLines, stageWalk,
} from './session-cards.mjs';

const ink = painter(0);
const glyphs = (rows) => rows.join('').replace(/\s/g, '').length;

test('the grid: as many columns as fit (three at most), rows as tall as the room allows', () => {
  const four = cardGrid(100, 16, 4);
  assert.equal(four.zones.length, 4);
  assert.deepEqual(four.zones.map(({ top, left }) => [top, left]), [[0, 0], [0, 50], [8, 0], [8, 50]]);
  assert.equal(four.height, 16);

  assert.equal(new Set(cardGrid(140, 16, 4).zones.map((zone) => zone.left)).size, 3, 'three across at 140');
  assert.equal(new Set(cardGrid(300, 16, 9).zones.map((zone) => zone.left)).size, 3, 'never more than three');
  assert.equal(cardGrid(100, 40, 1).zones[0].height, CARD_MAX_HEIGHT, 'a tall screen gives the rest to the prompt');
  assert.equal(cardGrid(100, 40, 1).zones[0].width, 100, 'one card takes the width');

  const narrow = cardGrid(60, 12, 4);
  assert.equal(narrow.zones.length, 2, 'one column, two rows of six');
  assert.equal(narrow.hidden, 2, 'the rest counted for the tab line');
  assert.deepEqual(cardGrid(100, CARD_MIN_HEIGHT - 1, 3), { zones: [], hidden: 3, height: 0 });
});

test('a card is exactly its rectangle at every size, rain or not, footer or not', () => {
  for (const width of [30, 38, 50, 120]) {
    for (const height of [CARD_MIN_HEIGHT, 8, CARD_MAX_HEIGHT]) {
      for (const [rain, footer] of [[true, ''], [false, '/pr opens the pull request · /close']]) {
        const lines = sessionCardLines({ width, height }, {
          n: 3, profile: 'CODE', title: 'R42 Payments refund flow, partial and whole',
          status: { key: 'running', mark: '●', word: 'running · 12m' },
          lines: ['Claude · Opus 5.5 ▸ saasng', 'plan ✓ ─ implement ●', 'now: Bash npm test'],
          footer, seed: 7, tick: 3, rain,
        }, ink);
        assert.equal(lines.length, height, `${width}×${height}`);
        lines.forEach((line, i) => assert.equal(visibleWidth(line), width, `${width}×${height} row ${i}: ${stripAnsi(line)}`));
      }
    }
  }
});

test('the title gives way before the status does, and says it was cut', () => {
  const [top] = sessionCardLines({ width: 50, height: 6 }, {
    n: 1, profile: 'PLAN', title: 'i45 Token leak in the request logs',
    status: { key: 'waiting', mark: '◆', word: 'waiting on you' }, focused: true,
  }, ink);
  assert.match(stripAnsi(top), /^┏━ 1  PLAN  i45 Token leak… ━+ ◆ waiting on you ━┓$/);
});

test('where a session stands: waiting on you first, then queued, running, and how it ended', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const running = { state: 'running', startedAt: '2026-10-30T11:48:00Z' };
  assert.deepEqual(cardStatus(running, null, now), { key: 'running', mark: '●', word: 'running · 12m' });
  assert.equal(cardStatus(running, 'waiting on you', now).key, 'waiting', 'waiting beats running');
  assert.equal(cardStatus({ state: 'queued' }).key, 'queued');
  assert.equal(cardStatus({ ended: true, view: { state: 'FINISHED', profile: 'CODE' } }).key, 'done');
  assert.equal(cardStatus({ ended: true, commits: 0, view: { state: 'FINISHED', profile: 'CODE' } }).key, 'idle',
    'finished having built nothing is not done');
  assert.deepEqual(cardStatus({ ended: true, view: { state: 'FINISHED', profile: 'PLAN' } }),
    { key: 'planned', mark: '✓', word: 'planned' }, 'a finished plan is a card planned');
  assert.deepEqual(cardStatus({ ended: true, view: { state: 'FAILED' } }), { key: 'stopped', mark: '✕', word: 'failed' });
  assert.equal(cardStatus({ ended: true, view: null }).key, 'ended', 'an outcome not read yet claims nothing');
  assert.deepEqual([elapsed(42_000), elapsed(12 * 60_000), elapsed(125 * 60_000)], ['42s', '12m', '2h05']);
});

test('the stage walk says the one it is on, and folds to a count when it does not fit', () => {
  const stages = ['PLAN', 'IMPLEMENT', 'TEST', 'VERIFY'];
  assert.equal(stageWalk(stages, 'IMPLEMENT', 80, ink), 'plan ✓ ─ implement ● ─ test ○ ─ verify ○');
  assert.equal(stageWalk(stages, 'IMPLEMENT', 20, ink), 'stage 2 of 4 · implement');
  assert.equal(stageWalk(null, 'IMPLEMENT', 80, ink), '', 'an unstaged run has no walk');
});

test('the now line is the last act, never the log, and nothing in it can drive the terminal', () => {
  const lines = [
    { kind: 'ASSISTANT', body: 'Reading the schema first.' },
    { kind: 'TOOL', body: 'Read schema.sql' },
    { kind: 'ASSISTANT', body: 'Three tables.' },
  ];
  assert.equal(nowLine({ state: 'running' }, lines), 'now: Read schema.sql');
  assert.equal(nowLine({ state: 'running' }, lines.slice(0, 1)), 'said: Reading the schema first.');
  assert.equal(nowLine({ state: 'running' }, []), 'starting…');
  assert.equal(nowLine({ state: 'queued', why: 'the checkout is busy' }), 'waiting — the checkout is busy');
  assert.equal(nowLine({ ended: true, view: { state: 'FAILED', exitSummary: '\n  no token\nmore' } }), 'why: no token');
  assert.equal(nowLine({ state: 'running' }, [{ kind: 'TOOL', body: 'Bash \x1b]0;owned\x07echo\x1b[2J' }]), 'now: Bash ]0;ownedecho');
});

test('the rain is the same drops for the same session and tick, moves while running, and is still once ended', () => {
  const at = (tick, mood = 'running', seed = seedOf('run-1')) => rainLines(40, 6, { seed, tick, mood }, ink);
  assert.deepEqual(at(5), at(5));
  assert.notDeepEqual(at(5), at(6), 'a running card moves every tick');
  assert.notDeepEqual(at(5), at(5, 'running', seedOf('run-2')), 'each session its own rain');
  assert.deepEqual(at(5, 'ended'), at(50, 'ended'), 'an ended one whose outcome is unknown does not move');
  for (const mood of ['running', 'waiting', 'queued', 'done', 'idle', 'stopped', 'ended']) {
    at(9, mood).forEach((line) => assert.equal(visibleWidth(line), 40, mood));
  }
  const many = (mood) => [...Array(30).keys()].reduce((sum, tick) => sum + glyphs(at(tick, mood)), 0);
  assert.ok(many('running') > many('queued'), 'a queued card is sparser than a running one');
});

test('the rain is coloured by the status, and its runs are painted once', () => {
  const colours = painter(3);
  const rows = rainLines(30, 5, { seed: 3, tick: 4, mood: 'stopped' }, colours);
  const red = colours.danger('x').split('x')[0];
  assert.ok(rows.join('').includes(red), 'a stopped card rains red');
  // A run costs at most four escapes (dim, colour, two resets) however long it is.
  const escapes = rows.join('').split('\x1b[').length - 1;
  assert.ok(escapes <= glyphs(rows.map(stripAnsi)) * 4, 'never more than one paint per glyph');
});

test('a planned card has a robot instead of rain: it paces, waves and holds up the sign', () => {
  const at = (tick, rows = 4, still = false) => robotLines(40, rows, { tick, still }, ink);
  for (const rows of [1, 2, 3, 6]) {
    const lines = at(5, rows);
    assert.equal(lines.length, rows);
    lines.forEach((line) => assert.equal(visibleWidth(line), 40, `${rows} rows`));
    assert.ok(lines.join('').includes(ROBOT_SIGN), `${rows} rows: the sign`);
    assert.ok(lines.join('').includes('[o_o]'), `${rows} rows: the head`);
  }
  const [blank, head, arms, legs] = at(0);
  assert.equal(blank.trim(), '', 'it stands on the card\'s last rows');
  assert.match(head, /^ \[o_o\] ✓ plan done/);
  assert.match(arms, /^ (\\\[_\]\/|\/\[_\]\\)/);
  assert.match(legs, /^ ( \/ \\ | \| \| )/);
  assert.notDeepEqual(at(0), at(40), 'it walks');
  assert.ok(at(40)[1].indexOf('[') > at(0)[1].indexOf('['), 'to the right first');
  assert.match(at(22)[1], /\[-_-\]/, 'and blinks now and then');
  assert.deepEqual(at(0, 4, true), at(99, 4, true), '/matrix off: it stands still');

  const card = sessionCardLines({ width: 50, height: 9 }, {
    n: 1, profile: 'PLAN', title: 'R2 Push notifications',
    status: cardStatus({ ended: true, view: { state: 'FINISHED', profile: 'PLAN' } }),
    lines: ['Claude · Opus 5.5 ▸ saasng'], tick: 3, rain: false,
  }, ink).map(stripAnsi).join('\n');
  assert.match(card, /✓ planned/);
  assert.match(card, /\[o_o\] ✓ plan done/, 'with the rain off the robot stays, standing');
  assert.doesNotMatch(card, /[ｱ-ﾝ]/, 'no rain on a planned card');
});

test('a merging card has its own robot: it carries the branch to the base, and stands still with the rain off', () => {
  const at = (tick, rows = 4, still = false) => mergingRobotLines(44, rows, { tick, still, base: 'main' }, ink);
  for (const rows of [1, 2, 3, 6]) {
    const lines = at(7, rows);
    assert.equal(lines.length, rows);
    lines.forEach((line) => assert.equal(visibleWidth(line), 44, `${rows} rows`));
    assert.ok(lines.join('').includes('▶ main'), `${rows} rows: where it goes`);
    assert.ok(lines.join('').includes('[■]'), `${rows} rows: what it carries`);
  }
  const [, head, arms] = at(0);
  assert.match(head, /^ \[>_>\]/, 'looking ahead, not the planned robot\'s [o_o]');
  assert.match(arms, /^ \/\[_\]=\[■\] +▶ main$/, 'the base stays at the right edge');
  assert.ok(at(20)[1].indexOf('[') > at(0)[1].indexOf('['), 'it walks to the base');
  assert.deepEqual(at(0, 4, true), at(31, 4, true), '/matrix off: it stands still');
});
