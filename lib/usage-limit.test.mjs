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
