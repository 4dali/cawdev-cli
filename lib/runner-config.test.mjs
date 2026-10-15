// node --test tools/lib/runner-config.test.mjs
//
// R294 — what a running daemon can take without a restart, as one pure answer.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOT_SWAPPABLE, normaliseConfigFile, reloadableFor, restartNeededFor } from './runner-config.mjs';

const BOOTED = {
  url: 'http://localhost:4200',
  name: 'laptop',
  token: 'cawdev_secret',
  projects: { cawdev: '/tmp/cawdev' },
  agentCommands: ['claude'],
  acceptsRulesFromConsole: false,
};

test('the same file needs nothing', () => {
  assert.deepEqual(restartNeededFor(BOOTED, { ...BOOTED }), []);
  assert.deepEqual(reloadableFor(BOOTED, { ...BOOTED }), []);
});

test('the three hot-swappable keys never need a restart, and are what a SIGHUP applies', () => {
  const edited = { ...BOOTED, agentCommands: ['claude', 'agy'], acceptsRulesFromConsole: true, grantable: ['Bash(npm *)'] };
  assert.deepEqual(restartNeededFor(BOOTED, edited), []);
  assert.deepEqual(reloadableFor(BOOTED, edited), ['agentCommands', 'grantable', 'acceptsRulesFromConsole']);
  assert.deepEqual([...HOT_SWAPPABLE], ['agentCommands', 'grantable', 'acceptsRulesFromConsole', 'autoWorkspaces']);
});

test('a project added, a workspace added, or the url changed needs a restart — names only, sorted', () => {
  const edited = {
    ...BOOTED,
    url: 'https://app.cawdev.com',
    projects: { cawdev: { workspaces: ['/tmp/cawdev', '/tmp/cawdev-2'] }, dycrypt: '/tmp/dycrypt' },
  };
  assert.deepEqual(restartNeededFor(BOOTED, edited), ['projects', 'url']);
});

test('a key added or removed is a difference either way', () => {
  assert.deepEqual(restartNeededFor(BOOTED, { ...BOOTED, browser: true }), ['browser']);
  const { token, ...without } = BOOTED;
  assert.deepEqual(restartNeededFor(BOOTED, without), ['token']);
});

test('the legacy agentCommand spelling is the same setting as agentCommands', () => {
  assert.deepEqual(normaliseConfigFile({ agentCommand: 'claude', name: 'x' }), { agentCommands: ['claude'], name: 'x' });
  assert.deepEqual(restartNeededFor({ ...BOOTED, agentCommands: undefined, agentCommand: 'claude' }, BOOTED), []);
  assert.deepEqual(reloadableFor({ agentCommand: 'claude' }, { agentCommands: ['claude'] }), []);
});

test('object key order is not a difference; a reverted edit clears the notice', () => {
  const reordered = { ...BOOTED, projects: { cawdev: { workspaces: ['/tmp/cawdev'], name: 'c' } } };
  const spelledOtherWay = { ...BOOTED, projects: { cawdev: { name: 'c', workspaces: ['/tmp/cawdev'] } } };
  assert.deepEqual(restartNeededFor(reordered, spelledOtherWay), []);
  // Booted with A, edited to B, edited back to A: compared against A, nothing.
  assert.deepEqual(restartNeededFor(BOOTED, { ...BOOTED, name: 'desk' }), ['name']);
  assert.deepEqual(restartNeededFor(BOOTED, { ...BOOTED, name: 'laptop' }), []);
});
