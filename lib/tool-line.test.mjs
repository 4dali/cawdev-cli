// node --test tools/lib/tool-line.test.mjs
//
// The RUNNER's half of R130's parsing contract.
//
// These exact strings are parsed by two other files, and this is the table all
// three are written against:
//
//   - backend/src/main/java/dev/caw/cawdev/run/CapabilityUse.java, whose
//     CapabilityUseTest carries the same examples;
//   - frontend/src/app/runs/capability-tag.ts, whose capability-tag.spec.ts
//     carries them too.
//
// Change a string here and change both. The fall-through case matters as much
// as the two named ones: every other tool must be written byte-identically to
// the way it was before R130, because `driftedFrom` in stage-tools.mjs reads
// the tool name off the front of a TOOL body.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeCall, describeInput } from './tool-line.mjs';

test('a skill call names the skill', () => {
  assert.equal(describeCall('Skill', { skill: 'dataviz' }), 'Skill(dataviz)');
});

test('a skill call carries its arguments, trimmed', () => {
  assert.equal(describeCall('Skill', { skill: 'dataviz', args: '  a bar chart  ' }),
    'Skill(dataviz) a bar chart');
  const long = 'x'.repeat(400);
  const line = describeCall('Skill', { skill: 'dataviz', args: long });
  assert.equal(line, `Skill(dataviz) ${'x'.repeat(120)}`);
});

test('a delegation names the expert and what it was asked', () => {
  assert.equal(
    describeCall('Agent', { subagent_type: 'code-reviewer', description: 'read the diff' }),
    'Agent(code-reviewer) read the diff');
});

test('Task is written as Agent', () => {
  // One vocabulary. An older CLI calling this `Task` must not put the same
  // expert on the panel twice under two spellings — see DELEGATE in runner.mjs.
  assert.equal(describeCall('Task', { subagent_type: 'code-reviewer' }),
    'Agent(code-reviewer)');
});

test('a delegation with nobody named still parses', () => {
  assert.equal(describeCall('Agent', { description: 'do a thing' }),
    'Agent(unnamed) do a thing');
});

test('a Skill call with no skill falls through rather than writing Skill()', () => {
  // `Skill()` would parse into a ledger row with an empty key. The honest
  // answer to a call this file does not recognise is the generic shape.
  assert.equal(describeCall('Skill', { args: 'nothing named' }),
    'Skill {"args":"nothing named"}');
});

test('every other tool is written exactly as it was before R130', () => {
  assert.equal(describeCall('Read', { file_path: 'src/main/java/Foo.java' }),
    'Read src/main/java/Foo.java');
  assert.equal(describeCall('Bash', { command: 'git status' }), 'Bash git status');
  assert.equal(describeCall('mcp__codegraph__explore', { query: 'src/main/java' }),
    'mcp__codegraph__explore src/main/java');
  // And the name alone when there is nothing worth saying about the input,
  // which is what `.trim()` is for.
  assert.equal(describeCall('TodoWrite', null), 'TodoWrite');
});

test('describeInput is unchanged', () => {
  assert.equal(describeInput({ file_path: 'a.txt' }), 'a.txt');
  assert.equal(describeInput({ number: 130 }), '130');
  assert.equal(describeInput({ whatever: 'else' }), '{"whatever":"else"}');
  assert.equal(describeInput(null), '');
  const big = describeInput({ whatever: 'x'.repeat(500) });
  assert.equal(big.length, 200);
  assert.ok(big.endsWith('…'));
});
