// node --test tools/lib/version.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cliVersion, isBelow } from './version.mjs';

test('reads this package\'s own version', async () => {
  const version = await cliVersion();
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test('below, equal, and above', () => {
  assert.equal(isBelow('0.9.0', '1.0.0'), true);
  assert.equal(isBelow('1.0.0', '1.0.0'), false);
  assert.equal(isBelow('1.1.0', '1.0.0'), false);
  assert.equal(isBelow('1.0.0', '1.0.1'), true);
  assert.equal(isBelow('0.9.9', '0.10.0'), true, 'compares numerically, not lexically');
});

test('no minimum set means nothing is below it', () => {
  assert.equal(isBelow('0.0.1', null), false);
  assert.equal(isBelow('0.0.1', ''), false);
  assert.equal(isBelow('0.0.1', '   '), false);
});

test('a version neither side can parse is never treated as too old', () => {
  assert.equal(isBelow('unknown', '1.0.0'), false);
  assert.equal(isBelow('1.0.0', 'not-a-version'), false);
});

test('a pre-release suffix still compares on its numeric prefix', () => {
  assert.equal(isBelow('1.0.0-beta.1', '1.0.0'), false);
  assert.equal(isBelow('0.9.0-beta.1', '1.0.0'), true);
});
