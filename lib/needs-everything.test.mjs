// node --test tools/lib/needs-everything.test.mjs
//
// @author Claude Opus 5.5 (Claude Code)
// @author Moez Ben MBarka

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsEverything } from './agents.mjs';

const machine = {
  name: 'MBM Local Dev Runner', acceptsConsoleRules: false,
  configPath: '/Users/ben/.cawdev/local.config.json', consoleUrl: 'http://localhost:5200/',
};

test('a refused Codex dev says what to do, in steps, for this machine', () => {
  const said = needsEverything('codex', machine, { entryRef: 'R18', profile: 'CODE' });
  assert.match(said, /^Codex CLI cannot write code on this machine yet/);
  assert.match(said, /1\. On this machine: in the cawdev terminal press c → "Accept permission rules from the console" \(or "acceptsRulesFromConsole": true in \/Users\/ben\/\.cawdev\/local\.config\.json\)/);
  assert.match(said, /2\. On cawdev: http:\/\/localhost:5200\/settings\/runners → MBM Local Dev Runner → tick "Allow everything"/);
  assert.match(said, /3\. Start it again: \/new dev R18 --codex/);
  assert.match(said, /Or, without it: \/new dev R18 --claude — or keep Codex CLI for plans \(\/new plan R18 --codex\)/);
  assert.match(said, /run any command in its checkouts/, 'what allowing everything means');
});

test('a step already done says so rather than asking for it again', () => {
  const said = needsEverything('codex', { ...machine, acceptsConsoleRules: true }, { entryRef: 'R18', profile: 'CODE' });
  assert.match(said, /1\. ✓ This machine already accepts permission rules from the console\./);
  assert.doesNotMatch(said, /press c/);
});

test('Antigravity needs it even to read, and offers no plan-only way out', () => {
  const said = needsEverything('agy', machine, { entryRef: 'R3', profile: 'PLAN' }, { readsWithout: false });
  assert.match(said, /^Antigravity CLI cannot run on this machine yet/);
  assert.match(said, /Start it again: \/new plan R3 --agy/);
  assert.match(said, /Or, without it: \/new plan R3 --claude\.$/);
});
