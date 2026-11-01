import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeCondition } from './gate-condition.mjs';

test('a count condition reads metric, actual, symbol, threshold', () => {
  assert.equal(describeCondition({ metric: 'new_violations', comparator: 'GT', threshold: '0', actual: '1287' }), 'new_violations 1287 > 0');
});

test('NE is spelled !=', () => {
  assert.equal(describeCondition({ metric: 'x', comparator: 'NE', threshold: '1', actual: '2' }), 'x 2 != 1');
});

test('an unknown comparator is printed as written', () => {
  assert.equal(describeCondition({ metric: 'x', comparator: 'WEIRD', threshold: '1', actual: '2' }), 'x 2 WEIRD 1');
});

test('a rating is read as letters', () => {
  assert.equal(describeCondition({ metric: 'new_reliability_rating', comparator: 'GT', threshold: '1', actual: '3' }), 'new_reliability_rating C worse than A');
});
