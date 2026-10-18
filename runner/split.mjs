// Advanced mode — the attached terminal split into one window per session,
// emacs-style, with the client's own prompt at the bottom.
//
// **R81 decided against a pane manager, and this does not reopen that.** The
// reason there was that a full-screen repaint EATS THE SCROLLBACK: the wheel,
// search and copy stop working and the transcript above the fold is gone. So
// the default is still `scrollback.mjs`, untouched. This is a mode somebody
// ASKS for with `/advanced-mode`, and it is drawn on the terminal's ALTERNATE
// screen — the buffer vim and emacs use — which leaves the normal screen and
// its scrollback exactly as they were. Leaving the mode puts them back, and
// what was said on the watched session meanwhile is laid into the scrollback
// then, so nothing is lost by having looked at it this way.
//
// Everything that decides a picture is a pure function — the layout, one
// window, the whole frame — so it can be rendered at four sizes and READ,
// which is how scrollback.mjs's own layout bugs were found. The class at the
// bottom only enters, leaves, and writes the rows that changed.

import { clip, padVisible, visibleWidth, wrap } from '../lib/ansi.mjs';

const ESC = '\x1b';
const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;
// What nano and emacs set as well as the alternate screen, and what makes the
// screen hold still: no AUTO-WRAP, so a row a little wider than we measured it
// (an emoji in an agent's output is two columns and one character) is cut at
// the edge instead of wrapping — a wrap on the last row scrolls the whole
// screen, and iTerm keeps what scrolled off where the wheel reaches it; and
// ALTERNATE SCROLL, so the wheel sends arrow keys to the program instead of
// scrolling the terminal. Both are put back on the way out.
const HOLD_STILL = `${ESC}[?7l${ESC}[?1007h`;
const LET_GO = `${ESC}[?1007l${ESC}[?7h`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const RESET = `${ESC}[0m`;

/** Narrower than this a window cannot show a title and a line of output. */
export const MIN_ZONE_WIDTH = 28;
/** Border, title, two lines of output, an action line. */
export const MIN_ZONE_HEIGHT = 5;
/** The prompt's band when nothing asks for more: border, messages, input, keys. */
export const PROMPT_ROWS = 8;

/**
 * Where everything goes, for `count` sessions on a `width`×`height` screen.
 *
 * The prompt is ALWAYS the band at the bottom, the way a shell's is — the
 * sessions fill the screen above it, in one row or, when there is room, two.
 * Sessions that do not fit at `MIN_ZONE_WIDTH` are not drawn and are counted
 * in `hidden`, so the prompt can say how many are off screen rather than
 * squeezing every window into something unreadable.
 *
 * @param promptRows how tall the prompt wants to be — taller while a picker
 *   is open, so the list is not cut off.
 * @returns `{ zones: [{ top, left, width, height }], prompt: {…}, hidden }`,
 *   rows and columns 0-based.
 */
export function splitLayout(width, height, count, promptRows = PROMPT_ROWS) {
  const promptHeight = Math.max(4, Math.min(height, promptRows));
  const room = height - promptHeight;
  if (count <= 0 || room < MIN_ZONE_HEIGHT) {
    return { zones: [], prompt: { top: 0, left: 0, width, height }, hidden: Math.max(0, count) };
  }
  const perRow = Math.max(1, Math.floor(width / MIN_ZONE_WIDTH));
  const twoRows = count > perRow || (count > 2 && Math.floor(room / 2) >= MIN_ZONE_HEIGHT * 2);
  const rows = twoRows && Math.floor(room / 2) >= MIN_ZONE_HEIGHT ? 2 : 1;
  const shown = Math.min(count, perRow * rows);
  const topCount = rows === 2 ? Math.ceil(shown / 2) : shown;
  const bottomCount = shown - topCount;
  const topHeight = rows === 2 ? Math.ceil(room / 2) : room;

  const row = (n, top, rowHeight) => spread(width, n).map(([left, w]) => ({
    top, left, width: w, height: rowHeight,
  }));
  return {
    zones: [
      ...row(topCount, 0, topHeight),
      ...(bottomCount ? row(bottomCount, topHeight, room - topHeight) : []),
    ],
    prompt: { top: room, left: 0, width, height: promptHeight },
    hidden: count - shown,
  };
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

/**
 * One window, as exactly `rect.height` strings of exactly `rect.width` columns.
 *
 * The SUBTITLE, when there is one, is a fixed first line inside it.
 * The TITLE is in the top border, clipped from the right so the start of it —
 * the number and the card — survives a narrow window. The BODY is the tail of
 * whatever lines it is handed, wrapped to the inside width: a window shows the
 * latest output, the way a terminal does. The FOOTER, when there is one, is the
 * last line inside the border — what can be done about this session now.
 *
 * The focused window is drawn in heavy lines, so which one the prompt is
 * talking to survives `NO_COLOR`; `tone` colours the frame by the session's
 * state — red while it runs, green once it finished, amber if it stopped any
 * other way.
 */
export function windowLines(rect, {
  title = '', subtitle = '', body = [], footer = '', focused = false, tone = null, dotted = false,
}, ink) {
  const { width, height } = rect;
  const inner = Math.max(0, width - 2);
  // Heavy and solid is the window the prompt talks to; a session window that
  // is NOT focused is dotted, so which one is active reads at a glance — the
  // heavy line alone was too close to the thin one on most terminal fonts.
  const [h, v, tl, tr, bl, br] = focused
    ? ['━', '┃', '┏', '┓', '┗', '┛']
    : dotted
      ? ['┄', '┆', '┌', '┐', '└', '┘']
      : ['─', '│', '┌', '┐', '└', '┘'];
  // The frame's COLOUR is the session's state (see `toneFor`); which window is
  // focused is the heavy line, so the two never compete for one channel.
  const byTone = { live: ink.danger, done: ink.success, stopped: ink.warn };
  const paint = byTone[tone] ?? ((text) => (focused ? ink.accent(text) : ink.muted(text)));

  const label = title ? ` ${clip(title, Math.max(0, inner - 3))} ` : '';
  const top = paint(tl + h) + label + paint(h.repeat(Math.max(0, inner - 1 - visibleWidth(label))) + tr);

  const footerRows = footer ? 1 : 0;
  const subtitleRows = subtitle ? 1 : 0;
  const rows = Math.max(0, height - 2 - footerRows - subtitleRows);
  const tail = tailOf(body, inner, rows);
  const lines = [top];
  if (subtitle) {
    // A fixed line under the title — the project — so a long title never
    // pushes it out of sight and the output scrolling never takes it.
    lines.push(paint(v) + padVisible(clip(subtitle, inner), inner) + RESET + paint(v));
  }
  for (let i = 0; i < rows; i++) {
    lines.push(paint(v) + padVisible(clip(tail[i] ?? '', inner), inner) + RESET + paint(v));
  }
  if (footer) {
    lines.push(paint(v) + padVisible(clip(footer, inner), inner) + RESET + paint(v));
  }
  lines.push(paint(bl + h.repeat(inner) + br));
  return lines.slice(0, height);
}

/**
 * The last `rows` screen lines of `lines`, each wrapped to `width` — walked
 * from the end, so a session with four thousand lines of history costs what
 * the window shows and not what the session said.
 */
export function tailOf(lines, width, rows) {
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < rows; i--) {
    const wrapped = wrap(String(lines[i] ?? ''), Math.max(1, width));
    for (let j = wrapped.length - 1; j >= 0 && out.length < rows; j--) {
      out.push(wrapped[j]);
    }
  }
  return out.reverse();
}

/**
 * The reader — `/view` on a session waiting for an answer or a permission.
 *
 * A window's body is the TAIL of what was said and a question's banner fits
 * the prompt's rows, so a long plan or a long question was cut and could not
 * be scrolled. The reader is one window over the whole screen, showing
 * `lines` from row `top` (wrapped to its width), with where it is in the
 * title. `top` null means "start where the request starts" (`requestAt`);
 * whatever is asked for is clamped, and the answer says what was used so the
 * keys can page from it.
 */
export function readerFrame(width, height, { title = '', lines = [], requestAt = 0, top = null, footer = '' }, ink) {
  const inner = Math.max(1, width - 2);
  const rows = [];
  let requestRow = 0;
  lines.forEach((line, i) => {
    if (i === requestAt) requestRow = rows.length;
    rows.push(...wrap(String(line ?? ''), inner));
  });
  const room = Math.max(1, height - 2 - (footer ? 1 : 0));
  const max = Math.max(0, rows.length - room);
  const at = Math.min(Math.max(0, top ?? requestRow), max);
  const shown = rows.slice(at, at + room);
  const where = rows.length > room ? ` · ${at + 1}–${at + shown.length} of ${rows.length}` : '';
  return {
    lines: windowLines({ width, height }, { title: `${title}${where}`, body: shown, footer, focused: true }, ink),
    top: at,
    max,
    room,
  };
}

/**
 * The whole screen, from placed pieces: `height` rows, each the pieces that
 * cross it laid left to right, and blank where nothing is.
 *
 * @param pieces `[{ rect, lines }]`, `lines` being what `windowLines` returned.
 */
export function composeFrame(width, height, pieces) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const crossing = pieces
      .filter(({ rect }) => y >= rect.top && y < rect.top + rect.height)
      .sort((a, b) => a.rect.left - b.rect.left);
    let row = '';
    let at = 0;
    for (const { rect, lines } of crossing) {
      if (rect.left > at) {
        row += ' '.repeat(rect.left - at);
        at = rect.left;
      }
      row += padVisible(lines[y - rect.top] ?? '', rect.width) + RESET;
      at += rect.width;
    }
    rows.push(at < width ? row + ' '.repeat(width - at) : row);
  }
  return rows;
}

/**
 * The alternate screen, and the rows on it.
 *
 * Writes only the rows that changed since the last frame: a busy session
 * prints hundreds of lines a second into one window, and repainting the four
 * others and the prompt for each of them is how a split screen flickers.
 */
export class SplitScreen {
  constructor(out = process.stdout) {
    this.out = out;
    this.last = [];
    this.on = false;
  }

  get width() {
    return this.out.columns ?? 80;
  }

  get height() {
    return this.out.rows ?? 24;
  }

  enter() {
    if (this.on) return;
    this.on = true;
    this.last = [];
    this.out.write(`${ALT_ON}${HOLD_STILL}${HIDE_CURSOR}${ESC}[2J${ESC}[H`);
  }

  /** Back to the normal screen, its scrollback exactly as it was left. */
  leave() {
    if (!this.on) return;
    this.on = false;
    this.last = [];
    this.out.write(`${RESET}${LET_GO}${ALT_OFF}${HIDE_CURSOR}`);
  }

  /** The window changed shape: every row is repainted on the next draw. */
  resize() {
    this.last = [];
    if (this.on) this.out.write(`${ESC}[2J`);
  }

  draw(rows) {
    if (!this.on) return;
    let out = '';
    for (let y = 0; y < rows.length; y++) {
      if (rows[y] !== this.last[y]) {
        out += `${ESC}[${y + 1};1H${rows[y]}${RESET}${ESC}[K`;
      }
    }
    this.last = rows.slice();
    if (out) this.out.write(out);
  }

  /** Leaving for good — a crash or a quit must not strand somebody on the alternate screen. */
  release() {
    if (this.on) {
      this.out.write(`${RESET}${LET_GO}${ALT_OFF}${SHOW_CURSOR}`);
      this.on = false;
    }
  }
}

// --- what a window says about its session -------------------------------------

/** A profile as the word a person uses for it — "dev", not CODE. */
export const TYPE_WORDS = {
  PLAN: 'plan', CODE: 'dev', REVIEW: 'review', ASK: 'ask', AUDIT: 'audit', SCOPE: 'scope',
  INTERVIEW: 'interview', MERGE: 'merge', RELEASE: 'release', ROADMAP: 'roadmap',
};

/** A pull request URL, and not the host's offer to open one (`/compare/`). */
export function isPullRequest(url) {
  return typeof url === 'string' && /^https?:\/\//.test(url) && !url.includes('/compare/');
}

/**
 * The window's title: what kind of session it is, where it stands, the card
 * and its title. The project is on a line of its own (`windowLines`'s
 * subtitle).
 *
 * @param meta what this terminal knows of a session — the daemon's snapshot
 *   (`projectSlug`, `label`, `profile`, `state`) and, once read, the platform's
 *   `view` of the run, which is where the card and the final state come from.
 * @param waiting a word when the session is stopped on a person, else null.
 */
/**
 * A dev session that ended FINISHED having committed nothing — R24: IMPLEMENT
 * stopped on a plan it would not follow, TEST and MEMORY ran on an untouched
 * branch, and the run finished. "finished" in green with `/pr` offered read
 * as work done, and `/pr` then said there was nothing to propose. Known only
 * once the terminal has read the run's commits (`meta.commits`); until then
 * nothing is claimed either way.
 */
export function builtNothing(meta) {
  const view = meta.view;
  return Boolean(meta.ended && view?.state === 'FINISHED'
    && (view.profile ?? 'CODE') === 'CODE' && meta.commits === 0);
}

export function titleFor(meta, waiting = null) {
  const view = meta.view ?? {};
  const profile = view.profile ?? meta.profile ?? null;
  const type = TYPE_WORDS[profile] ?? (profile ? String(profile).toLowerCase() : 'session');
  const what = view.entryRef
    ? `${view.entryRef} ${view.entryTitle ?? view.label ?? meta.label ?? ''}`.trim()
    : (view.label ?? meta.label ?? 'a session');
  const state = builtNothing(meta) ? 'finished · nothing built'
    : meta.ended
      ? String(view.state ?? 'ended').toLowerCase().replace(/_/g, ' ')
      : meta.state ?? 'running';
  // What it is and where it stands FIRST: a narrow window clips from the
  // right, and "plan · finished" is what decides what to do next. The project
  // is the window's subtitle, a line of its own, and not in here.
  return [type, waiting ?? state, what].filter(Boolean).join(' · ');
}

/**
 * What a person calls a model: `claude-opus-5-5` → `Opus 5.5`, `sonnet` →
 * `Sonnet`, `claude-haiku-4-5-20251001` → `Haiku 4.5`, `gpt-5-codex` →
 * `GPT-5-codex`. Anything else is shown as it came — a label must never hide
 * which model actually ran.
 */
export function modelLabel(model) {
  if (!model) return null;
  const raw = String(model).trim().replace(/\[.*\]$/, '');
  const claude = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+))?(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(raw);
  if (claude) {
    const [, family, major, minor] = claude;
    const version = major ? ` ${major}${minor ? `.${minor}` : ''}` : '';
    return `${family[0].toUpperCase()}${family.slice(1).toLowerCase()}${version}`;
  }
  if (/^gpt/i.test(raw)) return `GPT${raw.slice(3)}`;
  return raw;
}

/** Which CLI, as a person says it. */
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' };

/**
 * `Claude · Opus 5.5` — the agent a session runs on and its model, for the
 * window's second line. The daemon's word for a live session (what it
 * actually spawned, per stage), the platform's for an ended one. With no
 * model named, the CLI's own default is what ran, and it says so.
 */
export function agentModelFor(meta) {
  const agent = meta.agent ?? meta.view?.agent ?? null;
  const model = meta.model ?? meta.view?.model ?? null;
  if (!agent && !model) return '';
  const who = AGENT_NAMES[agent] ?? (agent ? String(agent) : 'Claude');
  return `${who} · ${modelLabel(model) ?? 'default model'}`;
}

/**
 * A window's second line: the project, and for a dev session the ABSOLUTE
 * path of the checkout its changes are being made in — on a machine with
 * `saasng`, `saasng-auto-1` and `saasng-auto-2`, the label alone does not say
 * which directory to open. The daemon's list says where a live session is;
 * the platform's view says where an ended one was.
 *
 * Too long for `width`, the path gives way FROM THE LEFT: `…/saasng-auto-2`
 * tells two checkouts apart, `/Users/ben/dev/…` tells nothing.
 */
export function subtitleFor(meta, width) {
  const project = `▸ ${meta.projectSlug ?? ''}`;
  const profile = meta.view?.profile ?? meta.profile ?? null;
  const path = meta.workspace ?? meta.view?.workspace ?? null;
  if (profile !== 'CODE' || !path) {
    return project;
  }
  const room = width - project.length - 3;
  if (room < 8) {
    return project;
  }
  const shown = path.length <= room ? path : `…${path.slice(path.length - room + 1)}`;
  return `${project} · ${shown}`;
}

/**
 * A window frame's colour, from where its session stands: `live` (red) while
 * it runs or waits, `done` (green) once it FINISHED — a plan planned, a dev
 * developed — and `stopped` (amber) for any other ending. Null until an ended
 * session's outcome has been read, so a frame never claims a success it has
 * not seen.
 */
export function toneFor(meta) {
  if (!meta.ended) {
    return 'live';
  }
  const state = meta.view?.state;
  if (!state || meta.view?.live) {
    return null;
  }
  // Finished having built nothing is not done: amber, not green.
  return state === 'FINISHED' && !builtNothing(meta) ? 'done' : 'stopped';
}

/**
 * What can be done about a session now — the window's last line. Empty while
 * it runs: the prompt, the answer and the permission keys are the prompt's.
 *
 * A finished PLAN on a card offers its development — `d`, in its place. A finished session that
 * wrote a branch offers the pull request until one is known, then shows it.
 * Every ended window can be closed.
 */
export function actionsFor(meta) {
  if (!meta.ended) {
    return '';
  }
  const view = meta.view;
  const parts = [];
  if (view?.canCarryOn && !meta.carryAsked) {
    parts.push('/continue picks it back up here');
  } else if (meta.carryAsked) {
    parts.push('continue asked for — back when this machine takes it');
  }
  if (view?.state === 'FINISHED' && view.profile === 'PLAN' && view.entryRef) {
    // `d` (or /develop) develops it with the agent that planned it, and the
    // development's window takes this one's place.
    parts.push(`d develops ${view.entryRef} here, in place of this plan`);
    parts.push('/open reads the plan on cawdev');
  }
  if (isPullRequest(view?.prUrl)) {
    parts.push(`PR ${view.prUrl} · /open`);
  } else if (meta.prAsked) {
    parts.push(meta.prAsked === true ? 'pull request asked for…' : meta.prAsked);
  } else if (builtNothing(meta)) {
    parts.push(`nothing was committed${view.entryRef ? ` — /new plan ${view.entryRef} to re-plan it` : ''}`);
  } else if (view?.branch && (view.profile ?? 'CODE') === 'CODE' && view.state === 'FINISHED') {
    parts.push('/pr opens the pull request');
  }
  if (meta.dropped) {
    parts.push('checkout deleted');
  } else if (isAutoCheckout(view?.workspace) && view?.state !== 'RUNNING' && !view?.live) {
    parts.push('/drop deletes its checkout');
  }
  parts.push('/close');
  return parts.join(' · ');
}

/**
 * Whether a run the platform listed is one THIS terminal can carry on, on
 * THIS machine — the console's Carry on, from here. Three conditions, each
 * the API's own refusal read in advance: the platform says it can be carried
 * on at all (`canCarryOn`: stopped or failed, a session or a hand-off to go
 * on from, not discarded); it is the signed-in person's, because carry-on is
 * the starter's alone; and its checkout is here or nowhere, because a run
 * holding one resumes on the machine that holds it.
 */
export function carriesOnHere(view, runnerId, email) {
  return Boolean(view?.canCarryOn)
    && Boolean(email) && view.startedByEmail === email
    && (!view.runnerId || view.runnerId === runnerId);
}

/**
 * Whether a checkout is one the daemon made on demand — `<first>-auto-<n>`
 * (auto-workspaces.mjs). Only those are ever offered to `/drop`: the
 * checkouts in the config are somebody's, and the project always keeps them.
 */
export function isAutoCheckout(path) {
  return typeof path === 'string' && /-auto-\d+$/.test(path.replace(/\/+$/, ''));
}

/**
 * `/new plan R3`, `/new dev R3`, `/new ask what does the importer do?` — and a
 * plan or a dev from a sentence, with no card: `/new plan add a CSV export`,
 * `/new dev fix the sort on the client list`. `@slug` anywhere names the
 * project; without it the caller asks which.
 *
 * One card reference and nothing else is that card; anything else is the task
 * in words. A plan from words writes its card first and plans what it wrote
 * (R150); a dev from words is a manual session, on a branch of its own.
 *
 * @param words what followed `/new`, split on spaces
 * @param projects the slugs this machine serves
 * @returns `{ kind, slug, ref }` for a card, `{ kind, slug, text }` for words,
 *   `{ needsProject, projects }` when no `@project` was written — the project
 *   is ALWAYS asked, never guessed — or `{ error }` in words.
 */
/**
 * A command line as words — on spaces and tabs, with every line break kept as
 * a word of its own (`'\n'`). Splitting on all whitespace turned a pasted list
 * of requirements into one long line; kept here, `wordsText` puts it back.
 */
export function commandWords(text) {
  return String(text).split(/[ \t]+/).flatMap((token) => token.split(/(\n)/)).filter(Boolean);
}

/** The words of a task back into its text, line breaks where they were. */
export function wordsText(words) {
  return words.join(' ').replace(/ *\n */g, '\n').trim();
}

export function parseNew(words, { projects = [] } = {}) {
  const named = words.find((word) => word.startsWith('@'));
  const rest = words.filter((word) => word !== named && word !== '');
  const [kindWord, ...args] = rest;
  const kind = { plan: 'plan', dev: 'dev', code: 'dev', ask: 'ask' }[String(kindWord ?? '').toLowerCase()];
  const usage = 'use /new plan R3, /new dev R3, /new plan|dev <the task in words> or /new ask <question>'
    + ' (and @project to pick one)';
  if (!kind) {
    return { error: kindWord ? `no such session kind: ${kindWord} — ${usage}` : usage };
  }
  const slug = named ? named.slice(1) : null;
  if (slug && projects.length && !projects.includes(slug)) {
    return { error: `this machine does not serve ${slug} — it serves ${projects.join(', ')}` };
  }
  const text = wordsText(args);
  if (!text) {
    return { error: kind === 'ask' ? 'ask what? /new ask <question>'
      : `${kind} what? /new ${kind} R3, or /new ${kind} <the task in words>` };
  }
  let what;
  if (kind !== 'ask' && args.length === 1 && /^[RrIi]?\d+$/.test(args[0])) {
    // A card is written R3 and an issue i3 — EntryRef's spelling; a bare
    // number is a roadmap card, as it is everywhere else.
    const digits = args[0].replace(/^[RrIi]/, '');
    what = { kind, ref: /^[Ii]/.test(args[0]) ? `i${digits}` : `R${digits}` };
  } else {
    what = { kind, text };
  }
  // Never guessed — not from the focused window, not from a machine serving
  // one project: a session started on the wrong project is a card planned or
  // a branch cut in the wrong repository, and asking costs one key.
  if (!slug) {
    return projects.length
      ? { needsProject: true, projects: [...projects], error: `which project? ${projects.join(', ')}` }
      : { error: 'this machine serves no project yet — c adds one' };
  }
  return { ...what, slug };
}

/**
 * The branch a dev from words works on: `task-` and the first words of the
 * task, accents folded, and a short suffix so two tasks worded alike do not
 * share one. Never the default branch — a manual session given no branch
 * works on the project's default, and a task typed into a prompt must not
 * commit straight onto `main`.
 */
/**
 * The title of the card `/new dev <the task in words>` writes before it
 * starts: the sentence itself, its first line, cut between words near a
 * hundred characters with `…` — the whole text goes in the card's body, so
 * nothing typed is lost to the cut.
 */
export function cardTitleFor(text, max = 100) {
  const first = String(text).trim().split('\n')[0].trim();
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

export function branchForTask(text, suffix = Date.now().toString(36).slice(-4)) {
  const words = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let cut = words.slice(0, 40);
  if (words.length > 40 && cut.includes('-')) {
    cut = cut.slice(0, cut.lastIndexOf('-'));
  }
  return ['task', cut || 'session', suffix].filter(Boolean).join('-');
}

// --- the roadmap, across the top ------------------------------------------------

/**
 * A card's title in `rows` lines of at most `width`, broken between words — a
 * card read at a glance should not say "mob / ile" — with `…` where it had to
 * stop. A word longer than a line is cut, since it cannot be broken anywhere
 * better.
 */
export function wordsIn(text, width, rows) {
  const lines = [];
  let line = '';
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const word = words[i].length > width ? `${words[i].slice(0, width - 1)}…` : words[i];
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === rows) {
      line = '';
      const last = lines[rows - 1];
      lines[rows - 1] = last.length < width ? `${last}…` : `${last.slice(0, width - 1)}…`;
      return lines;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, rows);
}

/**
 * Plain text in lines of at most `width`, broken between words; a word longer
 * than a line is cut, since it cannot be broken anywhere better. What a
 * question needs in a narrow prompt: `wordsIn` stops after N rows, and
 * ansi.mjs's `wrap` breaks mid-word ("fiscal ye" / "ar?").
 */
export function wordWrap(text, width) {
  const w = Math.max(1, width);
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (let word of paragraph.split(/\s+/).filter(Boolean)) {
      while (word.length > w) {
        if (line) { lines.push(line); line = ''; }
        lines.push(word.slice(0, w));
        word = word.slice(w);
      }
      if (!word) continue;
      const next = line ? `${line} ${word}` : word;
      if (next.length <= w) {
        line = next;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * The board's columns, in the board's order, and the words the console uses
 * for them — the work still to be done, which is what somebody at this
 * terminal acts on. MERGED, SHIPPED and DECLINED are not columns: the work
 * is over, the three only grow, and the console's own board folds the last
 * two to a count (R68) for the same reason — so here all three are counts
 * beside the project's name. BACKLOG is a count too, at the head of them: it
 * is work not yet taken up rather than work over, but a column of it would be
 * the first to give way, and since R371 it is where a new issue lands — left
 * out, a project's fresh bugs were on no line of the strip at all.
 */
export const BOARD_COLUMNS = [
  ['CONSIDERING', 'Considering'],
  ['PLANNED', 'Planned'],
  ['IN_DEVELOPMENT', 'In development'],
];
const FOLDED = [['BACKLOG', 'backlog'], ['MERGED', 'merged'], ['SHIPPED', 'shipped'], ['DECLINED', 'declined']];

/**
 * The column a card is drawn in. An issue (R85) has statuses of its own for
 * the first two steps — NEW is reported and not yet agreed, CONFIRMED is
 * agreed and waiting for somebody, the platform's `afterPlanning` — and they
 * are Considering's and Planned's counterparts, so they share those columns
 * rather than adding two more to a strip that already gives columns away.
 */
export function columnOf(status) {
  return { NEW: 'CONSIDERING', CONFIRMED: 'PLANNED' }[status] ?? status;
}

/** Most broken first: the issues board's own order (R85), and what a column cut short keeps. */
const SEVERITY_ORDER = ['CRITICAL', 'MEDIUM', 'MINOR'];

/**
 * Which column gives way first when the width runs out: the ideas, then what
 * is ready, and what is being built last of all — the order of how much a
 * person at this terminal is about to act on it.
 */
const GIVES_WAY = ['CONSIDERING', 'PLANNED', 'IN_DEVELOPMENT'];

/** Narrower than this, a column's card lines say nothing. */
export const MIN_COLUMN = 18;

/** Header rows above the cards: the projects, then the columns. */
const STRIP_HEAD = 2;

/**
 * The roadmap across the top of advanced mode: every project this machine
 * serves, each as a small board — its columns side by side, one line per
 * card, a `●` on a card with a session running now.
 *
 * THE ROOM RUNS OUT TWO WAYS, and each is said rather than cut:
 * - **Too many cards for the rows** — a column ends in `+N more` on its last
 *   row, never a card cut in half, and the header keeps the true count.
 * - **Too many columns for the width** — empty columns go first (the header
 *   line of their project still names nothing lost), then whole columns in
 *   `GIVES_WAY` order, each named in the project's header as `merged 3
 *   hidden`; then whole projects, counted as `+N projects`. A project always
 *   keeps one column.
 *
 * Between `STRIP_HEAD + 1` and `maxRows` lines — as many as the fullest
 * column needs, no more — of exactly `width` columns. One line when there is
 * no project at all.
 *
 * ISSUES SHARE THE COLUMNS (`columnOf`) and go first in each, most severe
 * first: a column cut to `+N more` should not hide a critical defect under
 * ideas. Their ref (`i12`) is in the colour of their severity.
 *
 * @param cards `[{ ref, title, slug, status, live?, severity? }]` — a card
 *   with a `severity` is an issue
 * @param projects the slugs to show, in order; defaults to those the cards
 *   come from
 */
export function roadmapStrip(width, maxRows, cards, ink, projects = null) {
  const slugs = projects?.length ? [...projects] : [...new Set(cards.map((card) => card.slug))];
  if (!slugs.length) {
    return [padVisible(ink.muted(' no project here yet — the roadmap shows here'), width)];
  }
  const boards = slugs.map((slug) => {
    const mine = cards.filter((card) => card.slug === slug);
    return {
      slug,
      folded: FOLDED.map(([status, word]) => [word, mine.filter((c) => c.status === status).length]),
      columns: BOARD_COLUMNS.map(([status, label]) => ({
        status, label, cards: inColumn(mine, status),
      })),
      hidden: [],
    };
  });

  // What fits: every column at MIN_COLUMN, a space between two columns and a
  // rule between two projects.
  const need = (list) => list.reduce((sum, board) => sum + board.columns.length * (MIN_COLUMN + 1), 0)
    - 1 + (list.length - 1) * 2;
  const drop = (board, column) => {
    board.columns = board.columns.filter((each) => each !== column);
    if (column.cards.length) board.hidden.push(column);
  };
  if (need(boards) > width) {
    for (const board of boards) {
      for (const column of [...board.columns]) {
        if (!column.cards.length && board.columns.length > 1) drop(board, column);
      }
    }
  }
  for (const status of GIVES_WAY) {
    if (need(boards) <= width) break;
    for (const board of boards) {
      const column = board.columns.find((each) => each.status === status);
      if (column && board.columns.length > 1) drop(board, column);
    }
  }
  const shown = [...boards];
  while (shown.length > 1 && need(shown) > width) shown.pop();
  const hiddenProjects = boards.length - shown.length;

  // Widths: what is left after the gaps, shared by column, the remainder
  // going to the first columns so the rule lines never move by one.
  const columnCount = shown.reduce((sum, board) => sum + board.columns.length, 0);
  const gaps = shown.reduce((sum, board) => sum + board.columns.length - 1, 0) + (shown.length - 1) * 3;
  const base = Math.max(1, Math.floor((width - gaps) / columnCount));
  let extra = Math.max(0, width - gaps - base * columnCount);
  for (const board of shown) {
    for (const column of board.columns) {
      column.width = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra -= 1;
    }
    board.width = board.columns.reduce((sum, column) => sum + column.width, 0) + board.columns.length - 1;
  }

  // Rows: as many as the fullest column needs, within what the screen gave.
  const fullest = Math.max(1, ...shown.flatMap((board) => board.columns.map((column) => column.cards.length)));
  const rows = Math.max(STRIP_HEAD + 1, Math.min(maxRows, STRIP_HEAD + fullest));
  const cardRows = rows - STRIP_HEAD;

  const lineOf = (pick) => shown.map((board, b) => {
    const segment = pick(board, b);
    return padVisible(ellipsed(segment, board.width), board.width);
  }).join(ink.muted(' │ '));

  const lines = [];
  lines.push(lineOf((board, b) => {
    const counts = board.folded.filter(([, n]) => n).map(([word, n]) => `${n} ${word}`);
    const lost = board.hidden.map((column) => `${column.label.toLowerCase()} ${column.cards.length} hidden`);
    const more = b === shown.length - 1 && hiddenProjects
      ? [`+${hiddenProjects} project${hiddenProjects === 1 ? '' : 's'}`] : [];
    // What is NOT drawn first: a clipped header should lose the tally of
    // shipped work before it loses the fact that a column is missing.
    const tail = [...lost, ...more, ...counts].join(' · ');
    return `${ink.bold(board.slug)}${tail ? ink.muted(` · ${tail}`) : ''}`;
  }));
  lines.push(lineOf((board) => board.columns.map((column) =>
    padVisible(clip(`${hueOf(column.status, ink)(column.label)} ${ink.muted(String(column.cards.length))}`,
      column.width), column.width)).join(' ')));
  for (let row = 0; row < cardRows; row++) {
    lines.push(lineOf((board) => board.columns.map((column) => {
      const overflow = column.cards.length > cardRows;
      const last = row === cardRows - 1;
      let cell = '';
      if (overflow && last) {
        cell = ink.muted(`+${column.cards.length - (cardRows - 1)} more`);
      } else if (column.cards[row]) {
        const card = column.cards[row];
        const mark = card.live ? ink.accent('●') : ' ';
        cell = `${mark}${refInk(card, ink)(card.ref)} ${card.title ?? ''}`;
      } else if (row === 0 && !column.cards.length) {
        cell = ink.muted(' —');
      }
      return padVisible(ellipsed(cell, column.width), column.width);
    }).join(' ')));
  }
  return lines.map((line) => padVisible(clip(line, width), width));
}

/** A column's cards: its issues first, most severe first, then its roadmap cards, each in the order given. */
function inColumn(cards, status) {
  const here = cards.filter((card) => columnOf(card.status) === status);
  const rank = (card) => {
    const at = SEVERITY_ORDER.indexOf(card.severity);
    return at === -1 ? SEVERITY_ORDER.length : at;
  };
  const issues = here.filter((card) => card.severity).sort((a, b) => rank(a) - rank(b));
  return [...issues, ...here.filter((card) => !card.severity)];
}

/** A card's ref in bold; an issue's in the colour of how broken it is. */
function refInk(card, ink) {
  if (!card.severity) return ink.bold;
  const hue = card.severity === 'CRITICAL' ? ink.danger : card.severity === 'MEDIUM' ? ink.warn : ink.muted;
  return (text) => ink.bold(hue(text));
}

/** Clipped to `width`, with `…` where it had to stop — a title cut dead reads as the whole title. */
function ellipsed(text, width) {
  return visibleWidth(text) <= width ? text : `${clip(text, width - 1)}…`;
}

/** A column's name in the colour of how close to done it is. */
function hueOf(status, ink) {
  return status === 'IN_DEVELOPMENT' ? ink.accent
    : status === 'MERGED' ? ink.success
      : status === 'PLANNED' ? ink.warn : ink.muted;
}

// --- more sessions than windows ------------------------------------------------

/** No more windows than this: past four, a window is too small to read. */
export const MAX_WINDOWS = 4;

/**
 * Which sessions get a window when there are more than `max`, in the order
 * they are listed (so a window does not jump about as the choice changes).
 *
 * The focused one always — Tab onto a session in the tab line brings it up.
 * Then sessions still running, then ended ones, each most recently focused
 * first: the work in progress is what the screen is for.
 *
 * @param metas every session with a window, listed in their order
 * @param recent session ids, most recently focused first
 */
export function visibleSessions(metas, recent, focus, max = MAX_WINDOWS) {
  if (metas.length <= max) return metas;
  const rank = (meta) => {
    const at = recent.indexOf(meta.id);
    return [meta.id === focus ? 0 : 1, meta.ended ? 1 : 0, at === -1 ? Infinity : at];
  };
  const order = [...metas].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || metas.indexOf(a) - metas.indexOf(b);
  });
  const keep = new Set(order.slice(0, max).map((meta) => meta.id));
  return metas.filter((meta) => keep.has(meta.id));
}

/**
 * The one line naming the sessions with no window: each one's number (what
 * `1`–`9` and the window titles use), its kind, its card and where it stands,
 * in its state's colour. Clipped to the width, the count of what did not fit
 * at the end.
 *
 * @param hidden `[{ n, meta }]`
 */
export function tabsLine(hidden, width, ink) {
  const byTone = { live: ink.danger, done: ink.success, stopped: ink.warn };
  const parts = hidden.map(({ n, meta }) => {
    const view = meta.view ?? {};
    const type = TYPE_WORDS[view.profile ?? meta.profile] ?? 'session';
    const state = meta.ended ? String(view.state ?? 'ended').toLowerCase() : meta.state ?? 'running';
    const what = clip(String(view.entryRef ?? view.label ?? meta.label ?? ''), 24);
    const text = `${n} ${type} · ${state}${what ? ` · ${what}` : ''}`;
    return (byTone[toneFor(meta)] ?? ink.muted)(text);
  });
  // Room is kept for the "+N more" a line that does not hold them all ends in.
  const reserve = 24;
  let line = ink.muted(' also ▸ ');
  for (let i = 0; i < parts.length; i++) {
    const next = line + (i ? ink.muted('   ') : '') + parts[i];
    const last = i === parts.length - 1;
    if (!last && visibleWidth(next) > width - reserve && i > 0) {
      line += ink.muted(`   +${parts.length - i} more — tab reaches them`);
      break;
    }
    line = next;
  }
  return padVisible(clip(line, width), width);
}

/**
 * A session named so a person can find its window: its number, its kind, its
 * card (or label) and its project — "2 · plan · R3 Offline mode — saasng".
 * What a question or a permission request in the prompt says it came from.
 */
export function sessionTag(n, meta) {
  const view = meta?.view ?? {};
  const profile = view.profile ?? meta?.profile ?? null;
  const type = TYPE_WORDS[profile] ?? (profile ? String(profile).toLowerCase() : 'session');
  // Cut, so the tag leaves room for what it is attached to — the question.
  const what = clip(view.entryRef
    ? `${view.entryRef} ${view.entryTitle ?? ''}`.trim()
    : (view.label ?? meta?.label ?? 'a session'), 32);
  return `${n ? `${n} · ` : ''}${type} · ${what}${meta?.projectSlug ? ` — ${meta.projectSlug}` : ''}`;
}

// --- a card, in the terminal ---------------------------------------------------

/** How many lines of a card's body `/view` prints before pointing at the web. */
export const CARD_BODY_LINES = 30;

/**
 * `/view R29`: a card as lines for the transcript — what it is, where it
 * stands, who has it, its branch and pull request, then its body. Pure, so it
 * is read at every combination rather than guessed from a live platform.
 * Only what the card SAYS: an empty field draws no line, because a row of
 * "none"s is read instead of scanned.
 *
 * @param card the platform's RoadmapEntryView (`GET …/roadmap/{ref}`).
 * @param url the card's page on the console, or null.
 */
export function cardLines(card, ink, url = null) {
  const lines = [];
  const field = (label, value) => {
    if (value) lines.push(`   ${ink.muted(label.padEnd(9))} ${value}`);
  };
  lines.push(` ${ink.bold(`${card.ref ?? ''} ${card.title ?? ''}`.trim())}`);
  const kind = card.kind === 'ISSUE'
    ? `issue${card.severity ? ` · ${String(card.severity).toLowerCase()}` : ''}` : null;
  field('status', [card.statusDisplay ?? card.status, kind].filter(Boolean).join(' · '));
  field('section', card.section);
  field('tags', card.tags?.length ? card.tags.join(', ') : null);
  field('sprint', card.sprint ? `${card.sprint.label ?? card.sprint.ref ?? card.sprint.number} ${card.sprint.name ?? ''}`.trim() : null);
  const item = card.workItem;
  field('branch', card.branch ?? item?.branch);
  field('work', item ? [item.statusDisplay ?? item.status, item.runnerName && `on ${item.runnerName}`]
    .filter(Boolean).join(' · ') : null);
  const pr = item?.prUrl ?? card.review?.prUrl;
  field('pr', isPullRequest(pr) ? pr : null);
  const run = card.activeRun;
  field('session', run ? [String(run.state ?? '').toLowerCase().replace(/_/g, ' '),
    run.runnerName && `on ${run.runnerName}`].filter(Boolean).join(' · ') : null);
  field('coding', card.codingBy?.email);
  field('review', card.reviewingBy?.email);
  field('rejected', card.rejection?.note ? `${card.rejection.note}${card.rejection.decidedByEmail ? ` — ${card.rejection.decidedByEmail}` : ''}` : null);
  field('merged', card.merge);
  field('version', card.version);
  field('declined', card.declinedReason);
  field('related', card.relatedRefs?.length ? card.relatedRefs.join(', ') : null);
  field('after', card.after?.length ? card.after.map((each) => each.ref).join(', ') : null);
  field('web', url);
  const body = String(card.body ?? '').replace(/\s+$/, '');
  if (body) {
    const all = body.split('\n');
    lines.push('');
    for (const line of all.slice(0, CARD_BODY_LINES)) lines.push(`   ${line}`);
    if (all.length > CARD_BODY_LINES) {
      lines.push(ink.muted(`   … ${all.length - CARD_BODY_LINES} more line(s)${url ? ' — the rest on the web' : ''}`));
    }
  }
  return lines;
}
