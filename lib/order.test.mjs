// node --test tools/lib/order.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { byCodeUnit } from './order.mjs';

const WORDS = ['b', 'a-b', 'ab', 'a.b', 'a_b', 'a1', 'a10', 'a9', 'B', 'pom.xml', 'secret/new.txt'];

test('byCodeUnit is the default string order, made explicit', () => {
  assert.deepEqual([...WORDS].sort(byCodeUnit), [...WORDS].sort());
});

test('localeCompare would order the same words differently, which is why it is not used', () => {
  assert.notDeepEqual([...WORDS].sort((a, b) => a.localeCompare(b)), [...WORDS].sort());
});
