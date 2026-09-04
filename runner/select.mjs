// One select widget, written once — R83.
//
// **The CLI was the one surface that threw the agent's options away.**
// `ask_user` has carried `options` since R10 — the agent has usually already
// worked out the two or three answers it can act on — and the console renders
// them as buttons. Here the question printed and you retyped one of them,
// spelled correctly. A permission request had the same shape and the same
// problem: R60's three answers were three single keys bolted to the side of a
// scrolling transcript rather than a thing you look at and choose from.
//
// So there is ONE of these and everything that offers a choice is it: the
// question picker, the permission decision, and R81's `L` run overlay, which
// stops being its own code. A second implementation of "a cursor, some rows and
// a window that walks" is a second place for the arithmetic to be wrong by one.
//
// Three rules the widget keeps:
//
//   1. **It draws into R81's live region and never rewrites the scrollback.**
//      `lines()` returns rows; the client pins them. Nothing here writes.
//   2. **Getting to free text costs one key.** `ask_user` says people can still
//      answer in prose because the options are the agent's GUESS at the shape of
//      the decision, and the whole value of asking a person is that they can say
//      the thing that was not on the list. So the last row opens a line editor,
//      and Esc from there comes back to the list rather than abandoning the
//      answer.
//   3. **Where there is no cursor to move it is a numbered list read from
//      stdin** — a plain prompt, not a broken repaint. {@link plainLines} and
//      {@link pickFromLine} are that path, and they are the same rows.
//
// Pure, and rendered from a plain object, for R62's reason: a widget built
// inside a draw method can only be checked by looking at it, and three of R81's
// five layout bugs were found by rendering at four widths and READING them.

import { clip, keyList, painter, visibleWidth } from '../lib/ansi.mjs';

const ESC = '\x1b';

/** The row that is always last on a question, and what choosing it means. */
export const WRITE_MY_OWN = '__write-my-own__';

// Arrows, and the keys people who live in a terminal press instead of arrows.
// Tab is here because R81's run list took it and taking it away would be a
// regression nobody asked for.
const DOWN = new Set([`${ESC}[B`, `${ESC}OB`, '\t', '\x0e', 'j']);
const UP = new Set([`${ESC}[A`, `${ESC}OA`, `${ESC}[Z`, '\x10', 'k']);

/**
 * A choice: a title, some rows, and a cursor.
 *
 * `kind` is for the caller — it is what tells the client whether a chosen row is
 * an answer, a decision or a run to watch. The widget itself does not care.
 */
export class Select {
  constructor({ kind = 'choice', title = '', rows = [], at = 0, empty = null, hint = null }) {
    this.kind = kind;
    this.title = title;
    this.rows = rows;
    this.empty = empty;
    this.hint = hint;
    this.at = Math.max(0, Math.min(at, Math.max(0, rows.length - 1)));
  }

  get row() {
    return this.rows[this.at] ?? null;
  }

  /** Whether the last row opens a line editor — rule 2 above. */
  get freeText() {
    return this.rows.some((row) => row.id === WRITE_MY_OWN);
  }

  move(by) {
    if (!this.rows.length) {
      this.at = 0;
      return;
    }
    this.at = (this.at + by + this.rows.length) % this.rows.length;
  }

  /**
   * One key, and what it settled.
   *
   * Returns null for a key that means nothing here, so the caller can decide
   * whether it means something to IT — which is how the single permission keys
   * keep working while the picker is open.
   *
   * **A digit chooses rather than merely moving.** It is the only key on this
   * widget that is faster than the arrows, and making it a two-step would spend
   * the whole reason somebody reached for it.
   */
  key(pressed) {
    if (pressed === ESC) {
      return { done: 'cancelled', row: null };
    }
    if (pressed === '\r' || pressed === '\n') {
      return { done: 'chosen', row: this.row };
    }
    if (DOWN.has(pressed)) {
      this.move(1);
      return { done: null, moved: true };
    }
    if (UP.has(pressed)) {
      this.move(-1);
      return { done: null, moved: true };
    }
    if (/^[1-9]$/.test(pressed)) {
      const at = Number(pressed) - 1;
      if (at < this.rows.length) {
        this.at = at;
        return { done: 'chosen', row: this.rows[at] };
      }
      return null;
    }
    return null;
  }

  lines(width, ink = painter(3), room = 8) {
    return selectLines(this, width, ink, room);
  }
}

/**
 * The widget, drawn.
 *
 * The window walks with the cursor rather than the list scrolling under it: a
 * machine with twenty runs should still show the one you are on, and a question
 * with a dozen options should still show the one about to be chosen.
 */
export function selectLines(select, width, ink = painter(3), room = 8) {
  const lines = [];
  if (select.title) {
    lines.push(clip(` ${ink.muted(select.title)}`, width));
  }
  if (!select.rows.length) {
    lines.push(clip(`  ${ink.muted(select.empty ?? 'nothing to choose from')}`, width));
  }

  const shown = Math.max(1, Math.min(select.rows.length, room));
  const from = Math.max(0, Math.min(select.at - Math.floor(shown / 2), select.rows.length - shown));
  select.rows.slice(from, from + shown).forEach((row, offset) => {
    const at = from + offset;
    lines.push(rowLine(row, {
      chosen: at === select.at,
      marker: row.marker ?? ' ',
      // Past nine there is no digit to offer, and a number nobody can press is
      // worse than a space.
      number: at < 9 ? String(at + 1) : ' ',
    }, width, ink));
  });
  if (select.rows.length > shown) {
    lines.push(clip(`  ${ink.muted(`… ${select.rows.length - shown} more`)}`, width));
  }

  lines.push(hintLine(select, width, ink));
  return lines;
}

/**
 * What to press.
 *
 * **`esc leave` has its room reserved rather than taking its chances.**
 * {@link keyList} drops whole keys from the right, which is the correct
 * behaviour and would drop exactly the wrong one here: leaving is the key
 * somebody reaches for when they do not want any of this, and it is the last
 * thing that should go when the terminal is narrow. So the others are given
 * what is left over and it is written after them, in the order somebody reads.
 * It is the same rule R51's banner keeps about `n refuse`.
 */
function hintLine(select, width, ink) {
  const leave = ink.muted('esc leave');
  const room = width - visibleWidth(leave) - 4;
  if (room < 10) {
    return clip(` ${leave}`, width);
  }
  const keys = [ink.muted('↑↓ move'), ink.muted('enter choose')];
  if (select.rows.length > 1) {
    keys.push(ink.muted('1-9 pick'));
  }
  if (select.hint) {
    keys.push(ink.muted(select.hint));
  }
  return clip(` ${keyList(keys, '', room, ink)}${ink.muted(' · ')}${leave}`, width);
}

/**
 * One row, and what gives way when there is not enough of it.
 *
 * A row may bring its own renderer — `runLine` narrows a run's LABEL and keeps
 * the reason it is queued, which is R58's lesson about which half should survive
 * and is not a rule a generic row could guess. Everything else is a label, a
 * `short` wording of it, and a hint beside it, and they give way in that order:
 *
 *   1. **The hint goes first.** It is a gloss; the label is the thing being
 *      chosen. Rendered at forty columns the other way round, this row read
 *      `2 Allow Bash(mvn *) for the rest of  dies with the session`, which
 *      spends the last columns on the aside and cuts the answer.
 *   2. **Then the wording shortens, a whole phrasing at a time.** R78's rule,
 *      and this is the widget where it matters most: `Allow Bash(mvn *) for th`
 *      describes a promise nobody made, and these words are a decision about
 *      what a machine may do rather than a status.
 *   3. Only a terminal too narrow for the short wording on its own reaches the
 *      clip, and there is nothing better than a cut line to give it.
 */
function rowLine(row, opts, width, ink) {
  if (row.render) {
    return row.render(opts, width, ink);
  }
  const head = `${opts.chosen ? ink.bold('❯') : ' '}${opts.marker ?? ' '}${ink.muted(opts.number ?? ' ')} `;
  const room = width - visibleWidth(head);
  const hint = row.hint ? `  ${row.hint}` : '';

  const label = String(row.label ?? '');
  const fits = (text, withHint) =>
    visibleWidth(text) + (withHint ? visibleWidth(hint) : 0) <= room;

  const withHint = fits(label, true);
  const text = fits(label, false) || !row.short || !fits(row.short, false)
    ? clip(label, Math.max(8, room))
    : row.short;

  return clip(
    `${head}${opts.chosen ? ink.text(text) : text}${withHint ? ink.muted(hint) : ''}`,
    width,
  );
}

/**
 * The same choice where there is no cursor to move — R62's rule, R81's rule.
 *
 * Through a pipe, on a dumb terminal, or anywhere the live region does not
 * exist, this is what a picker is: the rows PRINTED with numbers beside them and
 * a line read from stdin. Not a lesser widget — a different one, and the honest
 * shape for a stream that cannot be repainted.
 *
 * The free-text row does not need a number here. Anything that is not a number
 * IS the free text, which is what a plain prompt has always meant.
 */
export function plainLines(select) {
  const lines = ['', select.title ? ` ${select.title}` : ' choose:'];
  if (!select.rows.length) {
    lines.push(`  ${select.empty ?? 'nothing to choose from'}`);
  }
  select.rows.forEach((row, at) => {
    lines.push(`  ${at + 1}) ${row.label}${row.hint ? `  — ${row.hint}` : ''}`);
  });
  lines.push(select.freeText
    ? '  a number, or just type your answer:'
    : '  a number:');
  return lines;
}

/**
 * A typed line, against the rows.
 *
 * Returns null for a line that settles nothing, so the caller asks again rather
 * than guessing — except where free text is on offer, in which case a line that
 * is not a number is the answer itself.
 */
export function pickFromLine(select, typed) {
  const text = String(typed ?? '').trim();
  if (!text) {
    return null;
  }
  if (/^[0-9]+$/.test(text)) {
    const row = select.rows[Number(text) - 1];
    return row ? { done: 'chosen', row } : null;
  }
  const free = select.rows.find((row) => row.id === WRITE_MY_OWN);
  return free ? { done: 'chosen', row: free, text } : null;
}
