// node --test tools/runner/attach.test.mjs
//
// The rendering arithmetic, which is the part of a terminal UI that goes wrong
// silently. A transcript carries the agent's own ANSI colour (R23); measuring
// it as plain text makes every coloured line look forty characters longer than
// it is, and the pane wraps into nonsense exactly when a session is doing
// something worth watching.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clip, stripAnsi, visibleWidth, wrap } from './attach.mjs';

const RED = '\x1b[31m';
const OFF = '\x1b[0m';

test('width is what you can see, not what is in the string', () => {
  assert.equal(visibleWidth(`${RED}hello${OFF}`), 5);
  assert.equal(visibleWidth('hello'), 5);
  assert.equal(stripAnsi(`${RED}hello${OFF}`), 'hello');
});

test('wrapping counts visible characters and keeps the colour', () => {
  const wrapped = wrap(`${RED}abcdef${OFF}`, 3);
  assert.equal(wrapped.length, 2);
  assert.deepEqual(wrapped.map(stripAnsi), ['abc', 'def']);
  // The escape must survive: dropping it mid-wrap is how a red error line
  // turns the rest of the pane red.
  assert.ok(wrapped[0].includes(RED));
});

test('a line that fits is left exactly alone', () => {
  const line = `${RED}short${OFF}`;
  assert.deepEqual(wrap(line, 40), [line]);
});

test('newlines are paragraph breaks, not characters to wrap on', () => {
  assert.deepEqual(wrap('one\ntwo', 40), ['one', 'two']);
});

test('clipping never cuts an escape sequence in half', () => {
  const clipped = clip(`${RED}abcdef${OFF}`, 3);
  assert.equal(stripAnsi(clipped), 'abc');
  // Half an escape sequence is not a colour, it is three stray characters in
  // the middle of somebody's transcript.
  assert.ok(!/\x1b\[3$/.test(clipped));
  assert.ok(clipped.endsWith(OFF), 'a clipped line closes the colour it opened');
});

test('clipping leaves a short line alone', () => {
  assert.equal(clip('abc', 10), 'abc');
});
