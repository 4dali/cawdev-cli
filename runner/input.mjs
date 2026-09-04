// The input line, borrowed from Claude Code — R83.
//
// R81 took Claude Code's biggest idea — print into scrollback, pin a small live
// region. The rest of what makes that CLI feel like one program rather than a
// script with a prompt lives here, in the line you type into: a caret you can
// move, `/` filtering the command list while you type instead of after you have
// guessed the name, up-arrow for what you last sent, and a paste that arrives as
// ONE thing rather than four hundred lines of transcript.
//
// **Everything in this file is pure.** A line editor whose only test is somebody
// sitting at a terminal is a line editor with an off-by-one in it: the caret
// arithmetic here is the same kind that put `2/2sessions` on screen in R62, and
// the answer is the same one — make it a function and read what it draws.
//
// Zero dependencies, so this is a string and an index rather than readline.

import { clip, painter, visibleWidth } from '../lib/ansi.mjs';

const ESC = '\x1b';

/**
 * One line being typed, and where the caret is in it.
 *
 * A real editor rather than "append and backspace", because the last row of the
 * footer is where an answer to a question gets written and a typo forty
 * characters back should not cost the whole sentence.
 */
export class Line {
  constructor(text = '') {
    this.text = String(text);
    this.at = this.text.length;
  }

  insert(what) {
    this.text = this.text.slice(0, this.at) + what + this.text.slice(this.at);
    this.at += what.length;
  }

  backspace() {
    if (this.at === 0) return;
    this.text = this.text.slice(0, this.at - 1) + this.text.slice(this.at);
    this.at -= 1;
  }

  /** Forward delete, which is what a terminal sends for the Delete key. */
  forwardDelete() {
    this.text = this.text.slice(0, this.at) + this.text.slice(this.at + 1);
  }

  left() {
    this.at = Math.max(0, this.at - 1);
  }

  right() {
    this.at = Math.min(this.text.length, this.at + 1);
  }

  home() {
    this.at = 0;
  }

  end() {
    this.at = this.text.length;
  }

  /** Ctrl+U — everything before the caret. */
  killToStart() {
    this.text = this.text.slice(this.at);
    this.at = 0;
  }

  /** Ctrl+W — the word before the caret, trailing spaces and all. */
  killWord() {
    const before = this.text.slice(0, this.at).replace(/\s*\S*$/, '');
    this.text = before + this.text.slice(this.at);
    this.at = before.length;
  }

  set(text) {
    this.text = String(text ?? '');
    this.at = this.text.length;
  }

  /**
   * The part of the line that fits, and where the caret is inside it.
   *
   * **The caret is what has to stay on screen**, not the start of the line. A
   * window anchored at character zero means typing past the width types into a
   * line you cannot see, which is the failure a one-line editor has to avoid
   * before it has any other features.
   */
  window(width) {
    if (width <= 0 || this.text.length < width) {
      return { text: this.text, at: this.at };
    }
    // Two thirds ahead of the caret, so there is room to keep typing before it
    // slides again, and the tail of a long line is what you are usually reading.
    const from = Math.max(0, Math.min(
      this.at - Math.floor((width * 2) / 3),
      this.text.length - width + 1,
    ));
    return { text: this.text.slice(from, from + width), at: this.at - from };
  }

  /** The line with a block where the caret is. */
  render(width, ink = painter(3)) {
    const { text, at } = this.window(width);
    const under = text.slice(at, at + 1) || ' ';
    return `${text.slice(0, at)}${ink.reverse(under)}${text.slice(at + 1)}`;
  }
}

/**
 * What you last sent, and the walk back through it.
 *
 * The line being typed is kept as the DRAFT: walking up to something older and
 * back down again returns what you had written, because losing it is what makes
 * people stop pressing up.
 */
export class History {
  constructor(entries = []) {
    this.entries = [...entries];
    this.at = this.entries.length;
    this.draft = '';
  }

  /** Remember something that was actually sent. */
  add(line) {
    const text = String(line ?? '').trim();
    // Consecutive repeats are one entry: sending the same prompt twice is
    // normal and filling the history with it is not useful.
    if (text && this.entries[this.entries.length - 1] !== text) {
      this.entries.push(text);
    }
    this.at = this.entries.length;
    this.draft = '';
  }

  /** Older. Returns null when there is nothing older, so the line is left alone. */
  back(current = '') {
    if (this.at === this.entries.length) {
      this.draft = current;
    }
    if (this.at === 0) {
      return null;
    }
    this.at -= 1;
    return this.entries[this.at];
  }

  /** Newer, ending at the draft you were writing. */
  forward() {
    if (this.at >= this.entries.length) {
      return null;
    }
    this.at += 1;
    return this.at === this.entries.length ? this.draft : this.entries[this.at];
  }

  reset() {
    this.at = this.entries.length;
    this.draft = '';
  }
}

/**
 * The commands that match what has been typed so far — R83.
 *
 * **Filtered while you type, not after you have guessed the name.** Guessing a
 * command name and being told `no such command` is a step, and it is the step
 * this removes.
 *
 * A line with an argument in it has stopped being a name, so nothing matches:
 * completing `/runs foo` to `/runs` would eat the argument.
 */
export function completions(text, commands) {
  const typed = String(text ?? '');
  if (!typed.startsWith('/') || /\s/.test(typed)) {
    return [];
  }
  const word = typed.slice(1).toLowerCase();
  return commands.filter(([name]) => name.slice(1).toLowerCase().startsWith(word));
}

/**
 * What Tab completes to: the longest prefix every match shares.
 *
 * One match completes it whole. Several complete as far as they agree, which is
 * the behaviour every shell has and nobody has to be taught.
 */
export function commonPrefix(names) {
  if (!names.length) return '';
  let prefix = names[0];
  for (const name of names.slice(1)) {
    while (prefix && !name.toLowerCase().startsWith(prefix.toLowerCase())) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

/**
 * A paste, as one line — R83.
 *
 * Four hundred lines of somebody's stack trace scrolling past is the transcript
 * this program exists to keep, buried by the thing that was meant to go INTO it.
 * So a multi-line paste becomes a placeholder that says what it is, and the full
 * text is sent.
 *
 * **The threshold is "more than one line" rather than "a few".** The input is
 * one row of a footer, and a newline in it has nowhere to go: two lines already
 * cannot be drawn honestly, so two lines is already a placeholder.
 */
export function pasteMark(text) {
  const lines = String(text).split('\n').length;
  return `[pasted, ${lines} lines]`;
}

/**
 * A held paste, and the text that goes back in its place when it is sent.
 *
 * The map is the process's, so a placeholder recalled from a PREVIOUS launch's
 * history has nothing to expand to and goes as the literal text it looks like.
 * That is the honest outcome: the paste was never stored, only the fact of it.
 */
export class Pastes {
  constructor() {
    this.held = new Map();
  }

  /** The placeholder to type, having remembered what it stands for. */
  hold(text) {
    let mark = pasteMark(text);
    if (this.held.has(mark) && this.held.get(mark) !== text) {
      // Two pastes of the same length in one line. Rare, and silently sending
      // the first one twice would be much worse than an ugly suffix.
      let nth = 2;
      while (this.held.has(`${mark.slice(0, -1)} #${nth}]`)) nth += 1;
      mark = `${mark.slice(0, -1)} #${nth}]`;
    }
    this.held.set(mark, text);
    return mark;
  }

  /** What was typed, with every placeholder in it put back. */
  expand(text) {
    let out = String(text);
    for (const [mark, held] of this.held) {
      out = out.split(mark).join(held);
    }
    return out;
  }
}

/**
 * The rows of the completion list, drawn directly above the line being typed.
 *
 * Above it rather than in the overlay at the top, because a list of what you are
 * halfway through typing belongs next to what you are typing. Each row carries
 * its one-line description: the list exists so that the name is not something
 * you have to know.
 */
export function completionLines(matches, at, width, ink = painter(3)) {
  return matches.map(([name, what], index) => {
    const chosen = index === at;
    const head = `${chosen ? ink.bold('❯') : ' '} `;
    const shown = `${head}${chosen ? ink.accent(name) : ink.text(name)}`;
    const room = Math.max(0, width - visibleWidth(shown) - 3);
    return clip(`${shown}  ${ink.muted(clip(what, room))}`, width);
  });
}

/**
 * One chunk of stdin, split into the keystrokes it actually contains — R81, and
 * a paste is one of them since R83.
 *
 * **A `data` event is not a keypress.** It is however many bytes arrived
 * together, and the client used to treat the whole chunk as one key: it compared
 * it against `'\r'`, found `"help\r"`, and appended the lot to the prompt as
 * text.
 *
 * An escape sequence is ONE key. `ESC[B` is Down, not three characters, and a
 * bare `ESC` is Escape — so a sequence is taken whole when one is there and the
 * escape stands alone when it is not.
 *
 * **And a bracketed paste is one key too.** The terminal wraps a paste in
 * `ESC[200~` and `ESC[201~` when asked to, which is the only way to tell a
 * pasted newline from somebody pressing enter — without it, pasting a paragraph
 * sends the first line and types the rest into whatever opens next.
 */
export function keysIn(chunk) {
  return new KeyStream().push(chunk);
}

const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/**
 * `keysIn` across chunks, because a paste is not one of them.
 *
 * A pasted file arrives in however many reads the pipe felt like; the start
 * marker can be in one and the end marker three chunks later. Everything between
 * them is held here rather than being handed out as keystrokes — which is
 * exactly what it must not be.
 */
export class KeyStream {
  constructor() {
    this.pasting = null;
  }

  push(chunk) {
    const keys = [];
    let text = String(chunk);

    while (text.length) {
      if (this.pasting !== null) {
        const end = text.indexOf(PASTE_END);
        if (end === -1) {
          this.pasting += text;
          return keys;
        }
        keys.push({ paste: this.pasting + text.slice(0, end) });
        this.pasting = null;
        text = text.slice(end + PASTE_END.length);
        continue;
      }
      const start = text.indexOf(PASTE_START);
      const upTo = start === -1 ? text.length : start;
      for (const key of plainKeys(text.slice(0, upTo))) {
        keys.push(key);
      }
      if (start === -1) {
        return keys;
      }
      this.pasting = '';
      text = text.slice(start + PASTE_START.length);
    }
    return keys;
  }
}

function plainKeys(text) {
  const keys = [];
  for (let at = 0; at < text.length;) {
    if (text[at] === ESC) {
      const sequence = /^\x1b(\[[0-9;?]*[a-zA-Z~]|O[A-Z]|.)?/.exec(text.slice(at));
      keys.push(sequence[0]);
      at += sequence[0].length;
      continue;
    }
    keys.push(text[at]);
    at += 1;
  }
  return keys;
}
