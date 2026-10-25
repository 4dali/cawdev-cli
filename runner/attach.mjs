// The cawdev terminal client — R52, rewritten around the scrollback by R81.
//
// Two channels, on purpose, because they answer to different authorities:
//
//   THE SOCKET tells you what this machine is doing. Runs, transcripts, the
//   daemon's log, and the reason each queued run is waiting — which exists
//   nowhere else. Read-only, and available while the platform is down.
//
//   HTTP does anything that CHANGES something, signed in as you. Prompting,
//   cancelling and deciding a permission request all refuse a token (R51), so
//   they cannot go through the daemon: it would either lend its own credential
//   to a guard built to stop exactly that, or hold yours. Neither.
//
// The split has a plain consequence worth knowing: **you can watch without
// signing in, and you cannot act without it.** Watching is disclosed to whoever
// can already read the socket in your home directory; acting is you.
//
// **R81 took the alternate screen away, and that is the whole change.** This
// used to own the viewport and repaint a pane into it, which meant the
// terminal's own scroll, its wheel, its search and its copy all stopped working
// the moment you attached. Now the transcript is PRINTED — it goes into the
// scrollback and stays there — and the only thing drawn is a footer at the
// bottom. See scrollback.mjs for the mechanism; it is less machinery than the
// pane manager it replaced, not more.
//
// Three consequences worth stating, because they are what the rewrite bought:
//
//   - Scrolling up reaches the start of the session, using the scrollbar you
//     already had.
//   - The rail of runs is gone. It cost width on every line of every transcript
//     to answer a question asked a few times an hour; `L` is an overlay now.
//   - R62's five settings are in the footer, where they never scroll away,
//     rather than in a top bar that did.
//
// **R83 made answering a thing you pick rather than a thing you retype.** The
// agent has usually already worked out the two or three answers it can act on —
// `ask_user` has carried `options` since R10 — and this was the one surface that
// threw them away. Now a question with options arrives as a list you move
// through, a permission request is the same list with R60's three lengths of yes
// in it, and the last row of a question opens a line editor because the options
// are the agent's guess and the value of asking a person is that they can say
// the thing that was not on it. See select.mjs for the widget and input.mjs for
// the line — both pure, both readable without a terminal.
//
// Zero dependencies, so this is ANSI escapes and `setRawMode` rather than a
// curses library.

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { basename, dirname } from 'node:path';
import { listSockets, socketPathFor } from './control.mjs';
import {
  RESTART_FROM_ATTACH, addProject, addWorkspace, agentsOf, pathsOf, readConfigFile, reloadIfRunning,
  removeProject, setAcceptsRulesFromConsole, setAgentEnabled, setMaxPlanningRuns, setPaused, setQuality, slugsOf,
} from './configure.mjs';
import {
  TYPE_A_PATH, absolute, completePath, describe, inspectPath, listDirectories,
} from './paths.mjs';
import { clip, keyList, padVisible, painter, stripAnsi, visibleWidth, wrap } from '../lib/ansi.mjs';
import { restartNeededFor } from '../lib/runner-config.mjs';
import {
  BOARD_COLUMNS, MIN_ZONE_HEIGHT, PROMPT_ROWS, SplitScreen, readerFrame, tabsLine, visibleSessions, actionsFor, composeFrame,
  carriesOnHere, builtNothing, cardLines, columnOf, cardTitleFor, commandWords, wordsText, subtitleFor, agentModelFor, wordWrap, isAutoCheckout, isPullRequest, parseNew, roadmapStrip, sessionTag, splitLayout, titleFor, toneFor,
  windowLines,
} from './split.mjs';
import { KNOWN_AGENTS, agentOfCommand } from '../lib/agents.mjs';
import { loadPrefs, savePrefs } from './prefs.mjs';
import { oneLine } from './brand.mjs';
import { Scrollback } from './scrollback.mjs';
import { Session, signInThroughBrowser, storedSession } from './sign-in.mjs';
import { clearSession } from './session-store.mjs';
import { clearHistory, loadHistory, pushHistory } from './history.mjs';
import {
  History, KeyStream, Line, Pastes, commonPrefix, completionLines, completions, keysIn,
} from './input.mjs';
import { Select, WRITE_MY_OWN, pickFromLine, plainLines } from './select.mjs';

// Re-exported because they were this file's before R81 moved them into the
// shared ANSI helpers — and `keysIn` and `keyList` before R83 moved them beside
// the rest of the input and the rest of the layout. The tests that pin the
// arithmetic import them here.
export { clip, keyList, keysIn, stripAnsi, visibleWidth, wrap };

const ESC = '\x1b';

/** Colours for a run's state. Muted, because the transcript is the content. */
const STATE_COLOUR = {
  running: 'success',
  claiming: 'warn',
  queued: 'muted',
};

// --- the rules, which are pure and therefore testable -------------------------

/**
 * The question stopping a session, and whether this operator may answer it —
 * R58.
 *
 * Pure, and separate from the drawing, because it is a *rule* rather than a
 * layout: the API refuses anyone else with a message naming the owner, and a
 * terminal that offered the key anyway would turn "this is Alice's question"
 * into "cawdev is broken". The rule is the API's three ways in, by email —
 * this program never learns a user id, and `sharedWithEmail` is on the share
 * for exactly this kind of client.
 *
 * Returns null when nothing is waiting, which is the common case and the one
 * the caller wants to say nothing about.
 */
export function questionState(questions, email) {
  const open = (questions ?? []).find((question) => !question.answered);
  if (!open) {
    return null;
  }
  const handedToYou = (open.shares ?? []).some(
    (share) => share.open && share.kind === 'DECIDE' && share.sharedWithEmail === email,
  );
  return {
    question: open,
    // No owner means the run has no starter, which leaves the question open to
    // the project — the one case R58 deliberately did not narrow.
    yours: Boolean(email) && (!open.waitingOnEmail || open.waitingOnEmail === email
      || handedToYou),
    waitingOn: open.waitingOnEmail ?? null,
  };
}

/**
 * That question, drawn — R58, and a function rather than a method so it can be
 * rendered and looked at without a terminal.
 *
 * **Two shapes, and the second is why this exists.** When the question is this
 * operator's, `a` answers it here. When it is not, the banner names the person
 * it is waiting on instead of offering a key that would 403 — a terminal that
 * let somebody type an answer and then refused it reads as cawdev being broken
 * rather than as the question belonging to a colleague.
 */
export function questionBanner(asking, width, ink = painter(3), { entire = false } = {}) {
  if (!asking) return [];

  const options = asking.question.options?.length
    ? ink.muted(` · ${asking.question.options.join(' / ')}`)
    : '';
  // 12 is the label and its spaces: the same arithmetic the permission banner
  // uses, and for the same reason — clip counts visible characters.
  // `entire` (advanced mode, where the banner is the only place the question
  // is shown): every word of it, wrapped between words under the label.
  const label = ink.bold(ink.accent(' question '));
  const head = entire
    ? wordWrap(asking.question.question, width - 12)
      .map((line, i) => `${i === 0 ? label : ' '.repeat(10)} ${line}`)
    : [`${label} ${clip(asking.question.question, width - 12)}`];

  if (asking.yours) {
    return [...head, ` ${ink.success('a')} answer${options}`];
  }
  // The NAME is the last thing to go, the way the session total is on R62's
  // bar: "waiting on alice@…" is the whole answer to "why is that not moving",
  // and the clause after it is a courtesy. Truncating the sentence instead
  // spends the narrow terminal's last columns on the courtesy and cuts the
  // answer — which is what looking at this at 40 columns showed.
  const who = ` waiting on ${asking.waitingOn ?? 'somebody else'}`;
  const whole = `${who} — theirs to answer, or somebody they hand it to`;
  return [...head, ink.muted(clip(whole.length <= width ? whole : who, width))];
}

/**
 * What a key means for a permission request — R51, R60, R78, R135.
 *
 * Pure, and returning null for a key that cannot be honoured, because `Y`
 * cannot always be: the caller says so rather than sending a decision with
 * nothing to write, which the server would quietly turn into an allow-once.
 *
 * TWO patterns can be written now, and they are different offers. `suggestion`
 * is the machine's reading of what somebody meant — `mvn --version` offers
 * `Bash(mvn *)`. `exactPattern` is the command itself, verbatim, for the
 * compound and path-shaped commands no wildcard fits; it grants nothing but
 * itself, and before R135 those had no lasting answer at any key.
 */
export function permissionDecision(approval, key, machine = {}) {
  switch (key) {
    case 'y':
      return { allow: true, scope: 'ONCE' };
    case 's':
      // The whole tool when there is no narrower rule to name — the same two
      // sizes the console offers, chosen for you because a terminal has one
      // key. It dies with the run either way.
      return { allow: true, scope: 'SESSION',
        pattern: approval.suggestion ?? approval.toolName };
    case 'Y': {
      // The exact rule only when this machine said it would apply it: a
      // project rule outside the ceiling is dropped here on every call, so the
      // key would take an answer the next session does not keep. A suggestion
      // is offered as it always was — the console narrows it, and the ceiling
      // filter runs where it is enforced.
      const pattern = approval.suggestion
        ?? (approval.exactWithinCeiling ? approval.exactPattern : null);
      return pattern ? { allow: true, scope: 'PROJECT', pattern } : null;
    }
    case 'M':
      // R126, the widest of the four: every project that ever runs on this
      // machine. Null — and so not offered — for the two reasons it can be:
      // no pattern to write, as with `Y`, and a machine whose own config does
      // not accept rules from the console. A key that takes an answer the
      // platform then refuses reads as cawdev being broken, which is R58's
      // rule about the `a` key applied to this one.
      //
      // NOT filtered by the ceiling, unlike `Y`, and that is the whole of
      // R126: this is the scope that RAISES it.
      return (approval.suggestion ?? approval.exactPattern) && machine.acceptsConsoleRules
        ? { allow: true, scope: 'RUNNER',
          pattern: approval.suggestion ?? approval.exactPattern }
        : null;
    default:
      return null;
  }
}

/**
 * A pending permission request, drawn — R51 and R60's three answers.
 *
 * Two rules met here, from two sessions, and they were nearly contradictory.
 *
 * **Every key has to survive any width, and `n` is the one that would go.**
 * Written at its full length this row is ninety characters; clipped to a
 * forty-column terminal it read `y allow once   s allow for th`, which offers
 * two answers and hides *refuse* — the one somebody reaches for when they do
 * not like what they are looking at. Found by rendering it at four widths and
 * reading them, which is the only way this kind of thing is ever found.
 *
 * **And a grant is never cut short** (R78). "allow every Bash this s" describes
 * a promise nobody made, and this is the one banner in the program where the
 * words are a decision about what a machine may do rather than a status.
 *
 * So: the WORDING shortens — a whole phrasing at a time, never mid-clause —
 * and what will not fit on one row WRAPS onto the next. Nothing is dropped and
 * nothing is truncated while a shorter honest wording is still available. The
 * long wording says what `s` covers, because "for this session" and "every
 * Bash for this session" are not the same promise.
 */
export function permissionBanner(pending, width, ink = painter(3), machine = {}) {
  if (!pending) return [];
  // Called with a pending record by the client, and with the approval itself by
  // the rule's own tests — the banner is about the request either way.
  const approval = pending.approval ?? pending;
  const covers = approval.suggestion ?? `every ${approval.toolName}`;

  // The two standing-rule keys, asked here exactly as `permissionDecision`
  // asks them, so the banner and the key handler cannot disagree about what is
  // on offer. R126's `M` is offered only when this machine accepts rules from
  // the console; R135's exact rule reaches `Y` only inside the ceiling.
  const here = approval.suggestion
    ?? (approval.exactWithinCeiling ? approval.exactPattern : null);
  const onTheMachine = (approval.suggestion ?? approval.exactPattern)
    && machine.acceptsConsoleRules;

  // R78, and the reason `Y` is not always labelled with what it writes: an
  // exact rule is as long as the command, which is already on the line above
  // verbatim. Ninety characters inside the key row would either wrap the
  // banner badly or be clipped into a promise nobody made — so the wildcard
  // pattern is named and the exact one is described.
  const always = here
    ? (approval.suggestion
      ? `always allow ${approval.suggestion} here`
      : 'always allow this exact command here')
    : null;

  const long = [
    `${ink.success('y')} allow once`,
    `${ink.success('s')} allow ${covers} this session`,
    ...(always ? [`${ink.warn('Y')} ${always}`] : []),
    ...(onTheMachine
      ? [`${ink.warn('M')} always, on this machine`]
      : []),
    `${ink.danger('n')} refuse`,
  ];
  const short = [
    `${ink.success('y')} once`,
    `${ink.success('s')} session`,
    ...(always ? [`${ink.warn('Y')} ${always}`] : []),
    ...(onTheMachine ? [`${ink.warn('M')} this machine`] : []),
    `${ink.danger('n')} refuse`,
  ];

  // Two rows is the most a banner may take before it is the screen rather than
  // a note on it. What gives way, in order: first the wording shortens, and
  // only then the STANDING RULE goes — the widest clause and the least urgent,
  // and the only one of the four that can wait for a wider terminal. `n
  // refuse` never moves, because it is the one somebody reaches for when they
  // do not like what they are looking at.
  // R126's `M` goes with `Y`: both are standing rules, both are the widest and
  // least urgent clauses, and dropping one while keeping the other would leave
  // the banner offering the WIDER of the two on the narrower terminal.
  const without = (choices) => choices.filter((each) => !/\b[YM]\b/.test(stripAnsi(each)));
  const rows = (choices) => wrapChoices(choices, width);
  const keys = [long, without(long), short, without(short)]
    .map(rows)
    .find((lines) => lines.length <= 2)
    ?? rows(without(short));

  // A stage gate's summary is the whole PLAN, many lines long: one row here,
  // and how much more there is — `/view` reads it whole. Clipped as one
  // string, its newlines went through and filled the prompt.
  const [first = '', ...more] = String(approval.summary ?? '').split('\n');
  const rest = more.filter((line) => line.trim()).length;
  const tail = rest ? ` (+${rest} lines)` : '';
  return [
    `${ink.bold(ink.warn(' permission '))} ${clip(first, Math.max(8, width - 13 - tail.length))}${ink.muted(tail)}`,
    ink.muted(` ${approval.toolName} · waiting since ${approval.askedAt?.slice(11, 19) ?? ''}`),
    ...keys,
  ];
}

/**
 * The choices across as few rows as fit, wrapping rather than truncating.
 *
 * Only a terminal too narrow for one choice on its own reaches the clip at the
 * end, and there is nothing better than a cut line to give it.
 */
function wrapChoices(choices, width, gap = '   ') {
  const lines = [];
  let line = '';
  for (const choice of choices) {
    const next = line ? `${line}${gap}${choice}` : ` ${choice}`;
    if (line && visibleWidth(next) > width) {
      lines.push(line);
      line = ` ${choice}`;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.map((each) => clip(each, width));
}

/**
 * What the footer counts — R62, unchanged by R81 except in where it is drawn.
 *
 * **A queued run is not a session.** It is precisely the run that has NOT
 * taken a slot, and counting it would make the footer say the machine is full
 * at the moment it is not — which is exactly backwards, because "full" is the
 * answer to "why is mine queued".
 *
 * `room` is how many checkouts the project has (R47's per-project gate), and
 * is absent when talking to a daemon older than R62. Then there is nothing to
 * compare against and the count stands alone, rather than being shown over a
 * number that was guessed.
 *
 * **Only coding sessions are counted against `room`** — R70. The checkouts are
 * what that number bounds, and an ASK, a ROADMAP, an AUDIT or a SCOPE takes none.
 */
export function sessionCounts(runner, runs) {
  const live = (runs ?? []).filter((run) => run.state !== 'queued');
  const here = new Map();
  for (const run of live) {
    // R70: the checkouts bound coding alone. Only a run that SAYS it writes no
    // code is left out — a daemon too old to send the flag is counted as it
    // always was, because inventing "this is a question" from silence would
    // show a busy checkout as free, which is the failure worth avoiding.
    if (run.writesCode === false) continue;
    here.set(run.projectSlug, (here.get(run.projectSlug) ?? 0) + 1);
  }
  const projects = (runner?.projects ?? []).map((slug) => {
    const count = here.get(slug) ?? 0;
    const room = runner?.workspaces?.[slug];
    return { slug, count, room, full: Boolean(room) && count >= room };
  });
  return { total: live.length, cap: runner?.maxSessions, projects };
}

/**
 * The footer's counting row — R62, moved down by R81 and otherwise untouched.
 *
 * The arithmetic is the whole risk here: everything on this row is coloured,
 * and a coloured string is about ten characters longer than it looks. Padding
 * or truncating by `length` is what put `2/2sessions` on screen with no space
 * between them the first time this was rendered and looked at.
 */
export function settingsBar(runner, runs, width, ink = painter(3)) {
  const url = runner?.url ?? '';
  const { total, cap, projects } = sessionCounts(runner, runs);

  const served = projects.map(({ slug, count, room, full }) => {
    const of = room ? `${count}/${room}` : String(count);
    // Busy is worth seeing; idle should not shout. Full is worth seeing most,
    // because that is the one answering "why is mine waiting".
    const paint = full ? ink.warn : count ? ink.success : ink.muted;
    return `${ink.muted(slug)} ${paint(of)}`;
  });

  const tally = cap ? `${total}/${cap}` : String(total);
  const right = `${ink.muted('sessions')} ${
    cap && total >= cap ? ink.warn(tally) : ink.text(tally)} `;

  // Narrow terminals: drop projects from the END until it fits, rather than
  // dropping the total. Whichever number survives should be the one that
  // answers "why is mine waiting", and on a machine at its cap that is the
  // total — the ellipsis says the list was cut.
  const shown = [...served];
  const build = () => ` ${ink.accent(url)}${shown.length ? `  ${ink.muted('│')}  ` : ''}`
    + shown.join(ink.muted('  ·  '))
    + (shown.length < served.length ? ink.muted('  …') : '');

  let left = build();
  while (shown.length && visibleWidth(left) + visibleWidth(right) > width - 1) {
    shown.pop();
    left = build();
  }

  // Right-aligned by what is VISIBLE.
  const room = width - visibleWidth(left) - visibleWidth(right);
  const line = room > 0
    ? `${left}${' '.repeat(room)}${right}`
    : `${clip(left, Math.max(0, width - visibleWidth(right)))}${right}`;
  // No blanket dim over the row: everything in it already carries its own
  // colour, and dimming the lot flattens "full" back into "idle", which is the
  // one distinction this footer exists to make.
  return padVisible(clip(line, width), width);
}

/**
 * A run, as one line of the overlay — R81.
 *
 * The reason a queued run is queued goes on the SAME line as the run, because
 * that reason is the whole argument for this program existing and a list that
 * makes you press a key for it has hidden the answer behind the question.
 */
export function runLine(run, { chosen, marker, number }, width, ink = painter(3)) {
  const colour = ink[STATE_COLOUR[run.state] ?? 'text'];
  const head = `${chosen ? ink.bold('❯') : ' '}${marker ?? ' '}${ink.muted(number ?? ' ')} `;
  const where = ink.muted(`  ${run.projectSlug} · ${run.state}`);
  const why = run.why ? ink.warn(` — ${run.why}`) : '';

  // **The label is what gets shortened, not the reason.** R58's lesson, in a
  // second place: whichever half survives the narrowing should be the one that
  // answers the question, and here the question is "why is that not moving".
  // A card's title is recognisable from a dozen characters; "no free workspace
  // in cawdev (2 here, all busy" cut mid-parenthesis answers nothing.
  const room = width - visibleWidth(head) - visibleWidth(where) - visibleWidth(why);
  const name = colour(clip(run.label, Math.max(12, room)));
  return clip(`${head}${name}${where}${why}`, width);
}

/**
 * The run being driven right now, as one row — R83.
 *
 * **Which run, for how long, and the key that stops it.** A session that has
 * been going for four minutes and one that has been going for two hours look
 * identical in a transcript, and "is this thing still working" is the question
 * somebody is actually asking when they glance at the bottom of the screen.
 *
 * Absent when nothing is running, which is why this returns null rather than a
 * blank row: an empty line that is always there is a line that says nothing, and
 * the footer is short on rows to spend.
 */
export function statusLine(run, now, width, ink = painter(3)) {
  if (!run || (run.state !== 'running' && run.state !== 'claiming')) {
    return null;
  }
  const going = run.startedAt ? elapsed(now - Date.parse(run.startedAt)) : null;
  const tail = ink.muted(`${going ? ` · ${going}` : ''} · x stops it`);
  const head = `${ink.success('●')} ${run.state === 'claiming' ? ink.muted('claiming ') : ''}`;
  const room = Math.max(8, width - visibleWidth(head) - visibleWidth(tail) - 1);
  return clip(` ${head}${ink.text(clip(run.label ?? 'a session', room))}${tail}`, width);
}

/** How long, in the shortest form that is still a duration. */
export function elapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * The footer: everything that never changes, and the few things that do.
 *
 * **Pure, and rendered from a plain object.** R62 learned this the hard way —
 * a bar built inside a draw method can only be checked by looking at it, and
 * the arithmetic in it is exactly the kind that is wrong by ten characters in
 * a way nobody notices until a session goes red.
 *
 * The order is deliberate. What is stopping somebody is at the top, because it
 * is the only thing here that is blocking a person. Then the fixed answers,
 * then who and where, then the keys that work right now.
 */
export function footerLines(state, width, ink = painter(3)) {
  const {
    runner, runs = [], email, expired = false, watching, connected = true,
    banner = [], overlay = [], input = null, keys = '', status = '',
    running = null, now = Date.now(), matches = [],
  } = state;

  const rule = ink.muted('─'.repeat(Math.max(0, width)));
  const lines = [rule];

  for (const line of overlay) {
    lines.push(line);
  }
  if (overlay.length) {
    lines.push(rule);
  }
  for (const line of banner) {
    lines.push(line);
  }
  if (banner.length) {
    lines.push(rule);
  }

  lines.push(settingsBar(runner, runs, width, ink));

  // R294: the config file has moved on from what this daemon booted with, in
  // ways only a restart applies. A row while it is true and nothing when it
  // is not — the daemon decides, off the file's own mtime, so an edit by hand
  // shows here too and an edit reverted clears it. Pinned, because the one
  // sentence R288 printed about this scrolled off with the next transcript
  // line, and a person who added a project here believed it was being served.
  const stale = Array.isArray(runner?.restartNeeded) ? runner.restartNeeded : [];
  if (stale.length) {
    lines.push(padVisible(clip(
      ` ${ink.warn('!')} ${ink.muted('config changed:')} ${ink.text(stale.join(', '))} ${ink.muted(`— restart to apply (${RESTART_FROM_ATTACH})`)}`,
      width,
    ), width));
  }

  // The platform refused the stored session (401). Pinned for the same reason
  // as the row above: one line in the scrollback is gone with the next
  // transcript line, and every action from here on would fail without it.
  if (expired) {
    lines.push(padVisible(clip(
      ` ${ink.warn('!')} ${ink.muted('session expired —')} ${ink.text('/login')} ${ink.muted('to sign in again')}`,
      width,
    ), width));
  }

  // Who and where. The runner's NAME is what the console shows and what
  // `--runner` takes, so it is the word somebody would type; the email is what
  // every action here is done as, and "watching only" is not a lesser state,
  // it is the honest one.
  const who = email ? ink.text(email) : ink.muted('watching only');
  const link = connected ? '' : `  ${ink.danger('detached')}`;
  const named = `${ink.bold(runner?.name ?? '…')} ${ink.muted('·')} ${who}${link}`;
  // The mark is the only decoration in the program, so it is the first thing
  // to go: at forty columns it was costing eight of them and cutting the email
  // in half, and "who am I acting as" is an answer while a logo is a mood.
  const withMark = ` ${oneLine(ink)} ${ink.muted('·')} ${named}`;
  lines.push(padVisible(clip(
    visibleWidth(withMark) <= width ? withMark : ` ${named}`,
    width,
  ), width));

  // **A row of its own, and the state is what is reserved for.** Sharing the
  // line above cost the run's state at a hundred columns: a fifty-character
  // card title used every column the label was given and `(cawdev · running)`
  // fell off the end — so the footer said which session was being watched and
  // not whether it was still going, which is the half that changes.
  //
  // The height is affordable in a way it never was before R81: the footer no
  // longer competes with a pane for the screen. Everything it pushes up is in
  // the scrollback and is still there.
  lines.push(padVisible(clip(watching
    ? runLine(watching, { chosen: false, marker: ink.muted('▸'), number: ' ' }, width, ink)
    : `  ${ink.muted('▸ nothing being watched — L lists what this machine has')}`,
    width), width));

  // R83's status line: what is actually running, and how long it has been. It
  // is absent rather than blank when nothing is — the row above already says
  // which run is printing, and this one is only worth its height while there is
  // a clock ticking behind it.
  const going = statusLine(running, now, width, ink);
  if (going) {
    lines.push(padVisible(going, width));
  }

  // The commands that still match what is being typed, directly above the line
  // being typed — R83. Next to it rather than in the overlay at the top,
  // because a list of what you are halfway through writing belongs beside it.
  for (const line of completionLines(matches.rows ?? matches, matches.at ?? 0, width, ink)) {
    lines.push(padVisible(line, width));
  }

  // The last row is either what you are typing or what you can press. Never
  // both: a key list under a half-typed prompt is a list of keys that would
  // land in the prompt.
  if (input) {
    if (input.preview) {
      // R289: what the path on the line IS, above the line being typed.
      lines.push(padVisible(clip(`   ${ink.muted(input.preview)}`, width), width));
    }
    lines.push(padVisible(clip(` ${ink.accent(input.label)} ${input.text}`, width), width));
  } else if (keys.length || status) {
    lines.push(padVisible(clip(` ${keyList(keys, status, width - 1, ink)}`, width), width));
  }
  return lines;
}

// --- the client ---------------------------------------------------------------

/**
 * @param argv the command line, for `--runner`, `--url`, `--watch-only`
 * @param options set when the daemon is running IN THIS PROCESS (`--attach`):
 *   its socket is already known, quitting means stopping it, and it can say how
 *   much work would be lost if you did. `url` is where to sign in when the
 *   caller has read the config (`cawdev.mjs`'s `launchUrl`); without it,
 *   `urlFrom`, which cannot see a config.
 */
export async function attach(argv, { url, ...options } = {}) {
  const socket = options.socketPath ?? (await chooseSocket(valueOf(argv, '--runner')));
  const session = await openSession(argv, url ?? urlFrom(argv));

  // Spread second so `--attach`'s own wiring wins: there the daemon IS this
  // process and quitting has always stopped it.
  const ui = new Attached(socket, session,
    { leaveRunning: argv.includes('--leave-running'), ...options });
  await ui.start();
}

export function valueOf(argv, flag) {
  const at = argv.indexOf(flag);
  return at === -1 ? null : argv[at + 1];
}

/**
 * Whether a failed clone's output is ssh refusing to ask a person — BatchMode
 * with a key the agent does not hold. Pure, for the test.
 */
export function sshNeedsAPerson(said) {
  return /Permission denied \(publickey|passphrase|Host key verification failed/i.test(String(said ?? ''));
}

export function urlFrom(argv) {
  return (valueOf(argv, '--url') ?? process.env.CAWDEV_URL ?? 'https://app.cawdev.com')
    .replace(/\/+$/, '');
}

/**
 * Which daemon to watch.
 *
 * One is the answer without asking. Several is a machine running more than one
 * daemon, which is unusual enough that naming one is better than guessing.
 */
async function chooseSocket(wanted) {
  if (wanted) {
    return socketPathFor(wanted);
  }
  const sockets = await listSockets();
  if (!sockets.length) {
    throw new Error(
      'No runner is offering a socket on this machine. Start one with `cawdev`, which\n' +
        'launches a daemon when it finds none, or run it yourself:\n\n' +
        '  node runner.mjs --config <your config>.json',
    );
  }
  if (sockets.length === 1) {
    return sockets[0].path;
  }
  const names = sockets.map((each) => each.name).join(', ');
  throw new Error(`More than one runner here (${names}). Choose one: cawdev --runner <name>`);
}

/**
 * The session this launch starts with — R81.
 *
 * Stored first, because the entry's promise is that signing in once is enough.
 * A stored cookie the platform no longer honours is not an error: it is what an
 * expired session looks like, and the answer is the same as having none — the
 * browser, once, and then remembered again.
 */
async function openSession(argv, url) {
  if (argv.includes('--watch-only')) {
    return new Session(url);
  }
  const session = await storedSession(url);
  if (session.signedIn) {
    return session;
  }

  const ink = painter();
  console.log(`${ink.muted('Not signed in.')} Opening ${ink.accent(url)} in your browser —`);
  console.log(`${ink.muted('a session is what lets you prompt a run, cancel one, or decide a request.')}\n`);
  const outcome = await runSignIn(session, ink);
  if (!outcome.signedIn) {
    console.log(`${ink.muted('Watching only. Press')} / ${ink.muted('and type')} /login ${ink.muted('to try again.')}\n`);
  }
  return session;
}

/**
 * The browser dance, printed plainly. Shared by the first launch and `/login`.
 *
 * The code is printed as well as opened, because the point of a code is that
 * two screens show the same one and a person compares them. Printing the URL
 * too is not belt and braces: a machine over ssh has no browser to open, and
 * this is the only thing that makes it work at all.
 */
async function runSignIn(session, ink = painter(), say = (line) => console.log(line)) {
  const outcome = await signInThroughBrowser(session, ({ url, code }) => {
    say(`  ${ink.muted('If your browser did not open, go to')}`);
    say(`      ${ink.accent(url)}`);
    say(`  ${ink.muted('and check it is showing')}  ${ink.bold(code)}\n`);
    say(`  ${ink.muted('Waiting…')}`);
  });
  if (outcome.signedIn) {
    say(`  ${ink.success('Signed in')} as ${ink.bold(outcome.email)}.\n`);
  } else if (outcome.refused) {
    say(`  ${ink.danger('Refused')} in the browser.\n`);
  } else {
    say(`  ${ink.warn('The code expired.')}\n`);
  }
  return outcome;
}

/** What Esc throws out of a config step — R288. Compared by identity, never caught by message. */
export const CANCELLED = Symbol('cancelled');

/**
 * A configure.mjs prompt, split into what is PRINTED and what the footer keeps
 * — R289. `confirm` asks "…long sentence… [Y/n] ", and a footer line that
 * clips at the width would cut the sentence and keep the brackets. So anything
 * longer than a label is said in the transcript and the label is the trailing
 * `[default]` with the caret, or just the caret. A short prompt stays whole.
 */
export function splitPrompt(prompt, limit = 40) {
  const text = String(prompt ?? '').trim();
  const tail = /\s*(\[[^\]]*\])$/.exec(text);
  const bracket = tail ? tail[1] : '';
  const question = tail ? text.slice(0, tail.index).trim() : text;
  if (text.length <= limit) {
    return { said: '', label: `${text} ▸` };
  }
  return { said: question, label: `${bracket ? `${bracket} ` : ''}▸` };
}


/**
 * The config screen's rows, with the state of each thing on the row — R288.
 *
 * Pure, so the wording can be read in a test: "Disable claude" when claude is
 * on and "Enable claude" when it is not, because a row that always said
 * "enable" would ask the person to remember what the file says. The hint is
 * where the current value lives; the label is the change.
 */
/** A project entry's `quality` block, whatever shape the entry is — R300. */
function qualityOf(entry) {
  return entry && typeof entry === 'object' && entry.quality ? entry.quality : null;
}

export function configMenu(file, runner = {}, gone = new Set()) {
  const slugs = slugsOf(file);
  const agents = agentsOf(file);
  const rulesOn = file.acceptsRulesFromConsole === true;
  // R294: the file and the daemon can disagree, and the row says so rather
  // than claiming the file is what runs. `served` is what the hello says the
  // daemon booted with; a slug in the file and not there is "restart".
  const stale = Array.isArray(runner.restartNeeded) ? runner.restartNeeded : [];
  const served = Array.isArray(runner.projects) ? runner.projects : null;
  const notServed = served && stale.includes('projects') ? slugs.filter((slug) => !served.includes(slug)) : [];
  const serving = slugs.length
    ? `serves ${slugs.filter((slug) => !notServed.includes(slug)).join(', ') || 'nothing yet'}`
    : 'serves nothing yet';
  const pending = notServed.length ? ` · ${notServed.join(', ')} after a restart` : '';
  const checkouts = slugs.map((slug) => {
    const count = pathsOf(file.projects[slug]).length;
    const booted = runner.workspaces?.[slug];
    const moved = stale.includes('projects') && typeof booted === 'number' && booted !== count;
    return `${slug}: ${moved ? `${booted}, ${count} after a restart` : count}`;
  }).join(', ');
  return new Select({
    kind: 'config',
    title: `this machine — ${runner.name ?? file.name ?? 'cawdev'}`,
    rows: [
      { id: 'add-project', label: 'Add a project — or create one on cawdev', hint: `${serving}${pending}` },
      { id: 'add-workspace', label: 'Add a workspace to a project', hint: checkouts || 'no projects to add one to' },
      ...[...new Set([...KNOWN_AGENTS, ...agents])].map((command) => (agents.includes(command)
        ? { id: `agent:${command}`, label: `Disable ${command}`, hint: 'spawned here now' }
        : { id: `agent:${command}`, label: `Enable ${command}`, hint: 'not spawned here' })),
      rulesOn
        ? { id: 'rules', label: 'Stop accepting permission rules from the console', hint: 'on now' }
        : { id: 'rules', label: 'Accept permission rules from the console', hint: 'off now' },
      // R577: a number on the platform, not a switch in the file — the hello
      // carries what the daemon was last told, so the row reads the live value.
      // R571: the row that makes a queued line's "or press c" true. R288: the
      // label is the change, the hint the current value.
      {
        id: 'pause',
        // A usage pause has no toggle: the sweep would pause it again within a minute.
        label: runner.pausedByUsage
          ? 'Paused by cawdev for usage'
          : runner.paused ? 'Resume this machine — claim new runs again' : 'Pause this machine — claim nothing new',
        hint: runner.pausedByUsage
          ? 'resumes by itself when the window resets; change the threshold on Settings → Machines'
          : runner.paused ? 'paused now' : 'claiming now',
      },
      {
        id: 'planning-limit',
        label: 'Limit planning runs at once',
        hint: runner.maxPlanningRuns ? `${runner.maxPlanningRuns} at once now` : 'no limit now',
      },
      // R300: one row per served project, saying whether its branches are
      // scanned here now — the state the row would change, R288's rule.
      ...slugs.map((slug) => (qualityOf(file.projects[slug])
        ? { id: `quality:${slug}`, label: `Stop scanning ${slug} with SonarQube`, hint: `${qualityOf(file.projects[slug]).command ?? 'sonar-scanner'} after TEST now` }
        : { id: `quality:${slug}`, label: `Scan ${slug} with SonarQube after TEST`, hint: 'not scanned here' })),
      // One row per served project — first the ones cawdev no longer has,
      // which are the reason anybody comes looking for this row.
      ...[...slugs].sort((a, b) => Number(gone.has(b)) - Number(gone.has(a))).map((slug) => ({
        id: `remove:${slug}`,
        label: `Stop serving ${slug}`,
        hint: gone.has(slug) ? 'not on cawdev any more' : 'its checkouts stay on disk',
      })),
      { id: 'show', label: "Show this machine's config", hint: runner.configPath ?? '' },
    ],
  });
}

/** `/new`'s agent flags: `--claude`, `--codex`, `--agy`. */
const AGENT_FLAGS = new Set(KNOWN_AGENTS.map((agent) => `--${agent}`));

/** A start's body, naming the agent when one was chosen — and nothing when not. */
function withAgent(body, agent) {
  return agent ? { ...body, agent } : body;
}

/** What was started, saying with which agent when one was named. */
function withWho(what, agent) {
  return agent ? `${what} with ${agent}` : what;
}

/** How many times a finished dev session's zero commits is read again before it is believed — see countCommits. */
const COMMIT_REREADS = 6;

/** `r29` → `R29`, `I12` → `i12`, `29` as it is: how the API spells a card's ref (R221). */
function refOf(word) {
  return word.replace(/^r/i, 'R').replace(/^i/i, 'i');
}

/** How many matching commands advanced mode's prompt shows at once. */
const SPLIT_COMPLETIONS = 6;

/** The slash commands, and the one place they are described. */
const COMMANDS = [
  ['/help', 'this list'],
  ['/login', 'sign in through the browser'],
  ['/logout', 'forget the stored session on this machine'],
  ['/runs', 'the run list — the same as L'],
  ['/config', "this machine's config — the same as c"],
  ['/cancel', 'cancel the session you are watching'],
  ['/log', "the daemon's own log, on or off"],
  ['/advanced-mode', 'one window per session around the prompt, for the projects you tick (@slug names them), or back'],
  ['/new', 'start a session here: /new plan|dev R3, /new plan|dev <the task>, /new ask … (@project)'],
  ['/card', 'add an idea to Considering — no session: /card <the idea> (@project)'],
  ['/agent', 'which agent /new uses: /agent claude|codex|agy, /agent default, /agent to see it'],
  ['/develop', 'start the development of the card a finished plan was about, or of one named: /develop R30 (--codex) (@project)'],
  ['/pr', "open the pull request of a finished session's branch"],
  ['/continue', 'pick a failed or stopped session back up on this machine — the console\'s Carry on'],
  ['/projects', 'which projects advanced mode shows — tick one or several'],
  ['/refresh', "read the cards and their statuses from cawdev again — advanced mode's roadmap"],
  ['/open', "open the session's pull request in your browser — on a finished plan, its card and plan; on one waiting for you, its page on cawdev"],
  ['/view', "a card here in the terminal: /view R29, /view <words of its title> (@project), /view card for the session's; /view alone reads what a session waits on in full, or opens it on cawdev"],
  ['/drop', 'delete the checkout a finished session was made on demand for'],
  ['/close', "close an ended session's window"],
  ['/reload', 'quit and start again on the code on disk — the runner too, when nothing is running'],
  ['/quit', 'stop the runner and leave (--leave-running keeps it up)'],
];

/**
 * The client.
 *
 * Exported since R83 so the things it DECIDES can be checked without a
 * terminal: that choosing an option posts the same answer to the same record as
 * typing one, that a watcher who does not own a question is offered no picker,
 * that Esc from free text comes back to the list. Those are rules, and R62's
 * lesson about rules in a renderer is that they can only be tested by looking at
 * them.
 */
/**
 * Why a checkout must not be deleted, in words, or null when nothing in it
 * would be lost: no uncommitted file, and no commit that is on no branch of
 * origin.
 */
async function checkoutState(path) {
  const git = (args) => new Promise((done) => {
    const child = spawn('git', ['-C', path, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 ? out.trim() : null));
  });
  const status = await git(['status', '--porcelain']);
  if (status === null) return 'it could not be read as a git checkout';
  if (status) return `${status.split('\n').length} file(s) are not committed`;
  const unpushed = await git(['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']);
  if (unpushed === null) return 'whether its commits are on origin could not be read';
  if (Number(unpushed) > 0) return `${unpushed} commit(s) are not on origin — /pr pushes the branch`;
  return null;
}

/** The environment variable `/reload` hands its state over in. */
const RELOAD_STATE = 'CAWDEV_RELOAD_STATE';

/**
 * The state a `/reload` handed this process, read once and taken out of the
 * environment — a session this terminal spawns later must not inherit it, and
 * a second reload writes its own.
 */
function readReloadState() {
  const raw = process.env[RELOAD_STATE];
  delete process.env[RELOAD_STATE];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export class Attached {
  /**
   * @param options `out` is where to draw — `process.stdout` in the real thing,
   *   anything with `write` in a test, which is the same seam Scrollback takes
   *   and for the same reason.
   */
  constructor(socketPath, session, options = {}) {
    this.socketPath = socketPath;
    this.session = session;
    if (session) {
      session.onExpired = () => this.sessionExpired();
    }
    /** True from a 401 on a session that was signed in until `/login` works. */
    this.expired = false;
    this.options = options;
    this.ink = painter();
    this.screen = new Scrollback(options.out ?? process.stdout);

    this.runner = null;
    this.runs = [];
    /** The run whose output is being printed. An id, not an index: the list
     *  moves under you, and watching your transcript switch because a third
     *  session finished is how you send a prompt to the wrong place. */
    this.watching = null;
    /** runId -> transcript lines, for a run that is not the one printing. */
    this.lines = new Map();
    /** Which runs have had their history laid into the scrollback already. */
    this.printed = new Set();
    /** runId -> the pending permission request on it, from the inbox. */
    this.approvals = new Map();
    /** runId -> what it is asking, and whose question that is — R58. */
    this.questions = new Map();

    /** 'keys', 'select' or 'typing' — and only ever one of them. */
    this.mode = 'keys';
    /** The open picker, whatever it is a picker OF. See select.mjs. */
    this.select = null;
    /** The line being typed, its label, and where Esc goes back to. */
    this.input = null;
    /**
     * The question an open picker or line is answering — R119.
     *
     * Held apart from `mode` because the poll needs to know WHAT is being
     * answered, not merely that something is: the console is the other door
     * onto the same question, and a box waiting for an answer that has already
     * been given is this terminal asking a person to do a thing twice.
     */
    this.answering = null;
    /**
     * The permission request an open picker or refuse-line is deciding — R137.
     *
     * `answering`'s exact counterpart, and here for the same reason: the
     * console is the other door onto the same request, and a picker offering
     * three lengths of yes for something already allowed is this terminal
     * asking a person to decide a thing twice.
     *
     * Carries the APPROVAL id as well as the run because a run can be asked
     * twice: `approvals` is keyed by run, so a second request arriving would
     * otherwise make a picker titled with the first one's command look current.
     */
    this.deciding = null;
    this.status = '';
    this.showLog = false;
    this.asked = new Set();
    this.connected = false;
    this.stopped = false;
    this.dirty = false;
    /** Lines waiting to be committed on the next tick. See {@link say}. */
    this.pending = [];

    // R83's input line. The history is loaded from disk in `start`, because a
    // constructor that awaits is a constructor nobody can call.
    this.history = new History();
    this.pastes = new Pastes();
    this.stdinKeys = new KeyStream();
    /** Questions and requests already printed, so they are announced once. */
    this.announced = new Set();
    /**
     * Approval ids this client knows are over — R137.
     *
     * The inbox answers the moment anything is pending, so a response built
     * moments before a decision lands can arrive after the poll cleared it and
     * put the banner back for another twenty seconds. Same growth and same
     * lifetime as `announced`: one attached terminal's.
     */
    this.settled = new Set();
    /** Ctrl+C, armed. See {@link onInterrupt}. */
    this.interrupting = false;
    /**
     * The config walk in progress, if one is — R288.
     *
     * `answer` resolves the question it is waiting on — the line editor or
     * the picker hands its result here instead of to a session — and `cancel`
     * rejects it with {@link CANCELLED}, which is what unwinds the whole step
     * on Esc. One walk at a time, because two writing one file is R41 on a
     * laptop.
     */
    this.configuring = null;

    /**
     * Advanced mode, when it is on: the alternate screen, the window the
     * prompt talks to, and what was said while it was up — see split.mjs.
     */
    this.split = null;
    /**
     * Every session this terminal has seen, ended ones included — the daemon
     * forgets a run the moment it finishes, and "develop it now" or "open its
     * pull request" is asked of exactly those. runId -> meta.
     */
    this.sessions = new Map();
    /** Ended sessions whose window somebody closed. */
    this.closed = new Set();
    /**
     * Projects this machine serves that cawdev answered 404 for — deleted in
     * the console, or the person's access went. The config still names them,
     * so without this the terminal kept offering them everywhere it offers a
     * project. Learnt from `refreshPlanned`, and forgotten when one answers.
     */
    this.gone = new Set();
    /** Of those, the ones not yet said — see `sayGone`. */
    this.goneUnsaid = [];
    /** A project whose next new CODE session takes the focus — see startNew. */
    this.focusOnArrival = null;
    /** The PLANNED cards of the projects this machine serves — advanced mode's top strip. */
    this.planned = [];
    // Every card of every served project, whatever its status — the strip.
    this.cards = [];
  }

  /**
   * Whether this terminal can be drawn on at all.
   *
   * One flag for two things that are the same question: a stream with no cursor
   * cannot hold a live region, and it cannot hold a picker either. Where this is
   * true a picker is a numbered list read from stdin — a plain prompt, not a
   * broken repaint.
   *
   * **Colour is a different question and is deliberately not this one.** R62's
   * rule and R81's are that `NO_COLOR` is about escape codes, not about the
   * cursor: somebody who has turned colour off in their shell profile forever
   * still has arrow keys, and taking the picker away from them would be a worse
   * terminal for no reason. Under `NO_COLOR` the widget draws in plain text and
   * the `❯`, the numbers and the words carry what the colour did.
   */
  get plain() {
    return !this.screen.tty;
  }

  async start() {
    this.screen.open();
    this.history = new History(await loadHistory(this.session.url).catch(() => []));
    // `/agent`'s choice, from last time — see prefs.mjs.
    this.agent = (await loadPrefs(this.session.url).catch(() => ({}))).agent ?? null;
    // Raw mode only where there is a terminal to put in it. Through a pipe
    // there are no keys, the transcript is the whole output, and that is the
    // honest degradation rather than a broken one.
    if (!this.plain && process.stdin.isTTY) {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      // Bracketed paste, which is the only way to tell a pasted newline from
      // somebody pressing enter. Without it, pasting a paragraph sends the first
      // line and types the rest into whatever opens next.
      process.stdout.write(`${ESC}[?2004h`);
      // One chunk is however many bytes arrived together, not one keypress —
      // and a paste is not even one chunk. See input.mjs; this line used to be
      // the bug.
      process.stdin.on('data', (chunk) => {
        for (const key of this.stdinKeys.push(chunk.toString('utf8'))) {
          this.onKey(key);
        }
      });
    } else if (process.stdin.readable) {
      // The plain path: no cursor to move, so whole LINES are read. A number
      // picks from whatever list was printed, and anything else is a prompt, an
      // answer, or a command — which is what a plain prompt has always meant.
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
      let buffered = '';
      process.stdin.on('data', (chunk) => {
        buffered += chunk;
        let newline;
        while ((newline = buffered.indexOf('\n')) !== -1) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          this.onLine(line);
        }
      });
    }
    process.stdout.on('resize', () => {
      this.screen.resize();
      this.split?.screen.resize();
      this.dirty = true;
    });

    this.open();
    if (this.session.signedIn) {
      void this.watchInbox();
      void this.watchQuestions();
    }
    // `/reload`'s other half: the state the terminal was in before it
    // restarted — advanced mode, the focus, the windows of sessions that had
    // ended — so a reload changes the code and nothing else.
    this.restore(this.options.restore ?? readReloadState());

    // One write per tick at most, carrying everything that happened in it. A
    // busy session emits hundreds of lines a second, and a write per line means
    // an erase-and-redraw of the whole footer per line.
    const tick = setInterval(() => {
      if (this.dirty || this.pending.length) {
        this.flush();
      }
    }, 60);
    tick.unref?.();

    this.flush();
    await new Promise((done) => {
      this.finish = done;
    });
  }

  open() {
    const client = connect(this.socketPath);
    this.client = client;
    client.setEncoding('utf8');

    client.on('connect', () => {
      this.connected = true;
      this.note('attached');
    });

    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          this.onEvent(JSON.parse(line));
        } catch {
          // A line we cannot read is not worth tearing the screen down for.
        }
      }
    });

    client.on('error', (failure) => {
      this.connected = false;
      this.note(`socket: ${failure.message}`);
    });

    client.on('close', () => {
      this.connected = false;
      this.note('the daemon went away — retrying every two seconds');
      if (!this.stopped) {
        const retry = setTimeout(() => this.open(), 2000);
        retry.unref?.();
      }
    });
  }

  onEvent(event) {
    if (event.type === 'hello') {
      this.runner = event.runner;
      this.runs = event.runs;
      this.trackSessions();
      this.chooseWatched();
      void this.findStopped();
    } else if (event.type === 'runner') {
      // R294: the daemon re-read its config — after a signal, or because the
      // file's mtime moved — and says what it applied and what it could not.
      // The hello was sent once, when this terminal attached; this is the
      // same object again, so the footer and the `c` screen read what is
      // true now.
      this.runner = event.runner;
    } else if (event.type === 'runs') {
      this.runs = event.runs;
      this.trackSessions();
      this.chooseWatched();
    } else if (event.type === 'output') {
      const kept = this.lines.get(event.runId) ?? [];
      kept.push(event.line);
      if (kept.length > 5000) kept.splice(0, kept.length - 5000);
      this.lines.set(event.runId, kept);
      // In advanced mode the session's window is where its output goes; the
      // scrollback gets it when the mode is left.
      if (event.runId === this.watching && !this.showLog && !this.split) {
        this.say(this.render(event.line));
      }
    } else if (event.type === 'backlog') {
      this.lines.set(event.runId, event.lines);
      if (event.runId === this.watching && !this.printed.has(event.runId) && !this.split) {
        this.layHistoryIn(event.runId, event.lines);
      }
    } else if (event.type === 'log') {
      if (this.showLog) {
        this.say(`${this.ink.muted(event.at?.slice(11, 19) ?? '')} ${event.line}`);
      }
    }
    this.dirty = true;
  }

  /**
   * Queue lines for the scrollback.
   *
   * **Queued rather than written, and flushed with the footer on one tick.** A
   * busy session emits hundreds of lines a second; writing each one on its own
   * means an erase-and-redraw of the whole footer per line, and the footer that
   * gets drawn is the one from before whatever just happened — which showed up
   * in a real terminal as a stale prompt line flashing under `/help`'s output.
   *
   * Wrapped here rather than left to the terminal for one reason: a transcript
   * line carries the agent's own colour and can be a paragraph with newlines in
   * it, and `wrap` is the function that knows the difference between a
   * character and an escape sequence.
   */
  say(text) {
    // In advanced mode the prompt's window wraps what it shows, to its own
    // width; wrapping here first, to the whole terminal's, cut every long line
    // twice.
    if (this.split) {
      this.pending.push(...String(text).split('\n'));
      this.dirty = true;
      return;
    }
    for (const line of wrap(text, this.screen.width)) {
      this.pending.push(line);
    }
    this.dirty = true;
  }

  /**
   * A line that belongs to one question or one permission request. Outside
   * advanced mode it is printed like any other — the scrollback is a record.
   * In advanced mode it goes to the prompt window TAGGED, and the window drops
   * it as soon as what it is about is no longer open (`stillOpen`): answered
   * here, answered in the console, or its session gone. The prompt is where
   * the NEXT thing is read, and a question already answered sitting above it
   * is the text somebody reads by mistake.
   */
  sayAbout(about, text) {
    // `{ prefix, body, paint }` is prose to be wrapped between words at the
    // width it is DRAWN at — the window's, which changes — rather than now.
    const prose = typeof text === 'object' && text !== null;
    if (!this.split) {
      this.say(prose ? `${text.prefix}${text.paint(text.body)}` : text);
      return;
    }
    // Whatever was queued before it goes first, so the order on screen is the
    // order things happened in.
    this.split.messages.push(...this.pending);
    this.pending = [];
    if (prose) {
      this.split.messages.push({ ...text, about });
    } else {
      for (const line of String(text).split('\n')) {
        this.split.messages.push({ text: line, about });
      }
    }
    this.dirty = true;
  }

  /** The ids of every question and permission request this terminal believes open. */
  stillOpen() {
    return new Set([
      ...[...this.questions.values()].map((state) => state?.question?.id),
      ...[...this.approvals.values()].map((pending) => pending?.approval?.id),
    ].filter(Boolean));
  }

  /** Everything queued, plus the footer as it is right now, in one write. */
  flush() {
    const lines = this.pending;
    this.pending = [];
    this.dirty = false;
    if (this.split) {
      // What would have been printed is the prompt window's to show.
      this.split.messages.push(...lines);
      if (this.split.messages.length > 500) {
        this.split.messages.splice(0, this.split.messages.length - 500);
      }
      this.split.screen.draw(this.splitFrame());
      return;
    }
    this.screen.update(lines, this.footer());
  }

  /**
   * A run's history, laid into the scrollback when you switch to it — R81.
   *
   * Without this, opening a session that started an hour ago is a blank
   * terminal until the agent next speaks. The daemon has kept the last four
   * thousand lines for exactly this (control.mjs), and putting them in the
   * scrollback rather than in a pane is what makes scrolling up reach the
   * start of the session.
   */
  layHistoryIn(runId, lines) {
    this.printed.add(runId);
    const run = this.runs.find((each) => each.id === runId);
    const ink = this.ink;
    this.say(ink.muted('─'.repeat(Math.max(0, this.screen.width))));
    this.say(`${ink.bold(run?.label ?? 'a session')} ${ink.muted(
      `${run?.projectSlug ?? ''}${run?.branch ? ` · ${run.branch}` : ''}`)}`);
    if (!lines.length) {
      this.say(ink.muted(run?.state === 'queued'
        ? `  waiting — ${run.why ?? 'no reason recorded'}`
        : '  nothing said yet on this session'));
    }
    this.say('');
    for (const line of lines) {
      this.say(this.render(line));
    }
  }

  /**
   * What is being watched, after the list changed.
   *
   * A run that is gone releases the screen to the newest one, and a first run
   * on an idle machine takes it — the common case is one session, and making
   * somebody press a key to see the only thing happening is a poor greeting.
   */
  chooseWatched() {
    if (this.watching && this.runs.some((run) => run.id === this.watching)) {
      this.requestBacklog();
      return;
    }
    const next = this.runs[0];
    this.watching = next?.id ?? null;
    if (next) {
      this.requestBacklog();
    }
  }

  /** The backlog of whatever is being watched, once per run. */
  requestBacklog() {
    const run = this.current();
    if (!run || this.asked.has(run.id) || !this.connected) {
      return;
    }
    this.asked.add(run.id);
    try {
      this.client.write(`${JSON.stringify({ type: 'backlog', runId: run.id })}\n`);
    } catch {
      this.asked.delete(run.id);
    }
  }

  current() {
    return this.runs.find((run) => run.id === this.watching) ?? null;
  }

  /** Switch which session is printing, and lay its history in. */
  watch(runId) {
    if (runId === this.watching) {
      return;
    }
    this.watching = runId;
    this.printed.delete(runId);
    this.asked.delete(runId);
    const kept = this.lines.get(runId);
    if (kept) {
      this.layHistoryIn(runId, kept);
    }
    this.requestBacklog();
    this.note('');
  }

  note(text) {
    this.status = text;
    // In advanced mode, which window it was said about — the focused one at
    // the moment it was said. A note outlives the focus moving, and "a
    // session is running" read under another window is a note about nobody.
    this.statusWindow = this.split && text ? this.windowNumberOf(this.split.focus) : null;
    this.dirty = true;
  }

  /** A window's number, as its title shows it; null when it has none. */
  windowNumberOf(id) {
    const at = id ? this.windows().findIndex((meta) => meta.id === id) : -1;
    return at >= 0 ? at + 1 : null;
  }

  // --- what is waiting on a person -----------------------------------------

  /**
   * Permission requests, from the inbox rather than from the daemon.
   *
   * The daemon could read them — it has the project's read scope — but it
   * cannot answer them, and a channel that shows you a decision you must then
   * make somewhere else is worse than one that does both. The inbox is already
   * the long poll that answers "what is stopped on me", across every project.
   */
  async watchInbox() {
    while (!this.stopped) {
      try {
        const inbox = await this.session.request('/api/inbox?wait=20');
        this.rememberInbox(inbox);
        this.announce();
        this.dirty = true;
      } catch {
        await new Promise((done) => setTimeout(done, 5000));
      }
    }
  }

  /**
   * What the inbox says is waiting, minus what this client has already seen
   * settled — R137.
   *
   * A method rather than three lines in the loop so that the filter can be
   * tested without an infinite poll. The filter is the point: the inbox returns
   * as soon as anything is pending, so its answer is frequently older than the
   * decision that ended the thing it is describing, and a stale answer must not
   * be able to raise a banner over a request this terminal watched close.
   */
  rememberInbox(inbox) {
    this.approvals = new Map((inbox?.approvals ?? [])
      .filter((item) => !this.settled.has(item.approval?.id))
      .map((item) => [item.runId, item]));
  }

  pendingOn(run) {
    return run ? this.approvals.get(run.id) ?? null : null;
  }

  /**
   * What the watched session is stopped on — R58, and since R137 both shapes.
   *
   * The run's own questions rather than the inbox, and that is the point: the
   * inbox is now only what is *yours*, so a question stopping a session on this
   * machine that belongs to a colleague would simply not be there — and the one
   * thing this program exists to answer is "why is that run not moving". Here
   * the answer is a name.
   *
   * <p>A session stops on two things, and this poll now watches both: a
   * question, and a permission request. The second costs one extra GET, and
   * only while this client believes a request is pending on the run being
   * watched — nothing the rest of the time. See {@link decidedElsewhere}.
   */
  async watchQuestions() {
    while (!this.stopped) {
      const run = this.current();
      if (run?.projectSlug) {
        try {
          const asked = await this.session.request(
            `/api/projects/${run.projectSlug}/runs/${run.id}/questions`,
          );
          const state = questionState(asked, this.session.email);
          if (state) {
            this.questions.set(run.id, state);
          } else {
            this.questions.delete(run.id);
          }
          // R119. The banner going is not enough: a picker or a half-written
          // line is a MODE, and it sits there over a question that has already
          // been answered in the console — asking a person a second time for
          // something they have just done, and posting it into a refusal if
          // they oblige.
          this.answeredElsewhere(run.id, asked);
          // A run entering WAITING_ON_USER is the moment the question becomes
          // something to look at, and this poll is where that is noticed.
          this.announce();
          this.dirty = true;
        } catch {
          // A run this operator cannot read is not an error worth a banner.
          this.questions.delete(run.id);
        }
        // Outside the catch: a questions read that failed is no reason to stop
        // noticing that a permission request was decided somewhere else.
        await this.decidedElsewhere(run);
      }
      await new Promise((done) => setTimeout(done, 2500));
    }
  }

  askingOn(run) {
    return run ? this.questions.get(run.id) ?? null : null;
  }

  /**
   * Closes an answer being written to a question somebody has already answered
   * — R119.
   *
   * <p>The console and this terminal are two doors onto one question, and until
   * now only one of them noticed when it was closed. Answering in the browser
   * cleared the banner here and left the PICKER up, so the session everybody
   * could see had moved on was still, on this screen, waiting for a person who
   * had already answered it. Pressing enter then posted into a refusal.
   *
   * <p>Says WHO answered it where it can. "Answered" reads as something this
   * terminal did; a name is the difference between a thing that happened and a
   * thing that happened to you.
   *
   * <p>Only ever closes an ANSWER. A permission request and a prompt are
   * different questions with different lives, and a poll that tidied those away
   * would be closing boxes nobody asked it to touch.
   *
   * <p>And what decides that is the box that is OPEN, never the claim held
   * beside it. The claim says WHICH question is being answered; it does not say
   * that anything is still on screen, and it outlives its box every time
   * somebody escapes one.
   */
  answeredElsewhere(runId, asked) {
    const open = this.answering;
    if (!open || open.runId !== runId) {
      return false;
    }
    const question = (asked ?? []).find((each) => each.id === open.questionId);
    // Still open, still worth answering. A question that has VANISHED — the run
    // gone, the list unreadable — is treated as answered rather than left on
    // screen for ever, because the one thing that cannot be right is a terminal
    // insisting on an answer to something it can no longer find.
    if (question && !question.answered) {
      return false;
    }
    this.answering = null;
    // The claim is stale on every way out that is not an answer — esc from the
    // picker, a run taken off `L`, a POST that failed — so a poll that trusted
    // it closed whatever happened to be open INSTEAD: a permission request, a
    // command half typed, the run list, all of them over the words "answered
    // elsewhere". That is the one thing the paragraph above promises this
    // cannot do, which makes it a thing to check rather than to promise.
    const onScreen = this.select?.kind === 'question' || this.input?.kind === 'answer';
    if (!onScreen) {
      return false;
    }
    this.mode = 'keys';
    this.select = null;
    this.input = null;
    this.history.reset();
    this.dirty = true;
    const by = question?.answeredByEmail;
    this.note(by && by !== this.session.email
      ? `answered by ${by} — closing this`
      : 'answered elsewhere — closing this');
    return true;
  }

  /**
   * Closes a permission request somebody has already decided in the console —
   * R137. {@link answeredElsewhere}'s other half.
   *
   * <p>A session stops on two things and until now only one of them noticed
   * when it was let go. Deciding in the browser left the picker up here, and
   * choosing a row under it posted into a 409 — *"that request was already
   * settled: allowed"* — about the very request drawn on screen. The banner
   * outlived the decision too: the inbox long-poll returns early when something
   * <em>is</em> pending and never when something stops being, so the answer
   * that would have cleared it was asleep for up to twenty seconds.
   *
   * <p>Judged by the RECORD, not by absence from the inbox. The inbox is per
   * person and per visibility, so "not in mine" is not "decided" — it is also
   * what a colleague being asked instead looks like. A record that has VANISHED
   * counts as settled, for R119's reason: the one thing that cannot be right is
   * a terminal insisting on a decision about something it can no longer find.
   *
   * <p>And what closes the box is the box that is OPEN, never the claim held
   * beside it — `deciding` says WHICH request, and it outlives its picker every
   * time somebody escapes one. Mode-independent, because through a pipe there
   * is no mode to be in: {@link openPicker} leaves it at `keys`.
   */
  async decidedElsewhere(run) {
    const pending = this.approvals.get(run.id);
    // Nothing believed pending is not news about anything.
    if (!pending) {
      return false;
    }
    let seen;
    try {
      seen = await this.session.request(
        `/api/projects/${run.projectSlug}/runs/${run.id}/approvals`,
      );
    } catch {
      // A read that failed says nothing about the request, so it changes
      // nothing about it: closing a picker on a network blip would be this
      // terminal inventing a decision nobody made.
      return false;
    }
    const record = (Array.isArray(seen) ? seen : [])
      .find((each) => each.id === pending.approval.id);
    // Still stopped on a person, which is exactly what the picker is for.
    if (record?.pending) {
      return false;
    }

    this.settled.add(pending.approval.id);
    this.approvals.delete(run.id);
    this.dirty = true;

    const mine = this.deciding?.approvalId === pending.approval.id;
    const onScreen = this.select?.kind === 'permission' || this.input?.kind === 'reason';
    if (mine && onScreen) {
      this.mode = 'keys';
      this.select = null;
      this.input = null;
      this.history.reset();
      this.deciding = null;
    }

    const by = record?.decidedByEmail;
    const verb = record?.state === 'DENIED' ? 'refused'
      : record?.state === 'ALLOWED' ? 'allowed'
        : 'decided';
    // A name where there is one: "allowed" reads as something this terminal
    // did, and a name is the difference between a thing that happened and a
    // thing that happened to you. Nobody at all is its own sentence — EXPIRED
    // is not a tidier DENIED.
    const message = record?.state === 'EXPIRED'
      ? 'nobody came — this request expired'
      : `${verb}${by && by !== this.session.email ? ` by ${by}` : ' elsewhere'}`
        + ' — closing this';
    this.note(message);
    // And into the scrollback as well, under the request `announce` printed
    // there: through a pipe there is no status line to read this off, so R119's
    // half of it is invisible today.
    this.say(this.ink.muted(message));
    return true;
  }

  // --- keys ------------------------------------------------------------------

  onKey(key) {
    // A paste is one key and never a command: `\r` inside it is a newline
    // somebody copied, not enter. See input.mjs.
    if (typeof key === 'object' && key.paste !== undefined) {
      return this.onPaste(key.paste);
    }
    // Ctrl+C is the same key everywhere, and it is answered before anything
    // else has a chance to interpret it.
    if (key === '\x03') {
      return this.onInterrupt();
    }
    this.interrupting = false;

    if (this.reader && this.mode === 'keys') {
      return this.onReaderKey(key);
    }
    if (this.mode === 'typing') {
      return this.onTyping(key);
    }
    if (this.mode === 'select') {
      return this.onSelectKey(key);
    }
    // Any other key means "no". A confirmation that outlives the moment is one
    // somebody answers by accident three keystrokes later.
    if (key !== 'x') {
      this.confirming = null;
    }

    if (this.split && (key === '\t' || key === `${ESC}[Z`)) {
      return this.cycleFocus(key === '\t' ? 1 : -1);
    }
    if (this.split && key === 'd') {
      // On a finished plan's window, `d` is that plan's `/develop`: the card
      // it planned, by the agent that planned it, in the window it leaves.
      // Anywhere else, the list of planned cards.
      return void (this.finishedPlan(this.commandTarget()) ? this.develop() : this.pickPlanned());
    }
    // ↑ with no line open: the last thing typed, on a line ready to send — as
    // a shell does. Not in advanced mode, where the wheel arrives as arrows
    // (`?1007h`) and would pull the history up on every scroll; there ↑ works
    // on the line itself (`/` or enter, then ↑).
    if (!this.split && (key === `${ESC}[A` || key === `${ESC}OA`)) {
      return this.recallIntoALine();
    }

    switch (key) {
      case 'q':
        return this.quit();
      case '\r':
      case '\n':
      case 'i': {
        // R78: a session stopped on a question cannot read a prompt — it is
        // blocked inside `ask_user`, and the API refuses one. Said here so
        // nobody types a paragraph first and is told afterwards; `a` is where
        // those words belong, and the note points at it.
        const stopped = this.askingOn(this.current());
        if (stopped) {
          return this.note(stopped.yours
            ? 'stopped on a question — press a to answer it, a prompt will not'
            : `stopped on a question, waiting on ${stopped.waitingOn}`);
        }
        return this.type('prompt', 'prompt ▸', '');
      }
      case '/':
        return this.type('command', 'cawdev ▸', '/');
      case 'l':
      case 'L':
        return this.openList();
      case 'c':
        return void this.openConfig();
      case 'g':
        this.showLog = !this.showLog;
        return this.note(this.showLog ? "printing the daemon's log" : 'printing the session');
      case 'a': {
        // R58: the refusal is here rather than at the API, so nobody types an
        // answer into a session that is not going to take it.
        const asking = this.askingOn(this.current());
        if (!asking) {
          return this.note('nothing is waiting for an answer on this one');
        }
        if (!asking.yours) {
          return this.note(`waiting on ${asking.waitingOn} — not yours to answer`);
        }
        if (!this.requireSignIn('answer a question')) return undefined;
        return this.askTheQuestion(asking);
      }
      case 'y':
      case 's':
      case 'Y':
      case 'M':
        return void this.allow(key);
      case 'n': {
        if (!this.pendingOn(this.current())) {
          return this.note('nothing is waiting for permission on this one');
        }
        if (!this.requireSignIn('refuse a request')) return undefined;
        // The other door onto the same claim: `n` opens the line without ever
        // opening the picker — R137.
        this.deciding = { runId: this.current()?.id ?? null,
          approvalId: this.pendingOn(this.current()).approval.id };
        return this.type('reason', 'refuse, because ▸', '');
      }
      case 'x':
        return void this.cancel();
      default:
        if (/^[1-9]$/.test(key)) {
          const at = Number(key) - 1;
          if (this.split) {
            const windows = this.windows();
            return at < windows.length ? this.focusWindow(windows[at].id) : this.note('');
          }
          if (at < this.runs.length) {
            this.watch(this.runs[at].id);
          }
          return this.note('');
        }
        return undefined;
    }
  }

  /**
   * Ctrl+C — once says press again, twice leaves.
   *
   * **The first press also closes whatever is open**, which is the difference
   * between this and Esc: Esc steps back one level, so a free-text answer
   * returns to the list it came from; Ctrl+C is "stop all of this", and having
   * pressed it once nobody wants to press it three more times to get out of a
   * picker they opened by accident.
   *
   * The way out is `quit`'s, and since R123 that takes the daemon with it — so
   * where there is work the second press asks again rather than leaving, and a
   * third is what actually goes.
   */
  onInterrupt() {
    const closed = this.closeEverything();
    if (this.interrupting) {
      return this.quit();
    }
    this.interrupting = true;
    return this.note(closed
      ? 'cancelled — ctrl+c again to quit'
      : 'press ctrl+c again to quit, or q');
  }

  /** Everything open, closed. Returns whether there was anything. */
  closeEverything() {
    const open = this.mode !== 'keys' || Boolean(this.reader);
    this.reader = null;
    this.mode = 'keys';
    this.select = null;
    this.input = null;
    this.answering = null;
    this.deciding = null;
    this.history.reset();
    this.dirty = true;
    // A config question closed this way is cancelled, not left waiting — R288.
    this.configuring?.cancel?.();
    return open;
  }

  /**
   * A pasted blob, which is one thing however many lines it has — R83.
   *
   * It goes into the line being typed, and if it has more than one line it goes
   * in as a placeholder that SAYS what it is. Four hundred lines of somebody's
   * stack trace scrolling past would bury the transcript this program exists to
   * keep, and it is sent in full either way.
   *
   * A paste with nothing open opens a prompt, because that is plainly what
   * somebody pasting into this window meant.
   */
  onPaste(text) {
    if (!text) {
      return undefined;
    }
    if (this.mode !== 'typing') {
      if (this.mode === 'select') {
        // A paste is not a choice. Leaving the picker open and dropping it
        // would look like the terminal ignoring a paste.
        return this.note('a paste is not a choice — esc first, or pick a row');
      }
      this.type('prompt', 'prompt ▸', '');
      if (this.mode !== 'typing') {
        return undefined; // Not signed in; `type` has already said so.
      }
    }
    this.input.line.insert(text.includes('\n') ? this.pastes.hold(text) : text);
    this.dirty = true;
    return undefined;
  }

  /**
   * Open the line editor.
   *
   * @param back the picker to return to on Esc. R83's rule: Esc from "write my
   *   own answer" goes back to the list rather than abandoning the answer, so
   *   changing your mind about writing prose costs one key and not the question.
   */
  type(kind, label, start, back = null) {
    if (kind === 'prompt' && !this.requireSignIn('prompt a session')) {
      return undefined;
    }
    this.mode = 'typing';
    this.select = null;
    this.input = { kind, label, line: new Line(start), back };
    this.history.reset();
    return this.note('');
  }

  /** The commands still matching what is typed, and which one is highlighted. */
  matching() {
    if (this.mode === 'typing' && this.input.path) {
      // R289: the directories that would complete the path, drawn where the
      // commands are drawn for a `/`.
      return { rows: this.input.path.rows, at: this.input.path.at };
    }
    if (this.mode !== 'typing' || this.input.kind !== 'command') {
      return { rows: [], at: 0 };
    }
    const rows = completions(this.input.line.text, COMMANDS);
    return { rows, at: Math.min(this.input.at ?? 0, Math.max(0, rows.length - 1)) };
  }

  onTyping(key) {
    const { line } = this.input;
    const { rows, at } = this.matching();

    if (key === ESC) {
      // One level at a time. The completion list first, because it is the
      // thing most recently in the way; then the line, back to whatever opened
      // it — which for a free-text answer is the list of options.
      if (rows.length && this.input.kind === 'command' && this.input.showing !== false) {
        this.input.showing = false;
        return this.note('');
      }
      const back = this.input.back;
      const kind = this.input.kind;
      this.input = null;
      this.history.reset();
      if (back) {
        // Back to the options, still answering them.
        return this.reopen(back);
      }
      this.mode = 'keys';
      this.answering = null;
      this.deciding = null;
      if (kind === 'config') {
        // Esc from a config question cancels the STEP, not just the line —
        // R288. The walk it was in is waiting on this answer and would
        // otherwise wait for ever.
        this.configuring?.cancel?.();
        return this.note('');
      }
      return this.note('cancelled');
    }

    if (key === '\r' || key === '\n') {
      // With a completion list open, enter takes the highlighted command —
      // which is what makes guessing a name stop being a step. With none, it
      // sends what was typed.
      if (rows.length && this.input.showing !== false && this.input.kind === 'command'
          && !this.input.recalling) {
        line.set(rows[at][0]);
      }
      return this.submit();
    }

    if (key === '\t') {
      if (this.input.path) {
        this.completeThePath();
        return undefined;
      }
      if (rows.length) {
        // As far as they agree, which is what every shell does and nobody has
        // to be taught. One match completes it whole. Once the line is already
        // that far, Tab moves down the list instead — `/log` is a command AND
        // the prefix of `/login` and `/logout`, and Tab stopping there for
        // good left those two reachable only by the arrows.
        const prefix = commonPrefix(rows.map(([name]) => name));
        if (rows.length > 1 && line.text.toLowerCase() === prefix.toLowerCase() && this.input.showing !== false) {
          this.input.at = (at + 1) % rows.length;
        } else {
          line.set(prefix);
        }
        this.input.showing = true;
        this.dirty = true;
      }
      return undefined;
    }

    const up = key === `${ESC}[A` || key === `${ESC}OA` || key === '\x10';
    const down = key === `${ESC}[B` || key === `${ESC}OB` || key === '\x0e';
    // ↑ on a line nothing has been typed on yet — empty, or the bare `/` a
    // command line opens with — is HISTORY, as in every shell; so is ↑/↓
    // while walking it. Only once something is typed do the arrows move in the
    // list of commands. Before this the `/` line showed every command and ↑
    // moved in that list, so a command line could never reach its history.
    const untouched = line.text === '' || line.text === '/';
    if ((up && (untouched || this.input.recalling)) || (down && this.input.recalling)) {
      const keep = this.input.kind === 'command' ? (entry) => entry.startsWith('/') : undefined;
      const recalled = up ? this.history.back(line.text, keep) : this.history.forward(keep);
      if (recalled !== null) {
        line.set(recalled);
        // Walking the history, not the completions: enter sends the line as
        // recalled rather than swapping it for the highlighted command.
        this.input.recalling = true;
        this.input.showing = false;
        this.dirty = true;
      }
      return undefined;
    }
    if (up) {
      if (this.input.path && rows.length) {
        this.input.path.at = (at - 1 + rows.length) % rows.length;
        this.dirty = true;
        return undefined;
      }
      if (rows.length && this.input.showing !== false) {
        this.input.at = (at - 1 + rows.length) % rows.length;
        this.dirty = true;
        return undefined;
      }
      const older = this.history.back(line.text);
      if (older !== null) {
        line.set(older);
        this.input.recalling = true;
        this.dirty = true;
      }
      return undefined;
    }
    if (down) {
      if (this.input.path && rows.length) {
        this.input.path.at = (at + 1) % rows.length;
        this.dirty = true;
        return undefined;
      }
      if (rows.length && this.input.showing !== false) {
        this.input.at = (at + 1) % rows.length;
        this.dirty = true;
        return undefined;
      }
      const newer = this.history.forward();
      if (newer !== null) {
        line.set(newer);
        this.dirty = true;
      }
      return undefined;
    }
    // Anything else edits the line: what is on it is no longer a recollection.
    if (key !== '\r' && key !== '\n') {
      this.input.recalling = false;
    }

    if (key === '\x7f' || key === '\b') {
      line.backspace();
    } else if (key === `${ESC}[3~`) {
      line.forwardDelete();
    } else if (key === `${ESC}[D` || key === `${ESC}OD` || key === '\x02') {
      line.left();
    } else if (key === `${ESC}[C` || key === `${ESC}OC` || key === '\x06') {
      line.right();
    } else if (key === `${ESC}[H` || key === `${ESC}OH` || key === '\x01') {
      line.home();
    } else if (key === `${ESC}[F` || key === `${ESC}OF` || key === '\x05') {
      line.end();
    } else if (key === '\x15') {
      line.killToStart();
    } else if (key === '\x17') {
      line.killWord();
    } else if (!key.startsWith(ESC)) {
      // Printable only: an arrow key inside a prompt should not become "[A".
      line.insert(key);
      // Typing again re-opens a completion list Esc closed, because the list is
      // about what is on the line RIGHT NOW.
      this.input.showing = true;
      this.input.at = 0;
    } else {
      return undefined;
    }
    this.dirty = true;
    if (this.input.path) {
      void this.refreshPath();
    }
    return undefined;
  }

  /** Enter, on whatever was being typed. */
  submit() {
    const typed = this.input.line.text.trim();
    const kind = this.input.kind;
    const back = this.input.back;
    this.input = null;
    this.mode = 'keys';
    this.history.reset();

    if (kind === 'config') {
      // Before the empty-line rule, on purpose: every config question shows a
      // default in its label, and enter on an empty line TAKES it — R288.
      // Not remembered either; a path typed once is not a prompt worth
      // offering back next launch.
      this.configuring?.answer?.(this.pastes.expand(typed));
      return this.note('');
    }
    if (!typed || typed === '/') {
      // Nothing typed is not an answer, and a question that was open is still
      // open — so an empty line goes back to it rather than dropping it.
      return back ? this.reopen(back) : this.note('');
    }
    // What was typed, remembered as typed: a placeholder rather than the four
    // hundred lines behind it.
    const remembered = this.remember(typed);
    const text = this.pastes.expand(typed);

    if (kind === 'command' || (kind === 'prompt' && typed.startsWith('/'))) {
      // After the write, not beside it: `/logout` forgets the history, and a
      // write still in flight would put the command that cleared it back.
      // The EXPANDED text: a command is as much a place to paste into as a
      // prompt, and running it on the placeholder sent "[pasted, 12 lines]"
      // as the task in place of the twelve lines.
      return void remembered.then(() => this.runCommand(text));
    }
    if (kind === 'prompt') {
      return void this.send(text);
    }
    return kind === 'answer'
      ? void this.answer(text)
      : void this.decide({ allow: false, reason: text }, 'refused');
  }

  /** Up-arrow's memory, here and next launch — see history.mjs. */
  async remember(typed) {
    this.history.add(typed);
    await pushHistory(this.session.url, typed).catch(() => undefined);
  }

  // --- the one select widget -------------------------------------------------

  /**
   * Open a picker, or — where there is no cursor to move — print it and wait
   * for a line.
   *
   * The two paths take the same {@link Select}, which is the point: a numbered
   * list read from stdin is the same rows in the same order, so there is one
   * place where "what can be chosen here" is decided.
   */
  openPicker(select) {
    if (this.plain) {
      this.select = select;
      for (const line of plainLines(select)) {
        this.say(line);
      }
      return undefined;
    }
    this.mode = 'select';
    this.select = select;
    this.input = null;
    return this.note('');
  }

  /** Back to a picker that was left for the line editor. */
  reopen(select) {
    return this.openPicker(select);
  }

  onSelectKey(key) {
    const select = this.select;
    // `q` closes the run list, which is what it did before R83. It is not
    // offered on a question or a permission request: there `q` could be the
    // first letter of an answer somebody is about to write.
    if (key === 'q' && select.kind === 'runs') {
      this.mode = 'keys';
      this.select = null;
      return this.note('');
    }
    // A question's or a permission's list holds only the start of what is
    // asked; `/` leaves it for a command — `/view` reads it whole, `/open`
    // answers it on cawdev — and `a` (or `y`/`n`) brings the choice back.
    if (key === '/' && (select.kind === 'question' || select.kind === 'permission')) {
      this.mode = 'keys';
      this.select = null;
      this.answering = null;
      this.deciding = null;
      return this.type('command', 'cawdev ▸', '/');
    }

    const outcome = select.key(key);
    if (!outcome) {
      return undefined;
    }
    if (outcome.done === null) {
      this.dirty = true;
      return undefined;
    }
    if (outcome.done === 'cancelled') {
      this.mode = 'keys';
      this.select = null;
      // With the box goes the claim on the question it was answering — R119.
      // Nothing reads it while nothing is open, but a field that says an answer
      // is being written when none is is one the next reader will believe.
      this.answering = null;
      this.deciding = null;
      if (select.kind === 'config') {
        this.configuring?.cancel?.();
      }
      // Escape leaves without changing anything, which is the promise the key
      // makes everywhere else.
      return this.note('');
    }
    if (select.many) {
      this.mode = 'keys';
      this.select = null;
      return this.choseMany(select, outcome.rows ?? []);
    }
    return this.chose(select, outcome.row);
  }

  /** Several rows were ticked and confirmed — a picker opened with `many`. */
  choseMany(select, rows) {
    if (select.kind === 'split-projects') {
      const slugs = rows.map((row) => row.id);
      if (!slugs.length) return this.note('');
      return this.split ? this.focusProjects(slugs) : this.enterSplit(slugs);
    }
    return this.note('');
  }

  /**
   * A row was chosen, whichever way it was chosen.
   *
   * One place for it, so that a digit, an arrow-and-enter and a number typed at
   * a plain prompt cannot mean three different things.
   */
  chose(select, row, typed = null) {
    if (!row) {
      return this.note('');
    }
    this.mode = 'keys';
    this.select = null;

    if (select.kind === 'runs') {
      this.watch(row.id);
      return undefined;
    }
    if (select.kind === 'question') {
      if (row.id === WRITE_MY_OWN) {
        // Free text, with the question still on screen and Esc back to the
        // list: the options are the agent's guess, and the value of asking a
        // person is that they can say the thing that was not on it.
        return typed
          ? void this.answer(typed)
          : this.type('answer', 'answer ▸', '', select);
      }
      return void this.answer(row.label);
    }
    if (select.kind === 'permission') {
      if (row.id === 'refuse') {
        return this.type('reason', 'refuse, because ▸', '', select);
      }
      return void this.allow(row.id);
    }
    if (select.kind === 'drop') {
      return void this.droppedCheckout(row);
    }
    if (select.kind === 'view-card') {
      const [slug, ref] = String(row.id).split(' ');
      return void this.showCard(slug, ref);
    }
    if (select.kind === 'planned') {
      const [slug, ref] = String(row.id).split(' ');
      return void this.startNew(['dev', ref, `@${slug}`]).then(() => this.refreshPlanned());
    }
    if (select.kind === 'card-project') {
      // `/card` asked which project; the same card, with it named.
      const words = this.cardWaitingForProject ?? [];
      this.cardWaitingForProject = null;
      return void this.addCard([...words, `@${row.id}`]);
    }
    if (select.kind === 'project') {
      // `/new` asked which project; the same command again, with it named.
      const words = this.newWaitingForProject ?? [];
      this.newWaitingForProject = null;
      return void this.startNew([...words, `@${row.id}`]);
    }
    if (select.kind === 'config') {
      // R288: the walk asked, the walk gets the row. Nothing is decided here.
      this.configuring?.answer?.(row);
      return undefined;
    }
    return undefined;
  }

  /**
   * A line typed where there is no cursor — the plain path's whole input.
   *
   * A number picks from whatever was printed; anything else is the free text a
   * question allows, a command, or a prompt. Same rows, same rules, no repaint.
   */
  onLine(text) {
    const typed = String(text).trim();
    if (this.input?.kind === 'config' && !this.select) {
      // The plain path's half of R288: a config question waiting on a line
      // takes the whole line, empty included, and nothing else reads it.
      this.input = null;
      this.mode = 'keys';
      this.configuring?.answer?.(typed);
      return undefined;
    }
    if (this.select) {
      const picked = pickFromLine(this.select, typed);
      if (picked) {
        return this.chose(this.select, picked.row, picked.text ?? null);
      }
      if (!this.select.freeText) {
        for (const line of plainLines(this.select)) {
          this.say(line);
        }
        return undefined;
      }
    }
    if (!typed) {
      return undefined;
    }
    if (typed.startsWith('/')) {
      return void this.remember(typed).then(() => this.runCommand(typed));
    }
    void this.remember(typed);
    const asking = this.askingOn(this.current());
    if (asking?.yours) {
      // A session stopped on a question cannot read a prompt (R78), and the
      // words somebody typed here are plainly meant for it.
      return void this.answer(typed);
    }
    return void this.send(typed);
  }

  // --- the three things there are to pick from -------------------------------

  /**
   * `L` — every run this machine is driving, claiming or leaving queued.
   *
   * An overlay rather than a rail, because that is the trade R81 reversed: the
   * rail cost thirty columns on every line of every transcript to answer a
   * question asked a few times an hour. Since R83 it is the same widget as the
   * other two, which is how it stopped being its own key handler.
   */
  openList() {
    const ink = this.ink;
    return this.openPicker(new Select({
      kind: 'runs',
      title: 'sessions on this machine',
      empty: 'nothing running, claiming or queued here',
      at: Math.max(0, this.runs.findIndex((run) => run.id === this.watching)),
      rows: this.runs.map((run) => ({
        id: run.id,
        label: run.label,
        // `!` is a decision waiting; `?` is a question. Different marks because
        // they are answered with different keys, and since R58 the second may
        // not even be yours.
        marker: this.approvals.has(run.id)
          ? ink.warn('!')
          : this.questions.has(run.id) ? ink.accent('?') : ' ',
        // A run brings its own renderer: `runLine` narrows the LABEL and keeps
        // the reason a queued run is queued, which is not a rule a generic row
        // could guess.
        render: (opts, width, painted) => runLine(run, opts, width, painted),
      })),
    }));
  }

  /**
   * The question this session stopped on, as something to pick from — R83.
   *
   * With no options there is nothing to pick, so it goes straight to the line
   * editor, which is what it has always done.
   */
  askTheQuestion(asking) {
    // What is being answered, so that the poll can tell whether this is still
    // worth answering — R119. The RUN as well as the question: a picker left
    // open while the operator switches to another session is still this
    // question's, and clearing it on somebody else's news would close a box
    // with an answer half-written in it.
    this.answering = { runId: asking.question.runId ?? this.current()?.id ?? null,
      questionId: asking.question.id };
    const options = asking.question.options ?? [];
    if (!options.length) {
      return this.type('answer', 'answer ▸', '');
    }
    return this.openPicker(new Select({
      kind: 'question',
      title: clip(`${this.tagOf(this.current())} asks: ${String(asking.question.question).split('\n')[0]}`,
        Math.max(20, this.screen.width - 2)),
      hint: '/view reads it all',
      rows: [
        ...options.map((option) => ({ id: option, label: option })),
        // Always last, and always there.
        { id: WRITE_MY_OWN, label: 'Write my own answer', hint: 'opens a line to type on' },
      ],
    }));
  }

  /**
   * A permission request, as R60's lengths of yes — R83.
   *
   * The tool and its arguments are PRINTED above the rows, not clipped into
   * them: you are deciding about something you can read, which is the whole
   * reason R51 records the call rather than the tool's name.
   */
  askPermission(pending) {
    const approval = pending.approval;
    // What is being decided, so that the poll can tell whether this is still
    // worth deciding — R137, and the RUN as well as the request for the reason
    // {@link askTheQuestion} carries one.
    this.deciding = { runId: pending.runId ?? this.current()?.id ?? null,
      approvalId: approval.id };
    const covers = approval.suggestion ?? `every ${approval.toolName}`;
    return this.openPicker(new Select({
      kind: 'permission',
      // The call, on the title, as well as printed in full above: the picker
      // may still be on screen when the transcript under it has moved on.
      // The first line only: a stage gate's summary is the whole plan, and
      // `/view` is where it is read.
      title: `${this.tagOf(this.current())} wants ${approval.toolName} · ${String(approval.summary ?? '').split('\n')[0]}`,
      hint: '/view reads it all',
      rows: [
        { id: 'y', label: 'Allow once', hint: 'this call and no more' },
        // R78: the middle grant NAMES what it covers, and it says so in the
        // short wording too — "for this run" and "every Bash for this run" are
        // not the same promise, and a row that shortened to the first would be
        // describing one nobody made.
        {
          id: 's',
          label: `Allow ${covers} for the rest of this run`,
          short: `Allow ${covers} this run`,
          hint: 'dies with the session',
        },
        ...(approval.suggestion
          ? [{
            id: 'Y',
            label: `Always allow ${approval.suggestion} here`,
            short: `Always ${approval.suggestion}`,
            hint: 'a project rule',
          }]
          : []),
        { id: 'refuse', label: 'Refuse', hint: 'and say why' },
      ],
    }));
  }

  /**
   * What a session is stopped on, said once, when it starts being stopped on it.
   *
   * **Printed into the transcript and then offered as a list.** The text goes
   * into the scrollback because it is what happened and it should still be there
   * when you scroll back to it; the choice goes into the live region because it
   * is what is happening now. A question that scrolls away leaves a picker
   * asking about nothing.
   *
   * Nothing opens over something somebody is already doing: with a picker or a
   * half-written prompt on screen the banner and its key are enough, and taking
   * the keyboard away mid-sentence is how a client loses somebody's paragraph.
   */
  announce() {
    const run = this.current();
    if (!run) return;

    const pending = this.pendingOn(run);
    if (pending && !this.announced.has(pending.approval.id)) {
      this.announced.add(pending.approval.id);
      const ink = this.ink;
      const about = pending.approval.id;
      this.sayAbout(about, '');
      this.sayAbout(about, `${ink.bold(ink.warn(' permission '))} ${ink.muted('from')} ${ink.bold(this.tagOf(run))}`);
      this.sayAbout(about, `  ${ink.text(pending.approval.toolName)}`);
      // Not clipped: this is the thing being decided about, and a command cut
      // at the width is a command you have not read.
      this.sayAbout(about, { prefix: '  ', body: pending.approval.summary, paint: ink.text });
      if (this.mode === 'keys') {
        this.askPermission(pending);
      }
      return;
    }

    const asking = this.askingOn(run);
    if (!asking || this.announced.has(asking.question.id)) {
      return;
    }
    this.announced.add(asking.question.id);
    const ink = this.ink;
    // In advanced mode the question is the prompt's BANNER alone, whole and
    // wrapped, and it goes when the question does: written into the messages
    // as well, it was on screen twice — once whole, once cut — and stayed
    // after it was answered.
    if (!this.split) {
      this.say('');
      this.say(`${ink.bold(ink.accent(' question '))} ${ink.muted('from')} ${ink.bold(this.tagOf(run))}`);
      this.say(`  ${ink.text(asking.question.question)}`);
    }
    // R58: a watcher who does not own the question is told whose it is and is
    // offered nothing. A picker here would take an answer the platform then
    // refuses, which reads as cawdev being broken.
    if (!asking.yours) {
      if (!this.split) this.say(`  ${ink.muted(`waiting on ${asking.waitingOn ?? 'somebody else'}`)}`);
      return;
    }
    if (this.mode === 'keys' && this.session.signedIn && asking.question.options?.length) {
      this.askTheQuestion(asking);
    }
  }

  overlayLines(width) {
    if (this.mode !== 'select' || !this.select) return [];
    // A third of the window, so a long list never becomes the screen. The
    // transcript underneath is what this program is for.
    return this.select.lines(width, this.ink, Math.max(3, Math.floor(this.screen.height / 3)));
  }

  requireSignIn(what) {
    if (this.session.signedIn) {
      return true;
    }
    // The refusal names the rule rather than the symptom: this is not the
    // client being awkward, it is the platform refusing anything that is not a
    // person, and a message that says "403" would send somebody looking in the
    // wrong place.
    this.note(`sign in with /login to ${what} — a session may only be changed by a person`);
    return false;
  }

  // --- this machine's config — R288 ------------------------------------------

  /**
   * `c` — configure this machine from inside the terminal.
   *
   * R283 built `cawdev config …` as a shell subcommand, and the first person to
   * launch the new CLI could not find it: they were HERE, attached, which is
   * where cawdev lives on a machine, and nothing here said a word about
   * configuration. So the same functions get a second door. The rows carry the
   * state each toggle is in, because a list that says "enable claude" when
   * claude is already on is a list asking somebody to guess.
   *
   * Every change goes through configure.mjs — one implementation, two doors —
   * and its questions come back through this class's own line editor and its
   * own picker: {@link askLine} and {@link askPick} are the adapters, and the
   * walk between them cannot tell readline from raw mode. The daemon is never
   * told anything over R52's socket; the file is written as the operator and,
   * for the two settings runner.mjs re-reads, the process is sent a SIGHUP
   * through the pid the hello already carries.
   */
  async openConfig() {
    if (this.configuring) {
      return this.note('already configuring — finish that, or esc');
    }
    if (!this.runner) {
      return this.note('not connected to the daemon yet');
    }
    if (this.runner.configPath === undefined) {
      // An older daemon: it does not say which file it booted from, and
      // guessing at one is how a config screen edits the wrong machine.
      return this.note('this daemon is older than this client — q, then cawdev again, and c will work');
    }
    if (this.runner.configPath === null) {
      return this.note('this daemon was started from the environment, with no config file — nothing here to edit');
    }
    const file = await readConfigFile(this.runner.configPath);
    if (!file) {
      return this.note(`could not read ${this.runner.configPath}`);
    }

    this.configuring = { answer: null, cancel: null };
    try {
      await this.configWalk(file);
    } catch (failure) {
      if (failure === CANCELLED) {
        this.note('nothing changed');
      } else {
        this.say(`  ${this.ink.danger(failure.message)}`);
        this.note('nothing changed');
      }
    } finally {
      this.configuring = null;
      this.dirty = true;
    }
    return undefined;
  }

  /** One step of the screen: pick what to change, then change it. */
  async configWalk(file) {
    const ink = this.ink;
    const say = (line) => this.say(line);
    const configPath = this.runner.configPath;
    const url = this.session.url;
    const ask = { line: (prompt) => this.askLine(prompt) };
    const pick = (_ask, _say, select) => this.askPick(select).then((row) => ({ done: 'chosen', row }));

    const chosen = await this.askPick(configMenu(file, this.runner, this.gone));
    this.say('');
    this.say(`${ink.bold(ink.accent(' config '))} ${ink.text(chosen.label)}`);

    if (chosen.id === 'show') {
      const shown = { ...file };
      if (shown.token) shown.token = `${String(shown.token).slice(0, 10)}…`;
      for (const line of JSON.stringify(shown, null, 2).split('\n')) {
        this.say(`  ${ink.text(line)}`);
      }
      this.say(`  ${ink.muted(configPath)}`);
      return this.note('');
    }

    if (chosen.id === 'add-project') {
      // Widens the machine's token on the platform, which only a person may do.
      // `requireSignIn` has already said so; a second note would bury it.
      if (!this.requireSignIn('add a project to this machine')) {
        return undefined;
      }
      const next = await addProject({
        configPath, file, url, session: this.session, ask, say, ink, pick,
        askPath: (spec) => this.askPath(spec),
        inspect: this.options.inspect ?? inspectPath,
        clone: (gitUrl, path) => this.cloneInto(gitUrl, path),
      });
      return this.reloadDaemon(file, next);
    }
    if (chosen.id === 'add-workspace') {
      const next = await addWorkspace({
        configPath, file, url, session: this.session, ask, say, ink, pick,
        askPath: (spec) => this.askPath(spec),
        inspect: this.options.inspect ?? inspectPath,
        clone: (gitUrl, path) => this.cloneInto(gitUrl, path),
      });
      return this.reloadDaemon(file, next);
    }
    if (chosen.id.startsWith('agent:')) {
      const command = chosen.id.slice('agent:'.length);
      const next = await setAgentEnabled({
        file, configPath, ask, say, ink, command, enabled: !agentsOf(file).includes(command),
      });
      this.runner.agents = agentsOf(next);
      return this.reloadDaemon(file, next);
    }
    if (chosen.id.startsWith('quality:')) {
      const slug = chosen.id.slice('quality:'.length);
      const next = await setQuality({
        file, configPath, ask, say, ink, slug, enabled: !qualityOf(file.projects?.[slug]),
      });
      return this.reloadDaemon(file, next);
    }
    if (chosen.id.startsWith('remove:')) {
      const slug = chosen.id.slice('remove:'.length);
      const next = await removeProject({ file, configPath, ask, say, ink, slug });
      // Off the screen now, though the daemon serves it until a restart.
      this.gone.add(slug);
      this.cards = this.cards.filter((card) => card.slug !== slug);
      this.planned = this.planned.filter((card) => card.slug !== slug);
      return this.reloadDaemon(file, next);
    }
    if (chosen.id === 'pause') {
      if (this.runner.pausedByUsage) {
        this.say(`  ${ink.muted('cawdev paused this machine for usage; it resumes by itself. Change the threshold on Settings → Machines.')}`);
        return this.note('');
      }
      // Writes the platform, which only a person may do, and not the file.
      if (!this.requireSignIn('pause or resume this machine')) return undefined;
      const runner = await setPaused({
        session: this.session, runnerId: this.runner.id, paused: this.runner.paused !== true, say, ink,
      });
      this.runner.paused = runner?.paused === true;
      this.runner.pausedByUsage = runner?.pausedByUsage === true;
      return this.note('');
    }
    if (chosen.id === 'planning-limit') {
      // Writes the platform, which only a person may do, and not the file — so
      // no reload: the daemon reads the number off its next heartbeat.
      if (!this.requireSignIn('limit planning runs at once')) return undefined;
      const answer = (await ask.line('  How many at once (0 for no limit)? ')).trim();
      const limit = answer === '' ? NaN : Number(answer);
      const runner = await setMaxPlanningRuns({
        session: this.session, runnerId: this.runner.id, limit, say, ink,
      });
      this.runner.maxPlanningRuns = runner?.maxPlanningRuns ?? null;
      return this.note('');
    }
    if (chosen.id === 'rules') {
      const next = await setAcceptsRulesFromConsole({
        file, configPath, ask, say, ink, enabled: file.acceptsRulesFromConsole !== true,
      });
      this.runner.acceptsConsoleRules = next.acceptsRulesFromConsole === true;
      return this.reloadDaemon(file, next);
    }
    return this.note('');
  }

  /**
   * Every change ends here — R294. The daemon this terminal is attached to is
   * signalled through the pid the hello carries (R283's `reloadIfRunning`),
   * and what is printed is the DAEMON's verdict: the keys in
   * lib/runner-config.mjs's `HOT_SWAPPABLE` were applied, or the file has
   * moved on in ways only a restart picks up. The daemon pushes its re-read
   * hello to this terminal as a `runner` event, so `hello` here reads
   * `this.runner` and waits for `configReadAt` to move — no second socket.
   *
   * The footer then carries `restartNeeded` for as long as it is true, which
   * is the change from R288: a muted line that scrolled away was the only
   * thing that said a project added here was not being served yet.
   */
  async reloadDaemon(file, next) {
    const verdict = await reloadIfRunning(next.name, (line) => this.say(line), this.ink, {
      hello: async () => this.runner,
      fallback: restartNeededFor(file, next),
      // Injectable so a test can watch the signal without sending one.
      kill: this.options.kill ?? ((pid, signal) => process.kill(pid, signal)),
      restartHint: RESTART_FROM_ATTACH,
      waitMs: this.options.reloadWaitMs ?? 3000,
    });
    if (!verdict.running) {
      // Reachable when the hello carried no pid — a daemon older than R81.
      this.say(`  ${this.ink.muted('Saved. This daemon is still on the config it booted with — q, then cawdev, to serve it.')}`);
      return this.note('saved — q, then cawdev, to serve it');
    }
    return this.note(verdict.restartNeeded.length ? 'saved — restart to apply' : '');
  }

  /**
   * One line, asked through this class's own editor — the `ask.line` shape
   * configure.mjs takes. Enter on an empty line resolves '' (the default the
   * label shows); Esc rejects with {@link CANCELLED}, which unwinds the step.
   */
  askLine(prompt, { prefill = '', path = null } = {}) {
    return new Promise((resolve, reject) => {
      this.configuring.answer = (text) => {
        this.configuring.answer = null;
        this.configuring.cancel = null;
        resolve(text);
      };
      this.configuring.cancel = () => {
        this.configuring.answer = null;
        this.configuring.cancel = null;
        reject(CANCELLED);
      };
      const { said, label } = splitPrompt(prompt);
      if (said) {
        // R289: a question longer than a label is PRINTED, where it wraps and
        // stays, and the footer keeps the short part — a line the footer clips
        // is a question nobody read.
        this.say(`  ${this.ink.text(said)}`);
      }
      if (this.plain && !said) {
        // No footer to carry the label through a pipe, so it is printed.
        this.say(`  ${label}`);
      }
      this.type('config', label, prefill);
      if (path) {
        this.input.path = { ...path, rows: [], at: 0, preview: '', completion: null };
        void this.refreshPath();
      }
    });
  }

  /**
   * Where a checkout goes — R289. Suggestions first, each saying what is there
   * now; the last row opens a line PRE-FILLED with the first suggestion, with
   * tab completing directories and a preview under it. `~` expands. The path
   * comes back absolute; configure.mjs inspects it again before acting.
   */
  async askPath({ question, suggestions, slug, gitUrl, inspect = inspectPath }) {
    // The question is the picker's title; printing it as well put it on screen twice.
    const rows = [];
    for (const each of suggestions) {
      const seen = await inspect(each.path, { gitUrl });
      rows.push({ id: each.path, label: each.path, hint: `${each.why} · ${describe(seen, slug)}` });
    }
    rows.push({ id: TYPE_A_PATH, label: 'Type a path', hint: 'pre-filled · tab completes · ~ works' });
    const chosen = await this.askPick(new Select({ title: question, rows }));
    if (chosen.id !== TYPE_A_PATH) {
      return chosen.id;
    }
    const typed = await this.askLine('path', {
      prefill: suggestions[0]?.path ?? '',
      path: { slug, gitUrl, inspect },
    });
    return absolute(typed || suggestions[0]?.path || '');
  }

  /**
   * What the path on the line points at, recomputed as it is typed: the
   * directories that would complete it (drawn above the line, tab takes them)
   * and one line saying what is there (drawn under it). The inspection is
   * debounced and checked against the line afterwards, so a slow disk never
   * paints a verdict about a path that has since changed.
   */
  async refreshPath() {
    const input = this.input;
    if (!input?.path) return;
    const text = input.line.text;
    const expanded = absolute(text);
    const completion = completePath(text, await listDirectories(
      text.endsWith('/') ? expanded : dirname(expanded),
    ));
    if (this.input !== input || input.line.text !== text) return;
    input.path.completion = completion;
    input.path.rows = completion.matches
      .filter((match) => `${match}/` !== expanded && match !== expanded)
      .slice(0, 8)
      .map((match) => [`${basename(match)}/`, '']);
    input.path.at = Math.min(input.path.at, Math.max(0, input.path.rows.length - 1));
    this.dirty = true;

    await new Promise((done) => setTimeout(done, 120));
    if (this.input !== input || input.line.text !== text) return;
    const seen = await input.path.inspect(expanded, { gitUrl: input.path.gitUrl });
    if (this.input !== input || input.line.text !== text) return;
    input.path.preview = `${expanded} — ${describe(seen, input.path.slug)}`;
    this.dirty = true;
  }

  /** Tab on a path: as far as the matches agree; cycle them when they do not. */
  completeThePath() {
    const input = this.input;
    const path = input?.path;
    if (!path?.completion) return;
    const { completed, matches } = path.completion;
    if (completed !== input.line.text) {
      input.line.set(completed);
    } else if (matches.length > 1) {
      const pick = matches[path.at % matches.length];
      input.line.set(`${pick}/`);
      path.at = (path.at + 1) % matches.length;
    }
    this.dirty = true;
    void this.refreshPath();
  }

  /** One row, through the one select widget — R83's rule, kept. */
  askPick(select) {
    return new Promise((resolve, reject) => {
      this.configuring.answer = (row) => {
        this.configuring.answer = null;
        this.configuring.cancel = null;
        resolve(row);
      };
      this.configuring.cancel = () => {
        this.configuring.answer = null;
        this.configuring.cancel = null;
        reject(CANCELLED);
      };
      select.kind = 'config';
      this.openPicker(select);
    });
  }

  /**
   * `git clone` with its progress printed into the transcript rather than onto
   * a terminal in raw mode, and `GIT_TERMINAL_PROMPT=0` because a clone that
   * stops to ask for a password here would hang the screen with no prompt on
   * it: the credential helper may answer, a person cannot.
   *
   * ssh does not read that variable: a key with a passphrase is asked for on
   * `/dev/tty` directly, over this screen, while the screen's own raw-mode
   * reader takes half the keys. So ssh runs in BatchMode — a key the agent
   * holds (or one with no passphrase) still works, and one that would have to
   * ask fails at once and says how to make it not ask. A GIT_SSH_COMMAND the
   * person set themselves is theirs and left alone.
   */
  cloneInto(gitUrl, path) {
    return new Promise((done, fail) => {
      const child = spawn('git', ['clone', '--progress', gitUrl, path], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
        },
      });
      let said = '';
      const print = (chunk) => {
        said += chunk;
        for (const line of String(chunk).split(/\r?\n|\r/)) {
          if (line.trim()) this.say(`  ${this.ink.muted(line)}`);
        }
      };
      child.stdout.on('data', print);
      child.stderr.on('data', print);
      child.on('error', (failure) => fail(new Error(`Could not run git: ${failure.message}`)));
      child.on('close', (code) => {
        if (code === 0) {
          done();
          return;
        }
        fail(new Error(`git clone exited ${code}.${sshNeedsAPerson(said)
          ? ' ssh needed to ask you something — a key\'s passphrase, or whether to trust the host '
            + '— and this screen cannot ask. Add the key to your agent once (macOS: `ssh-add '
            + '--apple-use-keychain ~/.ssh/id_ed25519`) and try again, or run `cawdev config '
            + 'add-project` from a shell, which can ask.'
          : ''}`));
      });
    });
  }

  // --- slash commands ---------------------------------------------------------

  async runCommand(text) {
    const [word, ...rest] = commandWords(text.slice(1));
    switch (word) {
      case 'help':
        this.say('');
        this.say(this.ink.bold(' commands'));
        for (const [name, what] of COMMANDS) {
          this.say(`   ${this.ink.accent(name.padEnd(9))} ${this.ink.muted(what)}`);
        }
        this.say('');
        this.say(this.ink.bold(' keys'));
        this.say(this.ink.muted('   enter prompt · / command · L runs · 1-9 pick a run · c config'));
        this.say(this.ink.muted('   a answer · y/s/Y/n permission · x cancel · g log · q quit'));
        this.say(this.ink.muted('   in a list: ↑↓ move · 1-9 pick · enter choose · esc leave'));
        this.say(this.ink.muted('   while typing: ↑↓ history · tab complete · esc back · ctrl+c twice quits'));
        this.say('');
        return this.note('');
      case 'login':
        return this.signIn();
      case 'logout':
        await this.session.signOut();
        await clearSession(this.session.url);
        // The history goes with it. It is what this person typed, and "forget
        // the stored session on this machine" would be a strange promise to
        // keep half of.
        await clearHistory(this.session.url).catch(() => undefined);
        this.history = new History();
        return this.note('signed out — /login to sign in again');
      case 'runs':
        return this.openList();
      case 'config':
        return void this.openConfig();
      case 'cancel':
        return void this.cancel();
      case 'log':
        this.showLog = !this.showLog;
        return this.note(this.showLog ? "printing the daemon's log" : 'printing the session');
      case 'advanced-mode':
      case 'advanced': {
        const want = rest[0] === 'off' ? false : rest[0] === 'on' ? true : !this.split;
        if (!want) return this.leaveSplit();
        // `@slug` names the projects outright; otherwise they are asked.
        const named = rest.filter((word) => word.startsWith('@')).map((word) => word.slice(1));
        return named.length ? this.enterSplit(named) : this.askSplitProjects();
      }
      case 'projects':
        return this.askSplitProjects();
      case 'refresh':
        return void this.refreshCards();
      case 'new':
        return void this.startNew(rest);
      case 'card':
        return void this.addCard(rest);
      case 'agent':
        return void this.chooseAgent(rest[0]);
      case 'develop':
        return void this.develop(rest);
      case 'pr':
        return void this.openPullRequest();
      case 'continue':
        return void this.carryOn();
      case 'open':
        return void this.openInBrowser();
      case 'view':
        if (rest.length) return void this.viewCard(rest);
        return this.waitingOn(this.commandTarget()) ? this.openReader() : this.viewOnCawdev();
      case 'drop':
        return void this.dropCheckout();
      case 'close':
        return this.closeWindow();
      case 'reload':
        return void this.reload();
      case 'quit':
      case 'exit':
        return this.quit();
      default:
        return this.note(`no such command: /${word}${rest.length ? ' …' : ''} — try /help`);
    }
  }

  /**
   * `/login`, from inside the UI.
   *
   * The screen is given back for the duration, because this prints a URL and a
   * code somebody has to read and possibly copy — and a URL that scrolls under
   * a footer three lines later is a URL nobody can click. The footer comes back
   * the moment it is decided.
   */
  async signIn() {
    let say;
    if (this.split) {
      // Advanced mode stays: the URL and the code go to the prompt window,
      // where everything said there is read, and the browser opens anyway.
      say = (line) => this.say(line);
    } else {
      // Everything queued goes out first and the footer comes down, so what
      // `runSignIn` prints with `console.log` lands under the transcript rather
      // than through the middle of a live region nothing is going to erase.
      this.say('');
      this.screen.update(this.pending, []);
      this.pending = [];
    }
    const outcome = await runSignIn(this.session, this.ink, say)
      .catch((failure) => ({ signedIn: false, message: failure.message }));
    if (outcome.message) {
      this.say(this.ink.danger(`  could not sign in: ${outcome.message}`));
    }
    if (this.session.signedIn && this.expired) {
      // After an expiry the watchers never stopped — they have been failing
      // quietly and pick up on their own — so a second set would poll twice.
      this.expired = false;
      this.note('signed in again');
      void this.findStopped();
    } else if (this.session.signedIn) {
      void this.watchInbox();
      void this.watchQuestions();
      void this.findStopped();
    }
    this.dirty = true;
    return undefined;
  }

  /**
   * The platform answered 401 to a session that was signed in: it expired, was
   * signed out from the console, or the account went. Said once, where it is
   * read — the prompt window in advanced mode, the scrollback otherwise — and
   * the footer keeps a row until `/login` succeeds. The watchers keep polling
   * and fail quietly; they pick up again on their own after the sign-in.
   */
  sessionExpired() {
    if (this.expired) return;
    this.expired = true;
    this.say(this.ink.warn('  your cawdev session has expired or is no longer valid — type /login to sign in again'));
    this.note('session expired — /login to sign in again');
  }

  // --- advanced mode — split.mjs ----------------------------------------------

  /**
   * What this terminal knows of every session it has seen, after the daemon's
   * list changed. A session that left the list has ENDED — the daemon forgets
   * it there and then — and the platform is asked how, because what can be done
   * next (develop the plan, open the pull request) is decided by that.
   */
  trackSessions() {
    const live = new Set();
    for (const run of this.runs) {
      live.add(run.id);
      const known = this.sessions.get(run.id);
      if (known?.ended && this.lines.has(run.id)) {
        // Back to life (a carry-on): what was said about how it stopped is
        // over, and the new output is what the window is for.
        this.lines.set(run.id, this.lines.get(run.id).filter((line) => !line.seed));
      }
      const meta = known ?? { id: run.id, view: null, prAsked: null };
      Object.assign(meta, {
        projectSlug: run.projectSlug,
        label: run.label,
        profile: run.profile ?? meta.profile ?? null,
        state: run.state,
        why: run.why ?? null,
        // Where a live session is working — the daemon's word, and the one a
        // window names (`subtitleFor`); kept once it ends, with the view's.
        workspace: run.workspace ?? meta.workspace ?? null,
        // Which CLI and model it runs on — per stage, so kept up to date.
        // A daemon that sends the field is believed even when it is null (a
        // stage asking for no model); an older one that sends nothing keeps
        // what was known.
        agent: run.agent !== undefined ? run.agent : meta.agent ?? null,
        model: run.model !== undefined ? run.model : meta.model ?? null,
        ended: false,
        // A carried-on run the daemon has taken: the ask is answered.
        carryAsked: false,
      });
      if (!known) {
        this.sessions.set(run.id, meta);
        void this.readView(meta);
        // The development `d` started in place of a plan's window takes the
        // focus that window had, so it reads as the plan's successor.
        if (this.split && this.focusOnArrival === run.projectSlug && (run.profile ?? 'CODE') === 'CODE') {
          this.focusOnArrival = null;
          this.split.focus = run.id;
        }
      }
      if (this.split) {
        this.requestBacklogFor(run.id);
      }
    }
    for (const meta of this.sessions.values()) {
      if (!meta.ended && !live.has(meta.id)) {
        meta.ended = true;
        void this.readView(meta, 5);
      }
    }
    if (this.split && !this.windows().some((meta) => meta.id === this.split.focus)) {
      this.split.focus = this.windows()[0]?.id ?? null;
    }
  }

  /**
   * The platform's view of a session — its card, its kind, how it ended, its
   * pull request. Needs a person's session; without one a window says what the
   * daemon knows and no more.
   *
   * @param retries how many times to read again while the platform still says
   *   the run is live: the daemon drops a run a moment before its last
   *   transition lands, and an ended window saying "running" offers nothing.
   */
  async readView(meta, retries = 0) {
    if (!this.session.signedIn) return;
    try {
      meta.view = await this.session.request(`/api/projects/${meta.projectSlug}/runs/${meta.id}`);
      this.dirty = true;
      await this.countCommits(meta);
      this.sayWhyItFailed(meta);
      if (meta.ended && meta.view?.live && retries > 0) {
        const again = setTimeout(() => void this.readView(meta, retries - 1), 2000);
        again.unref?.();
      }
    } catch {
      // A window with the daemon's title is still a window.
    }
  }

  /**
   * A session that ended FAILED says why, in its own window — once. The
   * reason is the run's summary on the platform (a refusal before anything
   * was spawned — Codex on a machine that has not allowed everything — never
   * reaches the daemon's live transcript), and a window reading "failed" and
   * nothing else sent people to the console to find out what to do.
   */
  sayWhyItFailed(meta) {
    const view = meta.view;
    const failed = view?.state === 'FAILED';
    // A dev session that finished having built nothing says why too — its
    // summary is where the session explained stopping (R24: "the plan is
    // incomplete"), and the window otherwise read as work done.
    if (!meta.ended || meta.failureSaid || !(failed || builtNothing(meta)) || !view.exitSummary) return;
    meta.failureSaid = true;
    const kept = this.lines.get(meta.id) ?? [];
    const said = kept.some((line) => line.body === view.exitSummary.split('\n')[0]);
    if (said) return;
    const lines = String(view.exitSummary).split('\n').map((body) => ({ kind: 'ERROR', body }));
    this.lines.set(meta.id, [...kept, { kind: 'ERROR', body: failed ? 'failed:' : 'nothing built:' }, ...lines]);
    this.dirty = true;
  }

  /**
   * How many commits a finished dev session made — read once it has finished,
   * so `builtNothing` can tell "finished" from "finished having built nothing".
   * A read that fails leaves it unknown, and unknown claims nothing: the
   * window reads "finished" as it always did.
   *
   * A ZERO is not believed at once. The runner's last reading of the commits
   * lands AFTER the run is FINISHED — the agent ends its own run, and the
   * runner pushes, opens the pull request and only then reports — so the
   * first read of a run that committed twice and pushed can answer none. That
   * zero, cached, told a Codex session with two commits on origin that
   * "nothing was committed". A zero is read again `COMMIT_REREADS` times,
   * `commitRereadMs` apart, and claimed only if it is still a zero after that.
   */
  async countCommits(meta, rereads = COMMIT_REREADS) {
    const view = meta.view;
    if (!meta.ended || meta.commits !== undefined || view?.state !== 'FINISHED'
        || (view.profile ?? 'CODE') !== 'CODE') return;
    if (rereads === COMMIT_REREADS && meta.countingCommits) return;
    meta.countingCommits = true;
    let count;
    try {
      const commits = await this.session.request(
        `/api/projects/${meta.projectSlug}/runs/${meta.id}/commits`);
      count = Array.isArray(commits) ? commits.length : undefined;
    } catch {
      // Unknown: nothing claimed.
    }
    if (count === 0 && rereads > 0) {
      const again = setTimeout(async () => {
        await this.countCommits(meta, rereads - 1);
        this.sayWhyItFailed(meta);
      }, this.options.commitRereadMs ?? 5_000);
      again.unref?.();
      return;
    }
    meta.countingCommits = false;
    meta.commits = count;
    this.dirty = true;
  }

  /**
   * Which session a question or a request in the prompt comes from, by the
   * number its window carries (the position in the run list outside
   * advanced mode) — see split.mjs's `sessionTag`.
   */
  tagOf(run) {
    if (!run) return '';
    const meta = this.sessions.get(run.id) ?? run;
    const n = this.split
      ? this.windows().findIndex((each) => each.id === run.id) + 1
      : this.runs.findIndex((each) => each.id === run.id) + 1;
    return sessionTag(n, meta);
  }

  /** The sessions that get a window: every one seen, less those closed. */
  windows() {
    const only = this.split?.projects;
    return [...this.sessions.values()].filter((meta) => !this.closed.has(meta.id)
      && (!only || only.has(meta.projectSlug)));
  }

  /** The projects this machine serves that cawdev still has — see `gone`. */
  servedProjects() {
    return (this.runner?.projects ?? []).filter((slug) => !this.gone.has(slug));
  }

  /** The projects on screen: advanced mode's pick, else every one served here. */
  shownProjects() {
    const served = this.servedProjects();
    return this.split?.projects ? served.filter((slug) => this.split.projects.has(slug)) : served;
  }

  /** The session a command like /pr is about: the focused window, else the one watched. */
  commandTarget() {
    if (this.split) {
      return this.sessions.get(this.split.focus) ?? null;
    }
    return this.sessions.get(this.watching)
      ?? [...this.sessions.values()].reverse().find((meta) => meta.ended) ?? null;
  }

  /** The backlog of any live session, once — a window needs its history too. */
  requestBacklogFor(runId) {
    if (!runId || this.asked.has(runId) || !this.connected
        || !this.runs.some((run) => run.id === runId)) {
      return;
    }
    this.asked.add(runId);
    try {
      this.client.write(`${JSON.stringify({ type: 'backlog', runId })}\n`);
    } catch {
      this.asked.delete(runId);
    }
  }

  /**
   * `/advanced-mode` on a machine serving several projects: which of them to
   * show, ticked in a picker (all ticked to start with, so enter alone keeps
   * today's behaviour). One project served: nothing to ask. `/projects` asks
   * again from inside the mode.
   */
  async askSplitProjects() {
    if (this.plain) return this.note('advanced mode needs a terminal it can draw on');
    // Read first, so a project deleted in the console is not offered — and
    // say so AFTER the mode is entered, or the sentence lands on the normal
    // screen the alternate one is about to cover.
    await this.refreshPlanned({ hold: true });
    const served = this.servedProjects();
    if (served.length <= 1) {
      const entered = this.split ? this.note('this machine serves one project') : this.enterSplit(served);
      this.sayGone();
      return entered;
    }
    this.sayGone();
    const current = this.split?.projects ? [...this.split.projects] : served;
    return this.openPicker(new Select({
      kind: 'split-projects',
      title: 'which projects should advanced mode show?',
      rows: served.map((slug) => ({ id: slug, label: slug })),
      many: true,
      picked: current,
      // On what is shown now, so space alone takes it off.
      at: Math.max(0, served.findIndex((slug) => current.includes(slug))),
    }));
  }

  /**
   * Never a prompt to a session of a project advanced mode is not showing: a
   * watched session KNOWN to be in a hidden project hands over to the focused
   * window. One not known yet (a reload, before the daemon has said hello) is
   * left alone — it may well be in a project that is shown.
   */
  leaveHiddenWatch() {
    const watched = this.sessions.get(this.watching);
    const only = this.split?.projects;
    if (watched && only && !only.has(watched.projectSlug) && this.split.focus) {
      this.watching = this.split.focus;
    }
  }

  /** Advanced mode, narrowed to `slugs` — its windows, its roadmap, its `/new`. */
  focusProjects(slugs) {
    if (!this.split) return this.enterSplit(slugs);
    this.split.projects = new Set(slugs);
    if (!this.windows().some((meta) => meta.id === this.split.focus)) {
      this.split.focus = this.windows()[0]?.id ?? null;
    }
    this.leaveHiddenWatch();
    this.say(this.ink.muted(`showing ${slugs.join(', ')} — /projects changes it`));
    this.dirty = true;
    return undefined;
  }

  enterSplit(projects = null) {
    if (this.split) return this.note('already in advanced mode — /advanced-mode off to leave');
    if (this.plain) return this.note('advanced mode needs a terminal it can draw on');
    const shown = projects?.length ? new Set(projects) : null;
    // The footer comes down first, so the normal screen is left as a clean
    // scrollback for when this mode is left.
    this.screen.update(this.pending, []);
    this.pending = [];
    const screen = new SplitScreen(this.options.out ?? process.stdout);
    this.split = {
      screen,
      // The projects this mode shows; null is every one this machine serves.
      projects: shown,
      focus: null,
      messages: [],
      enteredWatching: this.watching,
      mark: new Map([...this.lines].map(([id, lines]) => [id, lines.length])),
    };
    const watched = this.windows().find((meta) => meta.id === this.watching);
    this.split.focus = watched?.id ?? this.windows()[0]?.id ?? null;
    this.leaveHiddenWatch();
    screen.enter();
    for (const meta of this.windows()) {
      this.requestBacklogFor(meta.id);
    }
    void this.refreshPlanned();
    this.split.plannedTimer = setInterval(() => void this.refreshPlanned(), 30_000);
    this.split.plannedTimer.unref?.();
    this.say(this.ink.muted('advanced mode — tab moves between windows · /new starts a session'
      + ' · /projects picks what is shown · /advanced-mode leaves'));
    if (shown) {
      this.say(this.ink.muted(`showing ${[...shown].join(', ')}`));
    }
    this.dirty = true;
    return undefined;
  }

  /**
   * Back to the scrollback, which is as it was left. What the watched session
   * said meanwhile is laid into it now — or, if the focus moved, that
   * session's history, which is what switching sessions has always done.
   */
  leaveSplit() {
    if (!this.split) return this.note('advanced mode is not on — /advanced-mode starts it');
    const { screen, enteredWatching, mark, plannedTimer } = this.split;
    clearInterval(plannedTimer);
    this.split = null;
    screen.leave();
    const watched = this.watching;
    const lines = this.lines.get(watched) ?? [];
    if (watched && watched === enteredWatching) {
      for (const line of lines.slice(mark.get(watched) ?? lines.length)) {
        this.say(this.render(line));
      }
    } else if (watched) {
      this.printed.delete(watched);
      this.layHistoryIn(watched, lines);
    }
    this.note('back to the scrollback');
    return undefined;
  }

  /** The window the prompt talks to. A live one becomes the session watched. */
  focusWindow(id) {
    this.split.focus = id;
    this.split.recent = [id, ...(this.split.recent ?? []).filter((each) => each !== id)];
    if (this.runs.some((run) => run.id === id)) {
      this.watching = id;
    }
    this.note('');
  }

  cycleFocus(step) {
    const windows = this.windows();
    if (!windows.length) return this.note('no session windows yet — /new starts one');
    const at = windows.findIndex((meta) => meta.id === this.split.focus);
    return this.focusWindow(windows[(at + step + windows.length) % windows.length].id);
  }

  /** The whole alternate screen, as rows — see split.mjs. */
  splitFrame() {
    const { width, height } = this.split.screen;
    const ink = this.ink;
    if (this.reader) {
      return composeFrame(width, height, [{ rect: { top: 0, left: 0, width, height }, lines: this.readerScreen(width, height) }]);
    }
    const windows = this.windows();
    const inner = Math.max(8, width - 2);

    const overlay = this.overlayLines(inner);
    const current = this.current();
    const pending = this.pendingOn(current);
    const banner = this.select && this.select.kind !== 'runs' ? [] : pending
      ? permissionBanner(pending, inner, ink, this.runner ?? {})
      : questionBanner(this.askingOn(current), inner, ink, { entire: true });
    // Which window a command or a prompt will act on, before it is sent.
    const target = this.windowNumberOf(this.split.focus);
    const tag = target ? ink.bold(ink.accent(`[${target}] `)) : '';
    const input = this.mode === 'typing'
      ? `${tag}${this.input.label} ${this.input.line.render(
        Math.max(8, inner - visibleWidth(tag) - visibleWidth(this.input.label) - 1), ink)}`
      : tag + ink.muted(`enter prompts ${current ? `“${current.label}”` : 'the focused session'}`
        + ' · / commands · tab next window');
    // A question or a request on screen says which window it came from.
    const from = banner.length ? [ink.bold(ink.warn(` from ${this.tagOf(current)}`))] : [];
    // Under the banner and right above the line, so a long one never pushes
    // it out of the window: the way to read all of it, and the other door.
    // Also while its list is open, which hides the banner.
    const whole = banner.length || this.waitingOn(this.commandTarget())
      ? [ink.muted(' /view reads it all · /open answers it on cawdev')] : [];
    // The commands matching what is typed, above the line as in the footer —
    // advanced mode drew none, so enter took a highlighted command nobody saw.
    const matches = this.mode === 'typing' && this.input?.showing !== false ? this.matching() : { rows: [], at: 0 };
    // Six rows at most, scrolled to the highlighted one: a bare `/` matches
    // every command, and the prompt grows with what it holds.
    const first = Math.max(0, Math.min(matches.at - 2, matches.rows.length - SPLIT_COMPLETIONS));
    const completing = completionLines(
      matches.rows.slice(first, first + SPLIT_COMPLETIONS), matches.at - first, inner, ink,
    );
    const fixed = [...from, ...banner, ...whole, ...overlay, ...completing, input];
    const promptRows = Math.max(PROMPT_ROWS, fixed.length + 5);
    // The roadmap across the top: as tall as its fullest column needs, never
    // more than a third of the screen, and never so tall that no window fits
    // under it — a short terminal drops it before it drops the sessions.
    const stripRoom = Math.min(Math.max(4, Math.floor(height / 3)), height - promptRows - MIN_ZONE_HEIGHT);
    // A rule under it, from the strip's own room: the roadmap is the board and
    // the windows are the sessions, and without it the strip's last card line
    // ran straight into the first window's border.
    const stripLines = stripRoom >= 4
      ? [...roadmapStrip(width, stripRoom - 1, this.cards, ink, this.shownProjects()),
        ink.muted('─'.repeat(width))]
      : [];
    const strip = stripLines.length <= Math.max(0, stripRoom) ? stripLines.length : 0;
    // Four windows at most; the rest are named on one line above the prompt,
    // and Tab onto one of them brings it up in place of the least recent.
    const shown = visibleSessions(windows, this.split.recent ?? [], this.split.focus);
    const hidden = windows.filter((meta) => !shown.includes(meta));
    const tabs = hidden.length ? 1 : 0;
    const layout = splitLayout(width, height - strip - tabs, shown.length, promptRows);
    for (const rect of layout.zones) {
      rect.top += strip;
    }
    layout.prompt.top += strip + tabs;

    const pieces = layout.zones.map((rect, i) => {
      const meta = shown[i];
      const n = windows.indexOf(meta) + 1;
      const asking = this.askingOn(this.runs.find((run) => run.id === meta.id));
      const waiting = this.pendingOn(this.runs.find((run) => run.id === meta.id))
        ? 'waiting for permission'
        : asking ? 'waiting for an answer' : null;
      const lines = (this.lines.get(meta.id) ?? []).map((line) => this.render(line));
      const body = lines.length ? lines : [ink.muted(meta.state === 'queued'
        ? `  waiting — ${meta.why ?? 'no reason recorded'}`
        : meta.ended ? '  nothing was said on this session here' : '  nothing said yet')];
      return {
        rect,
        lines: windowLines(rect, {
          title: `${n} ${titleFor(meta, waiting)}`,
          // The agent and its model first, bold and underlined — which CLI and
          // which model is what somebody comparing two windows looks for.
          subtitle: (() => {
            const who = agentModelFor(meta);
            const lead = who ? `${ink.strong(who)} ` : '';
            return lead + ink.muted(subtitleFor(meta, rect.width - 4 - (who ? who.length + 1 : 0)));
          })(),
          body,
          footer: actionsFor(meta),
          focused: meta.id === this.split.focus,
          dotted: meta.id !== this.split.focus,
          tone: toneFor(meta),
        }, ink),
      };
    });

    if (tabs) {
      pieces.push({
        rect: { top: layout.prompt.top - 1, left: 0, width, height: 1 },
        lines: [tabsLine(hidden.map((meta) => ({ n: windows.indexOf(meta) + 1, meta })), width, ink)],
      });
    }
    const unseen = layout.hidden ? ` · ${layout.hidden} more not shown` : '';
    // A question's lines leave with the question — see `sayAbout`.
    const open = this.stillOpen();
    this.split.messages = this.split.messages
      .filter((line) => typeof line === 'string' || open.has(line.about));
    const messages = this.split.messages.flatMap((line) => {
      if (typeof line === 'string') return [line];
      if (line.body === undefined) return [line.text];
      return wordWrap(line.body, inner - 2 - line.prefix.length).map((part) => `${line.prefix}${line.paint(part)}`);
    });
    const promptTitle = `cawdev ▸ ${this.runner?.name ?? 'runner'}`
      + `${this.session.email ? ` · ${this.session.email}` : ' · not signed in'}`
      + `${this.agent ? ` · ${this.agent}` : ''}${unseen}`;
    pieces.push({
      rect: layout.prompt,
      lines: windowLines(layout.prompt, {
        title: promptTitle,
        // The input line sits on the bottom row, the way a prompt does:
        // messages fill from above it, and blank rows pad a short log.
        body: [
          ...new Array(Math.max(0, layout.prompt.height - 3 - messages.length - fixed.length))
            .fill(''),
          ...messages,
          ...fixed,
        ],
        footer: this.status
          ? ink.warn(`${this.statusWindow ? `[${this.statusWindow}] ` : ''}${this.status}`)
          : keyList(this.keys(), '', inner, ink),
      }, ink),
    });
    if (strip) {
      pieces.push({
        rect: { top: 0, left: 0, width, height: strip },
        lines: stripLines,
      });
    }
    return composeFrame(width, height, pieces);
  }

  /**
   * Every card AND ISSUE of every project this machine serves, whatever its
   * status — the strip draws them all, and `d` offers the PLANNED cards and
   * the CONFIRMED issues. Two requests per project, the two boards' own
   * (`brief`, so no bodies). Needs a person's
   * session, like everything read off the roadmap here.
   *
   * A project that cannot be read keeps ITS last cards and no other's: this
   * used to give up on the first failure and keep the whole last list, so one
   * served slug the session could not reach left every column at 0 — a strip
   * saying "nothing considered" about a board full of ideas, and saying it
   * silently. What failed is returned so `/refresh` can say it.
   */
  async refreshPlanned({ hold = false } = {}) {
    if (!this.session.signedIn) return { signedIn: false, read: [], failed: [] };
    const read = [];
    const failed = [];
    const all = [];
    for (const slug of this.runner?.projects ?? []) {
      try {
        const cards = await this.session.request(`/api/projects/${slug}/roadmap?brief=true`);
        for (const card of Array.isArray(cards) ? cards : []) {
          all.push({ ref: card.ref, title: card.title, slug, status: card.status, live: Boolean(card.activeRun) });
        }
        // The issues are another list on the platform (R85), and were never
        // read here: the strip drew a project's ideas and not one of its bugs.
        const issues = await this.session.request(`/api/projects/${slug}/issues?brief=true`);
        for (const issue of Array.isArray(issues) ? issues : []) {
          all.push({
            ref: issue.ref, title: issue.title, slug, status: issue.status,
            live: Boolean(issue.activeRun), severity: issue.severity ?? 'MINOR',
          });
        }
        read.push(slug);
        this.gone.delete(slug);
      } catch (failure) {
        if (failure?.status === 404) {
          this.forgetGone(slug);
          continue;
        }
        failed.push({ slug, message: failure?.message ?? String(failure) });
        all.push(...this.cards.filter((card) => card.slug === slug));
      }
    }
    this.cards = all;
    // Ready to be developed: a planned card, or a confirmed issue.
    this.planned = all.filter((card) => columnOf(card.status) === 'PLANNED');
    this.dirty = true;
    if (!hold) this.sayGone();
    return { signedIn: true, read, failed };
  }

  /** A served project cawdev answered 404 for: hidden, and said once. */
  forgetGone(slug) {
    if (this.gone.has(slug)) return;
    this.gone.add(slug);
    this.goneUnsaid.push(slug);
  }

  /** What `forgetGone` learnt, said where it will be read. */
  sayGone() {
    for (const slug of this.goneUnsaid.splice(0)) {
      this.say(this.ink.warn(`  this machine serves ${slug}, but cawdev has no such project for you any more`
        + ' — deleted, or your access went. It is hidden here;'
        + ` c → Stop serving ${slug} takes it off this machine.`));
    }
  }

  /**
   * `/refresh`: the cards and their statuses read again now, rather than on
   * the strip's thirty-second timer — somebody who just moved a card in the
   * console should not have to wait for the terminal to believe it. Says what
   * it read per project shown, and which could not be read and why.
   */
  async refreshCards() {
    if (!this.requireSignIn('read the roadmap')) return;
    const { read, failed } = await this.refreshPlanned();
    const shown = new Set(this.shownProjects());
    const counts = read.filter((slug) => shown.has(slug)).map((slug) => {
      const mine = this.cards.filter((card) => card.slug === slug);
      const tally = BOARD_COLUMNS
        .map(([status, label]) => `${mine.filter((card) => columnOf(card.status) === status).length} ${label.toLowerCase()}`)
        .join(' · ');
      return `${slug}: ${tally}`;
    });
    for (const { slug, message } of failed) {
      this.say(this.ink.danger(`  could not read the roadmap of ${slug}: ${message}`));
    }
    if (!read.length && !failed.length) {
      return this.note('refreshed — this machine serves no project yet');
    }
    this.note(failed.length && !counts.length
      ? `refresh failed for ${failed.map((each) => each.slug).join(', ')}`
      : `refreshed — ${counts.join('; ')}${failed.length ? ` (${failed.length} could not be read)` : ''}`);
  }

  /**
   * `d`, or `/new dev` with nothing after it: the planned cards — and the
   * confirmed issues — as a list, and the one picked is developed — `/new dev R3 @slug`, on this machine.
   */
  async pickPlanned(slug = null) {
    if (!this.requireSignIn('start a session')) return;
    await this.refreshPlanned();
    const cards = this.planned.filter((card) => !slug || card.slug === slug);
    if (!cards.length) {
      this.note(slug ? `nothing planned in ${slug}` : 'nothing planned — /new dev <the task in words> starts one anyway');
      return;
    }
    const several = new Set(cards.map((card) => card.slug)).size > 1;
    this.openPicker(new Select({
      kind: 'planned',
      title: 'develop which planned card?',
      rows: cards.map((card) => ({
        id: `${card.slug} ${card.ref}`,
        label: `${card.ref} ${card.title}`,
        ...(several ? { hint: card.slug } : {}),
      })),
    }));
  }

  /** `/new plan|dev R3` · `/new plan|dev <the task in words>` · `/new ask …` — on this machine. */
  async startNew(words) {
    if (!this.requireSignIn('start a session')) return;
    // Advanced mode narrowed to ONE project: that is the project. Asking would
    // be asking somebody to repeat the choice they made on entering — this is
    // not the guess the question exists to prevent (a machine serving one
    // project, or the focused window), it is a choice already stated.
    const shown = this.split?.projects ? this.shownProjects() : [];
    if (shown.length === 1 && !words.some((word) => word.startsWith('@'))) {
      words = [...words, `@${shown[0]}`];
    }
    const bare = words.filter((word) => word && !word.startsWith('@') && word !== '--anyway' && word !== '--again');
    if (bare.length === 1 && ['dev', 'code'].includes(bare[0].toLowerCase())) {
      const named = words.find((word) => word.startsWith('@'));
      await this.pickPlanned(named ? named.slice(1) : null);
      return;
    }
    const anyway = words.includes('--anyway');
    // R369: the answer to "a session already finished here" — `--anyway`'s
    // shape, for a different question.
    const again = words.includes('--again');
    // `--codex`, `--claude`, `--agy`: this session's agent, over `/agent`'s.
    const flagged = words.find((word) => AGENT_FLAGS.has(word));
    let agent = flagged ? flagged.slice(2) : this.agent;
    const parsed = parseNew(words.filter((word) => word !== '--anyway' && word !== '--again' && !AGENT_FLAGS.has(word)), {
      // In advanced mode, among the projects it shows.
      projects: this.shownProjects(),
    });
    if (parsed.needsProject) {
      // Several projects here and nothing says which: ASK, from the list of
      // what this machine serves, and run the same command again with the
      // one picked. A sentence telling somebody to retype it with @slug is a
      // question the terminal could have asked itself.
      this.openPicker(new Select({
        kind: 'project',
        title: `which project is this ${words.find((word) => !word.startsWith('@')) ?? 'session'} for?`,
        rows: parsed.projects.map((slug) => ({ id: slug, label: slug })),
      }));
      this.newWaitingForProject = words;
      return;
    }
    if (parsed.error) {
      this.note(parsed.error);
      return;
    }
    if (parsed.kind === 'dev' && !parsed.ref) {
      // A dev from words writes its CARD first, then develops it exactly as
      // `/new dev R12` would. It used to be a manual session on a `task-…`
      // branch with no card: no number, nothing on the development board,
      // and a prompt that never said "commit" — so the work ended
      // uncommitted and `/pr` had nothing to propose.
      await this.developNewCard(parsed.slug, parsed.text, anyway, agent);
      return;
    }
    // Developing a card whose finished plan has a window here: the agent that
    // planned it develops it unless one was named on the line — it has read
    // the code once already, and swapping CLIs between the two halves of one
    // card was a choice nobody made — and the plan's window gives way to the
    // development's once it has started.
    const plan = parsed.kind === 'dev' && parsed.ref ? this.planWindowFor(parsed.slug, parsed.ref) : null;
    const planAgent = plan ? plan.agent ?? plan.view?.agent ?? null : null;
    if (!flagged && planAgent) {
      agent = planAgent;
    }
    const [path, body, what] = parsed.kind === 'ask'
      ? ['runs/ask', { prompt: parsed.text }, 'a question']
      : parsed.kind === 'plan'
        ? parsed.ref
          ? ['runs/plan', { entryNumber: parsed.ref }, `a plan of ${parsed.ref}`]
          // R150: the session writes the card first, then plans it.
          : ['runs/plan', { prompt: parsed.text }, 'a plan — it writes its card first']
        : ['runs', { entryNumber: parsed.ref }, `the development of ${parsed.ref}`];
    const started = await this.startSession(parsed.slug, path, withAgent(body, agent), withWho(what, agent), anyway, again);
    if (started && plan) {
      this.closeWindowOf(plan);
      this.focusOnArrival = plan.projectSlug;
    }
  }

  /** A FINISHED plan on a card, ended here — what `d` and `/develop` develop. */
  finishedPlan(meta) {
    return Boolean(meta?.ended && meta.view?.state === 'FINISHED'
      && meta.view.profile === 'PLAN' && meta.view.entryRef);
  }

  /** The open window of a finished plan of `ref` in `slug`, if there is one. */
  planWindowFor(slug, ref) {
    return [...this.sessions.values()].reverse().find((meta) => !this.closed.has(meta.id)
      && meta.projectSlug === slug && this.finishedPlan(meta)
      && meta.view.entryRef.toLowerCase() === String(ref).toLowerCase()) ?? null;
  }

  /**
   * `/agent` — which CLI `/new` asks for when a command names none. Kept
   * across launches (prefs.mjs). `default` goes back to the project's own
   * choice. A `--codex` on one `/new` still wins over it.
   */
  async chooseAgent(name) {
    if (!name) {
      return this.note(this.agent
        ? `/new uses ${this.agent} — /agent default goes back to the project's choice`
        : "/new uses the project's default agent — /agent claude|codex|agy picks one here");
    }
    const wanted = name.toLowerCase();
    if (['default', 'auto', 'none', 'project'].includes(wanted)) {
      this.agent = null;
      await savePrefs(this.session.url, { agent: null }).catch(() => undefined);
      this.dirty = true;
      return this.note("/new uses the project's default agent again");
    }
    if (!KNOWN_AGENTS.includes(wanted)) {
      return this.note(`no agent called ${name} — ${KNOWN_AGENTS.join(', ')}`);
    }
    this.agent = wanted;
    await savePrefs(this.session.url, { agent: wanted }).catch(() => undefined);
    this.dirty = true;
    // Said, not refused: the platform may send the run to another machine,
    // and this one can be told to spawn it (`c` → Enable) in a second.
    const here = (this.runner?.agents ?? []).map((command) => agentOfCommand(command));
    return this.note(this.runner?.agents && !here.includes(wanted)
      ? `/new uses ${wanted} — but this machine does not spawn it: c → Enable ${wanted}`
      : `/new uses ${wanted}`);
  }

  /**
   * `/card <the idea in words>` — a card in CONSIDERING, and nothing else: no
   * session, no branch, nothing spent. The roadmap's first column is where an
   * idea waits to be decided on, and writing one down should not need a model
   * to do it. The project is chosen as `/new` chooses it: `@slug`, else
   * advanced mode narrowed to one, else asked — never guessed.
   */
  async addCard(words) {
    if (!this.requireSignIn('write a card')) return;
    const named = words.find((word) => word.startsWith('@'))?.slice(1) ?? null;
    const text = wordsText(words.filter((word) => word && !word.startsWith('@')));
    if (!text) {
      this.note('/card what? — /card <the idea in words> (@project)');
      return;
    }
    const served = this.servedProjects();
    const shown = this.shownProjects();
    const slug = named ?? (this.split?.projects && shown.length === 1 ? shown[0] : null);
    if (named && !served.includes(named)) {
      this.note(`this machine does not serve ${named} — ${served.join(', ') || 'no project'}`);
      return;
    }
    if (!slug) {
      if (!shown.length) {
        this.note('this machine serves no project to write a card in');
        return;
      }
      this.openPicker(new Select({
        kind: 'card-project',
        title: 'which project is this card for?',
        rows: shown.map((each) => ({ id: each, label: each })),
      }));
      this.cardWaitingForProject = words;
      return;
    }
    let card;
    try {
      card = await this.session.request(`/api/projects/${slug}/roadmap`, {
        method: 'POST',
        body: { title: cardTitleFor(text), body: text, status: 'CONSIDERING' },
      });
    } catch (failure) {
      this.note(`could not write the card: ${failure.message}`);
      return;
    }
    const ref = card?.ref ?? (card?.number ? `R${card.number}` : 'the card');
    this.say(this.ink.success(`  wrote ${ref} ${card?.title ?? cardTitleFor(text)} in Considering on ${slug}`));
    this.note('');
    void this.refreshPlanned();
  }

  /**
   * `/new dev <the task in words>`: the card, then its development. Two
   * requests, and the first is said on its own line — a card that was written
   * but whose run was refused (a usage window, say) is still on the board,
   * and the person should know which half happened.
   */
  async developNewCard(slug, text, anyway, agent = this.agent) {
    let card;
    try {
      card = await this.session.request(`/api/projects/${slug}/roadmap`, {
        method: 'POST',
        body: { title: cardTitleFor(text), body: text },
      });
    } catch (failure) {
      this.note(`could not write the card: ${failure.message}`);
      return;
    }
    const ref = card?.ref ?? (card?.number ? `R${card.number}` : null);
    if (!ref) {
      this.note('the card was written but the platform did not say its number — start it from the board');
      return;
    }
    this.say(this.ink.success(`  wrote ${ref} ${card.title ?? ''} on ${slug}`));
    await this.startSession(slug, 'runs', withAgent({ entryNumber: ref }, agent),
      withWho(`the development of ${ref}`, agent), anyway);
    void this.refreshPlanned();
  }

  /**
   * The sessions that stopped before this terminal saw them and can be picked
   * back up HERE — a failed run holding its checkout on this machine above
   * all. The daemon forgets a run as it ends, so after a restart nothing on
   * this side knew it existed and only the console could carry it on. Each
   * gets a window like any session that ended while watched, and the window
   * offers `/carry-on`.
   *
   * The first page of each served project's runs, which carries every run not
   * over plus the fifty newest that are — a failed run older than that is on
   * the console's Sessions page, and a terminal that paged through a
   * project's whole history on every attach would be slow for everybody to
   * find one that rarely exists. Once per attach and once per sign-in.
   */
  async findStopped() {
    if (!this.session.signedIn || !this.runner?.id) return;
    const found = [];
    for (const slug of this.runner.projects ?? []) {
      const page = await this.session.request(`/api/projects/${slug}/runs?limit=50`)
        .catch(() => []);
      for (const view of Array.isArray(page) ? page : []) {
        if (this.sessions.has(view.id) || this.closed.has(view.id)
            || this.runs.some((run) => run.id === view.id)
            || !carriesOnHere(view, this.runner.id, this.session.email)) {
          continue;
        }
        const meta = {
          id: view.id, projectSlug: slug, label: view.label, profile: view.profile,
          state: view.state, ended: true, view, prAsked: null,
        };
        this.sessions.set(view.id, meta);
        // Its window has no transcript to show — the daemon never streamed it
        // to this terminal — so it opens on why it stopped.
        if (!this.lines.has(view.id)) {
          const why = view.exitSummary ?? view.failureReason ?? `${String(view.state).toLowerCase()}`;
          // `seed`: it stands for a transcript this terminal never had, and
          // leaves when the session comes back (`trackSessions`) — above live
          // output it reads as the session failing again.
          this.lines.set(view.id, [{ kind: 'ERROR', body: `stopped: ${why}`, seed: true }]);
        }
        found.push(meta);
      }
    }
    if (!found.length) return;
    this.say(this.ink.warn(`  ${found.length} session(s) stopped here and can be carried on:`));
    for (const meta of found) {
      this.say(`    ${meta.projectSlug} · ${String(meta.state).toLowerCase()} · ${meta.label ?? meta.id}`);
    }
    this.say(this.ink.muted(this.split
      ? '  focus its window and type /continue'
      : '  /continue picks up the latest — /advanced-mode gives each one a window'));
    this.dirty = true;
  }

  /**
   * `/carry-on` — the console's Carry on, for the focused (or last ended)
   * session, on THIS machine: a failed run's checkout is here, and it resumes
   * where its work is or nowhere. The platform re-queues the same run; its
   * window comes back to life when the daemon claims it.
   */
  async carryOn() {
    if (!this.requireSignIn('carry a session on')) return;
    const meta = this.commandTarget();
    const view = meta?.view;
    if (!meta || !view) {
      this.note('/continue needs a session that stopped — focus its window');
      return;
    }
    if (!meta.ended) {
      this.note(`${view.label ?? 'that session'} is still going — say something to it instead`);
      return;
    }
    if (!view.canCarryOn) {
      this.note(`that session is ${String(view.state ?? 'over').toLowerCase()} and cannot be carried on`);
      return;
    }
    if (!this.runner?.id) {
      this.note('this machine has not said which runner it is yet — try again in a moment');
      return;
    }
    try {
      meta.view = await this.session.request(
        `/api/projects/${meta.projectSlug}/runs/${meta.id}/carry-on`,
        { method: 'POST', body: { runnerId: this.runner.id } });
      meta.carryAsked = true;
      this.say(this.ink.success(`  carrying on ${view.label ?? meta.id} — its window comes back when this machine takes it`));
      this.note('');
    } catch (failure) {
      this.note(failure.message);
    }
  }

  /**
   * `/develop` — start the development of a card on this machine: the card a
   * finished plan was about (the focused session's), or the one named —
   * `/develop R30`, `@slug` for its project. It is `/new dev R30` said from a
   * plan's window, and it goes THROUGH `startNew` so the agent is chosen the
   * same way: `--codex`/`--claude`/`--agy`, else `/agent`'s. It used to ignore
   * every word after it, so `/develop R30 --codex` started the focused plan's
   * card with the runner's default agent — Claude — and said nothing.
   * Words that are none of those (`starts`, from the window's own hint) are
   * passed over.
   */
  async develop(words = []) {
    if (!this.requireSignIn('start a session')) return;
    const flags = words.filter((word) => word.startsWith('--'));
    const named = words.find((word) => word.startsWith('@'));
    const typed = words.find((word) => /^r?\d+$/i.test(word));
    if (typed) {
      const ref = typed.replace(/^r/i, 'R').replace(/^(\d)/, 'R$1');
      const slug = named?.slice(1) ?? this.commandTarget()?.projectSlug;
      await this.startNew(['dev', ref, ...(slug ? [`@${slug}`] : []), ...flags]);
      return;
    }
    const meta = this.commandTarget();
    const ref = meta?.view?.entryRef;
    if (!meta || !ref) {
      this.note('/develop needs a session on a card — focus a finished plan, or name one: /develop R30');
      return;
    }
    if (!meta.ended) {
      this.note(`${ref} is still being worked on — wait for it to end`);
      return;
    }
    await this.startNew(['dev', ref, `@${meta.projectSlug}`, ...flags]);
  }

  /**
   * One POST that starts a session, aimed at THIS machine so its window opens
   * here. A usage window over the machine's threshold is refused by the
   * platform in a sentence; `--anyway` is the same decision the console's
   * panel asks for. A card whose last session of that kind finished asks too
   * (R369), and `--again` answers it.
   */
  async startSession(slug, path, body, what, anyway, again = false) {
    try {
      await this.session.request(`/api/projects/${slug}/${path}`, {
        method: 'POST',
        body: {
          ...body,
          ...(this.runner?.id ? { targetRunnerId: this.runner.id } : {}),
          ...(anyway ? { acknowledgeUsage: true } : {}),
          ...(again ? { again: true } : {}),
        },
      });
      this.say(this.ink.success(`  started ${what} on ${slug} — its window opens when this machine takes it`));
      this.note('');
      return true;
    } catch (failure) {
      // R369's sentence is checked first: it is the one that names a session,
      // and the usage test is loose enough to match words in other sentences.
      this.note(/session that finished/.test(failure.message)
        ? `${failure.message} — add --again to start it regardless`
        : /usage|window/i.test(failure.message)
          ? `${failure.message} — add --anyway to start it regardless`
          : failure.message);
      return false;
    }
  }

  /**
   * `/pr` — the pull request of a finished session's branch. The machine pushes and runs `gh`, so the answer comes
   * back later: the window says it was asked for, and shows the URL when the
   * run carries one.
   */
  async openPullRequest() {
    if (!this.requireSignIn('open a pull request')) return;
    const meta = this.commandTarget();
    const view = meta?.view;
    if (!meta || !view?.branch) {
      this.note('/pr needs a session that wrote a branch — focus one');
      return;
    }
    if (!meta.ended) {
      this.note(`${view.branch} is still being written — wait for the session to end`);
      return;
    }
    if (isPullRequest(view.prUrl)) {
      this.note(`${view.branch} already has one: ${view.prUrl}`);
      return;
    }
    try {
      // Through the RUN: a card's run goes to its work item on the platform,
      // and a session started from a sentence — which has none — is proposed
      // from the run itself.
      const asked = await this.session.request(
        `/api/projects/${meta.projectSlug}/runs/${meta.id}/pull-request`, { method: 'POST' });
      meta.prAsked = true;
      this.say(this.ink.success(`  asked this machine to open the pull request for ${view.branch}`));
      this.note('');
      // The answer is the REQUEST the machine was handed, and its result is
      // the URL or the reason there is none. A platform older than that
      // answers with the run, and only the run's prUrl can be watched.
      void (asked?.id && asked?.runnerId && asked?.kind === 'OPEN_PR'
        ? this.followPullRequest(meta, asked, 60)
        : this.awaitPullRequest(meta, 60));
    } catch (failure) {
      this.note(failure.message);
    }
  }

  /**
   * Reads the machine's answer to `/pr` until there is one: the URL, which
   * the daemon checked the host for before saying so — or why not, in the
   * daemon's words (gh missing or signed out, a push refused). Before this the
   * terminal watched the run's prUrl, which a failure never writes, and said
   * "pull request asked for…" for as long as the window was open.
   */
  async followPullRequest(meta, request, tries) {
    const read = await this.session.request(
      `/api/runners/${request.runnerId}/workspace-requests/${request.id}`).catch(() => null);
    const state = read?.state;
    if (state === 'DONE') {
      const url = String(read.result ?? '').split('\n')[0].trim();
      if (isPullRequest(url)) {
        meta.prAsked = null;
        meta.view = { ...(meta.view ?? {}), prUrl: url };
        this.dirty = true;
        this.say(this.ink.success(`  pull request: ${url}`));
        return;
      }
    }
    if (state === 'FAILED' || state === 'DONE') {
      const why = String(read.result ?? 'the machine did not say why').trim();
      meta.prAsked = `no pull request — ${why.split('\n')[0]}`;
      this.dirty = true;
      this.say(this.ink.danger(`  no pull request for ${meta.view?.branch ?? 'this branch'}:`));
      for (const line of why.split('\n')) this.say(this.ink.danger(`    ${line}`));
      return;
    }
    if (tries <= 0) {
      meta.prAsked = 'no answer from the machine yet — is its daemon running?';
      this.dirty = true;
      return;
    }
    const again = setTimeout(() => void this.followPullRequest(meta, request, tries - 1), 2000);
    again.unref?.();
  }

  /** Reads the run until its pull request shows, or gives up and says so. */
  async awaitPullRequest(meta, tries) {
    await this.readView(meta);
    if (isPullRequest(meta.view?.prUrl)) {
      meta.prAsked = null;
      this.say(this.ink.success(`  pull request: ${meta.view.prUrl}`));
      return;
    }
    if (tries <= 0) {
      meta.prAsked = 'no pull request yet — the board says why';
      this.dirty = true;
      return;
    }
    const again = setTimeout(() => void this.awaitPullRequest(meta, tries - 1), 3000);
    again.unref?.();
  }

  /**
   * `/open` — the session's pull request, in the browser. A finished plan has
   * none: what it produced is the card's plan of record, so `/open` there is
   * the card on cawdev, opened on its plan (`?show=plan`).
   */
  async openInBrowser() {
    const meta = this.commandTarget();
    if (!meta) {
      return this.note('/open needs a session — focus one');
    }
    if (this.waitingOn(meta)) {
      // Stopped on a question or a permission: the run page on cawdev, where
      // the question panel and the decision are, whole.
      const url = this.consoleUrl(meta.projectSlug ?? meta.view?.projectSlug, `runs/${meta.id}`);
      if (!url) {
        return this.note('cannot tell where this session is on cawdev');
      }
      this.openLink(url);
      return this.note(`opened ${url}`);
    }
    if (this.finishedPlan(meta)) {
      const ref = meta.view.entryRef;
      const board = /^i/i.test(ref) ? 'issues' : 'roadmap';
      const url = this.consoleUrl(meta.projectSlug ?? meta.view?.projectSlug, `${board}/${ref}?show=plan`);
      if (!url) {
        return this.note('cannot tell where this card is on cawdev');
      }
      this.openLink(url);
      return this.note(`opened ${url}`);
    }
    // Read again, not the view taken when the session ended: the runner opens
    // the pull request and records its link AFTER the run is FINISHED, so the
    // copy read at that moment had none — and /open said "no pull request"
    // about a branch with one open on GitHub.
    await this.readView(meta);
    let url = meta.view?.prUrl;
    // A staged run's pull request can be the card's, through its work item
    // (i168) — the branch's, whichever run opened it.
    const ref = meta.view?.entryRef;
    if (!isPullRequest(url) && ref && this.session.signedIn) {
      const card = await this.session.request(`/api/projects/${meta.projectSlug}/roadmap/${ref}`)
        .catch(() => null);
      url = card?.workItem?.prUrl ?? card?.review?.prUrl ?? url;
    }
    if (!isPullRequest(url)) {
      return this.note('no pull request on this session yet — /pr opens one');
    }
    this.openLink(url);
    return this.note(`opened ${url}`);
  }

  /** A link, in this machine's browser. */
  openLink(url) {
    const opener = this.options.openUrl ?? ((link) => {
      const command = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      spawn(command, [link], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
    });
    opener(url);
  }

  /** What a session is stopped on — a question or a permission request — or null. */
  waitingOn(meta) {
    const run = meta ? this.runs.find((each) => each.id === meta.id) : null;
    if (!run) return null;
    const pending = this.pendingOn(run);
    if (pending) return { kind: 'permission', pending };
    const asking = this.askingOn(run);
    return asking ? { kind: 'question', asking } : null;
  }

  /**
   * `/view` on a session waiting for you: what it is waiting on, in FULL. In
   * advanced mode the reader — the session's output and the request under
   * it, over the whole screen, scrolled with the arrows (the wheel arrives as
   * arrows there), PgUp/PgDn, g/G; esc closes it, and any other key closes it
   * and does what it does (`a` answers, `y`/`n` decide). In the scrollback
   * the request is printed whole, where the terminal scrolls it.
   */
  openReader() {
    const meta = this.commandTarget();
    if (!this.split) {
      this.say('');
      for (const line of this.requestLines(this.waitingOn(meta), this.screen.width)) this.say(line);
      this.say('');
      return this.note('');
    }
    this.reader = { runId: meta.id, top: null, room: 1, max: 0 };
    this.dirty = true;
    return this.note('');
  }

  /** The request a session waits on, every word of it. */
  requestLines(waiting, width) {
    const ink = this.ink;
    if (!waiting) {
      return [ink.muted('  no longer waiting — answered, decided, or gone')];
    }
    const room = Math.max(20, width - 4);
    if (waiting.kind === 'question') {
      const { question, yours, waitingOn } = waiting.asking;
      return [
        ink.bold(ink.accent(' question ')),
        ...String(question.question ?? '').split('\n').flatMap((part) => wordWrap(part, room)).map((line) => `  ${line}`),
        ...(question.options?.length
          ? ['', ...question.options.map((option, i) => `  ${ink.success(String(i + 1))} ${option}`)]
          : []),
        '',
        yours
          ? `  ${ink.success('a')} ${ink.muted('answers it here · /open answers it on cawdev')}`
          : ink.muted(`  waiting on ${waitingOn ?? 'somebody else'} — theirs to answer`),
      ];
    }
    const approval = waiting.pending.approval ?? waiting.pending;
    return [
      `${ink.bold(ink.warn(' permission '))} ${ink.muted(`${approval.toolName ?? ''} · waiting since ${approval.askedAt?.slice(11, 19) ?? ''}`)}`,
      ...String(approval.summary ?? '').split('\n').flatMap((part) => wordWrap(part, room)).map((line) => `  ${line}`),
      ...(approval.toolInput && approval.toolInput !== approval.summary
        ? ['', ink.muted('  input'), ...String(approval.toolInput).split('\n').map((line) => `  ${ink.text(line)}`)]
        : []),
      '',
      ...permissionBanner(waiting.pending, width, ink, this.runner ?? {}).slice(2),
    ];
  }

  /** The reader, drawn over the whole screen — see `readerFrame` in split.mjs. */
  readerScreen(width, height) {
    const ink = this.ink;
    const meta = this.windows().find((each) => each.id === this.reader.runId)
      ?? this.sessions.get(this.reader.runId) ?? { id: this.reader.runId };
    const output = (this.lines.get(this.reader.runId) ?? []).map((line) => this.render(line));
    const waiting = this.waitingOn(meta);
    const request = this.requestLines(waiting, width - 2);
    const n = this.windowNumberOf(meta.id);
    const keys = waiting?.kind === 'permission'
      ? 'y once · s session · n refuse'
      : waiting?.asking?.yours ? 'a answer' : '';
    const drawn = readerFrame(width, height, {
      title: `${n ? `${n} ` : ''}${titleFor(meta, waiting ? `waiting for ${waiting.kind === 'question' ? 'an answer' : 'permission'}` : null)}`,
      lines: [...output, ink.muted('─'.repeat(Math.min(40, width - 2))), ...request],
      requestAt: output.length,
      top: this.reader.top,
      footer: keyList(['↑↓ scroll', 'PgUp/PgDn page', 'g/G top/end', 'esc close',
        ...(keys ? [keys] : []), '/open on cawdev'], '', width - 2, ink),
    }, ink);
    Object.assign(this.reader, { top: drawn.top, max: drawn.max, room: drawn.room });
    return drawn.lines;
  }

  /** Keys while the reader is open. */
  onReaderKey(key) {
    const reader = this.reader;
    const move = (to) => {
      reader.top = Math.min(Math.max(0, to), reader.max);
      this.dirty = true;
      return undefined;
    };
    const at = reader.top ?? 0;
    switch (key) {
      case `${ESC}[A`: case `${ESC}OA`: case 'k':
        return move(at - 1);
      case `${ESC}[B`: case `${ESC}OB`: case 'j':
        return move(at + 1);
      case `${ESC}[5~`: case 'b':
        return move(at - reader.room);
      case `${ESC}[6~`: case ' ':
        return move(at + reader.room);
      case `${ESC}[H`: case `${ESC}[1~`: case 'g':
        return move(0);
      case `${ESC}[F`: case `${ESC}[4~`: case 'G':
        return move(reader.max);
      case ESC: case 'q':
        this.reader = null;
        this.dirty = true;
        return this.note('');
      default:
        // Anything else is what it always is — `a` answers, `y`/`n` decide,
        // `/` a command — with the reader closed first.
        this.reader = null;
        this.dirty = true;
        return this.onKey(key);
    }
  }

  /**
   * `/view` alone — the focused session's page on cawdev (its transcript,
   * stages, card and checkout). On the console this terminal signed in to:
   * the sign-in URL is the console's, where the daemon's may be the API
   * behind it.
   */
  viewOnCawdev() {
    const meta = this.commandTarget();
    if (!meta) {
      return this.note('/view needs a session — focus one, or name a card: /view R29');
    }
    const url = this.consoleUrl(meta.projectSlug ?? meta.view?.projectSlug, `runs/${meta.id}`);
    if (!url) {
      return this.note('cannot tell where this session is on cawdev');
    }
    this.openLink(url);
    return this.note(`opened ${url}`);
  }

  /** A page of a project on the console this terminal signed in to, or null. */
  consoleUrl(slug, path) {
    const base = String(this.session.url ?? '').replace(/\/+$/, '');
    return base && slug ? `${base}/projects/${slug}/${path}` : null;
  }

  /**
   * `/view R29` · `/view i12` · `/view <words of its title>` · `/view card`
   * — a card printed here, rather than a browser opened on it: somebody at
   * this terminal wants to read what a card says without leaving it. `card`
   * is the focused session's own. `@slug` names the project; otherwise every
   * project on screen is looked in, and a ref or words matching cards in
   * several are offered as a list rather than guessed between.
   */
  async viewCard(words) {
    if (!this.requireSignIn('read a card')) return;
    const named = words.filter((word) => word.startsWith('@')).map((word) => word.slice(1));
    const bare = words.filter((word) => word && !word.startsWith('@'));
    if (bare.length === 1 && bare[0].toLowerCase() === 'card') {
      const meta = this.commandTarget();
      const ref = meta?.view?.entryRef;
      if (!ref) {
        return this.note(meta ? 'this session has no card — /view R29 names one' : '/view card needs a session — focus one');
      }
      return this.showCard(meta.projectSlug, ref);
    }
    const projects = named.length ? named
      : this.shownProjects().length ? this.shownProjects() : this.servedProjects();
    if (!projects.length) {
      return this.note('no project here to look in — name one: /view R29 @slug');
    }
    const asRef = bare.length === 1 && /^[ri]?\d+$/i.test(bare[0]) ? refOf(bare[0]) : null;
    let found;
    if (asRef) {
      const reads = await Promise.all(projects.map((slug) => this.session
        .request(`/api/projects/${slug}/roadmap/${asRef}`)
        .then((card) => (card ? { slug, ref: card.ref ?? asRef, title: card.title } : null))
        .catch(() => null)));
      found = reads.filter(Boolean);
      if (!found.length) {
        return this.note(`no ${asRef} in ${projects.join(', ')}`);
      }
    } else {
      const wanted = bare.map((word) => word.toLowerCase());
      if (!wanted.length) {
        return this.note('/view which card? /view R29, or words of its title');
      }
      await this.refreshPlanned();
      found = this.cards.filter((card) => projects.includes(card.slug)
        && wanted.every((word) => String(card.title ?? '').toLowerCase().includes(word)));
      if (!found.length) {
        return this.note(`no card titled like "${bare.join(' ')}" in ${projects.join(', ')}`);
      }
    }
    if (found.length === 1) {
      return this.showCard(found[0].slug, found[0].ref);
    }
    const several = new Set(found.map((card) => card.slug)).size > 1;
    this.openPicker(new Select({
      kind: 'view-card',
      title: 'view which card?',
      rows: found.map((card) => ({
        id: `${card.slug} ${card.ref}`,
        label: `${card.ref} ${card.title ?? ''}`.trim(),
        ...(several ? { hint: card.slug } : {}),
      })),
    }));
    return undefined;
  }

  /** One card, read fresh off the platform and printed into the transcript. */
  async showCard(slug, ref) {
    let card;
    try {
      card = await this.session.request(`/api/projects/${slug}/roadmap/${ref}`);
    } catch (failure) {
      return this.note(`could not read ${ref} on ${slug}: ${failure.message}`);
    }
    if (!card) {
      return this.note(`no ${ref} on ${slug}`);
    }
    const url = this.consoleUrl(slug, `roadmap/${card.ref ?? ref}`);
    this.say('');
    for (const line of cardLines(card, this.ink, url)) this.say(line);
    this.say('');
    return this.note(`${card.ref ?? ref} on ${slug}`);
  }

  /** ↑ with no line open: the most recent entry, on the line it belongs to. */
  recallIntoALine() {
    const last = this.history.entries.at(-1);
    if (last === undefined) {
      return this.note('nothing typed yet to go back to');
    }
    const command = last.startsWith('/');
    // The line first — opening one resets the history — then one step back,
    // so the next ↑ goes further rather than to the same entry again.
    this.type(command ? 'command' : 'prompt', command ? 'cawdev ▸' : 'prompt ▸', '');
    this.input.line.set(this.history.back(''));
    this.input.recalling = true;
    this.input.showing = false;
    this.dirty = true;
    return undefined;
  }

  /**
   * `/drop` — delete the checkout a finished session was cloned into.
   *
   * Only a checkout the daemon made on demand (`-auto-<n>`), so the project
   * always keeps the ones in the config. Refused while anything is in it: a
   * run on it, a run that failed and holds it (R80), uncommitted files, or a
   * commit origin does not have — deleting any of those is deleting work. It
   * asks first, naming the path. The daemon owns the list of checkouts and the
   * socket cannot change anything (R52), so the directory is removed here and
   * the daemon is sent SIGHUP, which makes it look again (auto-workspaces.mjs).
   */
  async dropCheckout() {
    const meta = this.commandTarget();
    const path = meta?.view?.workspace;
    if (!meta || !isAutoCheckout(path)) {
      return this.note('/drop deletes a checkout made on demand (…-auto-N) — this session was not in one');
    }
    if (meta.dropped) {
      return this.note(`${path} is already deleted`);
    }
    if (!meta.ended || this.runs.some((run) => run.workspace === path)) {
      return this.note(`a session is working in ${path} — wait for it to end`);
    }
    if (meta.view?.holdsACheckout) {
      return this.note(`the run keeps ${path} for its unfinished work — carry it on or discard it first`);
    }
    const unsafe = await (this.options.checkoutState ?? checkoutState)(path);
    if (unsafe) {
      return this.note(`not deleting ${path}: ${unsafe}`);
    }
    const noPr = isPullRequest(meta.view?.prUrl) ? '' : ' (no pull request yet — the branch is on origin)';
    this.dropping = { meta, path };
    this.openPicker(new Select({
      kind: 'drop',
      title: `delete ${path}?${noPr}`,
      rows: [
        { id: 'delete', label: `Delete ${path}` },
        { id: 'keep', label: 'Keep it' },
      ],
    }));
    return undefined;
  }

  /** The choice `/drop` asked for. */
  async droppedCheckout(row) {
    const { meta, path } = this.dropping ?? {};
    this.dropping = null;
    if (!meta || row.id !== 'delete') {
      return this.note('kept');
    }
    try {
      await (this.options.removeDir ?? ((dir) => rm(dir, { recursive: true, force: true })))(path);
    } catch (failure) {
      return this.note(`could not delete ${path}: ${failure.message}`);
    }
    meta.dropped = true;
    if (this.runner?.pid) {
      (this.options.signalDaemon ?? ((pid) => {
        try {
          process.kill(pid, 'SIGHUP');
        } catch {
          // Gone; the next one will not find the checkout either.
        }
      }))(this.runner.pid);
    }
    this.say(this.ink.success(`  deleted ${path}`));
    return this.note('');
  }

  /** `/close` — an ended session's window goes; a live one's stays. */
  closeWindow() {
    const meta = this.commandTarget();
    if (!meta) return this.note('no window to close');
    if (!meta.ended) return this.note('that session is still running — /cancel stops it');
    this.closeWindowOf(meta);
    return this.note('closed');
  }

  /** An ended session's window goes; focus moves to the first one left. */
  closeWindowOf(meta) {
    this.closed.add(meta.id);
    if (this.split && (this.split.focus === meta.id || !this.sessions.has(this.split.focus))) {
      this.split.focus = this.windows()[0]?.id ?? null;
    }
    this.dirty = true;
  }

  // --- the things a person can do ---------------------------------------------

  async send(text) {
    const run = this.current();
    if (!run) return;
    try {
      await this.session.request(
        `/api/projects/${run.projectSlug}/runs/${run.id}/prompts`,
        { method: 'POST', body: { prompt: text } },
      );
      this.note('sent');
    } catch (failure) {
      this.note(failure.message);
    }
  }

  /**
   * Answering the question this session stopped on — R58.
   *
   * The guard was already applied when `a` was pressed; this repeats nothing,
   * because a second copy of the rule here is a second place for it to drift.
   * If the API refuses anyway — the question was handed on while this was being
   * typed — its message names who it is waiting on, which is the right thing to
   * put on the status line.
   */
  async answer(text) {
    const run = this.current();
    const asking = this.askingOn(run);
    if (!asking) {
      return this.note('nothing is waiting for an answer on this one');
    }
    try {
      await this.session.request(
        `/api/projects/${run.projectSlug}/runs/${run.id}`
          + `/questions/${asking.question.id}/answer`,
        { method: 'POST', body: { answer: text } },
      );
      this.questions.delete(run.id);
      this.answering = null;
      this.note('answered');
    } catch (failure) {
      this.note(failure.message);
    }
    return undefined;
  }

  /**
   * Allowing it, for how long — R60's three, from a key (R78).
   *
   * The scope travels with the decision rather than as a second call, the same
   * way the console sends it: "allow this and stop asking" is one act, and
   * splitting it gives you a client that can half-succeed.
   */
  async allow(key) {
    const pending = this.pendingOn(this.current());
    if (!pending) {
      return this.note('nothing is waiting for permission on this one');
    }
    const decision = permissionDecision(pending.approval, key, this.runner ?? {});
    if (!decision) {
      // Two ways to get here and they need different sentences. `Y` or `M` on a
      // compound command: no rule can be written and a decision with nothing to
      // remember would silently be an allow-once. `M` on a machine that does
      // not accept console rules: the rule could be written and would not be
      // applied, which is worth saying out loud rather than as "no rule".
      if (key === 'M' && pending.approval.suggestion) {
        return this.note('this machine does not take rules from the console — add '
          + '"acceptsRulesFromConsole": true to its config');
      }
      return this.note(
        'no standing rule can be written for that one — s allows it for this session');
    }
    return this.decide(decision, decision.scope === 'PROJECT'
      ? `allowed, and ${pending.approval.suggestion} is now a project rule`
      : decision.scope === 'RUNNER'
        ? `allowed, and ${decision.pattern} is now allowed on this machine`
        : decision.scope === 'SESSION'
          ? `allowed ${decision.pattern} for the rest of this run`
          : 'allowed, once');
  }

  /**
   * R51's decision, with R60's three reaches.
   *
   * `scope` rather than `remember`: the useful answer was the missing one —
   * somebody unblocking a session at 2am wants neither "ask me again in ninety
   * seconds" nor "decide policy for every agent that ever runs here".
   */
  async decide(decision, said) {
    const run = this.current();
    const pending = this.pendingOn(run);
    if (!pending) {
      return this.note('nothing is waiting for permission on this one');
    }
    if (!this.requireSignIn('answer a permission request')) {
      return undefined;
    }
    try {
      await this.session.request(
        `/api/projects/${pending.projectSlug}/runs/${pending.runId}` +
          `/approvals/${pending.approval.id}/decision`,
        { method: 'POST', body: decision },
      );
      // Settled, and remembered as settled: the inbox answers as soon as
      // anything is pending, so its next reply may well have been built before
      // this POST landed — and without this it would raise the banner again
      // over a request this terminal has just decided (R137).
      this.settled.add(pending.approval.id);
      this.approvals.delete(run.id);
      this.deciding = null;
      this.note(said);
    } catch (failure) {
      this.note(failure.message);
    }
    return undefined;
  }

  async cancel() {
    const run = this.current();
    if (!run || run.state === 'queued') {
      return this.note('nothing running here to cancel');
    }
    if (!this.requireSignIn('cancel a session')) {
      return undefined;
    }
    if (this.confirming !== run.id) {
      // Two keys, because there is no undo and the transcript of a session you
      // killed by leaning on the keyboard is not much comfort.
      this.confirming = run.id;
      return this.note(`press x again to cancel "${run.label}"`);
    }
    this.confirming = null;
    try {
      await this.session.request(
        `/api/projects/${run.projectSlug}/runs/${run.id}/transition`,
        { method: 'POST', body: { state: 'CANCELLED', summary: 'Cancelled from the terminal.' } },
      );
      this.note('cancelling — the daemon will take the process down');
    } catch (failure) {
      this.note(failure.message);
    }
    return undefined;
  }

  /**
   * Leaving, and taking the daemon with it — R123.
   *
   * <p>It used to leave one running. The argument was that `cawdev` starts a
   * daemon when it finds none, and a background process you did not know you
   * started should be paid for out loud rather than silently — so the goodbye
   * named the runner and the `kill` that stopped it.
   *
   * <p>That is the right sentence for the wrong default. Somebody who typed one
   * word to look at their machine has one window and one mental model, and what
   * they are told on the way out is a chore: a process still claiming work,
   * still holding a checkout, and a command to copy. Two windows later there
   * are two daemons and the one that answers is whichever started first.
   *
   * <p>So quitting stops it, both ways in: `--attach` always did, and now the
   * detached daemon gets a SIGINT — its own shutdown, which says goodbye to the
   * platform and takes its children down, rather than a kill that leaves the
   * platform believing this machine is still there. `--leave-running` is the
   * old behaviour for anybody who wants it, and the goodbye still names the
   * runner either way.
   *
   * <p>It asks twice while work is live, which is the one thing that has not
   * changed: the sessions go with it.
   */
  quit() {
    const stopping = this.stopsTheDaemon();
    const live = this.liveHere();
    if (stopping && live > 0 && !this.confirmQuit) {
      this.confirmQuit = true;
      return this.note(
        `${live} session${live === 1 ? '' : 's'} running here — press q again to stop the daemon too`,
      );
    }

    this.stopped = true;
    // Off the alternate screen before anything is printed, or the goodbye
    // lands on a buffer that vanishes the moment the program exits.
    if (this.split) {
      clearInterval(this.split.plannedTimer);
      this.split.screen.release();
      this.split = null;
    }
    try {
      this.client?.destroy();
    } catch {
      // Going anyway.
    }
    // Anything queued is still somebody's transcript. It goes out before the
    // footer comes down, not after it.
    if (this.pending.length) {
      this.screen.update(this.pending, []);
      this.pending = [];
    }
    this.screen.close();
    if (!this.plain && process.stdin.isTTY) {
      // Bracketed paste is the terminal's mode, not ours, and leaving it on
      // would put `ESC[200~` into the shell somebody pastes into next.
      process.stdout.write(`${ESC}[?2004l`);
    }
    process.stdin.setRawMode?.(false);

    if (!this.options.onQuit) {
      for (const line of this.goodbye(stopping)) {
        console.log(line);
      }
    }
    this.finish?.();

    if (this.options.onQuit) {
      // Hand back to the daemon's own shutdown: say goodbye to the platform,
      // take the children down, then exit. Exiting here would skip all three.
      return this.options.onQuit();
    }
    if (stopping) {
      // SIGINT rather than SIGKILL, and the daemon's own handler does the rest:
      // it says goodbye to the platform, so the console does not show a machine
      // that is still there, and takes its children down with it.
      this.stopDaemon(this.runner.pid);
    }
    return process.exit(0);
  }

  /**
   * `/reload` — quitting and starting again, in one word, for when the client's
   * own code changed on disk.
   *
   * The same argv is run again in a fresh process, which is the only way a
   * module already loaded is read again; this one hands it the terminal and
   * waits, and leaves with its exit code. The daemon goes too — `q`'s SIGINT,
   * then waiting for it to be gone — when nothing is running here, so the
   * relaunch starts a daemon on the new code as well. When sessions are live
   * it is kept, and said: restarting it would end them, and a reload is not a
   * reason to lose somebody's work. `--attach` is refused: there the daemon IS
   * this process.
   */
  async reload() {
    if (this.options.onQuit) {
      return this.note('here the runner is this process (runner.mjs --attach) — quit and start it again');
    }
    const live = this.liveHere();
    const pid = this.runner?.pid ?? null;
    const restartDaemon = Boolean(pid) && live === 0;
    // Taken before anything is torn down: leaving advanced mode below would
    // otherwise be what gets saved.
    const state = this.reloadState();

    this.stopped = true;
    if (this.split) {
      clearInterval(this.split.plannedTimer);
      this.split.screen.release();
      this.split = null;
    }
    try {
      this.client?.destroy();
    } catch {
      // Going anyway.
    }
    if (this.pending.length) {
      this.screen.update(this.pending, []);
      this.pending = [];
    }
    this.screen.close();
    if (!this.plain && process.stdin.isTTY) {
      process.stdout.write(`${ESC}[?2004l`);
    }
    process.stdin.setRawMode?.(false);
    process.stdin.removeAllListeners('data');
    process.stdin.pause();

    if (restartDaemon) {
      this.stopDaemon(pid);
      const alive = this.options.alive ?? ((each) => {
        try {
          process.kill(each, 0);
          return true;
        } catch {
          return false;
        }
      });
      for (let waited = 0; waited < 100 && alive(pid); waited++) {
        await new Promise((done) => setTimeout(done, 100));
      }
      console.log(`\n  ${this.ink.muted('reloading — the runner and this terminal, on the code on disk')}\n`);
    } else {
      console.log(`\n  ${this.ink.muted(live
        ? `reloading this terminal — the runner keeps running, ${live} session${live === 1 ? ' is' : 's are'}`
          + ' live on it; /reload again once they end to reload it too'
        : 'reloading this terminal')}\n`);
    }

    // `--setup` was a request to walk setup once, not every time.
    const argv = process.argv.slice(1).filter((arg) => arg !== '--setup');
    const relaunch = this.options.relaunch ?? ((args, env) => {
      const child = spawn(process.execPath, [...process.execArgv, ...args],
        { stdio: 'inherit', env: { ...process.env, ...env } });
      child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
      return child;
    });
    relaunch(argv, { [RELOAD_STATE]: JSON.stringify(state) });
    return undefined;
  }

  /**
   * What `/reload` carries across the restart — only what the person arranged,
   * never what the daemon will say again anyway. Ended sessions go with their
   * daemon-side facts, because the daemon forgot them and their windows (and
   * the /develop or /pr on them) would otherwise be gone.
   */
  reloadState() {
    return {
      advanced: Boolean(this.split),
      projects: this.split?.projects ? [...this.split.projects] : null,
      focus: this.split?.focus ?? null,
      watching: this.watching,
      showLog: this.showLog,
      closed: [...this.closed],
      ended: [...this.sessions.values()]
        .filter((meta) => meta.ended && !this.closed.has(meta.id))
        .map(({ id, projectSlug, label, profile, state }) => ({ id, projectSlug, label, profile, state })),
    };
  }

  /** Puts back what `reloadState` saved. Anything missing is simply not restored. */
  restore(state) {
    if (!state || typeof state !== 'object') return;
    for (const meta of Array.isArray(state.ended) ? state.ended : []) {
      if (meta?.id && !this.sessions.has(meta.id)) {
        const restored = { ...meta, ended: true, view: null, prAsked: null };
        this.sessions.set(meta.id, restored);
        void this.readView(restored);
      }
    }
    for (const id of Array.isArray(state.closed) ? state.closed : []) {
      this.closed.add(id);
    }
    if (state.watching) {
      this.watching = state.watching;
    }
    this.showLog = state.showLog === true;
    if (state.advanced && !this.plain) {
      this.enterSplit(Array.isArray(state.projects) ? state.projects : null);
      if (state.focus && this.sessions.has(state.focus)) {
        this.split.focus = state.focus;
      }
    }
  }

  /**
   * Whether leaving here ends the daemon — R123.
   *
   * <p>Three answers and they are all different questions. `--attach` means the
   * daemon is this process. `--leave-running` is somebody saying they want it
   * to outlive the window. Otherwise it is stopped, provided this client knows
   * WHICH process to stop: a daemon too old to send its pid on `hello` cannot
   * be signalled, and inventing one to kill is not a thing to guess at.
   */
  stopsTheDaemon() {
    if (this.options.onQuit) {
      return true;
    }
    if (this.options.leaveRunning) {
      return false;
    }
    return Boolean(this.runner?.pid);
  }

  /** How much would go with it. The daemon's own count where there is one. */
  liveHere() {
    return this.options.liveSessions?.()
      ?? (this.runs ?? []).filter((run) => run.state !== 'queued').length;
  }

  /** Injected so a test can watch for the signal instead of sending one. */
  stopDaemon(pid) {
    if (this.options.stopDaemon) {
      return this.options.stopDaemon(pid);
    }
    try {
      return process.kill(pid, 'SIGINT');
    } catch {
      // Already gone, which is where this was heading.
      return undefined;
    }
  }

  goodbye(stopping = this.stopsTheDaemon()) {
    return farewell(this.runner, this.runs, this.ink, stopping);
  }

  render(line) {
    const kind = line.kind ?? 'SYSTEM';
    const paint = kind === 'ERROR' ? this.ink.danger : kind === 'USER' ? this.ink.accent : null;
    // The body already carries the agent's own colour; ours goes in front and
    // is closed after, so a line that sets a colour and never resets it cannot
    // paint the rest of the terminal.
    return paint ? paint(line.body) : `${line.body}${ESC}[0m`;
  }

  /**
   * The footer, or what stands in for it through a pipe.
   *
   * **A pipe has nothing to pin to**, so the live region stops existing and the
   * fixed answers are PRINTED instead — once, and again only when they change.
   * Repeating them per tick would drown the transcript, and dropping them
   * entirely would make the piped form the one place cawdev refuses to say
   * which platform it is talking to. The keys and the status line are left out
   * there on purpose: neither means anything without a keyboard.
   */
  footer() {
    const width = this.screen.width;
    const run = this.current();
    const pending = this.pendingOn(run);
    const state = {
      runner: this.runner,
      runs: this.runs,
      email: this.session.email,
      expired: this.expired,
      watching: run,
      connected: this.connected,
      // R83's status line is about what this machine is DRIVING, which is not
      // always what you are watching: a queued run prints nothing and has no
      // clock, and the answer to "is anything still going" should not depend on
      // which row you last opened.
      running: run?.state === 'running' || run?.state === 'claiming'
        ? run
        : this.runs.find((each) => each.state === 'running') ?? null,
      // A permission request wins when there is one: it is the narrower thing
      // and the one with three keys behind it. Otherwise a question — and
      // since R58 that banner has two shapes.
      //
      // **Unless its own picker is open**, in which case the banner is the same
      // choice written twice, one row above itself: three keys under a list of
      // the same three. At forty columns that was six rows of footer over a
      // transcript this program exists to show. The picker's title carries the
      // call, and the whole of it was printed above.
      banner: this.select && this.select.kind !== 'runs' ? [] : pending
        ? permissionBanner(pending, width, this.ink, this.runner ?? {})
        : questionBanner(this.askingOn(run), width, this.ink),
    };

    if (this.screen.tty) {
      return footerLines({
        ...state,
        overlay: this.overlayLines(width),
        matches: this.input?.showing === false ? { rows: [], at: 0 } : this.matching(),
        input: this.mode === 'typing' ? {
          label: this.input.label,
          preview: this.input.path?.preview ?? '',
          // The width the line has left, so the caret stays on screen when the
          // text is longer than the terminal — see Line.window.
          text: this.input.line.render(
            Math.max(8, width - visibleWidth(this.input.label) - 3), this.ink,
          ),
        } : null,
        keys: this.keys(),
        status: this.status,
      }, width, this.ink);
    }

    // A pipe: nothing is pinned, so the fixed answers are COMMITTED instead —
    // once, and again only when they change.
    const lines = footerLines(state, width, this.ink);
    const said = stripAnsi(lines.join('\n'));
    if (said !== this.lastSaid) {
      this.lastSaid = said;
      for (const line of lines) {
        this.pending.push(line);
      }
    }
    return [];
  }

  /**
   * What you can press right now, which is not the same list at all times.
   *
   * Ordered by what survives a narrow terminal: {@link keyList} drops from the
   * right, so the two that are always true come first and the ones that depend
   * on what a session is doing come after — those already have a banner above
   * them saying the same thing.
   */
  keys() {
    const ink = this.ink;
    if (this.mode === 'select') {
      // The widget draws its own key row, so this one would be a second copy of
      // it under the first.
      return [];
    }
    const parts = [
      `${ink.text('enter')} ${ink.muted('prompt')}`,
      `${ink.text('/')} ${ink.muted('commands')}`,
      `${ink.text('L')} ${ink.muted('runs')}`,
    ];
    if (this.askingOn(this.current())?.yours) {
      parts.push(`${ink.success('a')} ${ink.muted('answer')}`);
    }
    const pending = this.pendingOn(this.current());
    if (pending) {
      // `Y` is offered only when the server has a rule to write; a key that
      // would be refused is worse than one that is not there.
      parts.push(`${ink.warn(pending.approval?.suggestion ? 'y/s/Y/n' : 'y/s/n')} `
        + `${ink.muted('permission')}`);
    }
    if (this.split) {
      parts.push(`${ink.text('tab')} ${ink.muted('next window')}`);
      parts.push(`${ink.text('d')} ${ink.muted(this.finishedPlan(this.commandTarget())
        ? `develop ${this.commandTarget().view.entryRef}` : 'develop a planned card')}`);
    }
    parts.push(`${ink.text('x')} ${ink.muted('cancel')}`);
    parts.push(`${ink.text('c')} ${ink.muted('config')}`);
    parts.push(`${ink.text('q')} ${ink.muted(this.stopsTheDaemon() ? 'stop' : 'quit')}`);
    return parts;
  }
}

/**
 * What is said on the way out — R81, and a function so it can be read without
 * quitting anything.
 *
 * Two shapes since R123, because there are two ways to leave. Stopping it says
 * what went with it and how to have it not, which is where somebody who wanted
 * the machine left running finds that out. Leaving it running is R81's sentence
 * unchanged — "a background process you did not know you started is the cost of
 * this choice and it should be paid out loud" — so it names the runner, what it
 * is still driving, and the exact command that stops it.
 */
export function farewell(runner, runs, ink = painter(3), stopping = false) {
  const name = runner?.name ?? 'the runner';
  const busy = (runs ?? []).filter((run) => run.state !== 'queued').length;
  if (stopping) {
    // R123. What went with it, and how to have it not: a person who wanted the
    // machine left running finds that out here rather than from a run that is
    // no longer there.
    const took = busy
      ? `stopped, and ${busy} session${busy === 1 ? '' : 's'} with it`
      : 'stopped';
    return [
      '',
      `  ${ink.bold(name)} ${ink.muted(`${took}.`)}`,
      `  ${ink.muted('Leave it running next time with:')}  ${ink.text('cawdev --leave-running')}`,
      '',
    ];
  }
  const doing = busy
    ? `still driving ${busy} session${busy === 1 ? '' : 's'}`
    : 'still claiming work';
  const stop = runner?.pid
    ? `  Stop it with:  ${ink.text(`kill ${runner.pid}`)}`
    : `  Stop it by ending the process serving ${name}.`;
  return [
    '',
    `  ${ink.bold(name)} ${ink.muted(`is ${doing} on this machine, and keeps going.`)}`,
    stop,
    '',
  ];
}
