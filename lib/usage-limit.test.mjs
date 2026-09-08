// node --test tools/lib/usage-limit.test.mjs
//
// A usage-limit stop must not read as a crash, and a crash must not read as a
// usage limit. Both directions matter: the second hides a broken run behind a
// friendly label.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usageLimitOf } from './usage-limit.mjs';

const at = new Date('2026-09-04T10:00:00Z');

test('the five-hour window, with when it resets', () => {
  const out = usageLimitOf("You've hit your usage limit. Resets at 3:00 PM.", at);
  assert.equal(out.window, 'FIVE_HOUR');
  assert.ok(out.resetsAt instanceof Date);
});

test('the weekly window wins over the five-hour phrasing when both appear', () => {
  const out = usageLimitOf('Usage limit reached: weekly limit. Resets in 2h 30m.', at);
  assert.equal(out.window, 'WEEKLY');
  assert.equal(out.resetsAt.getTime(), at.getTime() + 150 * 60_000);
});

test('an ordinary failure is not a usage limit', () => {
  // "limit" on its own is in plenty of honest output. Calling this a usage
  // limit would hide a real failure.
  assert.equal(usageLimitOf('Error: rate limit on the API; retrying failed. Exit 1.', at), null);
  assert.equal(usageLimitOf('TypeError: cannot read properties of undefined', at), null);
  assert.equal(usageLimitOf('', at), null);
});

test('a reset the CLI did not state is null, not a guess', () => {
  const out = usageLimitOf('Usage limit reached.', at);
  assert.equal(out.window, 'FIVE_HOUR');
  assert.equal(out.resetsAt, null);
});

// --- what the CLI actually printed, 2026-09-08 --------------------------------

test('the CLI\'s "session limit" is a usage limit, not a crash', () => {
  // The sentence that started this: a run was marked FAILED — the word for a
  // crash — because none of the patterns knew "session". It is neither "usage
  // limit" nor "limit reset": a middle dot sits where the space would be.
  const said = "You've hit your session limit · resets 6pm (Africa/Tunis)";
  const limit = usageLimitOf(said, new Date('2026-09-08T15:00:00'));

  assert.ok(limit, 'the CLI said it had hit a limit and this did not hear it');
  assert.equal(limit.window, 'FIVE_HOUR');
  assert.equal(limit.resetsAt.getHours(), 18);
});

test('the same phrase, however the vendor words it', () => {
  // One phrase that gets reworded, not four sentences to enumerate. A list of
  // exact strings goes stale the next time somebody edits one, and goes stale
  // silently — the failure mode is a run that reads as broken.
  for (const said of [
    "You've hit your limit",
    "You've hit your usage limit",
    "You've hit your session limit",
    'You have reached your session limit',
    'session limit reached',
    'usage limit reached',
  ]) {
    assert.ok(usageLimitOf(said), `not heard: ${said}`);
  }
});

test('and still refuses the words that only look like it', () => {
  // The reason the matching was narrow in the first place. Calling a real
  // failure a usage limit hides a broken run behind a friendly label, and
  // AutoResumer would then pick it up again at the reset and fail it again.
  for (const said of [
    'rate limit on the API',
    'limit the scope of the change',
    'the test asserts a limit of 5',
    'ulimit -n',
  ]) {
    assert.equal(usageLimitOf(said), null, `wrongly heard: ${said}`);
  }
});
