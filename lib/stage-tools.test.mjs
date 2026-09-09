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

import {
  CAWDEV_READS, GIT_READS, SUBAGENT_READS, canChangeThings, canRunThings, driftedFrom,
  readOnlyExpert, toolsForStage,
} from './stage-tools.mjs';

/** What a CODE run's profile allows, near enough for these. */
const CODING = [
  'mcp__cawdev__task_current',
  'mcp__cawdev__report',
  'mcp__cawdev__roadmap_create',
  'Read', 'Grep', 'Glob',
  'Write', 'Edit',
  'Bash(git *)',
  'Bash(npm *)',
  // R129 needs it in the fixture: "cannot run" is one delegation away from
  // false, so the list a testbook stage is spawned with has to be checked
  // against a profile that HAD the delegation tool.
  'Agent',
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

test('IMPLEMENT and TEST get the profile, less the one tool no stage may hold', () => {
  // A stage is not the place to widen or narrow what a profile decided — with
  // exactly one exception, and this test used to assert the bug instead of the
  // rule. `report` ends the RUN, so a stage holding it can finish the run in
  // the middle of the walk and leave every stage behind it SKIPPED. That is not
  // a narrowing of what the profile may do; it is the difference between a
  // stage and a run, which the profile's list cannot express.
  const staged = CODING.filter((tool) => tool !== 'mcp__cawdev__report');
  assert.deepEqual(toolsForStage('IMPLEMENT', CODING), staged);
  assert.deepEqual(toolsForStage('TEST', CODING), staged);
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
  // `report` still goes: an unknown stage is still a stage inside a walk, and
  // the reason it must not end the run does not depend on knowing its name.
  assert.deepEqual(toolsForStage('WHATEVER', CODING),
    CODING.filter((tool) => tool !== 'mcp__cawdev__report'));
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

// --- R129: a TEST stage that may WRITE and cannot RUN -------------------------
//
// The mirror of everything above. R112's claim is that a planning stage cannot
// change anything; this one is that a TEST stage set to write the testbook
// cannot run anything — including the suite it is describing, and including
// through a subagent. It still has to be able to WRITE, because the artefact it
// exists for is a file.

test('a TESTBOOK stage has nothing that can run anything', () => {
  // THE claim of the entry. If this ever passes something runnable, the stage
  // is "asked not to run the tests" and the setting is decoration.
  for (const tool of toolsForStage('TEST', CODING, 'TESTBOOK')) {
    assert.equal(canRunThings(tool), false, `a TESTBOOK stage was given ${tool}`);
  }
});

test('a TESTBOOK stage can still WRITE, or it cannot write a testbook', () => {
  const tools = toolsForStage('TEST', CODING, 'TESTBOOK');
  for (const needed of ['Write', 'Edit', 'Read']) {
    assert.ok(tools.includes(needed), `a TESTBOOK stage cannot ${needed}`);
  }
  // `report` is NOT in that list, and this is the one place the two entries
  // meet: narrowing what a stage may RUN is R129's question, and refusing every
  // stage the tool that ends the RUN is the other. A testbook stage that
  // reported done would finish the run before MEMORY, which is the failure that
  // made MEMORY run once in fifty.
  assert.ok(!tools.includes('mcp__cawdev__report'),
    'a TESTBOOK stage kept report, which ends the run rather than the stage');
});

test('a TESTBOOK stage keeps git reads, but only if the profile had git', () => {
  // `git diff` is how it finds out what the run it is describing changed. A
  // profile with no git at all must not acquire it by being staged.
  assert.ok(toolsForStage('TEST', CODING, 'TESTBOOK').includes('Bash(git diff *)'));
  assert.deepEqual(
    toolsForStage('TEST', ['Read'], 'TESTBOOK').filter((tool) => tool.startsWith('Bash')),
    [],
  );
});

test('a TESTBOOK stage cannot delegate its way to a shell', () => {
  const tools = toolsForStage('TEST', CODING, 'TESTBOOK');
  assert.ok(!tools.includes('Agent'),
    'a TESTBOOK stage kept Agent, so "cannot run" is one delegation away from false');
  assert.ok(!tools.includes('Bash(npm *)'), 'a TESTBOOK stage kept a way to run the suite');
  assert.ok(!tools.includes('Bash(git *)'), 'a TESTBOOK stage kept a shell that can commit');
});

test('RUN, and an old platform that sends no mode, change nothing', () => {
  // The default is the behaviour TEST has always had, and a platform that has
  // never heard of R129 sends no third argument at all.
  const staged = CODING.filter((tool) => tool !== 'mcp__cawdev__report');
  assert.deepEqual(toolsForStage('TEST', CODING, 'RUN'), staged);
  assert.deepEqual(toolsForStage('TEST', CODING), staged);
});

test('a mode on any other stage is ignored rather than obeyed', () => {
  // Only TEST has a mode. A caller that somehow sent one for IMPLEMENT must not
  // find it has quietly narrowed the stage that does the work.
  assert.deepEqual(toolsForStage('IMPLEMENT', CODING, 'TESTBOOK'),
    CODING.filter((tool) => tool !== 'mcp__cawdev__report'));
});

test('canRunThings is canChangeThings with the other question asked', () => {
  // Writers are NOT runners: a stage refused them could not produce the file it
  // exists for, which is the difference between the two filters.
  assert.equal(canRunThings('Write'), false);
  assert.equal(canRunThings('Edit'), false);
  assert.equal(canRunThings('Read'), false);
  assert.equal(canRunThings('mcp__cawdev__report'), false);
  // And everything that reaches a shell or spawns something is.
  assert.equal(canRunThings('Bash(npm test)'), true);
  assert.equal(canRunThings('Bash(git *)'), true);
  assert.equal(canRunThings('Bash(git diff *)'), false);
  assert.equal(canRunThings('Agent'), true);
  assert.equal(canRunThings('Task'), true);
});

test('drift is noticed when a TESTBOOK stage runs something', () => {
  // R113's cross-check, and it still never blocks — it returns a sentence.
  //
  // The lines are shaped as `linesOf` really writes them: `<tool name> <the
  // described input>`, so a shell call is the bare `Bash` and the command.
  const said = driftedFrom('TEST', 'Bash npm test --workspace frontend', 'TESTBOOK');
  assert.match(said, /TEST stage is set to write the testbook/);
  assert.match(said, /was not stopped/);

  assert.ok(driftedFrom('TEST', 'Agent run the suite', 'TESTBOOK'),
    'delegating to something with a shell is the drift worth noticing');

  // Writing is exactly what it was spawned able to do, so writing is not drift.
  assert.equal(driftedFrom('TEST', 'Write TESTBOOK.md', 'TESTBOOK'), null);
  assert.equal(driftedFrom('TEST', 'Read frontend/package.json', 'TESTBOOK'), null);
  // And nor is the `git diff` the stage is TOLD to use. A note that fired on
  // every testbook run would make nothing visible, which is its whole job.
  assert.equal(driftedFrom('TEST', 'Bash git diff --stat main', 'TESTBOOK'), null);
  assert.equal(driftedFrom('TEST', 'Bash git status', 'TESTBOOK'), null);
  // But not everything that merely mentions git: `git commit` is not a read.
  assert.ok(driftedFrom('TEST', 'Bash git commit -m wip', 'TESTBOOK'));

  // A TEST stage told to run the tests running them is the job, not drift.
  assert.equal(driftedFrom('TEST', 'Bash npm test', 'RUN'), null);
  assert.equal(driftedFrom('TEST', 'Bash npm test'), null);
});

test('R113\'s original note still says what it said', () => {
  // Widening `driftedFrom` for R129 must not change what it did for the three
  // read-only stages, which is the note R113 exists for.
  const said = driftedFrom('PLAN', 'Write src/main.ts');
  assert.match(said, /the PLAN stage called Write/);
  assert.match(said, /was not stopped/);
  assert.equal(driftedFrom('PLAN', 'Read src/main.ts'), null);
  assert.equal(driftedFrom('IMPLEMENT', 'Write src/main.ts'), null);
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

test('a skill is not a writer, and delegation is — R130', () => {
  // The two look alike and are not the same fact, so both are pinned here
  // against a later tidy-up that makes them agree.
  //
  // `Agent` spawns a subagent with its OWN tool list, so a stage holding it can
  // write through a helper. `Skill` loads a body of INSTRUCTIONS into the
  // session that called it: it grants no tool, and a session holding `Skill`
  // and no `Write` still cannot write. Making it a writer would strip skills
  // from PLAN and VERIFY — the two stages that read and think, which is most of
  // what a skill is for.
  assert.equal(canChangeThings('Agent'), true);
  assert.equal(canChangeThings('Skill'), false);

  const profile = ['Read', 'Write', 'Agent', 'Skill'];
  for (const stage of ['PLAN', 'VERIFY', 'MEMORY']) {
    const tools = toolsForStage(stage, profile);
    assert.ok(tools.includes('Skill'), `${stage} lost Skill, which grants nothing`);
    assert.ok(!tools.includes('Agent'), `${stage} kept Agent`);
  }
});

// --- cawdev's own registry is judged by a list, not by the shape of a name ----
//
// The shape test was right about every tool that existed when it was written
// and wrong in the one direction that matters. `roadmap_comment` writes to an
// append-only, undeletable discussion and its name ends in a noun, so it read
// as a read — which is how a REVIEW run came to be told to file its findings
// with a tool nothing allowed it to call.

test('a cawdev writer whose name ends in a noun is still a writer', () => {
  // The three the shape test got wrong. All of them create or append something
  // that cannot afterwards be deleted, which is as much of a write as exists
  // in this platform.
  assert.equal(canChangeThings('mcp__cawdev__roadmap_comment'), true);
  assert.equal(canChangeThings('mcp__cawdev__issue_file'), true);
  assert.equal(canChangeThings('mcp__cawdev__propose_entry'), true);
});

test('a cawdev tool nobody has classified is a writer, not a reader', () => {
  // The direction of failure, which is the whole reason this is a list of
  // READS. Forget a reader and a stage says out loud that it cannot do
  // something; forget a writer and it quietly can.
  assert.equal(canChangeThings('mcp__cawdev__something_nobody_added_yet'), true);
});

test('the reads a stage genuinely needs survive', () => {
  for (const read of ['task_current', 'roadmap_get', 'issue_list', 'code_map',
    'changelog_list', 'ask_user', 'await_answer']) {
    assert.equal(canChangeThings(`mcp__cawdev__${read}`), false,
      `a read-only stage lost ${read}`);
  }
});

test('report is the one name a profile and a stage disagree about', () => {
  // A profile needs it: that is how an ASK or a REVIEW session finishes at all.
  // A stage must not have it, because `report` kind "done" ends the RUN — a
  // PLAN stage calling it finishes the walk before anything is implemented.
  assert.ok(CAWDEV_READS.has('report'));
  assert.equal(canChangeThings('mcp__cawdev__report'), true);
});

test('a read-only stage of a coding run cannot comment on the card', () => {
  // R124's PLAN phase writes nothing — "not the code, not the roadmap, not even
  // the plan". The comment tool is now in every coding run's defaults, so this
  // is the regression that adding it could have caused.
  const coding = ['Read', 'mcp__cawdev__task_current', 'mcp__cawdev__roadmap_comment'];
  assert.ok(!toolsForStage('PLAN', coding).includes('mcp__cawdev__roadmap_comment'));
  assert.ok(toolsForStage('PLAN', coding).includes('mcp__cawdev__task_current'));
  assert.deepEqual(toolsForStage('IMPLEMENT', coding), coding);
});

test('a third-party MCP tool is still judged by its shape, for better and worse', () => {
  // We have a list for our own registry because we own it. For everybody
  // else's, shape is all there is — and treating every third-party MCP tool as
  // a writer would strip a read-only stage of R76's registry entirely.
  assert.equal(canChangeThings('mcp__github__issue_create'), true);
  assert.equal(canChangeThings('mcp__github__get_file_contents'), false);

  // And the worse half, pinned rather than hidden: the shape test reads the END
  // of a name, so a third-party writer named verb-first is not caught. This is
  // the same defect the cawdev list above exists to remove, still present for
  // every registry we cannot enumerate. Deciding what to do about it is a
  // decision about R76's servers, not about this fix — but it should not be
  // discovered as a surprise.
  assert.equal(canChangeThings('mcp__github__create_issue'), false,
    'a verb-first third-party writer is still read as a reader');
});

test('no stage may hold `report`, whatever else it may do', () => {
  // The bug this pins: `report` kind "done" ends the RUN, not the stage. It was
  // stripped from the read-only stages by `canChangeThings` and left on
  // IMPLEMENT and TEST, which got the profile's list untouched. A real session
  // used it inside TEST; the walk saw the run already finished, marked TEST DONE
  // and every stage behind it SKIPPED. MEMORY is the stage behind TEST, so it
  // ran once in fifty runs and R108's briefing was written once.
  const coding = [
    'Bash(git *)',
    'Write',
    'mcp__cawdev__report',
    'mcp__cawdev__task_current',
    'mcp__cawdev__roadmap_create',
  ];
  for (const stage of ['PLAN', 'VERIFY', 'MEMORY', 'IMPLEMENT', 'TEST', 'SOMETHING_NEW']) {
    assert.ok(!toolsForStage(stage, coding).includes('mcp__cawdev__report'),
      `the ${stage} stage was handed report, which would end the run mid-walk`);
  }

  // And the rest of the profile survives on the stages that do the work: this
  // strips one name, it does not narrow IMPLEMENT and TEST to reads.
  assert.deepEqual(
    toolsForStage('IMPLEMENT', coding),
    coding.filter((tool) => tool !== 'mcp__cawdev__report'));
});

// --- R147: read-only experts may be reached from a read-only stage ----------

test('an expert whose frontmatter names only reads is read-only, and any other is not', () => {
  assert.equal(readOnlyExpert({ tools: 'Read, Grep, Glob' }), true);
  assert.equal(readOnlyExpert({ tools: 'Read, Grep, Glob, Bash' }), false);
  assert.equal(readOnlyExpert({ tools: 'Read, Write' }), false);
  // No `tools:` line inherits the parent's list, which is not a claim this
  // file can make — so it is not read-only.
  assert.equal(readOnlyExpert({}), false);
  assert.equal(readOnlyExpert({ tools: '' }), false);
  for (const read of SUBAGENT_READS) {
    assert.equal(canChangeThings(read), false, `${read} is a read`);
  }
});

test('a PLAN stage keeps Agent only when told its experts are read-only', () => {
  assert.equal(toolsForStage('PLAN', CODING).includes('Agent'), false);
  const tools = toolsForStage('PLAN', CODING, undefined, { delegatesReadOnly: true });
  assert.equal(tools.includes('Agent'), true);
  // And NOTHING else came back with it: the claim is unchanged for every
  // other tool in the list.
  for (const tool of tools.filter((each) => each !== 'Agent')) {
    assert.equal(canChangeThings(tool), false, `${tool} in a PLAN stage`);
  }
});

test('a delegation to an allowed expert is not drift; any other still is', () => {
  const allowed = ['cawdev:architect'];
  assert.equal(driftedFrom('PLAN', 'Agent(cawdev:architect) design the change', 'RUN', allowed),
    null);
  assert.match(driftedFrom('PLAN', 'Agent(cawdev:java-build-resolver) fix it', 'RUN', allowed),
    /PLAN stage called Agent/);
  assert.match(driftedFrom('PLAN', 'Agent(architect) design', 'RUN', allowed),
    /PLAN stage called Agent/);
});

