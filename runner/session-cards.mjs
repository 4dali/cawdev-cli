// Advanced mode's sessions as CARDS — one small box per session, not its log.
//
// A session's transcript scrolling past in a quarter of the screen was neither
// readable nor meant to be read live: what somebody glances at is what kind of
// session it is, where it stands and whether it waits on them. So a card says
// those three and one line of what the session is doing now, and the log is
// `/view`'s, over the whole screen (attach.mjs `readerScreen`).
//
// The space a card does not need for words is RAIN — falling glyphs whose
// colour and speed are the session's status: green and fast while it runs,
// amber while it waits on you, slow and grey while it is queued, a slow drizzle
// once it ended, red when it stopped. It is the status said a second way, read
// out of the corner of an eye; `/matrix off` stills it.
//
// Everything here is pure — the grid, a card, the rain at a given tick — so it
// can be rendered at four sizes and read, as split.mjs is. The rain is a
// function of (seed, tick): the same session draws the same drops, and a test
// can name the frame it wants.
//
// Zero dependencies, like everything in tools/.

import { clip, padVisible, stripAnsi, visibleWidth } from '../lib/ansi.mjs';
import { builtNothing } from './split.mjs';

const RESET = '\x1b[0m';

/** Narrower than this a card cannot hold its badge, card and status. */
export const CARD_MIN_WIDTH = 38;
/** Border, the agent line, the stage line, the `now:` line, the footer. */
export const CARD_MIN_HEIGHT = 6;
/** Taller than this a card is all rain: the rest goes to the prompt's messages. */
export const CARD_MAX_HEIGHT = 11;
/** At most this many cards side by side, however wide the terminal is. */
export const CARD_MAX_COLUMNS = 3;

/**
 * Where the cards go, for `count` sessions in `width`×`room` rows.
 *
 * As many columns as fit at `CARD_MIN_WIDTH` (three at most), as many rows of
 * cards as fit at `CARD_MIN_HEIGHT`, each row as tall as the room allows up to
 * `CARD_MAX_HEIGHT`. What does not fit is counted in `hidden`, for the tab
 * line. `height` is the rows the cards take; the prompt has the rest.
 *
 * @returns `{ zones: [{ top, left, width, height }], hidden, height }`, 0-based.
 */
export function cardGrid(width, room, count) {
  if (count <= 0 || room < CARD_MIN_HEIGHT || width < 10) {
    return { zones: [], hidden: Math.max(0, count), height: 0 };
  }
  const columns = Math.max(1, Math.min(CARD_MAX_COLUMNS, count, Math.floor(width / CARD_MIN_WIDTH)));
  const fit = Math.floor(room / CARD_MIN_HEIGHT);
  const rows = Math.min(fit, Math.ceil(count / columns));
  const tall = Math.min(CARD_MAX_HEIGHT, Math.floor(room / rows));
  const shown = Math.min(count, rows * columns);
  const zones = [];
  for (let i = 0; i < shown; i++) {
    const row = Math.floor(i / columns);
    // The last row's cards are as wide as the others: a lone card at the end
    // keeps its column rather than stretching across the screen.
    const [left, w] = spread(width, columns)[i % columns];
    zones.push({ top: row * tall, left, width: w, height: tall });
  }
  return { zones, hidden: count - shown, height: rows * tall };
}

/** `n` columns across `width`, the remainder given to the leftmost ones. */
function spread(width, n) {
  const base = Math.floor(width / n);
  const extra = width - base * n;
  const out = [];
  let left = 0;
  for (let i = 0; i < n; i++) {
    const w = base + (i < extra ? 1 : 0);
    out.push([left, w]);
    left += w;
  }
  return out;
}

// --- what a card says ----------------------------------------------------------

/**
 * A profile's badge: its word and its colour. The badge is drawn REVERSED
 * (`badgeOf`), so it reads as a label and never as a status, whose colours
 * (green, amber, red, grey) none of these share.
 */
const BADGES = {
  PLAN: ['PLAN', 'violetLight'],
  CODE: ['DEV', 'accent'],
  TEST: ['TEST', 'text'],
  MERGE: ['MERGE', 'text'],
  RELEASE: ['RELEASE', 'text'],
};

/** ` DEV ` reversed in its colour; any other profile is its own word, grey. */
export function badgeOf(profile, ink) {
  const [word, paint] = BADGES[profile] ?? [String(profile ?? 'session').toUpperCase(), 'muted'];
  return ink.reverse(ink.bold((ink[paint] ?? ink.muted)(` ${word} `)));
}

/**
 * Where a session stands, as a card says it: `key` (what the frame and the
 * rain are coloured and paced by), its `mark` and its `word`.
 *
 * Waiting on a person comes first whatever else is true — that is the one a
 * card exists to make impossible to miss.
 *
 * @param meta what the terminal knows of the session (attach.mjs `sessions`)
 * @param waiting a word when it waits on you (`waiting for an answer`), else null
 * @param now ms, for how long a live session has run
 */
export function cardStatus(meta, waiting = null, now = Date.now(), tick = 0) {
  if (waiting) {
    return { key: 'waiting', mark: '◆', word: waiting };
  }
  if (!meta.ended) {
    const shape = spinnerFor(meta.view?.profile ?? meta.profile, meta.stage);
    if (meta.state === 'queued' || meta.state === 'claiming') {
      // Nothing moves while queued: the spinner rests on its first frame, grey.
      return { key: 'queued', mark: shape[0], word: meta.state };
    }
    const since = Date.parse(meta.startedAt ?? '');
    const ran = Number.isFinite(since) ? ` · ${elapsed(now - since)}` : '';
    return { key: 'running', mark: spinnerFrame(shape, tick), word: `${meta.state ?? 'running'}${ran}` };
  }
  const state = meta.view?.state;
  if (!state || meta.view?.live) {
    return { key: 'ended', mark: '…', word: 'ended' };
  }
  if (state === 'FINISHED') {
    // A plan that finished is a card planned: the robot's, not the rain's.
    if (meta.view.profile === 'PLAN') {
      return { key: 'planned', mark: '✓', word: 'planned' };
    }
    return builtNothing(meta)
      ? { key: 'idle', mark: '✓', word: 'finished · nothing built' }
      : { key: 'done', mark: '✓', word: 'finished' };
  }
  return { key: 'stopped', mark: '✕', word: String(state).toLowerCase().replaceAll('_', ' ') };
}

// --- the spinner ---------------------------------------------------------------

/** A stage that writes turns the solid quadrant counter-clockwise: the rule `cawdev-actions.js` draws. */
export const SPINNER_WRITES = ['◴', '◵', '◶', '◷'];
/** A stage that only reads turns the thin arc clockwise. */
export const SPINNER_READS = ['◜', '◝', '◞', '◟'];
/** Stages that only read; every other action — plan, code, merge, release, roadmap, interview — writes. */
const READING_STAGES = new Set(['test', 'ask', 'audit', 'scope', 'show']);
const READING_PROFILES = new Set(['TEST', 'ASK', 'AUDIT', 'SCOPE']);

/** The frames a session turns through: by its stage when it walks stages, else by its profile. */
export function spinnerFor(profile, stage = null) {
  const word = String(stage ?? '').toLowerCase();
  if (word) return READING_STAGES.has(word) ? SPINNER_READS : SPINNER_WRITES;
  return READING_PROFILES.has(String(profile ?? '').toUpperCase()) ? SPINNER_READS : SPINNER_WRITES;
}

/** One frame every two ticks, so every spinner on the screen is in phase. */
export function spinnerFrame(shape, tick = 0) {
  return shape[Math.floor(Math.max(0, tick) / 2) % shape.length];
}

/** How many ticks a changed value is drawn bright before it settles. */
export const BEAT_TICKS = 4;

/** Whether a value that changed at `changedAt` is still in its beat at `tick`. */
export function beating(changedAt, tick) {
  return Number.isFinite(changedAt) && tick - changedAt >= 0 && tick - changedAt < BEAT_TICKS;
}

/** `42s`, `12m`, `2h05`. */
export function elapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
}

/** The colour of each status — the frame's, the mark's and the rain's. */
const STATUS_PAINT = {
  running: 'success', waiting: 'warn', queued: 'muted', done: 'success', planned: 'success', merging: 'muted',
  idle: 'warn', stopped: 'danger', ended: 'muted', landed: 'success',
};

export function statusPaint(key, ink) {
  return ink[STATUS_PAINT[key]] ?? ink.muted;
}

/**
 * `plan ✓ ─ implement ● ─ test ○` — the stages a live session walks and the
 * one it is on. Too long for `width`, it says the count and the stage instead,
 * which still answers "how far has it got".
 */
export function stageWalk(stages, current, width, ink, tick = null) {
  if (!Array.isArray(stages) || !stages.length || !current) return '';
  const at = stages.indexOf(current);
  // The mark on the current stage turns when a tick is given, as the status's does.
  const mark = tick === null ? '●' : spinnerFrame(spinnerFor(null, current), tick);
  const words = stages.map((name, i) => {
    const word = String(name).toLowerCase();
    if (at < 0 || i > at) return ink.muted(`${word} ○`);
    return i === at ? ink.bold(`${word} ${mark}`) : ink.muted(`${word} ✓`);
  });
  const line = words.join(ink.muted(' ─ '));
  if (visibleWidth(line) <= width) return line;
  const name = ink.bold(String(current).toLowerCase());
  if (at < 0) return name;
  const place = ink.muted(`stage ${at + 1} of ${stages.length} ·`);
  return `${place} ${name}`;
}

/**
 * The one line of what a session is doing — never its log. The last tool call
 * (`describeCall`'s words: `Edit pay.js`, `Bash npm test`) while it works,
 * else the last thing it said; for an ended session that failed or built
 * nothing, the first line of why.
 *
 * @param lines the session's transcript lines, `{ kind, body }`
 */
export function nowLine(meta, lines = []) {
  const view = meta.view ?? {};
  if (meta.ended && view.exitSummary && view.state !== 'FINISHED') {
    return `why: ${firstLine(view.exitSummary)}`;
  }
  if (builtNothing(meta) && view.exitSummary) {
    return `why: ${firstLine(view.exitSummary)}`;
  }
  if (!meta.ended && (meta.state === 'queued' || meta.state === 'claiming')) {
    return meta.why ? `waiting — ${meta.why}` : '';
  }
  // The last ACT, even with words said since: what it last did is what it is
  // doing, and a sentence is the log's. Before its first tool, what it said.
  const tool = lines.findLast((line) => line?.kind === 'TOOL');
  if (tool) return `now: ${firstLine(tool.body)}`;
  const spoke = lines.findLast((line) => line?.kind === 'ASSISTANT' && firstLine(line.body));
  if (spoke) return `said: ${firstLine(spoke.body)}`;
  return meta.ended ? '' : 'starting…';
}

/** The first line with words in it, escapes and control bytes gone: an agent's output must not drive the terminal. */
function firstLine(text) {
  return stripAnsi(String(text ?? ''))
    // eslint-disable-next-line no-control-regex
    .split('\n').map((part) => part.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim()).find(Boolean) ?? '';
}

// --- the rain ------------------------------------------------------------------

/**
 * How each status rains: its colour, how fast a drop falls (rows per tick),
 * how many columns carry one, and how long its trail is.
 */
export const RAIN = {
  running: { speed: 1, density: 0.5, trail: 6 },
  waiting: { speed: 0.5, density: 0.45, trail: 4 },
  queued: { speed: 0.15, density: 0.2, trail: 2 },
  done: { speed: 0.08, density: 0.18, trail: 2 },
  idle: { speed: 0.1, density: 0.22, trail: 2 },
  stopped: { speed: 0.12, density: 0.3, trail: 3 },
  ended: { speed: 0, density: 0.12, trail: 1 },
};

/**
 * Plain ASCII: one column in every terminal and every font. Half-width
 * katakana are East Asian "halfwidth" — a terminal or font that draws them two
 * columns wide pushed every rain row past the card's right border.
 */
export const GLYPHS = '0123456789=+*<>:ZXJ';

/** How far down the trail a cell is: the head, the body, or the tail. */
function toneOf(behind, trail) {
  if (behind === 0) return 'head';
  return behind <= trail / 2 ? 'body' : 'tail';
}

/** The drawing for `rows` rows tall: three and more, two, or one. */
function byRows(rows, three, two, one) {
  if (rows >= 3) return three;
  return rows === 2 ? two : one;
}

/** A small integer hash — the same inputs, the same drop. */
function mix(...values) {
  let h = 0x811c9dc5;
  for (const value of values) {
    h ^= Math.trunc(value);
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

/** A string's seed: a session's id, so its rain is its own. */
export function seedOf(text) {
  let h = 0;
  for (const ch of String(text ?? '')) h = Math.imul(h ^ ch.codePointAt(0), 0x5bd1e995) >>> 0;
  return h;
}

/**
 * `rows` lines of rain, each exactly `width` columns, at `tick`.
 *
 * Each column either carries a drop or not (`density`, fixed per column). A
 * drop falls at the status's speed times its column's own (0.6–1.4, so the
 * columns do not march together), wraps after its trail and a gap, and its
 * glyphs change as it moves. The head is bright, the trail fades into dim.
 *
 * @param mood a key of `RAIN` (a card's `cardStatus(...).key`)
 */
export function rainLines(width, rows, { seed = 0, tick = 0, mood = 'running' } = {}, ink) {
  const rain = RAIN[mood] ?? RAIN.ended;
  const paint = statusPaint(mood, ink);
  const grid = Array.from({ length: rows }, () => new Array(width).fill(null));
  for (let x = 0; x < width; x++) {
    const h = mix(seed, x);
    if ((h % 1000) / 1000 >= rain.density) continue;
    const trail = rain.trail + (h >>> 10) % 3;
    const period = rows + trail + 2 + ((h >>> 14) % Math.max(1, rows));
    const pace = 0.6 + ((h >>> 20) % 9) / 10;
    const fallen = Math.floor(tick * rain.speed * pace);
    const head = ((h >>> 4) % period + fallen) % period;
    for (let y = 0; y < rows; y++) {
      const behind = head - y;
      if (behind < 0 || behind > trail) continue;
      const glyph = GLYPHS[mix(seed, x, y, fallen) % GLYPHS.length];
      grid[y][x] = { glyph, tone: toneOf(behind, trail) };
    }
  }
  const styles = {
    head: (text) => ink.bold(mood === 'running' ? ink.text(text) : paint(text)),
    body: paint,
    tail: (text) => ink.dim(paint(text)),
  };
  // Runs of one style are painted once: a cell each would be ten bytes of
  // escape per glyph, eight times a second, for every card on the screen.
  return grid.map((cells) => {
    let out = '';
    let run = '';
    let style = null;
    const close = () => {
      if (run) out += style ? styles[style](run) : run;
      run = '';
    };
    for (const cell of cells) {
      const next = cell?.tone ?? null;
      if (next !== style) {
        close();
        style = next;
      }
      run += cell ? cell.glyph : ' ';
    }
    close();
    return out;
  });
}

/** Cut to `width` with `…` where it was cut. */
function ellipsed(text, width) {
  const plain = String(text);
  return plain.length <= width ? plain : `${plain.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
}

// --- the robot ------------------------------------------------------------------

/** What the robot holds up: the plan is done, and the card is ready to develop. */
export const ROBOT_SIGN = '✓ plan done';

/**
 * A finished plan's card, in place of its rain: a small robot pacing along
 * the bottom of the card, waving and blinking, with `ROBOT_SIGN` beside its
 * head. The rain says a session is working; the robot says it worked, and
 * that what it made, a plan, is waiting for somebody to build it.
 *
 *     [o_o]  ✓ plan done          three rows and more: head, arms, legs,
 *     \[_]/                        standing on the card's last spare row
 *      / \
 *
 * Two rows are a head and legs, one a head and the sign. It walks a column
 * every four ticks and turns at either side; `still` stands it at the left,
 * for `/matrix off`. Pure: the same tick is the same frame.
 */
export function robotLines(width, rows, { tick = 0, still = false } = {}, ink) {
  const paint = (text) => ink.bold(ink.success(text));
  const sign = ` ${ROBOT_SIGN}`;
  const body = 5;
  const room = Math.max(0, width - body - sign.length - 2);
  const step = still ? 0 : Math.floor(tick / 4);
  let along = 0;
  if (room) along = Math.floor(step / room) % 2 ? room - (step % room) : step % room;
  const x = 1 + along;
  const blink = !still && tick % 23 === 22;
  const head = blink ? '[-_-]' : '[o_o]';
  const arms = still || Math.floor(tick / 3) % 2 ? String.raw`\[_]/` : '/[_]\\';
  const legs = still || step % 2 ? String.raw` / \ ` : ' | | ';
  const at = (text, extra = '') => {
    const line = `${' '.repeat(x)}${paint(text)}${extra}`;
    return padVisible(clip(line, width), width);
  };
  const withSign = (text) => at(text, width >= body + sign.length + 1 ? ink.success(sign) : '');
  const drawn = byRows(rows, [withSign(head), at(arms), at(legs)], [withSign(head), at(legs)], [withSign(head)]);
  return [...new Array(Math.max(0, rows - drawn.length)).fill(' '.repeat(width)), ...drawn].slice(-rows);
}

/**
 * A card being merged, in place of its rain: the robot, looking ahead
 * (`[>_>]`), carries the branch (`[■]`) to the base on the right (`▶ main`),
 * sets it down and walks back for the next load — a loop, because a merge has
 * no progress to show, only that it is under way. The card around it is grey:
 * nothing can be done on it until it lands, and then it closes.
 *
 *     [>_>]                         three rows and more
 *     /[_]=[■]          ▶ main
 *      / \
 *
 * `still` (`/matrix off`) stands it at the left with its load.
 */
export function mergingRobotLines(width, rows, { tick = 0, still = false, base = 'main' } = {}, ink) {
  const paint = (text) => ink.bold(ink.accent(text));
  const dock = ` ▶ ${base}`;
  const body = 8;
  const room = Math.max(0, width - body - dock.length - 2);
  const x = 1 + (still || !room ? 0 : Math.floor(tick / 2) % (room + 1));
  const legs = still || Math.floor(tick / 2) % 2 ? String.raw` / \ ` : ' | | ';
  const at = (text, extra = '') => padVisible(clip(`${' '.repeat(x)}${paint(text)}${extra}`, width), width);
  // The base stays where it is while the robot walks to it.
  const toDock = (text) => {
    const gap = width - x - visibleWidth(text) - dock.length;
    return gap >= 1 ? at(text, `${' '.repeat(gap)}${ink.muted(dock)}`) : at(text);
  };
  const drawn = byRows(rows, [at('[>_>]'), toDock('/[_]=[■]'), at(legs)], [at('[>_>]'), toDock('/[_]=[■]')], [toDock('[>_>]=[■]')]);
  return [...new Array(Math.max(0, rows - drawn.length)).fill(' '.repeat(width)), ...drawn].slice(-rows);
}

// --- the robots' moments ----------------------------------------------------------
//
// Each is a pure function of `since`, the ticks since the card's status changed
// (attach.mjs records the tick when it marks a session ended), so a test can
// name the frame it wants. The pacing and merging robots above are unchanged.

/** The tick the walk-in of a finished plan takes: from x = -6, a column every two ticks, in by x = 0. */
export const WALK_IN_TICKS = 14;

/** `text` placed at column `x` of a row `width` wide; a negative `x` cuts the text's front off. */
function placed(text, x, width) {
  const cut = x < 0 ? text.slice(Math.min(text.length, -x)) : text;
  const left = Math.max(0, x);
  return (' '.repeat(left) + cut).slice(0, width).padEnd(width);
}

/** Overlays plain `text` on the plain row `base` at `x`; spaces in `text` leave `base` alone. */
function overlay(base, text, x) {
  const chars = [...base];
  [...text].forEach((ch, i) => {
    const at = x + i;
    if (at >= 0 && at < chars.length && ch !== ' ') chars[at] = ch;
  });
  return chars.join('');
}

/** Three plain rows → exactly `rows` painted ones, bottom-aligned, as the other robots are. */
function stand(rowsOf, width, rows, paintRow) {
  const drawn = byRows(rows, rowsOf, [rowsOf[0], rowsOf[2]], [rowsOf[0]])
    .map((row, i, all) => paintRow(row, i, all.length));
  return [...new Array(Math.max(0, rows - drawn.length)).fill(' '.repeat(width)), ...drawn].slice(-rows);
}

/** A finished plan, the moment it finishes: the robot walks in from the left carrying `✓ plan done`, then paces. */
export function planWalkInLines(width, rows, { since = 0, tick = 0, still = false } = {}, ink) {
  if (still || since >= WALK_IN_TICKS) {
    return robotLines(width, rows, { tick: still ? 0 : Math.max(0, since - WALK_IN_TICKS), still }, ink);
  }
  const x = -6 + Math.floor(since / 2);
  const sign = ` ${ROBOT_SIGN}`;
  const legs = since % 2 ? String.raw` / \ ` : ' | | ';
  const rowsOf = [`[o_o]${sign}`, String.raw`\[_]/`, legs];
  return stand(rowsOf, width, rows, (row, i) => {
    const plain = placed(row, x, width);
    return i === 0 && row.length > 5
      ? ink.bold(ink.success(plain.slice(0, Math.max(0, x + 5)))) + ink.success(plain.slice(Math.max(0, x + 5)))
      : ink.bold(ink.success(plain));
  });
}

/** Where a development's robot sets the branch down: just left of the dock's sign. */
function dockOf(width, word) {
  const dock = ` ▶ ${word}`;
  return { dock, dockAt: Math.max(0, width - dock.length), branchX: Math.max(8, width - dock.length - 4) };
}

/** A plain row painted in `[from, to, paint]` segments, the rest in `base`. */
function segments(plain, spans, base) {
  let out = '';
  let at = 0;
  for (const [from, to, paint] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (from > at) out += base(plain.slice(at, from));
    out += paint(plain.slice(from, to));
    at = to;
  }
  return out + (at < plain.length ? base(plain.slice(at)) : '');
}

/** The dock's sign set on the row the branch sits on (the middle one, or the last when there is no room for three). */
function withDock(rowsOf, rows, dock, width) {
  const at = rows >= 3 ? 1 : rowsOf.length - 1;
  return rowsOf.map((row, i) => (i === at && width > dock.length
    ? row.slice(0, width - dock.length) + dock : row));
}

/**
 * A finished development, the moment it finishes: the robot walks in carrying
 * the branch (`[>_>]`, `/[_]=[■]`) to `▶ review`, sets it down (the `[■]` stays
 * by the dock), steps back three columns and waits beside it — `[o_o]`, a blink
 * every 23 ticks, a look at the branch (`[>_>]`) three ticks in every forty —
 * under the sign `✓ built · /pr`.
 */
export function devDoneRobotLines(width, rows, { since = 0, still = false } = {}, ink) {
  const { dock, dockAt, branchX } = dockOf(width, 'review');
  const endX = Math.max(0, branchX - 5);
  const walk = 2 * (endX + 8);
  const t = still ? walk + 4 : since;
  const carrying = t < walk + 1;
  const back = carrying ? 0 : Math.min(3, t - walk - 1);
  const x = carrying ? Math.min(endX, -8 + Math.floor(t / 2)) : Math.max(0, endX - back);
  const waited = t - walk - 4;
  const blink = !still && waited >= 0 && waited % 23 === 22;
  const looking = !still && waited >= 0 && waited % 40 >= 37;
  let head = '[o_o]';
  if (carrying || looking) head = '[>_>]';
  else if (blink) head = '[-_-]';
  const striding = carrying && !still && Math.floor(t / 2) % 2;
  const legs = striding ? String.raw` / \ ` : ' | | ';
  const sign = '✓ built · /pr';
  const signed = !carrying && x >= sign.length + 2;
  let top = placed(head, x, width);
  if (signed) top = overlay(top, sign, 1);
  const plain = withDock([
    top,
    carrying ? placed('/[_]=[■]', x, width) : overlay(placed('/[_]\\', x, width), '[■]', branchX),
    placed(legs, x, width),
  ], rows, dock, width);
  return stand(plain, width, rows, (row, i, n) => {
    const onDock = (n >= 3 ? i === 1 : i === n - 1);
    const spans = [];
    if (onDock) spans.push([dockAt, width, ink.muted]);
    if (signed && i === 0) spans.push([1, 1 + sign.length, ink.success]); // the sign is on the top row, which stand() always draws first
    return segments(row, spans, (text) => ink.bold(ink.accent(text)));
  });
}

/** Nothing built: the robot walks in empty-handed, amber, stands at the left and shrugs. */
export function nothingBuiltRobotLines(width, rows, { since = 0, still = false, ref = null } = {}, ink) {
  const paint = (text) => ink.bold(ink.warn(text));
  const x = still ? 1 : Math.min(1, -6 + Math.floor(since / 2));
  const waited = still ? 0 : since - 14;
  const shrug = waited >= 0 && waited % 30 >= 24;
  const blink = waited >= 0 && waited % 23 === 22;
  const head = blink ? '[-_-]' : '[o_o]';
  const arms = shrug ? '¯[_]¯' : '/[_]\\';
  const sign = ` ✗ nothing built · /new plan ${ref ?? '<card>'}`;
  const shown = width - 6 - 1 >= sign.length ? sign : ' ✗ nothing built';
  const rowsOf = [head + (x >= 0 ? shown : ''), arms, ' | | '];
  return stand(rowsOf, width, rows, (row, i) => {
    const plain = placed(row, x, width);
    return i === 0 && x >= 0
      ? paint(plain.slice(0, x + 5)) + ink.warn(plain.slice(x + 5))
      : paint(plain);
  });
}

/** Ticks the robot waves for after a landing, and ticks it then takes to walk off a card `width` wide. */
export const WAVE_TICKS = 12;
/** A landed card closes itself this many ticks after it lands (3 s at 120 ms). */
export const CLOSE_AFTER_TICKS = 25;

/**
 * The landing: the branch is set down at `▶ main`, the robot waves (`[^_^]`,
 * arms alternating) for twelve ticks and walks off the right edge.
 */
export function landingRobotLines(width, rows, { since = 0, still = false, base = 'main' } = {}, ink) {
  const { dock, dockAt, branchX } = dockOf(width, base);
  const stands = Math.max(0, branchX - 8);
  const t = still ? 0 : since;
  const waving = t < WAVE_TICKS;
  // Off the edge before the card closes itself, however wide the card is.
  const pace = Math.max(1, Math.ceil((width - stands) / (CLOSE_AFTER_TICKS - WAVE_TICKS - 1)));
  const x = stands + Math.max(0, t - WAVE_TICKS) * pace;
  const arms = waving && Math.floor(t / 2) % 2 ? String.raw`\[_]/` : '/[_]\\';
  const head = waving ? '[^_^]' : '[>_>]';
  const legs = !waving && Math.floor(t / 2) % 2 ? String.raw` / \ ` : ' | | ';
  const plain = withDock([
    placed(head, x, width),
    overlay(placed(arms, x, width), '[■]', branchX),
    placed(legs, x, width),
  ], rows, dock, width);
  return stand(plain, width, rows, (row, i, n) => {
    const onDock = n >= 3 ? i === 1 : i === n - 1;
    const spans = onDock ? [[dockAt, width, ink.muted]] : [];
    return segments(row, spans, (text) => ink.bold(ink.accent(text)));
  });
}

// --- a card --------------------------------------------------------------------

/** A card's top edge: the corner, the label, the status (reversed while it is new), the other corner. */
function cardTop(card, inner, paint, ink, [h, tl, tr]) {
  const status = ` ${card.status.mark} ${card.status.word} `;
  const number = card.n ? `${card.n} ` : '';
  const left = ` ${number}`;
  const badge = badgeOf(card.profile, ink);
  const titleRoom = Math.max(0, inner - 1 - visibleWidth(left) - visibleWidth(badge) - 1
    - visibleWidth(status) - 2);
  const title = titleRoom >= 4 ? ` ${ellipsed(card.title ?? '', titleRoom - 1)} ` : ' ';
  const label = `${left}${badge}${title}`;
  const fill = Math.max(0, inner - 1 - visibleWidth(label) - visibleWidth(status) - 1);
  // A status that changed is drawn reversed for a few ticks, then settles.
  const beat = card.changedAt !== undefined && beating(card.changedAt, card.tick ?? 0);
  const fits = visibleWidth(label) + visibleWidth(status) + 2 <= inner;
  let shownStatus = '';
  if (fits) shownStatus = beat ? ink.reverse(paint(status)) : paint(status);
  return paint(tl + h) + (card.focused ? ink.bold(label) : label)
    + paint(h.repeat(shownStatus ? fill : Math.max(0, inner - 1 - visibleWidth(label)))) + shownStatus
    + paint((shownStatus ? h : '') + tr);
}

/** The `spare` rows under a card's words: the status's robot, the rain, or nothing. */
function cardRain(card, inner, spare, ink) {
  if (spare <= 0) return [];
  // The robots move whether the rain is on or off: they are not the matrix.
  const since = Number.isFinite(card.since) ? card.since : null;
  const key = card.status.key;
  if (key === 'planned') {
    return since === null ? robotLines(inner, spare, { tick: card.tick }, ink)
      : planWalkInLines(inner, spare, { since }, ink);
  }
  if (key === 'merging') return mergingRobotLines(inner, spare, { tick: card.tick, base: card.base }, ink);
  if (key === 'done') return devDoneRobotLines(inner, spare, { since: since ?? 1e6 }, ink);
  if (key === 'idle') return nothingBuiltRobotLines(inner, spare, { since: since ?? 1e6, ref: card.ref }, ink);
  if (key === 'landed') return landingRobotLines(inner, spare, { since: since ?? 1e6, base: card.base }, ink);
  // Failed, running, waiting, queued, stopped: no robot. The rain only when asked for.
  if (card.rain !== true || key === 'failed') return new Array(spare).fill('');
  return rainLines(inner, spare, { seed: card.seed, tick: card.tick, mood: key }, ink);
}

/**
 * One card, as exactly `rect.height` strings of exactly `rect.width` columns.
 *
 *     ┌─ 1  DEV  R42 Payments refund flow ──── ● running · 12m ─┐
 *     │ Claude · Opus 5.5 ▸ saasng · …/saasng-auto-2            │
 *     │ plan ✓ ─ implement ● ─ test ○                           │
 *     │ now: Bash npm test                                      │
 *     │ ｱ  7    ｻ                                                │  ← rain
 *     │ /pr opens the pull request · /close                     │
 *     └─────────────────────────────────────────────────────────┘
 *
 * The frame is the status's colour; the focused card is drawn heavy, which
 * survives `NO_COLOR`. The title is clipped before the status is: "● running"
 * is what a glance is for.
 *
 * @param card `{ n, profile, title, status, lines, footer, focused, seed, tick, rain }`
 *   — `lines` the card's words, top down; `rain` false draws none.
 */
export function sessionCardLines(rect, card, ink) {
  const { width, height } = rect;
  const inner = Math.max(0, width - 2);
  const [h, v, tl, tr, bl, br] = card.focused
    ? ['━', '┃', '┏', '┓', '┗', '┛']
    : ['─', '│', '┌', '┐', '└', '┘'];
  const paint = statusPaint(card.status.key, ink);

  const top = cardTop(card, inner, paint, ink, [h, tl, tr]);

  // A column of margin inside the border, for the words; the rain runs to it.
  const row = (text) => paint(v) + padVisible(clip(text, inner), inner) + RESET + paint(v);
  const said = (text) => row(` ${clip(text, Math.max(0, inner - 2))}`);
  const footer = card.footer ? 1 : 0;
  const room = Math.max(0, height - 2 - footer);
  const words = (card.lines ?? []).filter((line) => line !== null && line !== undefined).slice(0, room);
  const spare = room - words.length;
  const rain = cardRain(card, inner, spare, ink);
  const lines = [top, ...words.map(said), ...rain.map(row)];
  if (footer) lines.push(said(ink.muted(card.footer)));
  lines.push(paint(bl + h.repeat(inner) + br));
  return lines.slice(0, height);
}
