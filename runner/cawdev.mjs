#!/usr/bin/env node
// `cawdev` — one word, and you are in. R81.
//
// This is the whole interface from a machine. Not `node runner.mjs`, not
// `node runner.mjs attach`, not argument number two of a script: a command you
// type by name, which is what R52's terminal client became once it stopped
// being an accessory to the daemon and started being the way people use cawdev.
//
// **Finding no daemon, it starts one.** That was decided by the person who
// asked for this entry, and it has a cost worth naming: a background process
// somebody did not know they started. R81 paid that cost out loud and left the
// process running; R123 pays it by ENDING it — one word started the window and
// the machine, and `q` stops both, asking twice while sessions are live.
// `--leave-running` is the old answer, for a machine that should outlive the
// window, and there the goodbye still names the runner and the `kill`.
//
// R52's discovery is unchanged where it still applies: one daemon is the answer
// without asking, and more than one means naming which.
//
// Zero dependencies, like everything in tools/.

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, mkdir, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attach, urlFrom, valueOf } from './attach.mjs';
import { asker, askOne, mintForThisMachine, setUpThisMachine } from './bootstrap.mjs';
import { liveSockets, probeSocket, socketPathFor } from './control.mjs';
import {
  addProject, addWorkspace, readConfigFile, reloadIfRunning, removeProject, setAcceptsRulesFromConsole,
  setQuality, setAgentEnabled,
} from './configure.mjs';
import { restartNeededFor } from '../lib/runner-config.mjs';
import { Select } from './select.mjs';
import { storedSession } from './sign-in.mjs';
import { loadToken } from './token-store.mjs';
import { painter } from '../lib/ansi.mjs';
import { KNOWN_AGENTS } from '../lib/agents.mjs';
import { mark } from './brand.mjs';
import { cliVersion, isBelow } from '../lib/version.mjs';

const HERE = dirname(new URL(import.meta.url).pathname);
const RUNNER = join(HERE, 'runner.mjs');

const USAGE = `
  cawdev — this machine's sessions, in your terminal

  cawdev                    attach to the runner here, starting one if there is none
  cawdev --runner <name>    when this machine runs more than one
  cawdev --url <url>        which cawdev to sign in to (or CAWDEV_URL)
  cawdev --config <path>    the runner config to start a daemon from
  cawdev --setup            set this machine up again: projects, checkouts, token
  cawdev --no-start         attach only; never launch a daemon
  cawdev --watch-only       do not sign in; watch without being able to act
  cawdev --leave-running    leave the daemon running when you quit
  cawdev --version          this CLI's version, and the platform's
  cawdev --help

  cawdev config                          a menu: add a project, add a
                                          workspace, agents, console rules
  cawdev config add-project              serve one more project you can write to, or create one
  cawdev config add-workspace            another checkout for a project you
                                          already serve — R47's concurrency
  cawdev config remove-project <slug>    stop serving a project (its checkouts
                                          stay on disk)
  cawdev config agent enable|disable <claude|agy|codex>
  cawdev config rules on|off             accept permission rules from the console
  cawdev config quality on|off <slug>    scan that project's branches with
                                         SonarQube after a run's TEST stage
  cawdev config show                     this machine's config, token redacted

  On a machine with no config, cawdev sets one up: it signs you in through the
  browser, asks which projects this machine should run agents for, clones them,
  and mints its own runner token. No token is ever typed. \`cawdev config\` is
  the same walk, one change at a time, on a machine already set up.

  Inside: enter prompts the session you are watching, / takes a command
  (/help lists them), L lists the runs, c configures this machine (the same
  menu as \`cawdev config\`, on screen), and q stops the machine and leaves.
  It asks twice while sessions are running. --leave-running keeps it up.
`;

/**
 * The config a daemon would be started from.
 *
 * Four places, in the order somebody would expect: what they just typed, what
 * their shell says, the directory they are standing in, and the one that
 * follows them between directories. Nothing is invented — if none of the four
 * is there, the daemon is started without one and `readConfig` decides whether
 * the environment supplied enough, which is the answer it already gives.
 */
export async function findConfig(argv, env = process.env, cwd = process.cwd()) {
  const named = valueOf(argv, '--config');
  if (named) {
    // Not checked for existence: a file somebody named and got wrong should
    // fail saying so, not quietly fall back to a different one.
    return resolve(cwd, named);
  }
  const candidates = [
    env.CAWDEV_RUNNER_CONFIG,
    join(cwd, 'runner.config.json'),
    join(env.HOME ?? homedir(), '.cawdev', 'runner.config.json'),
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      await access(path);
      return path;
    } catch {
      // Next.
    }
  }
  return null;
}

/** Where a daemon this command started writes what it could not put on a socket. */
export function daemonLogPath() {
  return join(homedir(), '.cawdev', 'runner.log');
}

/**
 * Start a daemon in the background and wait for its socket.
 *
 * Detached with its output on a file, because this terminal belongs to the UI
 * a second later — a daemon writing its banner into the middle of a transcript
 * is the thing `--attach` exists to avoid, and the same reasoning applies
 * harder when the two are separate processes.
 *
 * The wait is for the SOCKET rather than for a timer: a daemon that boots is
 * ready when it is offering one, and a daemon that refuses to boot — no token,
 * no projects — never will. That is why the failure path prints the log rather
 * than a timeout, since the log is where `readConfig` said what was missing.
 */
export async function startDaemon(configPath, ink = painter()) {
  await mkdir(dirname(daemonLogPath()), { recursive: true, mode: 0o700 });
  const log = await open(daemonLogPath(), 'a');

  const args = [RUNNER, ...(configPath ? ['--config', configPath] : [])];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
    // From the config's own directory, so relative workspace paths in it mean
    // what they meant when it was written.
    cwd: configPath ? dirname(configPath) : process.cwd(),
  });
  child.unref();
  await log.close();

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 250));
    const alive = await liveSockets();
    if (alive.length === 1) {
      return alive[0].path;
    }
    if (alive.length > 1) {
      // Somebody else's daemon was already here and ours arrived beside it.
      const named = alive.map((each) => each.name).join(', ');
      throw new Error(`More than one runner here (${named}). Choose one: cawdev --runner <name>`);
    }
    if (child.exitCode !== null) {
      break;
    }
  }

  const tail = await lastLines(daemonLogPath(), 12);
  throw new Error(
    `The runner did not start.${configPath ? `\n  Config: ${configPath}` : '\n  No config file found.'}\n`
      + `  ${ink.muted(daemonLogPath())}\n\n`
      + (tail.length ? tail.map((line) => `  ${line}`).join('\n') : '  (nothing in the log)'),
  );
}

async function lastLines(path, count) {
  try {
    const text = await readFile(path, 'utf8');
    return text.trimEnd().split('\n').slice(-count);
  } catch {
    return [];
  }
}

/**
 * Which socket to attach to, starting a daemon if that is what "none" means.
 *
 * A named runner is never started for you: naming one is a claim that it is
 * there, and launching a *different* daemon under that name because the first
 * was not answering is not the request.
 */
export async function socketToAttach(argv, ink = painter()) {
  const named = valueOf(argv, '--runner');
  if (named) {
    const path = socketPathFor(named);
    if (await probeSocket(path)) {
      return path;
    }
    throw new Error(`No runner called "${named}" is answering on this machine.`);
  }

  const alive = await liveSockets();
  if (alive.length === 1) {
    return alive[0].path;
  }
  if (alive.length > 1) {
    const names = alive.map((each) => each.name).join(', ');
    throw new Error(`More than one runner here (${names}). Choose one: cawdev --runner <name>`);
  }

  if (argv.includes('--no-start')) {
    throw new Error('No runner is answering on this machine, and --no-start was given.');
  }

  let configPath = await findConfig(argv);
  const file = configPath ? await readConfigFile(configPath) : null;

  // R93. A machine that cannot produce a token is one nobody has finished
  // setting up, and it is the ONLY case that acts by itself: a token that is
  // exported, or one written into the config, is somebody having said which
  // credential to use, and asking them again would be ignoring it.
  //
  // The old behaviour here was to start a daemon that could not boot and then
  // print `readConfig`'s complaint out of a log file — accurate, and useless on
  // a laptop where the answer was "you have not set this up yet".
  //
  // **The guard used to ask whether a config EXISTED, and that was the bug.**
  // A config with no token in it is the commonest shape there is: the file
  // names working copies and permissions, so it is written by hand, copied
  // between machines and committed — and it must not carry a credential. Such
  // a machine skipped the walk, started a daemon that refused to boot, and was
  // told to go and mint a token in the console by hand. Which is precisely the
  // errand R93 exists to abolish, reached through a different door.
  if (!process.env.CAWDEV_TOKEN && !file?.token) {
    if (!configPath) {
      // Nothing here at all: the walk, which asks what this machine serves.
      configPath = await runSetup(argv, ink);
    } else if (file && !(await loadToken(daemonUrl(file)))) {
      // Configured but uncredentialed, and nothing minted here before. The
      // config answers every question the walk would ask, so only the token is
      // fetched. A file we could not parse is left alone deliberately: the
      // daemon's own complaint about it says more than a walk would.
      //
      // Asked under `daemonUrl`, not the one being signed in to: the question
      // is "will the daemon find a token", and the daemon has never heard of
      // `--url`.
      await runMint(configPath, file, argv, ink);
    }
  }

  console.log(`  ${ink.muted('No runner here yet — starting one')}`
    + `${configPath ? ` ${ink.muted('from')} ${ink.accent(configPath)}` : ''}${ink.muted('…')}`);
  return startDaemon(configPath, ink);
}

/**
 * The URL a daemon assumes when nothing says otherwise.
 *
 * A third copy of a string that already exists in `runner.mjs`'s `DEFAULTS` and
 * in `attach.mjs`'s `urlFrom`, and importing either would be worse: `DEFAULTS`
 * lives in a module whose top level starts a daemon, and `urlFrom` folds in
 * `--url`, which is the very thing this must not see. `cawdev-command.test.mjs`
 * pins the three in step instead — it reads the three files and fails when they
 * hold more than one value, which is what makes moving the default a
 * three-line change rather than a two-line bug.
 */
const DEFAULT_URL = 'https://app.cawdev.com';

/**
 * Two URLs, because they answer two different questions.
 *
 * **Where a person signs in** is a browser's question. **What this machine is
 * called** is the daemon's, and it is the key the token is stored under. An
 * earlier version of this file had one function for both, with a comment
 * claiming they were kept in step — they are not, and the cost of the claim was
 * a token minted at one URL, filed under it, and looked for under another. A
 * live credential on the tokens page that nothing would ever read.
 *
 * They differ for an ordinary reason rather than a broken one: a config may
 * name the API directly — in development it is on `:8091` while the console
 * proxying to it is on `:4200` — and a browser sent to the API gets no sign-in
 * page, because the console is what serves one. So `--url` is how somebody says
 * which door *they* are going through, and it has no business renaming the
 * machine.
 *
 * <p>The DEFAULT is now the console's origin, which makes the two agree when
 * nothing has been configured — but they are still two questions, and the split
 * is what keeps a config naming `:8091` working with a browser sent to `:4200`.
 */
export function signInUrl(file, argv, env = process.env) {
  const typed = valueOf(argv, '--url') ?? env.CAWDEV_URL;
  return String(typed ?? file?.url ?? urlFrom(argv)).replace(/\/+$/, '');
}

/**
 * Where THIS launch signs in: `signInUrl` over the config the launch would use.
 *
 * The banner, the version check and the person's own session all asked
 * `urlFrom(argv)`, which knows `--url` and `CAWDEV_URL` and never the config —
 * so `cawdev --config local.config.json` minted the machine's token at the
 * config's localhost and then opened the browser on app.cawdev.com for the
 * person. One reading, taken once, so the three cannot disagree with the mint.
 */
export async function launchUrl(argv, env = process.env, cwd = process.cwd()) {
  const configPath = await findConfig(argv, env, cwd);
  const file = configPath ? await readConfigFile(configPath) : null;
  return signInUrl(file, argv, env);
}

/**
 * What `readConfig` will call this machine — and therefore the storage key.
 *
 * Deliberately a copy of the daemon's own precedence (`CAWDEV_URL`, the config,
 * the default) rather than a call into it: `readConfig` is not exported, reads
 * `process.argv` for its own `--config`, and throws when there is no token,
 * which is the state this is deciding about. `--url` is absent because the
 * daemon is never passed one, and a key the daemon cannot compute is a token it
 * cannot find.
 */
export function daemonUrl(file, env = process.env) {
  return String(env.CAWDEV_URL ?? file?.url ?? DEFAULT_URL).replace(/\/+$/, '');
}

// `readConfigFile` lives in configure.mjs since R288 — the attached UI reads
// the file too, and this module imports attach.mjs. Re-exported so nothing
// that imported it from here has to move.
export { readConfigFile };

/**
 * The setup walk, with the terminal handed to it and taken back.
 *
 * `readline` owns stdin while it is open and the client's raw mode wants it
 * afterwards, so the interface is closed on every path out — including the one
 * where somebody answered "no, Claude Code is not signed in", which throws.
 */
async function runSetup(argv, ink) {
  const ask = asker();
  try {
    const { configPath } = await setUpThisMachine({
      url: urlFrom(argv),
      ask,
      say: (line) => console.log(line),
      ink,
    });
    return configPath;
  } finally {
    ask.close();
  }
}

/**
 * Minting for a machine that is already configured.
 *
 * No `asker` here, and that is the point rather than an omission: this asks
 * nothing. The config named the projects, the checkouts are on disk, and the
 * browser handles the one interaction there is.
 */
async function runMint(configPath, file, argv, ink) {
  await mintForThisMachine({
    url: signInUrl(file, argv),
    storeUrl: daemonUrl(file),
    config: file,
    configPath,
    say: (line) => console.log(line),
    ink,
  });
}

/**
 * This CLI's version against the platform's — R283.
 *
 * Best-effort and silent on the happy path, matching `acceptsConsoleRules`'
 * own philosophy (R126's comment on the daemon side): a mismatch is worth a
 * line, agreement is worth nothing. Never thrown from here — a network hiccup
 * is not evidence of a stale CLI, and `cawdev` has an attach to get on with.
 */
async function warnIfVersionMismatched(url, ink) {
  try {
    const mine = await cliVersion();
    const response = await fetch(`${url}/api/health`);
    if (!response.ok) return;
    const health = await response.json();
    if (health.version && health.version !== mine && health.version !== 'unknown') {
      console.log(`  ${ink.warn('!')} ${ink.muted(`This CLI is ${mine}; ${url} is on ${health.version}.`)}`);
      console.log(`  ${ink.muted('Update this machine\'s cawdev if things look wrong.')}`);
    }
    if (isBelow(mine, health.minimumCliVersion)) {
      console.log(`  ${ink.danger('!')} ${ink.text(`This CLI (${mine}) is below what ${url} requires `
        + `(${health.minimumCliVersion}) — the daemon will refuse to start until it is updated.`)}`);
    }
  } catch {
    // Best-effort. readConfig's own health check, before registering, is
    // where a genuinely unreachable platform actually matters.
  }
}

/**
 * `cawdev --version`: this CLI's own version, and the platform's.
 *
 * Works with no config and no sign-in — `/api/health` needs neither — so it
 * answers on a machine that has not been set up at all yet.
 */
async function runVersion(url, ink) {
  const mine = await cliVersion();
  console.log(`  ${ink.muted('cawdev')} ${ink.text(mine)}`);
  try {
    const response = await fetch(`${url}/api/health`);
    const health = response.ok ? await response.json() : null;
    if (health) {
      console.log(`  ${ink.muted(url)} ${ink.text(health.version)}`);
      if (isBelow(mine, health.minimumCliVersion)) {
        console.log(`  ${ink.danger('This CLI is below the minimum that platform requires')} `
          + `(${health.minimumCliVersion}). Update it.`);
      } else if (health.version !== mine && health.version !== 'unknown') {
        console.log(`  ${ink.muted('These differ — update whichever is behind.')}`);
      }
    } else {
      console.log(`  ${ink.muted(url)} ${ink.warn('did not answer')}`);
    }
  } catch (failure) {
    console.log(`  ${ink.muted(url)} ${ink.warn(`unreachable (${failure.message})`)}`);
  }
}

/**
 * `cawdev config` — R283's granular half of the setup walk, on a machine
 * already configured. A direct subcommand (`add-project`, `add-workspace`,
 * `remove-project <slug>`,
 * `agent enable|disable <command>`, `rules on|off`, `quality on|off <slug>`,
 * `show`) or, with none, a
 * menu — the same `Select` widget everything that offers a choice uses.
 */
async function runConfig(args, ink) {
  const configPath = await findConfig(args);
  if (!configPath) {
    throw new Error('No config on this machine yet. Run `cawdev --setup` first.');
  }
  const file = await readConfigFile(configPath);
  if (!file) {
    throw new Error(`Could not read ${configPath}.`);
  }

  if (args[0] === 'show') {
    printConfig(file, ink, (line) => console.log(line));
    return;
  }

  const url = daemonUrl(file);
  const session = await storedSession(url);
  if (!session.signedIn) {
    throw new Error('Not signed in on this machine. Run `cawdev --setup` first.');
  }

  const ask = asker();
  const say = (line) => console.log(line);
  try {
    const action = args.length ? args : await pickAction(ask, say);
    await runAction(action, { configPath, file, url, session, ask, say, ink });
  } finally {
    ask.close();
  }
}

export async function pickAction(ask, say, pick = askOne) {
  const picked = await pick(ask, say, new Select({
    title: 'What do you want to change on this machine?',
    rows: [
      { id: 'add-project', label: 'Add a project — or create one on cawdev' },
      { id: 'add-workspace', label: 'Add a workspace to a project' },
      { id: 'remove-project', label: 'Stop serving a project' },
      { id: 'agent-enable', label: `Enable an agent (${KNOWN_AGENTS.join(' / ')})` },
      { id: 'agent-disable', label: 'Disable an agent' },
      { id: 'rules-on', label: 'Accept permission rules from the console' },
      { id: 'rules-off', label: 'Stop accepting rules from the console' },
      { id: 'quality-on', label: 'Scan a project\'s branches with SonarQube after TEST' },
      { id: 'quality-off', label: 'Stop scanning a project\'s branches' },
      { id: 'show', label: 'Show this machine\'s config' },
    ],
  }));
  const id = picked.row.id;
  if (id === 'agent-enable' || id === 'agent-disable') {
    const command = (await ask.line(`  Which agent — ${KNOWN_AGENTS.join(', ')}? `)).trim();
    return ['agent', id === 'agent-enable' ? 'enable' : 'disable', command];
  }
  if (id === 'remove-project') {
    return ['remove-project', (await ask.line('  Which project (slug)? ')).trim()];
  }
  if (id === 'rules-on') return ['rules', 'on'];
  if (id === 'rules-off') return ['rules', 'off'];
  if (id === 'quality-on' || id === 'quality-off') {
    const slug = (await ask.line('  Which project (slug)? ')).trim();
    return ['quality', id === 'quality-on' ? 'on' : 'off', slug];
  }
  return [id];
}

export async function runAction([verb, ...rest], { configPath, file, url, session, ask, say, ink, reloadOptions = {} }) {
  if (verb === 'show') {
    printConfig(file, ink, say);
    return;
  }
  // R294: every change ends the same way — the daemon on this config, if one
  // is running, is signalled and its own verdict is printed. For a project or
  // a workspace that verdict is "needs a restart", because `config.projects`
  // is read once at boot; but it is the daemon saying so about the file it is
  // actually on, not this command guessing about a daemon it cannot see.
  const reload = (next) => reloadIfRunning(file.name, say, ink, {
    fallback: restartNeededFor(file, next), ...reloadOptions,
  });
  if (verb === 'add-project') {
    await reload(await addProject({ configPath, file, url, session, ask, say, ink }));
    return;
  }
  if (verb === 'add-workspace') {
    await reload(await addWorkspace({ configPath, file, url, session, ask, say, ink }));
    return;
  }
  if (verb === 'remove-project') {
    const [slug] = rest;
    if (!slug) {
      throw new Error('Name a project: cawdev config remove-project <slug>');
    }
    await reload(await removeProject({ file, configPath, ask, say, ink, slug }));
    return;
  }
  if (verb === 'agent') {
    const [sub, command] = rest;
    if (!KNOWN_AGENTS.includes(command)) {
      throw new Error(`Name an agent: cawdev config agent enable|disable ${KNOWN_AGENTS.join('|')}`);
    }
    await reload(await setAgentEnabled({
      file, configPath, ask, say, ink, command, enabled: sub === 'enable',
    }));
    return;
  }
  if (verb === 'rules') {
    const [sub] = rest;
    await reload(await setAcceptsRulesFromConsole({ file, configPath, ask, say, ink, enabled: sub === 'on' }));
    return;
  }
  if (verb === 'quality') {
    // R300. The block is captured per project at boot, so the daemon's own
    // verdict here is always "restart" — and it is the daemon that says so.
    const [sub, slug] = rest;
    if (!['on', 'off'].includes(sub) || !slug) {
      throw new Error('Name a project: cawdev config quality on|off <slug>');
    }
    await reload(await setQuality({ file, configPath, ask, say, ink, slug, enabled: sub === 'on' }));
    return;
  }
  throw new Error(`Not a cawdev config command: ${verb}. See cawdev --help.`);
}

/** The config as somebody would want to read it back — never the secret. */
export function printConfig(file, ink, say) {
  const shown = { ...file };
  if (shown.token) shown.token = `${String(shown.token).slice(0, 10)}…`;
  say(JSON.stringify(shown, null, 2)
    .split('\n')
    .map((line) => `  ${ink.text(line)}`)
    .join('\n'));
}

async function main() {
  const argv = process.argv.slice(2);
  const ink = painter();

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  if (argv[0] === 'config') {
    await runConfig(argv.slice(1), ink);
    return;
  }

  const url = await launchUrl(argv);

  if (argv.includes('--version')) {
    await runVersion(url, ink);
    return;
  }

  // The mark, once, before anything else happens. It is the only decoration in
  // the program and it is here because this is the moment somebody is waiting:
  // a browser about to open, or a daemon about to boot.
  for (const line of mark(ink, { tagline: url })) {
    console.log(`\n${line}\n`);
  }

  // R283. Best-effort, silent when the two agree — see the function's own
  // comment for why this never throws.
  await warnIfVersionMismatched(url, ink);

  // Asked for by name, the walk runs even where one has been done before —
  // that is what "again" means, and adding a project to this machine is the
  // ordinary reason. A daemon already running keeps the config it booted with,
  // so it is told to restart rather than left to look like it took the change.
  if (argv.includes('--setup')) {
    await runSetup(argv, ink);
    const alive = await liveSockets();
    if (alive.length) {
      console.log(`  ${ink.warn('!')} ${ink.muted('A runner is already running here, on the config it booted with.')}`);
      console.log(`  ${ink.muted('Attach and quit to stop it, and the next cawdev starts one')}`);
      console.log(`  ${ink.muted('on what you just set up.')}`);
    }
  }

  const socketPath = await socketToAttach(argv, ink);
  await attach(argv, { socketPath, url });
}

/**
 * Is this file the command being run, rather than a module somebody imported?
 *
 * **Through the SYMLINK, and that is the whole point.** `npm i -g` installs a
 * bin as a link — `…/bin/cawdev` → `…/lib/node_modules/cawdev/runner/cawdev.mjs`
 * — so `process.argv[1]` is the link and `import.meta.url` is its target. A
 * lexical comparison of the two is never equal, `main()` never ran, and the
 * installed command exited 0 having printed nothing. It worked only when the
 * file was named directly, which is how it passed every test and every hand
 * check: those all typed the path.
 *
 * So both sides are resolved through the filesystem, which is what makes a
 * link and its target the same file. `fileURLToPath` rather than
 * `URL.pathname`, because a path containing a space arrives percent-encoded
 * and would miss for a second reason.
 *
 * Pure enough to test: give it the two strings and it answers.
 */
export function isTheCommand(argv1, moduleUrl) {
  if (!argv1) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      // A path that is not there cannot be this file; the lexical form is
      // still worth comparing, since that is the case where both are absent
      // from disk (a bundler, a test harness) and equality still means yes.
      return resolve(path);
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

// Only when this file IS the command. Its helpers are imported by the tests,
// and a module that starts a daemon on import is one nothing can test.
if (isTheCommand(process.argv[1], import.meta.url)) {
  main().catch((failure) => {
    console.error(`\n  ${failure.message}\n`);
    process.exit(1);
  });
}
