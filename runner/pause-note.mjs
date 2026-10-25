// What a queued run's note says when this machine is paused — R571.
//
// Pure, zero dependencies, so `node --test` pins the two sentences. There are
// two kinds of pause and they have different ways out: one a person made (R73:
// Settings → Machines, or `c` in an attached terminal) and one cawdev made for
// usage (R158: it lifts itself when the window resets, and a Resume would be
// undone within the minute while the machine is still over the line).
//
// The usage sentence is a second implementation of the console's
// (`runners/pause-words.ts`) across the zero-dependency boundary. Both read the
// server's `percent`, never recompute it.

/** The fullest whole window (no `model`) with a reading, or null. */
export function worstWindow(limits) {
  const whole = (Array.isArray(limits) ? limits : [])
    .filter((limit) => limit && !limit.model && Number.isFinite(limit.percent));
  if (!whole.length) {
    return null;
  }
  return whole.reduce((worst, each) => (each.percent > worst.percent ? each : worst));
}

/** `1h 20m` · `12m` · `under a minute`. */
export function inWords(ms) {
  if (!Number.isFinite(ms) || ms < 60_000) {
    return 'under a minute';
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  }
  return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * The queued line for a paused machine.
 *
 * @param {{ pausedByUsage?: boolean, limits?: object[] }} machine what the heartbeat said
 * @param {number} now milliseconds
 */
export function pausedNote({ pausedByUsage = false, limits = [] } = {}, now = Date.now()) {
  if (!pausedByUsage) {
    return 'this machine is paused from the console '
      + '(resume it on Settings → Machines, or press c)';
  }
  const worst = worstWindow(limits);
  if (!worst) {
    return 'cawdev paused this machine for usage — it resumes by itself when the window resets';
  }
  const name = worst.window === 'WEEKLY' ? 'weekly' : 'five-hour';
  const resets = worst.resetsAt ? Date.parse(worst.resetsAt) : NaN;
  const back = Number.isFinite(resets) ? `, back in ${inWords(resets - now)}` : '';
  return `cawdev paused this machine for usage: its ${name} window is at ${worst.percent}%${back}`
    + ' — it resumes by itself';
}

/**
 * The key a note changes on: the kind of pause, the window and its percent and
 * reset — never the minutes left, which would change the sentence every
 * heartbeat and make the log chatter.
 */
export function noteKey({ pausedByUsage = false, limits = [] } = {}) {
  if (!pausedByUsage) {
    return 'hand';
  }
  const worst = worstWindow(limits);
  return worst ? `usage:${worst.window}:${worst.percent}:${worst.resetsAt ?? ''}` : 'usage';
}

/**
 * The heartbeat's change line, or null when nothing about the pause moved.
 *
 * @param {{ paused: boolean, pausedByUsage: boolean }} before
 * @param {{ paused?: boolean, pausedByUsage?: boolean }} after
 */
export function pauseLogLine(before, after) {
  const paused = !!after.paused;
  const byUsage = paused && !!after.pausedByUsage;
  if (before.paused === paused && before.pausedByUsage === byUsage) {
    return null;
  }
  if (!paused) {
    return before.pausedByUsage
      ? 'cawdev lifted the usage pause: claiming again'
      : 'unpaused from the console';
  }
  return byUsage
    ? 'cawdev paused this machine for usage: claiming nothing new, finishing what is running'
    : 'paused from the console: claiming nothing new, finishing what is running';
}

/**
 * What the platform is told about a pause: nothing. The queued-reasons call is
 * served to EVERY project viewer as `queuedReason`, so the usage figures and
 * "press c" stay in this daemon's log and terminal; the platform says it
 * itself, per viewer, as `waitingOn` (R571).
 */
export function reportedPauseNote() {
  return null;
}
