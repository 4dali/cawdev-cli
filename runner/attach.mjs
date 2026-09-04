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
// Zero dependencies, so this is ANSI escapes and `setRawMode` rather than a
// curses library.

import { connect } from 'node:net';
import { listSockets, socketPathFor } from './control.mjs';
import { clip, painter, stripAnsi, visibleWidth, wrap } from '../lib/ansi.mjs';
import { oneLine } from './brand.mjs';
import { Scrollback } from './scrollback.mjs';
import { Session, signInThroughBrowser, storedSession } from './sign-in.mjs';
import { clearSession } from './session-store.mjs';

// Re-exported because they were this file's before R81 moved them into the
// shared ANSI helpers, and the tests that pin the arithmetic import them here.
export { clip, stripAnsi, visibleWidth, wrap };

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
 * A pending permission request, drawn — R51 and R60's three answers.
 *
 * **All three keys have to survive any width, and `n` is the one that would
 * go.** Written at its full length this row is ninety characters; clipped to a
 * forty-column terminal it reads `y allow once   s allow for th`, which offers
 * two of the three answers and hides *refuse* — the one somebody reaches for
 * when they do not like what they are looking at. So the wording shortens
 * before anything is dropped, and the standing rule, the widest clause and the
 * least urgent, is what goes first. Found by rendering this at four widths and
 * reading them, which is the only way this kind of thing is ever found.
 */
export function permissionBanner(pending, width, ink = painter(3)) {
  if (!pending) return [];
  const approval = pending.approval;

  const long = ` ${ink.success('y')} allow once   ${ink.success('s')} allow for this session   `
    + `${ink.danger('n')} refuse`;
  const short = ` ${ink.success('y')} once · ${ink.success('s')} session · ${ink.danger('n')} refuse`;
  const always = approval.suggestion
    ? `   ${ink.warn('Y')} always allow ${approval.suggestion}`
    : '';

  const keys = [long + always, long, short + always, short]
    .find((option) => visibleWidth(option) <= width) ?? short;

  return [
    `${ink.bold(ink.warn(' permission '))} ${clip(approval.summary, Math.max(8, width - 13))}`,
    ink.muted(` ${approval.toolName} · waiting since ${approval.askedAt?.slice(11, 19) ?? ''}`),
    keys,
  ];
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
  return pad(clip(line, width), width);
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
 * One chunk of stdin, split into the keystrokes it actually contains — R81.
 *
 * **A `data` event is not a keypress.** It is however many bytes arrived
 * together, and the client used to treat the whole chunk as one key: it
 * compared it against `'\r'`, found `"help\r"`, and appended the lot to the
 * prompt as text. Typing `/help` and pressing enter left `/help` sitting on the
 * line with nothing happening, and the next key landed in it.
 *
 * That was survivable while the client was key-driven and a prompt was a rare
 * mode. R81 makes typing the primary way in, so it is not. It shows up whenever
 * bytes coalesce: a paste, a fast typist, a session over ssh, or anything
 * driving the terminal rather than sitting at it — which is how it was found.
 *
 * An escape sequence is ONE key. `ESC[B` is Down, not three characters, and a
 * bare `ESC` is Escape — so a sequence is taken whole when one is there and the
 * escape stands alone when it is not.
 */
export function keysIn(chunk) {
  const keys = [];
  for (let at = 0; at < chunk.length;) {
    if (chunk[at] === ESC) {
      const sequence = /^\x1b(\[[0-9;?]*[a-zA-Z~]|O[A-Z]|.)?/.exec(chunk.slice(at));
      keys.push(sequence[0]);
      at += sequence[0].length;
      continue;
    }
    keys.push(chunk[at]);
    at += 1;
  }
  return keys;
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
  lines.push(pad(clip(
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
  lines.push(pad(clip(watching
    ? runLine(watching, { chosen: false, marker: ink.muted('▸'), number: ' ' }, width, ink)
    : `  ${ink.muted('▸ nothing being watched — L lists what this machine has')}`,
    width), width));

  // The last row is either what you are typing or what you can press. Never
  // both: a key list under a half-typed prompt is a list of keys that would
  // land in the prompt.
  if (input) {
    lines.push(pad(clip(` ${ink.accent(input.label)} ${input.text}${ink.reverse(' ')}`, width), width));
  } else if (keys.length || status) {
    lines.push(pad(clip(` ${keyList(keys, status, width - 1, ink)}`, width), width));
  }
  return lines;
}

/**
 * The keys, and whatever was just said, in the room there is.
 *
 * **Whole keys are dropped rather than a key being cut in half.** At sixty
 * columns this row ended `x c`, and at forty `y/`, which is not a shorter list
 * — it is a list with a typo at the end of it. The status goes first, because
 * it is a sentence about something that already happened; then keys from the
 * right, where the rarer ones are.
 */
export function keyList(keys, status, width, ink = painter(3)) {
  const parts = Array.isArray(keys) ? [...keys] : [String(keys)];
  const said = status ? `  ${ink.warn(status)}` : '';
  const join = (of, tail) => of.join(ink.muted(' · ')) + (of.length < parts.length ? ink.muted(' …') : '') + tail;

  if (visibleWidth(join(parts, said)) <= width) {
    return join(parts, said);
  }
  const shown = [...parts];
  while (shown.length > 1 && visibleWidth(join(shown, '')) > width) {
    shown.pop();
  }
  return join(shown, '');
}

function pad(text, width) {
  const short = width - visibleWidth(text);
  return short > 0 ? text + ' '.repeat(short) : text;
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

  const ui = new Attached(socket, session, options);
  await ui.start();
}

export function valueOf(argv, flag) {
  const at = argv.indexOf(flag);
  return at === -1 ? null : argv[at + 1];
}

export function urlFrom(argv) {
  return (valueOf(argv, '--url') ?? process.env.CAWDEV_URL ?? 'http://localhost:8091')
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
  ['/quit', 'leave; the runner keeps going'],
];

class Attached {
  constructor(socketPath, session, options = {}) {
    this.socketPath = socketPath;
    this.session = session;
    this.options = options;
    this.ink = painter();
    this.screen = new Scrollback(process.stdout);

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

    this.mode = 'keys';
    this.input = '';
    this.inputKind = null;
    this.status = '';
    this.showLog = false;
    this.listAt = 0;
    this.asked = new Set();
    this.connected = false;
    this.stopped = false;
    this.dirty = false;
    /** Lines waiting to be committed on the next tick. See {@link say}. */
    this.pending = [];
  }

  async start() {
    this.screen.open();
    // Raw mode only where there is a terminal to put in it. Through a pipe
    // there are no keys, the transcript is the whole output, and that is the
    // honest degradation rather than a broken one.
    if (process.stdin.isTTY) {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      // One chunk is however many bytes arrived together, not one keypress.
      // See {@link keysIn} — this line used to be the bug.
      process.stdin.on('data', (chunk) => {
        for (const key of keysIn(chunk.toString('utf8'))) {
          this.onKey(key);
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

  // --- keys ------------------------------------------------------------------

  onKey(key) {
    if (this.mode === 'typing') {
      return this.onTyping(key);
    }
    if (this.mode === 'list') {
      return this.onListKey(key);
    }
    // Any other key means "no". A confirmation that outlives the moment is one
    // somebody answers by accident three keystrokes later.
    if (key !== 'x') {
      this.confirming = null;
    }

    switch (key) {
      case 'q':
      case '\x03': // Ctrl-C
        return this.quit();
      case '\r':
      case '\n':
      case 'i':
        return this.type('prompt', 'prompt ▸', '');
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
        return this.type('answer', 'answer ▸', '');
      }
      case 'y':
        return void this.decide({ allow: true, scope: 'ONCE' });
      case 's':
        return void this.decide({ allow: true, scope: 'SESSION' });
      case 'Y':
        return void this.decide({ allow: true, scope: 'PROJECT' });
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

  type(kind, label, start) {
    if (kind === 'prompt' && !this.requireSignIn('prompt a session')) {
      return undefined;
    }
    this.mode = 'typing';
    this.inputKind = kind;
    this.inputLabel = label;
    this.input = start;
    return this.note('');
  }

  onTyping(key) {
    if (key === '\x03' || key === ESC) {
      this.mode = 'keys';
      this.input = '';
      return this.note('cancelled');
    }
    if (key === '\r' || key === '\n') {
      const text = this.input.trim();
      const was = this.inputKind;
      this.mode = 'keys';
      this.input = '';
      if (!text || text === '/') {
        return this.note('');
      }
      if (was === 'command' || text.startsWith('/')) {
        return void this.runCommand(text);
      }
      if (was === 'prompt') {
        return void this.send(text);
      }
      return was === 'answer'
        ? void this.answer(text)
        : void this.decide({ allow: false, reason: text });
    }
    if (key === '\x7f' || key === '\b') {
      this.input = this.input.slice(0, -1);
      this.dirty = true;
      return undefined;
    }
    // Printable only: an arrow key inside a prompt should not become "[A".
    if (!key.startsWith(ESC)) {
      this.input += key;
      this.dirty = true;
    }
    return undefined;
  }

  // --- the run list, as an overlay ------------------------------------------

  /**
   * `L` — every run this machine is driving, claiming or leaving queued.
   *
   * An overlay rather than a rail, because that is the trade R81 reversed: the
   * rail cost thirty columns on every line of every transcript to answer a
   * question asked a few times an hour.
   */
  openList() {
    this.mode = 'list';
    this.listAt = Math.max(0, this.runs.findIndex((run) => run.id === this.watching));
    return this.note('');
  }

  onListKey(key) {
    if (key === ESC || key === 'q' || key === '\x03') {
      this.mode = 'keys';
      // Escape leaves without changing anything, which is the promise the key
      // makes everywhere else.
      return this.note('');
    }
    if (key === '\r' || key === '\n') {
      const run = this.runs[this.listAt];
      this.mode = 'keys';
      if (run) {
        this.watch(run.id);
      }
      return undefined;
    }
    if (key === `${ESC}[B` || key === 'j' || key === '\t') {
      this.listAt = this.runs.length ? (this.listAt + 1) % this.runs.length : 0;
      this.dirty = true;
      return undefined;
    }
    if (key === `${ESC}[A` || key === 'k') {
      this.listAt = this.runs.length
        ? (this.listAt - 1 + this.runs.length) % this.runs.length
        : 0;
      this.dirty = true;
      return undefined;
    }
    return undefined;
  }

  overlayLines(width) {
    if (this.mode !== 'list') return [];
    const ink = this.ink;
    const lines = [`${ink.muted(' sessions on this machine')}`];
    if (!this.runs.length) {
      lines.push(ink.muted('  nothing running, claiming or queued here'));
    }
    // The window walks with the cursor rather than the list scrolling under it:
    // a machine with twenty runs should still show the one you are on.
    const room = Math.max(3, Math.min(this.runs.length, Math.floor(this.screen.height / 3)));
    const from = Math.max(0, Math.min(this.listAt - Math.floor(room / 2), this.runs.length - room));
    this.runs.slice(from, from + room).forEach((run, offset) => {
      const at = from + offset;
      lines.push(runLine(run, {
        chosen: at === this.listAt,
        // `!` is a decision waiting; `?` is a question. Different marks because
        // they are answered with different keys, and since R58 the second may
        // not even be yours.
        marker: this.approvals.has(run.id)
          ? ink.warn('!')
          : this.questions.has(run.id) ? ink.accent('?') : ' ',
        number: at < 9 ? String(at + 1) : ' ',
      }, width, ink));
    });
    if (this.runs.length > room) {
      lines.push(ink.muted(`  … ${this.runs.length - room} more`));
    }
    lines.push(ink.muted('  ↑↓ move · enter open · esc leave'));
    return lines;
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
        this.say('');
        return this.note('');
      case 'login':
        return this.signIn();
      case 'logout':
        await this.session.signOut();
        await clearSession(this.session.url);
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
      this.note('answered');
    } catch (failure) {
      this.note(failure.message);
    }
    return undefined;
  }

  /**
   * R51's decision, with R60's three reaches.
   *
   * `scope` rather than `remember`: the useful answer was the missing one —
   * somebody unblocking a session at 2am wants neither "ask me again in ninety
   * seconds" nor "decide policy for every agent that ever runs here".
   */
  async decide({ allow, scope, reason }) {
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
        { method: 'POST', body: { allow, scope, reason } },
      );
      this.approvals.delete(run.id);
      this.note(allow
        ? { ONCE: 'allowed, once', SESSION: 'allowed for this session', PROJECT: 'allowed, and remembered' }[scope]
        : 'refused');
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
   * Leaving.
   *
   * **The daemon keeps going, and the goodbye says so.** `cawdev` starts one
   * for you when it finds none, and a background process somebody did not know
   * they started is the price of that convenience — so it is paid out loud,
   * naming the runner and how to stop it. The one exception is `--attach`,
   * where the daemon IS this process and quitting really does take the
   * sessions with it; that one asks twice.
   */
  quit() {
    const live = this.options.liveSessions?.() ?? 0;
    if (this.options.onQuit && live > 0 && !this.confirmQuit) {
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
    process.stdin.setRawMode?.(false);

    if (!this.options.onQuit) {
      for (const line of this.goodbye()) {
        console.log(line);
      }
    }
    this.finish?.();

    if (this.options.onQuit) {
      // Hand back to the daemon's own shutdown: say goodbye to the platform,
      // take the children down, then exit. Exiting here would skip all three.
      return this.options.onQuit();
    }
    return process.exit(0);
  }

  goodbye() {
    return farewell(this.runner, this.runs, this.ink);
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
      // A permission request wins when there is one: it is the narrower thing
      // and the one with three keys behind it. Otherwise a question — and
      // since R58 that banner has two shapes.
      banner: pending
        ? permissionBanner(pending, width, this.ink)
        : questionBanner(this.askingOn(run), width, this.ink),
    };

    if (this.screen.tty) {
      return footerLines({
        ...state,
        overlay: this.overlayLines(width),
        input: this.mode === 'typing' ? { label: this.inputLabel, text: this.input } : null,
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
    if (this.mode === 'list') {
      return [ink.muted('↑↓ move'), ink.muted('enter open'), ink.muted('esc leave')];
    }
    const parts = [
      `${ink.text('enter')} ${ink.muted('prompt')}`,
      `${ink.text('/')} ${ink.muted('commands')}`,
      `${ink.text('L')} ${ink.muted('runs')}`,
    ];
    if (this.askingOn(this.current())?.yours) {
      parts.push(`${ink.success('a')} ${ink.muted('answer')}`);
    }
    if (this.pendingOn(this.current())) {
      parts.push(`${ink.warn('y/s/n')} ${ink.muted('permission')}`);
    }
    parts.push(`${ink.text('x')} ${ink.muted('cancel')}`);
    parts.push(`${ink.text('q')} ${ink.muted(this.options.onQuit ? 'stop' : 'quit')}`);
    return parts;
  }
}

/**
 * What is said on the way out — R81, and a function so it can be read without
 * quitting anything.
 *
 * The entry is explicit about this: quitting does not kill the daemon, and
 * "a background process you did not know you started is the cost of this choice
 * and it should be paid out loud". So the goodbye names the runner, what it is
 * still driving, and the exact command that stops it.
 */
export function farewell(runner, runs, ink = painter(3)) {
  const name = runner?.name ?? 'the runner';
  const busy = (runs ?? []).filter((run) => run.state !== 'queued').length;
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
