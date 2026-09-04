// node --test tools/runner/scrollback.test.mjs
//
// R81 — the transcript is the terminal's, and only the footer is ours.
//
// The whole rewrite rests on one invariant: **after every write the cursor is
// at column 0 of the live region's first row, and everything below it is the
// live region.** Break it by one and the footer either eats a line of somebody's
// transcript or leaves a copy of itself behind on every update — and both look
// like the terminal being broken rather than like an off-by-one here.
//
// That invariant is arithmetic, which means it can be checked without a
// terminal: a fake stream, and a count of the escape codes that come out.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scrollback } from './scrollback.mjs';

/** A stdout that is a terminal, and remembers what it was asked to draw. */
function fakeTty({ columns = 80, rows = 24, isTTY = true } = {}) {
  const written = [];
  return {
    isTTY,
    columns,
    rows,
    write: (text) => written.push(text),
    on: () => undefined,
    get all() {
      return written.join('');
    },
    written,
  };
}

const upBy = (text) => {
  const move = /\x1b\[(\d+)A/.exec(text);
  return move ? Number(move[1]) : 0;
};

test('the cursor walks back over exactly as many rows as were drawn', () => {
  const out = fakeTty();
  const screen = new Scrollback(out);
  screen.live(['one', 'two', 'three']);

  assert.equal(upBy(out.all), 3, 'three rows drawn, three rows back');
  assert.ok(out.all.endsWith('\r'), 'and back to column 0');
});

test('a live line is clipped so it can never occupy two rows', () => {
  // The one rule the arithmetic depends on. A line that wraps takes two rows
  // and one row of cursor movement, and that difference is how a footer eats a
  // transcript one line at a time.
  const out = fakeTty({ columns: 20 });
  const screen = new Scrollback(out);
  screen.live(['x'.repeat(200)]);

  const drawn = out.all.split('\n')[0].replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  assert.equal(drawn.length, 20);
  assert.equal(upBy(out.all), 1);
});

test('printing erases the live region first, then commits, then redraws it', () => {
  const out = fakeTty();
  const screen = new Scrollback(out);
  screen.live(['footer']);
  out.written.length = 0;

  screen.print(['a line of transcript']);
  const drawn = out.all;

  assert.ok(drawn.startsWith('\x1b[0J'), 'the stale footer is erased before anything is written');
  assert.ok(drawn.includes('a line of transcript'), 'the line is committed to the scrollback');
  assert.ok(drawn.indexOf('a line of transcript') < drawn.indexOf('footer'),
    'and the footer is drawn under it, not over it');
  assert.equal(upBy(drawn), 1);
});

test('a committed line is never clipped — folding it is the terminal\'s job', () => {
  // Clipping here would freeze today's width into the copy somebody takes
  // tomorrow, and it is the copy that is the point of printing at all.
  const out = fakeTty({ columns: 20 });
  const screen = new Scrollback(out);
  screen.print(['y'.repeat(200)]);

  assert.ok(out.all.includes('y'.repeat(200)));
});

test('a live region taller than the window is cut to fit, keeping the bottom', () => {
  // Otherwise the cursor walks back over rows that scrolled off the top, and
  // every update writes the footer a little further into the transcript.
  const out = fakeTty({ rows: 6 });
  const screen = new Scrollback(out);
  screen.live(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);

  assert.equal(upBy(out.all), 5, 'one row is kept for whatever is committed next');
  assert.ok(out.all.includes('10'), 'and the bottom is what survives — the footer is at the bottom');
  assert.ok(!out.all.includes('\n1\n'), 'the top of an over-tall region is what goes');
});

test('the alternate screen is never entered', () => {
  // The entry, in one assertion. Entering it is what took the terminal's
  // scroll, wheel, search and copy away in the first place.
  const out = fakeTty();
  const screen = new Scrollback(out);
  screen.open();
  screen.print(['transcript']);
  screen.live(['footer']);
  screen.close();

  assert.ok(!out.all.includes('\x1b[?1049h'));
  assert.ok(!out.all.includes('\x1b[?1049l'));
});

test('closing erases the live region and leaves the transcript alone', () => {
  const out = fakeTty();
  const screen = new Scrollback(out);
  screen.print(['kept']);
  screen.live(['going']);
  out.written.length = 0;

  screen.close();
  assert.ok(out.all.includes('\x1b[0J'), 'the footer goes');
  assert.ok(out.all.includes('\x1b[?25h'), 'and the cursor comes back');
  assert.ok(!out.all.includes('kept'), 'nothing that was committed is touched');
});

test('through a pipe there is no live region at all', () => {
  // No cursor to move and nothing to pin to. The transcript is the whole
  // output, which is the honest degradation rather than a lesser one — and
  // crucially, no escape codes leak into a file somebody will read later.
  const out = fakeTty({ isTTY: false });
  const screen = new Scrollback(out, { colour: false });
  screen.open();
  screen.live(['footer']);
  screen.print([`${'\x1b[32m'}transcript`]);

  assert.equal(out.all, 'transcript\n');
  assert.ok(!out.all.includes('footer'), 'a footer pinned to nothing is a footer repeated for ever');
  assert.ok(!out.all.includes('\x1b'), 'and not one escape code in a file somebody will read later');
});

test('piping into something that understands colour keeps it, when asked', () => {
  // `FORCE_COLOR` is somebody piping into `less -R` or a CI log viewer. There
  // is still no cursor and still no live region — the two flags answer two
  // different questions, and conflating them is what makes one of the two
  // cases wrong.
  const out = fakeTty({ isTTY: false });
  const screen = new Scrollback(out, { colour: true });
  screen.print([`${'\x1b[32m'}green`]);

  assert.ok(out.all.includes('\x1b[32m'), 'the agent\'s own colour survives');
  assert.ok(out.all.endsWith('\x1b[0m\n'), 'and is closed, so it cannot bleed');
});

test('a resize redraws the live region and repairs nothing above it', () => {
  // Those lines are the terminal's now, and it has already reflowed them the
  // way it reflows every other line in its buffer. Touching them is what a
  // pane manager does, and this stopped being one.
  const out = fakeTty();
  const screen = new Scrollback(out);
  screen.print(['committed']);
  screen.live(['footer one', 'footer two']);
  out.written.length = 0;

  out.columns = 40;
  screen.resize();

  assert.ok(out.all.startsWith('\r'), 'back to a known column before erasing');
  assert.ok(!out.all.includes('committed'), 'nothing above the cursor is rewritten');
  assert.equal(upBy(out.all), 2);
});
