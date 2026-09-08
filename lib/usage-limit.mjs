// Recognising that Claude's usage window closed — R73.
//
// A run that hits the five-hour or weekly window exits non-zero, and without
// this the runner reports what it always reports and the card reads FAILED:
// the same word as a compile error. The clock said no; the work did not.
//
// Pure, and per-provider by design: this is the Claude Code adapter's half of
// R20's seam. A second CLI (R17) supplies its own recogniser or none, and none
// means the old FAILED behaviour — a run is never called usage-limited on a
// guess.
//
// The shapes below are what the CLI has actually printed. Matching is
// deliberately narrow: "limit" alone appears in ordinary output ("rate limit
// on the API", "limit the scope"), and calling a real failure a usage limit
// would hide a broken run behind a friendly label.

// `session limit` is what the CLI actually printed on 2026-09-08, and none of
// the patterns before it matched: "You've hit your session limit · resets 6pm
// (Africa/Tunis)" is neither "usage limit" nor "limit reset" — a middle dot
// sits where the space would have been. The run was marked FAILED, which is
// the word for a crash, and R73 exists precisely so that a clock is not called
// a crash.
//
// `(usage |session )?` rather than a fourth alternative, because these are one
// phrase the vendor rewords: `hit your limit`, `hit your usage limit`, `hit
// your session limit`. A list of exact sentences goes stale the next time
// somebody edits a string, and goes stale SILENTLY — the failure mode is a
// run that reads as broken.
const FIVE_HOUR =
  /(5|five)[- ]hour|(usage|session) limit reached|you(?:.ve| have|ve) (?:hit|reached) your (?:usage |session )?limit|limit\s*\W?\s*(will )?resets?/i;
const WEEKLY = /weekly (usage )?limit|this week.s limit/i;

/**
 * `resets at 3:00 PM`, `resets in 2h 15m`, `try again at 15:00 UTC`.
 * Whichever the CLI said; null when it said none. A time with no date is
 * taken as the next occurrence of it.
 */
function resetInstant(text, now) {
  const at = /(?:resets?|try again|available)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*(utc|z))?/i.exec(text);
  if (at) {
    let hour = Number(at[1]);
    const minute = Number(at[2] ?? 0);
    const half = (at[3] ?? '').toLowerCase();
    if (half === 'pm' && hour < 12) hour += 12;
    if (half === 'am' && hour === 12) hour = 0;
    const when = new Date(now);
    if (at[4]) {
      when.setUTCHours(hour, minute, 0, 0);
      if (when <= now) when.setUTCDate(when.getUTCDate() + 1);
    } else {
      when.setHours(hour, minute, 0, 0);
      if (when <= now) when.setDate(when.getDate() + 1);
    }
    return when;
  }
  const inFor = /(?:resets?|try again|available)\s+in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(text);
  if (inFor && (inFor[1] || inFor[2])) {
    const ms = (Number(inFor[1] ?? 0) * 60 + Number(inFor[2] ?? 0)) * 60_000;
    return new Date(now.getTime() + ms);
  }
  return null;
}

/**
 * What the session's last words say, or null.
 *
 * @returns `{ window: 'FIVE_HOUR' | 'WEEKLY', resetsAt: Date | null }`
 */
export function usageLimitOf(text, now = new Date()) {
  if (!text) {
    return null;
  }
  if (WEEKLY.test(text)) {
    return { window: 'WEEKLY', resetsAt: resetInstant(text, now) };
  }
  if (FIVE_HOUR.test(text)) {
    return { window: 'FIVE_HOUR', resetsAt: resetInstant(text, now) };
  }
  return null;
}
