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

import { connect } from 'node:net';
import { listSockets, socketPathFor } from './control.mjs';
import { clip, keyList, padVisible, painter, stripAnsi, visibleWidth, wrap } from '../lib/ansi.mjs';
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
export function questionBanner(asking, width, ink = painter(3)) {
  if (!asking) return [];

  const options = asking.question.options?.length
    ? ink.muted(` · ${asking.question.options.join(' / ')}`)
    : '';
  // 12 is the label and its spaces: the same arithmetic the permission banner
  // uses, and for the same reason — clip counts visible characters.
  const head = `${ink.bold(ink.accent(' question '))} ${clip(asking.question.question, width - 12)}`;

  if (asking.yours) {
    return [head, ` ${ink.success('a')} answer${options}`];
  }
  // The NAME is the last thing to go, the way the session total is on R62's
  // bar: "waiting on alice@…" is the whole answer to "why is that not moving",
  // and the clause after it is a courtesy. Truncating the sentence instead
  // spends the narrow terminal's last columns on the courtesy and cuts the
  // answer — which is what looking at this at 40 columns showed.
  const who = ` waiting on ${asking.waitingOn ?? 'somebody else'}`;
  const whole = `${who} — theirs to answer, or somebody they hand it to`;
  return [head, ink.muted(clip(whole.length <= width ? whole : who, width))];
}

/**
 * What a key means for a permission request — R51, R60, R78.
 *
 * Pure, and returning null for a key that cannot be honoured, because `Y`
 * cannot always be: `suggestion` is the server's rendering of a rule, and it is
 * absent for a compound command that no pattern can settle. The caller says so
 * rather than sending a decision with nothing to write, which the server would
 * quietly turn into an allow-once.
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
    case 'Y':
      return approval.suggestion
        ? { allow: true, scope: 'PROJECT', pattern: approval.suggestion }
        : null;
    case 'M':
      // R126, the widest of the four: every project that ever runs on this
      // machine. Null — and so not offered — for the two reasons it can be:
      // no pattern to write, as with `Y`, and a machine whose own config does
      // not accept rules from the console. A key that takes an answer the
      // platform then refuses reads as cawdev being broken, which is R58's
      // rule about the `a` key applied to this one.
      return approval.suggestion && machine.acceptsConsoleRules
        ? { allow: true, scope: 'RUNNER', pattern: approval.suggestion }
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

  // R126's key is offered only when this machine accepts rules from the
  // console — the same test `permissionDecision` makes, asked once here so the
  // banner and the key handler cannot disagree about what is on offer.
  const onTheMachine = approval.suggestion && machine.acceptsConsoleRules;

  const long = [
    `${ink.success('y')} allow once`,
    `${ink.success('s')} allow ${covers} this session`,
    ...(approval.suggestion
      ? [`${ink.warn('Y')} always allow ${approval.suggestion} here`]
      : []),
    ...(onTheMachine
      ? [`${ink.warn('M')} always, on this machine`]
      : []),
    `${ink.danger('n')} refuse`,
  ];
  const short = [
    `${ink.success('y')} once`,
    `${ink.success('s')} session`,
    ...(approval.suggestion
      ? [`${ink.warn('Y')} always allow ${approval.suggestion} here`]
      : []),
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

  return [
    `${ink.bold(ink.warn(' permission '))} ${clip(approval.summary, Math.max(8, width - 13))}`,
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
 * what that number bounds, and an ASK, a ROADMAP or an AUDIT takes none.
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
    runner, runs = [], email, watching, connected = true,
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
 *   much work would be lost if you did.
 */
export async function attach(argv, options = {}) {
  const socket = options.socketPath ?? (await chooseSocket(valueOf(argv, '--runner')));
  const session = await openSession(argv);

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

export function urlFrom(argv) {
  return (valueOf(argv, '--url') ?? process.env.CAWDEV_URL ?? 'http://localhost:4200')
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
async function openSession(argv) {
  const url = urlFrom(argv);
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
async function runSignIn(session, ink = painter()) {
  const outcome = await signInThroughBrowser(session, ({ url, code }) => {
    console.log(`  ${ink.muted('If your browser did not open, go to')}`);
    console.log(`      ${ink.accent(url)}`);
    console.log(`  ${ink.muted('and check it is showing')}  ${ink.bold(code)}\n`);
    console.log(`  ${ink.muted('Waiting…')}`);
  });
  if (outcome.signedIn) {
    console.log(`  ${ink.success('Signed in')} as ${ink.bold(outcome.email)}.\n`);
  } else if (outcome.refused) {
    console.log(`  ${ink.danger('Refused')} in the browser.\n`);
  } else {
    console.log(`  ${ink.warn('The code expired.')}\n`);
  }
  return outcome;
}

/** The slash commands, and the one place they are described. */
const COMMANDS = [
  ['/help', 'this list'],
  ['/login', 'sign in through the browser'],
  ['/logout', 'forget the stored session on this machine'],
  ['/runs', 'the run list — the same as L'],
  ['/cancel', 'cancel the session you are watching'],
  ['/log', "the daemon's own log, on or off"],
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
export class Attached {
  /**
   * @param options `out` is where to draw — `process.stdout` in the real thing,
   *   anything with `write` in a test, which is the same seam Scrollback takes
   *   and for the same reason.
   */
  constructor(socketPath, session, options = {}) {
    this.socketPath = socketPath;
    this.session = session;
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
    /** Ctrl+C, armed. See {@link onInterrupt}. */
    this.interrupting = false;
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
      this.dirty = true;
    });

    this.open();
    if (this.session.signedIn) {
      void this.watchInbox();
      void this.watchQuestions();
    }

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
      this.chooseWatched();
    } else if (event.type === 'runs') {
      this.runs = event.runs;
      this.chooseWatched();
    } else if (event.type === 'output') {
      const kept = this.lines.get(event.runId) ?? [];
      kept.push(event.line);
      if (kept.length > 5000) kept.splice(0, kept.length - 5000);
      this.lines.set(event.runId, kept);
      if (event.runId === this.watching && !this.showLog) {
        this.say(this.render(event.line));
      }
    } else if (event.type === 'backlog') {
      this.lines.set(event.runId, event.lines);
      if (event.runId === this.watching && !this.printed.has(event.runId)) {
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
    for (const line of wrap(text, this.screen.width)) {
      this.pending.push(line);
    }
    this.dirty = true;
  }

  /** Everything queued, plus the footer as it is right now, in one write. */
  flush() {
    const lines = this.pending;
    this.pending = [];
    this.dirty = false;
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
    this.dirty = true;
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
        this.approvals = new Map(
          (inbox.approvals ?? []).map((item) => [item.runId, item]),
        );
        this.announce();
        this.dirty = true;
      } catch {
        await new Promise((done) => setTimeout(done, 5000));
      }
    }
  }

  pendingOn(run) {
    return run ? this.approvals.get(run.id) ?? null : null;
  }

  /**
   * What the watched session is asking — R58.
   *
   * The run's own questions rather than the inbox, and that is the point: the
   * inbox is now only what is *yours*, so a question stopping a session on this
   * machine that belongs to a colleague would simply not be there — and the one
   * thing this program exists to answer is "why is that run not moving". Here
   * the answer is a name.
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
        return this.type('reason', 'refuse, because ▸', '');
      }
      case 'x':
        return void this.cancel();
      default:
        if (/^[1-9]$/.test(key)) {
          const at = Number(key) - 1;
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
    const open = this.mode !== 'keys';
    this.mode = 'keys';
    this.select = null;
    this.input = null;
    this.answering = null;
    this.history.reset();
    this.dirty = true;
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
      this.input = null;
      this.history.reset();
      if (back) {
        // Back to the options, still answering them.
        return this.reopen(back);
      }
      this.mode = 'keys';
      this.answering = null;
      return this.note('cancelled');
    }

    if (key === '\r' || key === '\n') {
      // With a completion list open, enter takes the highlighted command —
      // which is what makes guessing a name stop being a step. With none, it
      // sends what was typed.
      if (rows.length && this.input.showing !== false && this.input.kind === 'command') {
        line.set(rows[at][0]);
      }
      return this.submit();
    }

    if (key === '\t') {
      if (rows.length) {
        // As far as they agree, which is what every shell does and nobody has
        // to be taught. One match completes it whole.
        line.set(commonPrefix(rows.map(([name]) => name)));
        this.input.showing = true;
        this.dirty = true;
      }
      return undefined;
    }

    if (key === `${ESC}[A` || key === `${ESC}OA` || key === '\x10') {
      if (rows.length && this.input.showing !== false) {
        this.input.at = (at - 1 + rows.length) % rows.length;
        this.dirty = true;
        return undefined;
      }
      const older = this.history.back(line.text);
      if (older !== null) {
        line.set(older);
        this.dirty = true;
      }
      return undefined;
    }
    if (key === `${ESC}[B` || key === `${ESC}OB` || key === '\x0e') {
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
      return void remembered.then(() => this.runCommand(typed));
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
      // Escape leaves without changing anything, which is the promise the key
      // makes everywhere else.
      return this.note('');
    }
    return this.chose(select, outcome.row);
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
      title: clip(asking.question.question, Math.max(20, this.screen.width - 2)),
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
    const covers = approval.suggestion ?? `every ${approval.toolName}`;
    return this.openPicker(new Select({
      kind: 'permission',
      // The call, on the title, as well as printed in full above: the picker
      // may still be on screen when the transcript under it has moved on.
      title: `${approval.toolName} · ${approval.summary}`,
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
      this.say('');
      this.say(`${ink.bold(ink.warn(' permission '))} ${ink.text(pending.approval.toolName)}`);
      // Not clipped: this is the thing being decided about, and a command cut
      // at the width is a command you have not read.
      this.say(`  ${ink.text(pending.approval.summary)}`);
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
    this.say('');
    this.say(`${ink.bold(ink.accent(' question '))} ${ink.text(asking.question.question)}`);
    // R58: a watcher who does not own the question is told whose it is and is
    // offered nothing. A picker here would take an answer the platform then
    // refuses, which reads as cawdev being broken.
    if (!asking.yours) {
      this.say(`  ${ink.muted(`waiting on ${asking.waitingOn ?? 'somebody else'}`)}`);
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

  // --- slash commands ---------------------------------------------------------

  async runCommand(text) {
    const [word, ...rest] = text.slice(1).split(/\s+/);
    switch (word) {
      case 'help':
        this.say('');
        this.say(this.ink.bold(' commands'));
        for (const [name, what] of COMMANDS) {
          this.say(`   ${this.ink.accent(name.padEnd(9))} ${this.ink.muted(what)}`);
        }
        this.say('');
        this.say(this.ink.bold(' keys'));
        this.say(this.ink.muted('   enter prompt · / command · L runs · 1-9 pick a run'));
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
      case 'cancel':
        return void this.cancel();
      case 'log':
        this.showLog = !this.showLog;
        return this.note(this.showLog ? "printing the daemon's log" : 'printing the session');
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
    // Everything queued goes out first and the footer comes down, so what
    // `runSignIn` prints with `console.log` lands under the transcript rather
    // than through the middle of a live region nothing is going to erase.
    this.say('');
    this.screen.update(this.pending, []);
    this.pending = [];
    const outcome = await runSignIn(this.session, this.ink)
      .catch((failure) => ({ signedIn: false, message: failure.message }));
    if (outcome.message) {
      this.say(this.ink.danger(`  could not sign in: ${outcome.message}`));
    }
    if (this.session.signedIn) {
      void this.watchInbox();
      void this.watchQuestions();
    }
    this.dirty = true;
    return undefined;
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
      this.approvals.delete(run.id);
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
    parts.push(`${ink.text('x')} ${ink.muted('cancel')}`);
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
