// `node runner.mjs attach` — this machine's sessions, in the terminal. R52.
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
// Zero dependencies, so this is ANSI escapes and `setRawMode` rather than a
// curses library. It redraws the whole screen on change rather than diffing:
// at eighty by fifty that is four thousand characters, and a diffing renderer
// is where a terminal UI goes to acquire bugs nobody can reproduce.

import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { listSockets, socketPathFor } from './control.mjs';

// --- talking to the platform as a person ------------------------------------

/**
 * A cookie jar and the CSRF dance, in the smallest form that works.
 *
 * The API uses a session cookie plus a double-submit CSRF cookie, because it
 * was built for a browser. A client that is not a browser has to do by hand
 * what Angular's HttpClient does for free: read `XSRF-TOKEN` and echo it back
 * as `X-XSRF-TOKEN`.
 */
class Session {
  constructor(url) {
    this.url = url.replace(/\/+$/, '');
    this.cookies = new Map();
    this.email = null;
  }

  get signedIn() {
    return this.email !== null;
  }

  #cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  #remember(response) {
    // Node exposes repeated Set-Cookie headers through getSetCookie().
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const at = pair.indexOf('=');
      if (at > 0) {
        this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
      }
    }
  }

  async request(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(this.cookies.size ? { cookie: this.#cookieHeader() } : {}),
        // Sent on every write. The server checks it against the cookie; a
        // missing one is a 403 that looks exactly like "wrong password".
        ...(this.cookies.has('XSRF-TOKEN')
          ? { 'x-xsrf-token': this.cookies.get('XSRF-TOKEN') }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    this.#remember(response);
    const text = await response.text();
    if (!response.ok) {
      const message = (() => {
        try {
          return JSON.parse(text).message;
        } catch {
          return null;
        }
      })();
      throw new Error(message ?? `${method} ${path} failed: HTTP ${response.status}`);
    }
    return text ? JSON.parse(text) : null;
  }

  /** One open GET first, purely to be handed the CSRF cookie. */
  async login(email, password) {
    await this.request('/api/health').catch(() => undefined);
    const me = await this.request('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    this.email = me.email;
    return me;
  }
}

// --- the terminal ------------------------------------------------------------

const ESC = '\x1b';
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR = `${ESC}[2J${ESC}[H`;
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const REVERSE = `${ESC}[7m`;

/** Colours for a run's state. Muted, because the transcript is the content. */
const STATE_COLOUR = {
  running: `${ESC}[32m`,
  claiming: `${ESC}[33m`,
  queued: `${ESC}[90m`,
};

const RAIL = 30;

/**
 * How wide a string looks, ignoring escape sequences.
 *
 * Transcripts carry ANSI colour (R23), and measuring it as plain text makes
 * every coloured line look forty characters longer than it is — which wraps the
 * pane into nonsense exactly when a session is doing something interesting.
 */
export function visibleWidth(text) {
  return stripAnsi(text).length;
}

export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

/** Wraps to a width, keeping escape sequences where they fall. */
export function wrap(text, width) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    if (visibleWidth(paragraph) <= width) {
      lines.push(paragraph);
      continue;
    }
    let current = '';
    let visible = 0;
    for (let i = 0; i < paragraph.length; i++) {
      const escape = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(paragraph.slice(i));
      if (escape) {
        current += escape[0];
        i += escape[0].length - 1;
        continue;
      }
      current += paragraph[i];
      visible += 1;
      if (visible >= width) {
        lines.push(current);
        current = '';
        visible = 0;
      }
    }
    if (current) {
      // Trailing escapes with nothing after them — the reset at the end of a
      // coloured line — belong to the line they close, not to a new empty one.
      // Without this every coloured line in the pane is followed by a blank.
      if (visible === 0 && lines.length) {
        lines[lines.length - 1] += current;
      } else {
        lines.push(current);
      }
    }
  }
  return lines;
}

function pad(text, width) {
  const short = width - visibleWidth(text);
  return short > 0 ? text + ' '.repeat(short) : text;
}

/** Cuts to a width without cutting an escape sequence in half. */
export function clip(text, width) {
  if (visibleWidth(text) <= width) return text;
  let out = '';
  let visible = 0;
  for (let i = 0; i < text.length && visible < width; i++) {
    const escape = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(text.slice(i));
    if (escape) {
      out += escape[0];
      i += escape[0].length - 1;
      continue;
    }
    out += text[i];
    visible += 1;
  }
  return `${out}${RESET}`;
}

// --- asking for a password without echoing it --------------------------------

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((done) => rl.question(question, (answer) => {
    rl.close();
    done(answer.trim());
  }));
}

/**
 * Reads a line with nothing echoed.
 *
 * Hand-rolled because there is no dependency to reach for, and because the
 * usual trick — overriding readline's private `_writeToOutput` — reaches into
 * Node's internals for the same result.
 */
function askSecret(question) {
  return new Promise((done) => {
    process.stdout.write(question);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    let secret = '';
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      for (const character of text) {
        if (character === '\r' || character === '\n') {
          process.stdin.removeListener('data', onData);
          process.stdin.setRawMode?.(wasRaw ?? false);
          process.stdout.write('\n');
          return done(secret);
        }
        if (character === '\x03') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (character === '\x7f' || character === '\b') {
          secret = secret.slice(0, -1);
          continue;
        }
        secret += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

// --- the client ---------------------------------------------------------------

/**
 * @param argv the command line, for `--runner`, `--email`, `--watch-only`
 * @param options set when the daemon is running IN THIS PROCESS (`--attach`):
 *   its socket is already known, quitting means stopping it, and it can say how
 *   much work would be lost if you did.
 */
export async function attach(argv, options = {}) {
  const socket = options.socketPath ?? (await chooseSocket(valueOf(argv, '--runner')));
  const session = await maybeSignIn(argv);

  const ui = new Attached(socket, session, options);
  await ui.start();
}

function valueOf(argv, flag) {
  const at = argv.indexOf(flag);
  return at === -1 ? null : argv[at + 1];
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
      'No runner is offering a socket on this machine. Start the daemon first:\n\n' +
        '  node runner.mjs --config <your config>.json\n\n' +
        'A daemon older than R52 does not offer one at all.',
    );
  }
  if (sockets.length === 1) {
    return sockets[0].path;
  }
  const names = sockets.map((each) => each.name).join(', ');
  throw new Error(`More than one runner here (${names}). Choose one: attach --runner <name>`);
}

async function maybeSignIn(argv) {
  const url = valueOf(argv, '--url') ?? process.env.CAWDEV_URL ?? 'http://localhost:8091';
  const session = new Session(url);

  if (argv.includes('--watch-only')) {
    return session;
  }

  console.log(
    'Sign in to prompt a session, cancel one, or answer a permission request.\n' +
      'Leave the email blank to watch without signing in.\n',
  );
  const email = valueOf(argv, '--email') ?? process.env.CAWDEV_EMAIL ?? (await ask('Email: '));
  if (!email) {
    return session;
  }
  const password = await askSecret('Password: ');
  try {
    await session.login(email, password);
    console.log(`Signed in as ${session.email}.`);
  } catch (failure) {
    // Not fatal. Watching is the larger half of what this is for, and refusing
    // to start over a typo would be a poor trade.
    console.log(`Could not sign in (${failure.message}). Watching only.`);
  }
  return session;
}

class Attached {
  constructor(socketPath, session, options = {}) {
    this.socketPath = socketPath;
    this.session = session;
    this.options = options;

    this.runner = null;
    this.runs = [];
    this.selected = 0;
    /** runId -> rendered transcript lines. */
    this.lines = new Map();
    this.logs = [];
    /** runId -> the pending permission request on it, from the inbox. */
    this.approvals = new Map();

    this.mode = 'normal';
    this.input = '';
    this.status = '';
    this.showLog = false;
    /** Lines scrolled back from the tail. Zero follows the session. */
    this.scroll = 0;
    this.asked = new Set();
    this.connected = false;
    this.stopped = false;
    this.dirty = false;
  }

  async start() {
    process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on('data', (chunk) => this.onKey(chunk.toString('utf8')));
    process.stdout.on('resize', () => this.draw());

    this.open();
    if (this.session.signedIn) {
      void this.watchInbox();
    }

    // One repaint per tick at most. A busy session emits hundreds of lines a
    // second and redrawing per line would spend the whole terminal on escape
    // codes.
    const painter = setInterval(() => {
      if (this.dirty) {
        this.dirty = false;
        this.draw();
      }
    }, 60);
    painter.unref?.();

    this.draw();
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
      this.requestBacklog();
    } else if (event.type === 'runs') {
      const before = this.current()?.id;
      this.runs = event.runs;
      // Keep the selection on the SAME run when the list moves under it.
      // Watching your cursor jump to another session because a third one
      // finished is how you send a prompt to the wrong place.
      const at = this.runs.findIndex((run) => run.id === before);
      this.selected = at === -1 ? Math.min(this.selected, Math.max(0, this.runs.length - 1)) : at;
      this.requestBacklog();
    } else if (event.type === 'output') {
      const kept = this.lines.get(event.runId) ?? [];
      kept.push(event.line);
      if (kept.length > 5000) kept.splice(0, kept.length - 5000);
      this.lines.set(event.runId, kept);
    } else if (event.type === 'backlog') {
      this.lines.set(event.runId, event.lines);
    } else if (event.type === 'log') {
      this.logs.push(event);
      if (this.logs.length > 2000) this.logs.splice(0, this.logs.length - 2000);
    }
    this.dirty = true;
  }

  /** The backlog of whatever is selected, once per run. */
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
    return this.runs[this.selected] ?? null;
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

  // --- keys ------------------------------------------------------------------

  onKey(key) {
    if (this.mode === 'prompt' || this.mode === 'reason') {
      return this.onTyping(key);
    }
    // Any other key means "no". A confirmation that outlives the moment is one
    // somebody answers by accident three keystrokes later.
    if (key !== 'q' && key !== 'x') {
      this.confirmQuit = false;
      this.confirming = null;
    }

    switch (key) {
      case 'q':
      case '\x03': // Ctrl-C
        return this.quit();
      case '\t':
      case 'j':
      case `${ESC}[B`:
        return this.move(1);
      case 'k':
      case `${ESC}[A`:
        return this.move(-1);
      case 'g':
        this.showLog = !this.showLog;
        this.scroll = 0;
        return this.note(this.showLog ? "the daemon's log" : 'the session');
      case 'i':
        if (!this.requireSignIn('prompt a session')) return undefined;
        this.mode = 'prompt';
        this.input = '';
        return this.note('');
      case 'y':
        return void this.decide(true, false);
      case 'Y':
        return void this.decide(true, true);
      case 'n':
        if (!this.pendingOn(this.current())) {
          return this.note('nothing is waiting for permission on this one');
        }
        if (!this.requireSignIn('refuse a request')) return undefined;
        this.mode = 'reason';
        this.input = '';
        return this.note('');
      case 'x':
        return void this.cancel();
      case `${ESC}[5~`: // PgUp
        this.scroll += 10;
        return this.note('');
      case `${ESC}[6~`: // PgDn
        this.scroll = Math.max(0, this.scroll - 10);
        return this.note('');
      default:
        if (/^[1-9]$/.test(key)) {
          const at = Number(key) - 1;
          if (at < this.runs.length) {
            this.selected = at;
            this.scroll = 0;
            this.requestBacklog();
          }
          return this.note('');
        }
        return undefined;
    }
  }

  onTyping(key) {
    if (key === '\x03' || key === ESC) {
      this.mode = 'normal';
      this.input = '';
      return this.note('cancelled');
    }
    if (key === '\r' || key === '\n') {
      const text = this.input.trim();
      const was = this.mode;
      this.mode = 'normal';
      this.input = '';
      if (!text) {
        return this.note('nothing to send');
      }
      return was === 'prompt' ? void this.send(text) : void this.decide(false, false, text);
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

  move(by) {
    if (!this.runs.length) return;
    this.selected = (this.selected + by + this.runs.length) % this.runs.length;
    this.scroll = 0;
    this.requestBacklog();
    this.note('');
  }

  requireSignIn(what) {
    if (this.session.signedIn) {
      return true;
    }
    // The refusal names the rule rather than the symptom: this is not the
    // client being awkward, it is the platform refusing anything that is not a
    // person, and a message that says "403" would send somebody looking in the
    // wrong place.
    this.note(`sign in to ${what} — a session may only be changed by a person`);
    return false;
  }

  // --- the three things a person can do -------------------------------------

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

  async decide(allow, remember, reason) {
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
        { method: 'POST', body: { allow, remember, reason } },
      );
      this.approvals.delete(run.id);
      this.note(allow ? (remember ? 'allowed, and remembered' : 'allowed') : 'refused');
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

  quit() {
    const live = this.options.liveSessions?.() ?? 0;
    if (this.options.onQuit && live > 0 && !this.confirmQuit) {
      // Started with `--attach`, so this window IS the daemon: quitting takes
      // the sessions with it. `q` must not be a way to lose three hours of work
      // by leaning on the keyboard.
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
    process.stdin.setRawMode?.(false);
    process.stdout.write(SHOW_CURSOR + ALT_SCREEN_OFF);
    this.finish?.();

    if (this.options.onQuit) {
      // Hand back to the daemon's own shutdown: say goodbye to the platform,
      // take the children down, then exit. Exiting here would skip all three.
      return this.options.onQuit();
    }
    return process.exit(0);
  }

  // --- drawing -----------------------------------------------------------------

  draw() {
    const width = process.stdout.columns ?? 100;
    const height = process.stdout.rows ?? 30;
    const paneWidth = Math.max(20, width - RAIL - 1);
    const bodyHeight = Math.max(3, height - 3);

    const rail = this.railLines(bodyHeight);
    const pane = this.paneLines(paneWidth, bodyHeight);

    const out = [CLEAR, this.header(width), '\n'];
    for (let row = 0; row < bodyHeight; row++) {
      out.push(pad(rail[row] ?? '', RAIL));
      out.push(`${DIM}│${RESET}`);
      out.push(clip(pane[row] ?? '', paneWidth));
      out.push('\n');
    }
    out.push(this.footer(width));
    process.stdout.write(out.join(''));
  }

  header(width) {
    const runner = this.runner?.name ?? '…';
    const who = this.session.signedIn ? this.session.email : 'watching only';
    const link = this.connected ? '' : `${ESC}[31m detached${RESET}`;
    const left = ` ${BOLD}cawdev${RESET}${DIM} · ${RESET}${runner}${DIM} · ${who}${RESET}${link}`;
    return `${REVERSE}${pad(clip(left, width - 1), width)}${RESET}`;
  }

  railLines(height) {
    const lines = [];
    lines.push(` ${DIM}sessions here${RESET}`);
    if (!this.runs.length) {
      lines.push(` ${DIM}nothing running${RESET}`);
    }
    this.runs.forEach((run, at) => {
      const colour = STATE_COLOUR[run.state] ?? '';
      const marker = at === this.selected ? `${BOLD}❯${RESET}` : ' ';
      const waiting = this.approvals.has(run.id) ? `${ESC}[33m!${RESET}` : ' ';
      const number = at < 9 ? `${at + 1}` : ' ';
      lines.push(`${marker}${waiting}${DIM}${number}${RESET} ${colour}${clip(run.label, RAIL - 6)}${RESET}`);
      lines.push(`   ${DIM}${clip(`${run.projectSlug} · ${run.state}`, RAIL - 4)}${RESET}`);
      if (run.why) {
        // The reason a run is queued is the whole argument for this program
        // existing, so it is on the rail rather than a keypress away.
        lines.push(`   ${DIM}${ESC}[33m${clip(run.why, RAIL - 4)}${RESET}`);
      }
    });
    return lines.slice(0, height);
  }

  paneLines(width, height) {
    const run = this.current();
    const source = this.showLog
      ? this.logs.map((entry) => `${DIM}${entry.at?.slice(11, 19) ?? ''}${RESET} ${entry.line}`)
      : (this.lines.get(run?.id) ?? []).map((line) => this.render(line));

    const wrapped = source.flatMap((line) => wrap(line, width));

    const banner = this.bannerLines(run, width);
    const room = Math.max(1, height - banner.length);
    const end = Math.max(0, wrapped.length - this.scroll);
    const visible = wrapped.slice(Math.max(0, end - room), end);

    if (run?.state === 'queued' && !this.showLog) {
      // A queued run has no transcript, and "nothing said yet" would be a poor
      // answer to the question somebody actually has. The rail can only show
      // twenty-odd characters of the reason; here it fits.
      return [
        ...banner,
        ` ${BOLD}waiting${RESET}`,
        ` ${ESC}[33m${clip(run.why ?? 'no reason recorded', width - 2)}${RESET}`,
        '',
        `${DIM} This machine has claimed nothing for it yet. Nothing is wrong —${RESET}`,
        `${DIM} the daemon re-offers it every poll and takes it when it can.${RESET}`,
      ];
    }
    if (!visible.length && !banner.length) {
      return [
        `${DIM} ${run ? 'nothing said yet on this session' : 'no session selected'}${RESET}`,
      ];
    }
    return [...banner, ...visible];
  }

  /** A permission request, above the transcript, because it stops everything. */
  bannerLines(run, width) {
    const pending = this.pendingOn(run);
    if (!pending) return [];
    const approval = pending.approval;
    const rule = approval.suggestion
      ? `${ESC}[33mY${RESET} always allow ${approval.suggestion}   `
      : '';
    return [
      `${ESC}[33m${BOLD} permission ${RESET} ${clip(approval.summary, width - 14)}`,
      `${DIM} ${approval.toolName} · waiting since ${approval.askedAt?.slice(11, 19) ?? ''}${RESET}`,
      ` ${ESC}[32my${RESET} allow once   ${rule}${ESC}[31mn${RESET} refuse`,
      `${DIM}${'─'.repeat(Math.max(0, width))}${RESET}`,
    ];
  }

  render(line) {
    const kind = line.kind ?? 'SYSTEM';
    const colour = kind === 'ERROR' ? `${ESC}[31m` : kind === 'USER' ? `${ESC}[36m` : '';
    // The body already carries the agent's own colour; ours goes in front and
    // is closed after, so a line that sets a colour and never resets it cannot
    // paint the rest of the pane.
    return `${colour}${line.body}${RESET}`;
  }

  footer(width) {
    if (this.mode === 'prompt') {
      return `${REVERSE}${pad(clip(` prompt ▸ ${this.input}`, width - 1), width)}${RESET}`;
    }
    if (this.mode === 'reason') {
      return `${REVERSE}${pad(clip(` refuse, because ▸ ${this.input}`, width - 1), width)}${RESET}`;
    }
    const keys =
      ` ${DIM}tab${RESET} next  ${DIM}1-9${RESET} pick  ${DIM}i${RESET} prompt  ` +
      `${DIM}y/Y/n${RESET} permission  ${DIM}x${RESET} cancel  ${DIM}g${RESET} log  ` +
      `${DIM}q${RESET} ${this.options.onQuit ? 'stop' : 'quit'}`;
    const status = this.status ? `  ${ESC}[33m${this.status}${RESET}` : '';
    return pad(clip(keys + status, width - 1), width);
  }
}
