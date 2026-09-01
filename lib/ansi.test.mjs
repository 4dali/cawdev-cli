// node --test tools/lib/ansi.test.mjs
//
// R62. What is worth pinning here is not that colours are pretty — it is that
// the tool stays usable where colour is unwanted or impossible, and that
// anything which lines up keeps lining up once something in it goes red.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colourDepth, painter, padVisible, stripAnsi, visibleWidth } from './ansi.mjs';

const tty = { isTTY: true };
const pipe = { isTTY: false };

test('a pipe gets no colour, so a log file stays a log file', () => {
  assert.equal(colourDepth({ TERM: 'xterm-256color' }, pipe), 0);
});

test('NO_COLOR wins on its presence, whatever it is set to', () => {
  // no-color.org: the variable existing is the signal. An empty string is the
  // usual way people set it, and treating that as falsy is the classic bug.
  for (const value of ['', '0', 'false', '1']) {
    assert.equal(
      colourDepth({ NO_COLOR: value, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, tty),
      0,
      `NO_COLOR=${JSON.stringify(value)} should silence colour`,
    );
  }
});

test('FORCE_COLOR turns it back on where there is no TTY', () => {
  // For output that is piped somewhere which does understand escapes — a file
  // to be read with `less -R`, a CI log viewer.
  assert.equal(colourDepth({ FORCE_COLOR: '3' }, pipe), 3);
  assert.equal(colourDepth({ FORCE_COLOR: '' }, pipe), 3);
  assert.equal(colourDepth({ FORCE_COLOR: '0' }, pipe), 0);
});

test('a dumb terminal is treated as no terminal', () => {
  assert.equal(colourDepth({ TERM: 'dumb' }, tty), 0);
});

test('truecolor when advertised, the cube when only 256 is', () => {
  assert.equal(colourDepth({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }, tty), 3);
  assert.equal(colourDepth({ TERM: 'xterm-256color' }, tty), 2);
  assert.equal(colourDepth({ TERM: 'xterm' }, tty), 1);
});

test('a disabled painter returns the text and nothing else', () => {
  // The whole promise of degrading: no stray escapes in a file somebody greps.
  const ink = painter(0);
  assert.equal(ink.enabled, false);
  assert.equal(ink.danger('failed'), 'failed');
  assert.equal(ink.bold(ink.muted('x')), 'x');
  assert.equal(stripAnsi(ink.accent('http://x')), 'http://x');
});

test('every depth still says the same words', () => {
  for (const depth of [0, 1, 2, 3]) {
    assert.equal(stripAnsi(painter(depth).warn('no free workspace')), 'no free workspace');
  }
});

test('a near-grey uses the grey ramp, not the colour cube', () => {
  // Rounding a near-grey into the 6x6x6 cube gives it a cast, and on the dim
  // text this is mostly used for that reads as a broken terminal.
  const grey = painter(2).muted('x');
  const index = Number(/38;5;(\d+)/.exec(grey)[1]);
  assert.ok(index >= 232 && index <= 255, `expected the grey ramp, got ${index}`);
});

test('width is what shows, not what is written', () => {
  const painted = painter(3).danger('failed');
  assert.equal(visibleWidth(painted), 6);
  assert.ok(painted.length > 6, 'the escapes should make the string longer');
});

test('padding a coloured cell still lines the next column up', () => {
  // The bug this prevents: pad by .length, and a coloured cell is silently
  // about ten characters wide, so every column after it walks.
  const plain = padVisible('ok', 10);
  const painted = padVisible(painter(3).success('ok'), 10);
  assert.equal(visibleWidth(plain), 10);
  assert.equal(visibleWidth(painted), 10);
});

test('padding never truncates something already too wide', () => {
  assert.equal(padVisible('a very long value', 4), 'a very long value');
});
