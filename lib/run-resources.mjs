// What a run takes from the machine it runs on — R643.
//
// Every stage is spawned `detached`, so it leads a process group of its own
// and the group id is the child's pid (the daemon already stops a stage by
// signalling `-pid`). That group is what is measured here: the CPU time and
// resident memory of every process in it, and how many there are.
//
// Two sources, and the better one wins:
//
//   - **cgroup** (Linux, under `sessionMemoryMax`): the stage runs in a
//     `systemd-run --scope`, and the kernel already counts that scope exactly —
//     a peak no sampling interval can miss, and the CPU of processes that have
//     already exited or `setsid`-ed out of the group. Read only when the
//     group leader's cgroup IS such a scope; the daemon's own cgroup is shared
//     with everything else the daemon runs and would be a lie.
//   - **ps**: everywhere else. `ps -A` once per sample, summed per group. It
//     misses a spike between samples, counts only processes alive now (so the
//     CPU of a stage's finished children is lost) and double-counts shared
//     pages. Approximate, and the reading says which source it came from.
//
// Neither sees containers a run asks dockerd for (Testcontainers, docker
// build): they are dockerd's children, not the run's. The console says so.
//
// The parsing is pure and tested; `sample` is the plumbing around it.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/**
 * `ps`'s cumulative CPU time in seconds. macOS writes `M:SS.ss`, procps
 * `[[DD-]HH:]MM:SS`; both are colon-separated from the right, with an
 * optional `DD-` day prefix. Null for anything else.
 */
export function cpuSecondsOf(text) {
  const trimmed = String(text ?? '').trim();
  const match = /^(?:(\d+)-)?([\d:.]+)$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const parts = match[2].split(':');
  if (parts.length > 3 || parts.some((part) => part === '' || Number.isNaN(Number(part)))) {
    return null;
  }
  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + Number(part);
  }
  return seconds + (match[1] ? Number(match[1]) * 86_400 : 0);
}

/**
 * `ps -A -o pgid=,rss=,time=` → Map of pgid → {cpuSeconds, rssBytes,
 * processes}, for the groups asked about only. `rss` is in KiB on both
 * platforms. A line that does not parse is skipped, not guessed.
 */
export function groupsFromPs(output, pgids) {
  const wanted = new Set(pgids.map(Number));
  const groups = new Map();
  for (const line of String(output ?? '').split('\n')) {
    const [pgidText, rssText, timeText] = line.trim().split(/\s+/);
    const pgid = Number(pgidText);
    if (!wanted.has(pgid)) {
      continue;
    }
    const rss = Number(rssText);
    const cpu = cpuSecondsOf(timeText);
    if (!Number.isFinite(rss) || cpu === null) {
      continue;
    }
    const group = groups.get(pgid) ?? { cpuSeconds: 0, rssBytes: 0, processes: 0 };
    group.cpuSeconds += cpu;
    group.rssBytes += rss * 1024;
    group.processes += 1;
    groups.set(pgid, group);
  }
  return groups;
}

/**
 * The cgroup v2 path of a process, from `/proc/<pid>/cgroup`, when it is a
 * transient systemd scope (`…/run-….scope`) — what `systemd-run --scope`
 * makes. Anything else is shared with the daemon and is not the run's.
 */
export function scopeOf(procCgroup) {
  for (const line of String(procCgroup ?? '').split('\n')) {
    const match = /^0::(\/.*)$/.exec(line.trim());
    if (match && /\/run-[^/]+\.scope$/.test(match[1])) {
      return match[1];
    }
  }
  return null;
}

/** `cpu.stat`'s `usage_usec`, in seconds, or null. */
export function cpuSecondsOfCpuStat(text) {
  const match = /^usage_usec\s+(\d+)$/m.exec(String(text ?? ''));
  return match ? Number(match[1]) / 1_000_000 : null;
}

function intOf(text) {
  const value = Number(String(text ?? '').trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * One run's running total across its stages.
 *
 * A stage is a new process group, so `ps` CPU restarts at zero with each one.
 * The tracker keeps what earlier groups had reached, adds it under the current
 * one, and holds the peak memory it has seen. `observe` takes the group's
 * reading and returns what is sent.
 */
export class RunTracker {
  constructor() {
    this.earlierCpu = 0;
    this.pgid = null;
    this.lastCpu = 0;
    this.peakRssBytes = 0;
  }

  observe(pgid, reading, at = new Date()) {
    if (pgid !== this.pgid) {
      this.earlierCpu += this.lastCpu;
      this.pgid = pgid;
      this.lastCpu = 0;
    }
    // CPU only rises; a group whose busiest child has just exited reads lower
    // under `ps`, and the total must not go backwards.
    this.lastCpu = Math.max(this.lastCpu, reading.cpuSeconds);
    this.peakRssBytes = Math.max(this.peakRssBytes, reading.rssBytes, reading.peakRssBytes ?? 0);
    return {
      cpuSeconds: Math.round((this.earlierCpu + this.lastCpu) * 10) / 10,
      rssBytes: reading.rssBytes,
      peakRssBytes: this.peakRssBytes,
      processes: reading.processes,
      source: reading.source,
      sampledAt: at.toISOString(),
    };
  }
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out : null));
  });
}

async function fromCgroup(pid) {
  const procCgroup = await readFile(`/proc/${pid}/cgroup`, 'utf8').catch(() => null);
  const scope = scopeOf(procCgroup);
  if (!scope) {
    return null;
  }
  const base = `/sys/fs/cgroup${scope}`;
  const read = (name) => readFile(`${base}/${name}`, 'utf8').catch(() => null);
  const [current, peak, cpuStat, pids] = await Promise.all([
    read('memory.current'), read('memory.peak'), read('cpu.stat'), read('pids.current'),
  ]);
  const rssBytes = intOf(current);
  const cpuSeconds = cpuSecondsOfCpuStat(cpuStat);
  if (rssBytes === null || cpuSeconds === null) {
    return null;
  }
  return {
    cpuSeconds,
    rssBytes,
    peakRssBytes: intOf(peak) ?? rssBytes,
    processes: intOf(pids) ?? 0,
    source: 'cgroup',
  };
}

/**
 * One reading per process group asked about: Map of pgid → reading. A group
 * with no process left is absent. Never throws: a machine where `ps` fails
 * simply reports nothing, which the platform shows as no reading.
 */
export async function sample(pgids, { platform = process.platform } = {}) {
  const readings = new Map();
  if (pgids.length === 0) {
    return readings;
  }
  const rest = [];
  if (platform === 'linux') {
    await Promise.all(pgids.map(async (pgid) => {
      const reading = await fromCgroup(pgid).catch(() => null);
      if (reading) {
        readings.set(pgid, reading);
      } else {
        rest.push(pgid);
      }
    }));
  } else {
    rest.push(...pgids);
  }
  if (rest.length > 0) {
    const output = await run('ps', ['-A', '-o', 'pgid=,rss=,time=']);
    for (const [pgid, group] of groupsFromPs(output, rest)) {
      readings.set(pgid, { ...group, source: 'ps' });
    }
  }
  return readings;
}
