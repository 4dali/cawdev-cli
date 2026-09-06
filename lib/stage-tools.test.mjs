// node --test tools/lib/stage-tools.test.mjs
//
// R112 — the claim the whole entry rests on, checked as what it actually is: a
// claim about a list of strings.
//
// R109 gave a run stages and handed them to the session as an INSTRUCTION. This
// is the fix, and it is R28's fix: the narrowing is in what the process is
// spawned with. So the thing to test is not that a session behaved — it is that
// the list a planning stage is spawned with contains nothing that can write.

import assert from 'node:assert/strict';
import test from 'node:test';

import { GIT_READS, canChangeThings, toolsForStage } from './stage-tools.mjs';

/** What a CODE run's profile allows, near enough for these. */
const CODING = [
  'mcp__cawdev__task_current',
  'mcp__cawdev__report',
  'mcp__cawdev__roadmap_create',
  'Read', 'Grep', 'Glob',
  'Write', 'Edit',
  'Bash(git *)',
  'Bash(npm *)',
];

test('a PLAN stage has nothing that can change anything', () => {
  // THE claim. If this ever passes something writeable, a planning session can
  // start editing and the gate is decoration.
  for (const tool of toolsForStage('PLAN', CODING)) {
    assert.equal(canChangeThings(tool), false, `PLAN was given ${tool}`);
  }
});

test('a PLAN stage can still READ, or it cannot plan', () => {
  const tools = toolsForStage('PLAN', CODING);
  for (const needed of ['Read', 'Grep', 'Glob', 'mcp__cawdev__task_current']) {
    assert.ok(tools.includes(needed), `PLAN cannot ${needed}`);
  }
});

test('VERIFY and MEMORY are read-only too', () => {
  for (const stage of ['VERIFY', 'MEMORY']) {
    for (const tool of toolsForStage(stage, CODING)) {
      assert.equal(canChangeThings(tool), false, `${stage} was given ${tool}`);
    }
  }
});

test('IMPLEMENT and TEST get the profile, unchanged', () => {
  // A stage is not the place to widen or narrow what a profile decided.
  assert.deepEqual(toolsForStage('IMPLEMENT', CODING), CODING);
  assert.deepEqual(toolsForStage('TEST', CODING), CODING);
});

test('a stage can never be given what the PROFILE would refuse', () => {
  // Narrowed, never widened. An interview's stages get an interview's tools.
  const interview = ['Read', 'Write(docs/brief/**)', 'mcp__cawdev__report'];
  for (const stage of ['PLAN', 'VERIFY', 'IMPLEMENT', 'TEST', 'MEMORY']) {
    for (const tool of toolsForStage(stage, interview)) {
      assert.ok(interview.includes(tool) || GIT_READS.includes(tool),
        `${stage} invented ${tool}`);
    }
  }
});

test('a read-only stage keeps git reads, but only if the profile had git', () => {
  // `git diff` is how a plan finds out what changed. But a profile with no git
  // at all must not acquire it by being staged.
  assert.ok(toolsForStage('PLAN', CODING).includes('Bash(git diff *)'));
  assert.deepEqual(
    toolsForStage('PLAN', ['Read']).filter((tool) => tool.startsWith('Bash')),
    [],
  );
});

test('an unknown stage gets the profile rather than nothing', () => {
  // A rollback must not turn into a run that can do nothing and cannot say why.
  assert.deepEqual(toolsForStage('WHATEVER', CODING), CODING);
});

test('canChangeThings judges Bash by its pattern, not by its name', () => {
  // The one that has to be judged: `Bash(git *)` can commit, `Bash(git diff *)`
  // cannot, and both start with the same four characters.
  assert.equal(canChangeThings('Bash(git *)'), true);
  assert.equal(canChangeThings('Bash(git diff *)'), false);
  assert.equal(canChangeThings('Bash(rm *)'), true);
});

test('a writer this version has never heard of is still refused', () => {
  // Recognised by SHAPE, not by a list of names that goes stale the day the CLI
  // ships a new tool — and goes stale silently, which is the worst kind.
  assert.equal(canChangeThings('WriteMany'), true);
  assert.equal(canChangeThings('NotebookEdit'), true);
  assert.equal(canChangeThings('mcp__something__roadmap_create'), true);
  assert.equal(canChangeThings('Read'), false);
});

// --- delegation is a writer, and a read-only stage must not hold it -----------
//
// R104's experts are reached with the `Agent` tool (`Task` on older builds).
// It looks like a reader and is the loudest writer there is: it spawns a
// subagent with its OWN tool list, so a PLAN stage holding it could write every
// file it was carefully not given a tool for, through a helper. R112's whole
// claim is that a planning stage cannot write.

test('a read-only stage cannot delegate its way around its own tool list', () => {
  const profile = ['Read', 'Grep', 'Write', 'Agent', 'mcp__cawdev__report'];

  for (const stage of ['PLAN', 'VERIFY', 'MEMORY']) {
    const tools = toolsForStage(stage, profile);
    assert.ok(!tools.includes('Agent'),
      `${stage} kept Agent, so "cannot write" is one delegation away from false`);
    assert.ok(!tools.includes('Write'), `${stage} kept Write`);
    assert.ok(tools.includes('Read'), `${stage} lost a reader`);
  }
});

test('the stages that do the work keep it', () => {
  const profile = ['Read', 'Write', 'Agent'];

  for (const stage of ['IMPLEMENT', 'TEST']) {
    assert.deepEqual(toolsForStage(stage, profile), profile,
      `${stage} is where an expert was always meant to be reached from`);
  }
});

test('both names for the delegation tool are recognised', () => {
  // `Agent` on Claude Code 2.1.263, `Task` on older builds. A machine on an
  // older CLI must not get a PLAN stage that can write.
  assert.equal(canChangeThings('Agent'), true);
  assert.equal(canChangeThings('Task'), true);
  // And the shape holds for anything the CLI names next in that family.
  assert.equal(canChangeThings('Agent(reviewer)'), true);
  // Without swallowing a reader whose name merely starts the same way.
  assert.equal(canChangeThings('AgentListReadOnly'), false,
    'the boundary is there so a future reader is not refused by accident');
});
