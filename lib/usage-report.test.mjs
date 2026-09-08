// node --test tools/lib/usage-report.test.mjs
//
// Reading somebody else's prose, which is the thing that changes without
// warning. R73 was written when the CLI would not answer this at all, and
// `usage-limit.mjs` was already caught once by a reworded sentence — "session
// limit" where it expected "usage limit" — so what is pinned here is not only
// that today's output parses, but that tomorrow's failure is SILENCE rather
// than an invented number on a page somebody decides from.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUsage } from './usage-report.mjs';

/** Exactly what `claude -p "/usage"` printed on 2.1.263. */
const REAL = `You are currently using your subscription to power your Claude Code usage

Current session: 25% used · resets Sep 8 at 11pm (Africa/Tunis)
Current week (all models): 51% used · resets Sep 11 at 2pm (Africa/Tunis)
Current week (Fable): 28% used · resets Sep 11 at 2pm (Africa/Tunis)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 944 requests · 15 sessions
  78% of your usage was at >150k context
  14% of your usage was while 4+ sessions ran in parallel
  Top MCP servers: claude-in-chrome 19%, cawdev 3%`;

const NOW = new Date('2026-09-08T16:00:00');

test('the three windows the CLI actually reports', () => {
  const windows = parseUsage(REAL, NOW);
  assert.equal(windows.length, 3);

  assert.deepEqual(
    windows.map((each) => [each.kind, each.model, each.percent]),
    [['FIVE_HOUR', null, 25], ['WEEKLY', null, 51], ['WEEKLY', 'Fable', 28]],
  );
});

test('"all models" is the absence of a model, not a model called that', () => {
  // The weekly window and the weekly-window-for-one-model are different rows,
  // and telling them apart by a null is what lets the console draw one meter
  // per window without inventing a model name nobody uses.
  const [, week, fable] = parseUsage(REAL, NOW);
  assert.equal(week.model, null);
  assert.equal(fable.model, 'Fable');
});

test('the reset time is read in the machine\'s own zone', () => {
  // The CLI prints the zone it chose for a person — this machine's — and the
  // daemon runs on this machine. Parsing locally is right; converting a value
  // to itself could only introduce error.
  const [session] = parseUsage(REAL, NOW);
  assert.equal(session.resetsAt.getHours(), 23);
  assert.equal(session.resetsAt.getDate(), 8);
});

test('a date already past is next year, not ten months ago', () => {
  const said = 'Current week (all models): 10% used · resets Jan 2 at 9am';
  const [week] = parseUsage(said, new Date('2026-12-30T12:00:00'));
  assert.equal(week.resetsAt.getFullYear(), 2027);
});

test('prose with percentages in it is not a window', () => {
  // The report's own explanation is full of numbers — "78% of your usage was
  // at >150k context" — and reading one as a limit would put a number on the
  // page that means something else entirely.
  const windows = parseUsage(REAL, NOW);
  assert.ok(windows.every((each) => each.percent !== 78));
  assert.ok(windows.every((each) => each.percent !== 14));
});

test('a CLI that has changed its mind yields nothing, not a guess', () => {
  // The failure this is designed for. `usage-limit.mjs` was caught by exactly
  // this once, and the cost of guessing here is worse: a wrong percentage is
  // believed, where a missing one is visibly missing.
  for (const said of [
    '',
    null,
    undefined,
    'Usage: claude [options]',
    'Error: unknown command "/usage"',
    'You are currently using your subscription to power your Claude Code usage',
  ]) {
    assert.deepEqual(parseUsage(said, NOW), [], `read something out of: ${said}`);
  }
});

test('a percentage outside 0-100 is not a percentage', () => {
  assert.deepEqual(parseUsage('Current session: 4000% used', NOW), []);
  assert.deepEqual(parseUsage('Current session: -5% used', NOW), []);
});

test('a window with no reset time is still a window', () => {
  // Half an answer is worth reporting: the percentage is the part somebody
  // acts on, and "when does it come back" being unknown is not a reason to
  // discard "how much is left".
  const [only] = parseUsage('Current session: 40% used', NOW);
  assert.equal(only.percent, 40);
  assert.equal(only.resetsAt, null);
});
