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
import { capabilityIn, describeCall, describeInput } from './tool-line.mjs';

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

/**
 * R161's reader — the third one of the contract this file's header describes.
 *
 * Against the strings `describeCall` above ACTUALLY writes, and not against
 * strings invented here: the daemon asks this "has the stage used the thing the
 * project requires", and a reader that agreed with a hand-written example but
 * not with the formatter would nudge a session that had done what it was asked.
 */
test('capabilityIn reads back what describeCall wrote', () => {
  assert.deepEqual(capabilityIn(describeCall('Skill', { skill: 'cawdev:dataviz', args: 'a bar chart' })),
    { kind: 'SKILL', key: 'cawdev:dataviz' });
  assert.deepEqual(capabilityIn(describeCall('Agent',
    { subagent_type: 'cawdev:architect', description: 'read the diff' })),
  { kind: 'EXPERT', key: 'cawdev:architect' });
  // `Task` is normalised to `Agent` by describeCall, so that is all this sees.
  assert.deepEqual(capabilityIn(describeCall('Task', { subagent_type: 'cawdev:planner' })),
    { kind: 'EXPERT', key: 'cawdev:planner' });
});

test('capabilityIn on the literal shapes, which is what a transcript holds', () => {
  assert.deepEqual(capabilityIn('Skill(cawdev:dataviz) a bar chart'),
    { kind: 'SKILL', key: 'cawdev:dataviz' });
  assert.deepEqual(capabilityIn('Agent(cawdev:architect) read the diff'),
    { kind: 'EXPERT', key: 'cawdev:architect' });
});

test('everything that is not a capability call is null, not a guess', () => {
  // Silence is required of this. A line that produced a key would have the
  // daemon believing a stage had used something it never touched.
  assert.equal(capabilityIn('Bash git status'), null);
  assert.equal(capabilityIn('Read src/main/java/Foo.java'), null);
  // What an OLD daemon wrote, before R130 named the capability. It must not
  // match — see this file's header.
  assert.equal(capabilityIn('Agent {"description":"read the diff"}'), null);
  assert.equal(capabilityIn('Skill {"args":"nothing named"}'), null);
  assert.equal(capabilityIn(''), null);
  assert.equal(capabilityIn(null), null);
  assert.equal(capabilityIn(undefined), null);
});
