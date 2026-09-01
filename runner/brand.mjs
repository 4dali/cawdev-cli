// The cawdev mark, in a terminal — R62.
//
// **Not ASCII art.** The first version of this drew the crow from
// `cawdev-mark.svg` in half blocks, three rows tall, and it was rendered and
// looked at: at cell resolution the head does not cohere. The rows do not
// touch, so it reads as three violet bars, and the white eye punches a hole
// that splits it into two. Six variants, all the same verdict.
//
// So the mark here is the mark reduced to what a character cell can honestly
// hold: the violet head and the amber beak, `●▸`, beside the wordmark. That is
// the same reduction a favicon makes at 16px, and it is what the CLIs this
// sits beside do — a glyph and clean type, not a picture of a bird.
//
// `●` is U+25CF, Geometric Shapes, which every monospace font ships. The
// larger `⬤` (U+2B24) looked better in a comparison and is in a block with
// patchy coverage — and a missing glyph renders as a box, which looks broken
// rather than plain. Not worth it.
//
// The two colours are `cawdev-mark.svg`'s own: `#4B3FD4` and `#F0A22E`. If the
// mark changes, this is the one place that has to follow it.

import { painter } from '../lib/ansi.mjs';

/** `caw` heavy, `dev` light — the wordmark's own construction, from R53. */
function wordmark(ink) {
  return `${ink.bold('caw')}${ink.muted('dev')}`;
}

/** The head and the beak. Nothing without colour, where it would be a dot. */
function glyph(ink) {
  return ink.enabled ? `${ink.violet('●')}${ink.amber('▸')}` : '';
}

/**
 * The launch form: the mark, the name, and what this program is.
 *
 * Returned as lines rather than printed, so a caller can indent it, box it or
 * measure it without this file knowing anything about the layout it goes into.
 */
export function mark(ink = painter(), { tagline = '' } = {}) {
  const after = tagline ? `   ${ink.muted(tagline)}` : '';
  if (!ink.enabled) {
    return [tagline ? `cawdev — ${tagline}` : 'cawdev'];
  }
  return [`  ${glyph(ink)}  ${wordmark(ink)}${after}`];
}

/** One line, for a bar that has a few columns to spare. */
export function oneLine(ink = painter()) {
  if (!ink.enabled) return 'cawdev';
  return `${glyph(ink)} ${wordmark(ink)}`;
}

/** For anything that is not a terminal. */
export function plain() {
  return 'cawdev';
}
