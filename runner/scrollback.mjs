// The terminal's own scrollback, with a live region pinned under it — R81.
//
// **This replaces a pane manager rather than adding a framework.** The client
// used to take the alternate screen and repaint a viewport into it, which meant
// the terminal's scroll, its wheel, its search and its copy all stopped working
// the moment you attached, and the transcript above the fold was gone. Claude
// Code's CLI does not do that, and the difference is the one people notice.
//
// So: transcript lines are PRINTED. They go into the scrollback and are never
// touched again — which is what makes wheel, `shift+PgUp`, search and copy the
// terminal's job rather than ours. Only the last few lines and the footer are
// drawn, and they are the only thing that is ever erased.
//
// The whole mechanism is three escape sequences and one invariant:
//
//   **After every write, the cursor sits at column 0 of the live region's first
//   row, and everything below it belongs to the live region.**
//
// Which makes the update trivial: erase from the cursor down (`ESC[0J`), print
// whatever is being committed to the scrollback, print the live region, then
// walk back up by however many rows it took.
//
// The one rule that keeps that arithmetic honest: **every live line is clipped
// to the width.** A line that wraps occupies two rows and one row of cursor
// arithmetic, and the difference between those two numbers is how a footer
// eats a transcript. Committed lines are NOT clipped — they are the terminal's
// to wrap, and its to reflow when the window changes.

import { clip, colourDepth, stripAnsi } from '../lib/ansi.mjs';

const ESC = '\x1b';
const ERASE_DOWN = `${ESC}[0J`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const RESET = `${ESC}[0m`;

export class Scrollback {
  /**
   * @param out where to write. `process.stdout` in the real thing; anything
   *   with `write` in a test, which is how the arithmetic below is checked
   *   without a terminal.
   */
  constructor(out = process.stdout, { colour = colourDepth(process.env, out) > 0 } = {}) {
    this.out = out;
    this.drawn = 0;
    this.pinned = [];
    // A pipe, a `less`, a CI log. There is no cursor to move and no region to
    // pin, so the live region simply stops existing and the transcript is the
    // whole output — which is the honest degradation, not a lesser one.
    this.tty = Boolean(out.isTTY);
    // **Two flags, because they are two questions.** `tty` is about a cursor;
    // this is about escape codes, and `FORCE_COLOR` is somebody piping into
    // something that does understand them. Where it is off, a committed line is
    // stripped rather than merely un-tinted: the transcript carries the AGENT'S
    // colour (R23), which our own painter has no say over, and a file full of
    // `ESC[32m` is not what "legible through a pipe" means.
    this.colour = colour;
  }

  get width() {
    return this.out.columns ?? 80;
  }

  get height() {
    return this.out.rows ?? 24;
  }

  /** Takes the cursor. The alternate screen is deliberately NOT entered. */
  open() {
    if (this.tty) {
      this.out.write(HIDE_CURSOR);
    }
  }

  /**
   * Commit lines to the scrollback and replace what is pinned, in one write.
   *
   * **One call rather than two, and that is not tidiness.** Printing a line and
   * then setting the footer is two erase-and-redraw cycles per line: on a
   * session emitting a few hundred lines a second the terminal spends its time
   * on escape codes, and — worse — the footer drawn by the first of the two is
   * the *previous* one, so a stale prompt line flashes under everything that is
   * printed. Both were visible in a real terminal.
   *
   * Committed lines are not clipped and not wrapped: a long line is the
   * terminal's to fold, and folding it here would freeze today's width into the
   * copy somebody takes tomorrow.
   */
  update(lines = [], live = this.pinned) {
    this.pinned = live ?? [];
    this.#write(Array.isArray(lines) ? lines : [lines], this.pinned);
  }

  /** Commit lines under whatever is already pinned. */
  print(lines) {
    this.update(lines, this.pinned);
  }

  /** Replace what is pinned at the bottom. */
  live(lines) {
    this.update([], lines ?? []);
  }

  /**
   * The window changed shape.
   *
   * Nothing is repaired above the cursor, and that is the point: those lines
   * are the terminal's now, and it has already reflowed them the way it
   * reflows every other line in the buffer. Only the live region is redrawn.
   */
  resize() {
    if (!this.tty) return;
    this.out.write('\r');
    this.drawn = 0;
    this.#write([], this.pinned);
  }

  /** Give the terminal back, leaving the transcript where it is. */
  close() {
    if (!this.tty) return;
    this.out.write(`${ERASE_DOWN}${SHOW_CURSOR}`);
    this.drawn = 0;
  }

  /** A line as it should be committed: closed if coloured, plain if not. */
  #commit(line) {
    return this.colour ? `${line}${RESET}\n` : `${stripAnsi(line)}\n`;
  }

  #write(committed, live) {
    if (!this.tty) {
      // No region, so nothing to erase and nothing to walk back over.
      if (committed.length) {
        this.out.write(committed.map((line) => this.#commit(line)).join(''));
      }
      return;
    }

    // A live region taller than the window would scroll the transcript off the
    // top and leave the cursor arithmetic pointing at rows that are no longer
    // there. One row is kept for whatever is committed next.
    const shown = live.slice(-Math.max(1, this.height - 1)).map((line) => clip(line, this.width));

    let out = ERASE_DOWN;
    for (const line of committed) {
      out += this.#commit(line);
    }
    for (const line of shown) {
      out += `${line}${RESET}\n`;
    }
    if (shown.length) {
      out += `${ESC}[${shown.length}A`;
    }
    out += '\r';
    this.out.write(out);
    this.drawn = shown.length;
  }
}
