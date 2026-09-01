// node --test tools/runner/question-owner.test.mjs
//
// R58 — whose question the terminal is looking at.
//
// The terminal shows every question on the session it has selected, because
// this program's whole job is answering "why is that run not moving". What it
// offers depends on this rule: the `a` key, or a line naming the person it is
// waiting on. Offering the key anyway would turn "this is Alice's question"
// into "cawdev is broken", which is the failure this file exists to prevent.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { questionBanner, questionState, stripAnsi, visibleWidth } from './attach.mjs';

const ALICE = 'alice@cawdev.test';
const BOB = 'bob@cawdev.test';

const asked = (over = {}) => [{
  id: 'q1',
  question: 'Postgres or SQLite?',
  options: [],
  answered: false,
  waitingOnEmail: ALICE,
  shares: [],
  ...over,
}];

const share = (over = {}) => ({
  kind: 'DECIDE',
  open: true,
  sharedByEmail: ALICE,
  sharedWithEmail: BOB,
  takenOver: false,
  ...over,
});

test('nothing waiting is nothing to say', () => {
  assert.equal(questionState([], ALICE), null);
  assert.equal(questionState(undefined, ALICE), null);
  assert.equal(questionState(asked({ answered: true }), ALICE), null);
});

test('the person who started the run may answer it here', () => {
  const state = questionState(asked(), ALICE);
  assert.equal(state.yours, true);
  assert.equal(state.waitingOn, ALICE);
});

test('an operator who was not asked is told whose it is, not offered the key', () => {
  const state = questionState(asked(), BOB);
  assert.equal(state.yours, false);
  // The name is the point: this is the machine the session is running on, so
  // "why is that not moving" is answered here or nowhere.
  assert.equal(state.waitingOn, ALICE);
});

test('a question handed over is answerable by the person it went to', () => {
  const state = questionState(asked({ shares: [share()] }), BOB);
  assert.equal(state.yours, true);
});

test('a takeover reads as the hand-over it is written as', () => {
  const state = questionState(asked({ shares: [share({ takenOver: true })] }), BOB);
  assert.equal(state.yours, true);
});

test('a resolved share is not a standing permission', () => {
  const state = questionState(asked({ shares: [share({ open: false })] }), BOB);
  assert.equal(state.yours, false);
});

test('an opinion request is not the decision', () => {
  const state = questionState(asked({ shares: [share({ kind: 'OPINION' })] }), BOB);
  assert.equal(state.yours, false);
});

test('a run with no starter leaves its question open to the project', () => {
  // agent_run.started_by is NOT NULL, so this is the unreachable case — but a
  // question nobody owns must stay answerable rather than stall forever.
  const state = questionState(asked({ waitingOnEmail: null }), BOB);
  assert.equal(state.yours, true);
  assert.equal(state.waitingOn, null);
});

test('watching without signing in offers nothing, owner or not', () => {
  // `--watch-only`, or a sign-in that failed. There is no person here to be the
  // one who decided, which is the whole premise of a question.
  assert.equal(questionState(asked({ waitingOnEmail: null }), null).yours, false);
  assert.equal(questionState(asked(), null).yours, false);
});

// --- and what the banner then says ------------------------------------------

const banner = (yours, width = 80, waitingOn = ALICE) =>
  questionBanner(
    { question: asked()[0], yours, waitingOn },
    width,
  ).map(stripAnsi);

test('a question of yours offers the key that answers it', () => {
  const said = banner(true).join('\n');
  assert.match(said, /Postgres or SQLite\?/);
  assert.match(said, /a answer/);
});

test('a question that is not yours names who it is waiting on instead of a key', () => {
  const said = banner(false).join('\n');
  assert.match(said, new RegExp(`waiting on ${ALICE}`));
  assert.doesNotMatch(said, /a answer/, 'a key that would 403 must not be offered');
});

test('the name is the last thing to go when the terminal is narrow', () => {
  // The whole answer to "why is that run not moving" is the name. Truncating
  // the sentence instead spends the last columns on the clause and cuts the
  // answer — which is what looking at this at 40 columns showed.
  for (const width of [80, 60, 46, 40]) {
    assert.match(banner(false, width)[1], new RegExp(ALICE), `at ${width} columns`);
  }
});

test('no line is wider than the pane it is drawn in', () => {
  for (const width of [80, 46, 24]) {
    for (const yours of [true, false]) {
      for (const line of questionBanner({ question: asked()[0], yours, waitingOn: ALICE }, width)) {
        assert.ok(visibleWidth(line) <= width,
          `${visibleWidth(line)} > ${width}: ${stripAnsi(line)}`);
      }
    }
  }
});
