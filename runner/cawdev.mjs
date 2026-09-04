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
// somebody did not know they started. So the cost is paid out loud — quitting
// the UI leaves the daemon running, because it is driving runs, and says so,
// naming the runner and the command that stops it.
//
// R52's discovery is unchanged where it still applies: one daemon is the answer
// without asking, and more than one means naming which.
//
// Zero dependencies, like everything in tools/.

import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { attach, urlFrom, valueOf } from './attach.mjs';
import { liveSockets, probeSocket, socketPathFor } from './control.mjs';
import { painter } from '../lib/ansi.mjs';
import { mark } from './brand.mjs';

const HERE = dirname(new URL(import.meta.url).pathname);
const RUNNER = join(HERE, 'runner.mjs');

const USAGE = `
  cawdev — this machine's sessions, in your terminal

  cawdev                    attach to the runner here, starting one if there is none
  cawdev --runner <name>    when this machine runs more than one
  cawdev --url <url>        which cawdev to sign in to (or CAWDEV_URL)
  cawdev --config <path>    the runner config to start a daemon from
  cawdev --no-start         attach only; never launch a daemon
  cawdev --watch-only       do not sign in; watch without being able to act
  cawdev --help

  Inside: enter prompts the session you are watching, / takes a command
  (/help lists them), L lists the runs, q leaves — and the runner keeps going.
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

  const configPath = await findConfig(argv);
  console.log(`  ${ink.muted('No runner here yet — starting one')}`
    + `${configPath ? ` ${ink.muted('from')} ${ink.accent(configPath)}` : ''}${ink.muted('…')}`);
  return startDaemon(configPath, ink);
}

async function main() {
  const argv = process.argv.slice(2);
  const ink = painter();

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  // The mark, once, before anything else happens. It is the only decoration in
  // the program and it is here because this is the moment somebody is waiting:
  // a browser about to open, or a daemon about to boot.
  for (const line of mark(ink, { tagline: urlFrom(argv) })) {
    console.log(`\n${line}\n`);
  }

  const socketPath = await socketToAttach(argv, ink);
  await attach(argv, { socketPath });
}

// Only when this file IS the command. Its helpers are imported by the tests,
// and a module that starts a daemon on import is one nothing can test.
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((failure) => {
    console.error(`\n  ${failure.message}\n`);
    process.exit(1);
  });
}
