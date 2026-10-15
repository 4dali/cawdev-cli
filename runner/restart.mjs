// What a daemon that restarted under its sessions does about them — R339.
//
// A daemon killed mid-run (most often for memory, by the kernel, while the
// session ran a test suite) comes back healthy with an empty `running` map.
// The platform could only infer what happened: five minutes later
// StaleRunSweeper failed the run as "its runner is alive but stopped driving
// it", a sentence that names no cause and arrives after somebody has already
// gone looking. The one process that KNOWS is the new daemon, so the old one
// leaves a note: the runs it is driving, written beside the socket every time
// that set changes. On boot the new one reads it and reports each run it no
// longer holds as DAEMON_RESTARTED, at once.
//
// And so it happens less: `sessionMemoryMax` spawns each agent in a systemd
// scope with a memory ceiling, so a runaway test suite takes down its own
// session — the ordinary "agent was terminated" path — and not the daemon.
//
// Pure where it can be. The file, the scope probe and the kill are the only
// side effects, and each takes what it touches as an argument.

import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Where a runner's note lives — one per runner id, because one machine may
 * run two configs. NOT in the run directory, which holds sockets and nothing
 * else (the terminal lists it to find daemons): beside it, so a test that
 * points CAWDEV_RUN_DIR at a temporary directory keeps its notes there too.
 */
export function drivingPath(runnerId, env = process.env) {
  const dir = env.CAWDEV_DRIVING_DIR
    ?? (env.CAWDEV_RUN_DIR ? `${env.CAWDEV_RUN_DIR}-driving` : join(homedir(), '.cawdev', 'driving'));
  return join(dir, `${runnerId}.json`);
}

/**
 * The note: who wrote it and what it was driving. `command` is the child's
 * command's base name, so the next daemon can tell its own orphan from an
 * unrelated process that was handed the same pid after a reboot.
 */
export function snapshotOf(pid, running) {
  const runs = [];
  for (const [id, child] of running) {
    runs.push({
      id,
      projectSlug: child?.cawdevProjectSlug ?? null,
      childPid: Number.isInteger(child?.pid) ? child.pid : null,
      command: child?.cawdevCommand ? basename(child.cawdevCommand) : null,
    });
  }
  return { pid, runs };
}

/** Atomic: a daemon killed mid-write must not leave half a note for the next one. */
export async function writeDriving(path, snapshot) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(temporary, path);
}

/** The previous note, or null — a missing or unreadable one is "nothing was being driven". */
export async function readDriving(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && Number.isInteger(parsed.pid) && Array.isArray(parsed.runs) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The runs a previous daemon left behind, or none.
 *
 * None when the note is this process's own, and none when its writer is
 * still alive: that is a second daemon on the same runner id, and its runs
 * are its own business.
 */
export function leftBehind(previous, myPid, isAlive) {
  if (!previous || previous.pid === myPid || isAlive(previous.pid)) {
    return [];
  }
  return previous.runs.filter((run) => typeof run.id === 'string' && run.projectSlug);
}

/** Whether a pid is a live process. Signal 0 tests without sending. */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (failure) {
    return failure.code === 'EPERM';
  }
}

/** Live states a restart does not concern: they hold no process. */
const NOT_DRIVEN = new Set(['QUEUED', 'PAUSED', 'USAGE_LIMITED']);

/**
 * Whether the platform's view of a run means a restart killed it: live,
 * holding a process, and still this runner's. A run carried on elsewhere in
 * the meantime is not ours to fail.
 */
export function killedByRestart(run, runnerId) {
  return Boolean(run?.live)
    && !NOT_DRIVEN.has(run.state)
    && (!run.runnerId || run.runnerId === runnerId);
}

/**
 * What the run says — the cause, the evidence to look for, and the way out.
 * `stopped` is the signal a daemon that stopped ON PURPOSE wrote into its
 * note; without one it was killed, and memory is the usual reason.
 */
export function restartSummary({ name, previousPid, pid, orphanStopped, stopped = null }) {
  const why = stopped
    ? `It was stopped (${stopped}) — by somebody, or by the service manager restarting it.`
    : 'Most often the machine ran out of memory — `journalctl -k | grep -i "killed process"` '
      + 'says so on Linux; `sessionMemoryMax` in the runner config keeps a session from taking '
      + 'the daemon with it.';
  return `The cawdev daemon on ${name} restarted while driving this run (it was pid `
    + `${previousPid}; it is pid ${pid} now), and the agent session went with it. ${why}`
    + (orphanStopped ? ' The session it left running unattended has been stopped.' : '')
    + ' The workspace is kept with whatever the session had written: carry it on there, or '
    + 'discard it.';
}

// --- the memory ceiling ----------------------------------------------------

/**
 * `sessionMemoryMax` as systemd reads it — `6G`, `512M`, `75%` — or null.
 * Anything else is null, and the daemon says so rather than guessing.
 */
export function memoryMaxOf(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  return /^\d+(\.\d+)?[KMGT]?$|^\d+(\.\d+)?%$/i.test(text) ? text.toUpperCase() : null;
}

/**
 * The command line that runs `command args` under the ceiling — or the same
 * command line, when there is no ceiling to apply. `systemd-run --scope` execs
 * the command in place, so the pid, the process group and the pipes are the
 * agent's own: cancelling (`kill(-pid)`) and the stream readers do not change.
 */
export function scoped(command, args, scope) {
  if (!scope?.memoryMax) {
    return { command, args };
  }
  return {
    command: 'systemd-run',
    args: [`--${scope.manager}`, '--scope', '--quiet', '--collect', '--no-ask-password',
      '-p', `MemoryMax=${scope.memoryMax}`, '--', command, ...args],
  };
}

/**
 * Whether this machine can apply the ceiling: Linux, and a systemd that will
 * make a scope for this user. Tried with `true` once at boot, because a
 * daemon run as a system service has no user manager and every spawn would
 * otherwise fail on a command that cannot work here.
 */
export async function probeScope(memoryMax, { platform = process.platform, run = runQuietly } = {}) {
  if (!memoryMax) return { scope: null, why: null };
  if (platform !== 'linux') {
    return { scope: null, why: `sessionMemoryMax needs Linux and systemd; this is ${platform}` };
  }
  for (const manager of ['user', 'system']) {
    const code = await run('systemd-run',
      [`--${manager}`, '--scope', '--quiet', '--collect', '--no-ask-password',
        '-p', `MemoryMax=${memoryMax}`, 'true']);
    if (code === 0) {
      return { scope: { manager, memoryMax }, why: null };
    }
  }
  return {
    scope: null,
    why: 'systemd-run could not make a scope here (no user manager — `loginctl enable-linger` '
      + 'for this user, or run the daemon as root)',
  };
}

function runQuietly(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code));
  });
}
