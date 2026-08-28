// node --test tools/lib/usage.test.mjs
//
// The rule these guard: a transcript reports TOKENS, never dollars. The CLI's
// `total_cost_usd` is a list-price equivalent — the event says so with
// `costBasis: "list"` — so showing it to somebody on a subscription names a
// number they will never be charged.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeTurn, describeUsage, formatDuration, formatTokens } from './usage.mjs';

// A real result event, trimmed to the fields that matter.
const RESULT = {
  type: 'result',
  subtype: 'success',
  duration_ms: 781_000,
  total_cost_usd: 5.3692,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 12_400,
    cache_read_input_tokens: 226_180,
    output_tokens: 3100,
  },
  modelUsage: {
    'claude-opus-5[1m]': {
      inputTokens: 40,
      outputTokens: 12_800,
      cacheCreationInputTokens: 45_200,
      cacheReadInputTokens: 385_540,
    },
  },
};

test('a turn reports tokens, never a dollar figure', () => {
  const line = describeTurn(RESULT);

  assert.ok(!line.includes('$'), `a cost leaked into the transcript: ${line}`);
  assert.ok(!line.includes('5.3692'), line);
  assert.match(line, /in$|out|cached/);
});

test('the line says how it ended, how long it took, and what it used', () => {
  assert.equal(
    describeTurn(RESULT),
    'turn ended (success) in 13m · 12.4k in, 3.1k out, 226k cached, session 45.2k in, 12.8k out',
  );
});

test('input counts cache writes, which are input the model had to read', () => {
  const [first] = describeUsage({ usage: { input_tokens: 100, cache_creation_input_tokens: 900 } });

  assert.equal(first, '1.0k in');
});

test('session totals sum across models, so switching model keeps one total', () => {
  const parts = describeUsage({
    usage: { output_tokens: 1 },
    modelUsage: {
      opus: { inputTokens: 1000, outputTokens: 100 },
      sonnet: { inputTokens: 2000, outputTokens: 200 },
    },
  });

  assert.ok(parts.some((part) => part === 'session 3.0k in, 300 out'), parts.join(' | '));
});

test('a turn with no usage still says how it ended', () => {
  assert.equal(describeTurn({ subtype: 'error_max_turns' }), 'turn ended (error_max_turns)');
});

test('formatTokens keeps small numbers exact and abbreviates the rest', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1000), '1.0k');
  assert.equal(formatTokens(12_400), '12.4k');
  // A decimal on a big number is noise.
  assert.equal(formatTokens(226_180), '226k');
  assert.equal(formatTokens(2_400_000), '2.4M');
});

test('formatTokens survives what a malformed event hands it', () => {
  assert.equal(formatTokens(undefined), '0');
  assert.equal(formatTokens(-5), '0');
  assert.equal(formatTokens(Number.NaN), '0');
});

test('formatDuration reads at the precision that matters', () => {
  assert.equal(formatDuration(4_000), '4s');
  assert.equal(formatDuration(781_000), '13m');
  assert.equal(formatDuration(3_900_000), '1h 5m');
  assert.equal(formatDuration(undefined), null);
});
