// node --test tools/lib/background-shells.test.mjs
//
// @author Claude Opus 5.5 (Claude Code)
// @author Moez Ben MBarka

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackgroundShells } from './background-shells.mjs';

const call = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const answer = (id, content) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });

test('a command started in the background and never read is unfinished', () => {
  const shells = new BackgroundShells();
  shells.observe(call('t1', 'Bash', { command: 'npx ng test', run_in_background: true }));
  shells.observe(answer('t1', 'Command running in background with ID: bash_1'));
  shells.observe(call('t2', 'Bash', { command: 'git status' }));
  assert.deepEqual(shells.unfinished(), ['npx ng test'], 'a foreground command is not tracked');
});

test('a read that says it ended finishes it; one that says running does not', () => {
  const shells = new BackgroundShells();
  shells.observe(call('t1', 'Bash', { command: 'mvn test', run_in_background: true }));
  shells.observe(answer('t1', [{ type: 'text', text: 'Command running in background with ID: 7f3a' }]));
  shells.observe(call('r1', 'BashOutput', { bash_id: '7f3a' }));
  shells.observe(answer('r1', '<status>running</status>\n<stdout>Tests run: 12</stdout>'));
  assert.deepEqual(shells.unfinished(), ['mvn test'], 'still running when it was read');
  shells.observe(call('r2', 'BashOutput', { bash_id: '7f3a' }));
  shells.observe(answer('r2', '<status>completed</status>\n<exit_code>0</exit_code>'));
  assert.deepEqual(shells.unfinished(), []);
});

test('a killed command is over, and one whose id could not be read stays unfinished', () => {
  const shells = new BackgroundShells();
  shells.observe(call('t1', 'Bash', { command: 'ng build', run_in_background: true }));
  shells.observe(answer('t1', 'Command running in background with ID: b2'));
  shells.observe(call('k1', 'KillShell', { shell_id: 'b2' }));
  shells.observe(call('t2', 'Bash', { command: 'docker compose up', run_in_background: true }));
  shells.observe(answer('t2', 'started'));
  assert.deepEqual(shells.unfinished(), ['docker compose up']);
});

test('an agent delegated to in the background is unfinished until its notification arrives (R6)', () => {
  const shells = new BackgroundShells();
  shells.observe(call('a1', 'Agent', { description: 'R6 backend offline endpoint', subagent_type: 'general-purpose', prompt: '…', run_in_background: true }));
  shells.observe(answer('a1', 'Async agent launched successfully. agentId: ac64d435b50cbdaab (internal ID)'));
  shells.observe(call('a2', 'Agent', { description: 'R6 Android offline feedback', prompt: '…' }));
  shells.observe(answer('a2', [{ type: 'text', text: 'Async agent launched successfully. agentId: aa9f05d15e97c896f' }]));
  shells.observe(call('a3', 'Agent', { description: 'read the schema', prompt: '…' }));
  shells.observe(answer('a3', 'The schema has three tables.'));
  assert.deepEqual(shells.unfinished(), ['Agent: R6 backend offline endpoint', 'Agent: R6 Android offline feedback'],
    'launched in the background, whether the flag or the result says so; a foreground one is over when it answers');

  shells.observe({ type: 'user', message: { content: '<task-notification>\n<task-id>ac64d435b50cbdaab</task-id>\n<status>completed</status>\n</task-notification>' } });
  shells.observe({ type: 'user', message: { content: [{ type: 'text', text: '<task-notification><task-id>aa9f05d15e97c896f</task-id><status>running</status></task-notification>' }] } });
  assert.deepEqual(shells.unfinished(), ['Agent: R6 Android offline feedback']);
  shells.observe(call('s1', 'TaskStop', { task_id: 'aa9f05d15e97c896f' }));
  assert.deepEqual(shells.unfinished(), []);
});
