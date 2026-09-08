// What `claude -p "/usage"` says about this machine's windows, as data.
//
// R73 concluded cawdev could not know these numbers — "the CLI reports its
// windows to a person more readily than to a program, so the one moment this
// daemon KNOWS a window is closed is when a run was refused" — and built the
// refusal path instead. That was true of the CLI it was written against. It is
// not true of 2.1.263, which answers `/usage` non-interactively:
//
//   Current session: 25% used · resets Sep 8 at 11pm (Africa/Tunis)
//   Current week (all models): 51% used · resets Sep 11 at 2pm (Africa/Tunis)
//   Current week (Fable): 28% used · resets Sep 11 at 2pm (Africa/Tunis)
//
// Pure, for `code-map.mjs`'s reason: the hard part here is reading somebody
// else's prose, and prose is the thing that changes without warning. It is
// testable without a CLI, and the tests are where the shapes actually seen get
// written down.
//
// TOLERANT ON PURPOSE, and in one direction. A line this cannot read is a line
// it drops; text that is not a usage report at all yields nothing rather than
// something. The alternative — guessing — puts an invented number on a page
// somebody makes decisions from, and R20's rule for the console is exactly
// this: show what the provider said, and blank when it said nothing.

/**
 * `25% used`, wherever in the line it sits.
 *
 * The lookbehind is doing real work: without it `4000%` matches its last three
 * digits and reads as 0%, and `-5%` reads as 5%. A number that is not a
 * percentage must not become a plausible one — 0% used is a sentence somebody
 * would act on.
 */
const PERCENT = /(?<![\d.-])(\d{1,3})\s*%/;

/**
 * `resets Sep 8 at 11pm (Africa/Tunis)`, `resets Sep 11 at 2pm`.
 *
 * The zone is captured and DELIBERATELY not applied: it is the zone the CLI
 * chose to print for a person, which is this machine's own, and this daemon
 * runs on that machine. Parsing in local time is therefore right, and pulling
 * in a timezone library to convert a value to itself would be work that can
 * only introduce error.
 */
const RESET = /resets?\s+(?:on\s+)?([A-Z][a-z]{2})\s+(\d{1,2})(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * When a window says it resets.
 *
 * <p>The CLI prints a month and a day and no year, so the year is inferred:
 * the next occurrence, which across a New Year means next year rather than a
 * reset ten months in the past.
 */
function resetAt(line, now) {
  const found = RESET.exec(line);
  if (!found) {
    return null;
  }
  const month = MONTHS.indexOf(found[1].toLowerCase());
  if (month === -1) {
    return null;
  }
  let hour = Number(found[3]);
  const minute = Number(found[4] ?? 0);
  const half = (found[5] ?? '').toLowerCase();
  if (half === 'pm' && hour < 12) hour += 12;
  if (half === 'am' && hour === 12) hour = 0;

  const when = new Date(now);
  when.setMonth(month, Number(found[2]));
  when.setHours(hour, minute, 0, 0);
  // A date that has already gone is next year's, not this year's.
  if (when.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
    when.setFullYear(when.getFullYear() + 1);
  }
  return when;
}

/**
 * One line's window.
 *
 * <p>`Current session` is the five-hour window and `Current week` the weekly
 * one; a parenthesised name after `week` is a MODEL, and `all models` is the
 * absence of one rather than a model called that. Told apart here rather than
 * by the caller, so "which window is this" has a single answer.
 */
function windowOf(label) {
  const lower = label.toLowerCase();
  if (lower.includes('session')) {
    return { kind: 'FIVE_HOUR', model: null };
  }
  if (!lower.includes('week')) {
    return null;
  }
  const named = /\(([^)]+)\)/.exec(label);
  const model = named ? named[1].trim() : null;
  return {
    kind: 'WEEKLY',
    model: !model || /^all models$/i.test(model) ? null : model,
  };
}

/**
 * Every window the report named.
 *
 * @returns `[{ kind, model, percent, resetsAt, label }]` — empty when the text
 *   was not a usage report, which is the answer for a CLI that has changed its
 *   output or refused the command.
 */
export function parseUsage(text, now = new Date()) {
  if (!text) {
    return [];
  }
  const windows = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    // The colon is what separates the window's name from its numbers, and its
    // absence is what tells a heading from a reading — the report's prose
    // ("What's contributing to your limits usage?") has percentages in it too.
    const at = line.indexOf(':');
    if (at === -1 || !/^current\b/i.test(line)) {
      continue;
    }
    const percent = PERCENT.exec(line.slice(at));
    const which = windowOf(line.slice(0, at));
    if (!percent || !which) {
      continue;
    }
    const value = Number(percent[1]);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      continue;
    }
    windows.push({
      ...which,
      percent: value,
      resetsAt: resetAt(line, now),
      label: line.slice(0, at).trim(),
    });
  }
  return windows;
}
