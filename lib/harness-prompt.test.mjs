// node --test tools/lib/harness-prompt.test.mjs
//
// R107–R109 — where the two levels of configuration MEET.
//
// The whole design of R107 rests on one claim: the console's instincts and the
// repository's `.ai-config.md` are merged in the assembler rather than synced
// into each other, so editing the file is enough and nothing goes stale. That
// claim is either true of this string or it is not, and it needs no daemon, no
// platform and no repository to check.
//
// The other property worth pinning is that the blocks are LABELLED and appended.
// A session that cannot tell "what this project always wants" from "what you
// were asked to do" will treat one as the other, and the failure mode of getting
// that backwards is a run that does the standing rule instead of the task.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AI_CONFIG, harnessPrompt, readRepoConfig } from './harness-prompt.mjs';

const INSTINCT = { key: 'exports', name: 'Never hand-edit the exports', body: 'They are generated.' };

test('a project that has said nothing adds nothing', () => {
  // Not an empty section, not a heading with nothing under it: nothing at all.
  // A prompt that ends with "How work is done here:" and then stops is worse
  // than one that never mentioned it.
  assert.equal(harnessPrompt({}), '');
  assert.equal(harnessPrompt({ instincts: [], lifecycle: [], briefing: null }), '');
});

test('the instincts arrive under a heading of their own', () => {
  const said = harnessPrompt({ instincts: [INSTINCT] });
  assert.match(said, /## How work is done here/);
  assert.match(said, /Never hand-edit the exports/);
  assert.match(said, /They are generated\./);
});

test('the task and the standing rules are separated', () => {
  // The separator is what makes the two blocks readable as two things. This is
  // appended to a profile's prompt, and without it the first instinct reads as
  // the last sentence of the instruction.
  assert.match(harnessPrompt({ instincts: [INSTINCT] }), /^\n\n---\n\n/);
});

test("the repository's half comes AFTER the console's", () => {
  // Deliberate, and it is a precedence rule: a rule somebody put in the
  // repository wins a disagreement with one set in the console, because the
  // file is the thing they can see from the checkout they are standing in.
  const said = harnessPrompt({ instincts: [INSTINCT], repoConfig: 'Use tabs, not spaces.' });
  assert.ok(said.indexOf('How work is done here') < said.indexOf(AI_CONFIG), said);
  assert.match(said, /Use tabs, not spaces\./);
});

test('either half alone is enough', () => {
  // The point of merging rather than syncing: a project with only a file, and a
  // project with only console rows, both work and neither needs an import step.
  assert.match(harnessPrompt({ repoConfig: 'Only a file.' }), /Only a file\./);
  assert.match(harnessPrompt({ instincts: [INSTINCT] }), /Never hand-edit/);
});

test('a briefing says it may be out of date', () => {
  // It is what a previous session BELIEVED. A block that presented it as fact
  // would make a stale briefing worse than none, because the next session would
  // act on it without checking.
  const said = harnessPrompt({ briefing: 'The parser is the bottleneck.' });
  assert.match(said, /Where this work had got to/);
  assert.match(said, /not necessarily what is true now/);
  assert.match(said, /The parser is the bottleneck\./);
});

test('a gated stage says to stop, and an automatic one does not', () => {
  const said = harnessPrompt({
    lifecycle: [
      { stage: 'PLAN', gate: 'ASK' },
      { stage: 'IMPLEMENT', gate: 'AUTO' },
    ],
  });
  assert.match(said, /1\. \*\*PLAN\*\* — \*\*stop here and wait\*\*/);
  assert.match(said, /2\. \*\*IMPLEMENT\*\*$/m);
  // And the gated one names the tool, because "wait" without a mechanism is an
  // instruction a session cannot follow.
  assert.match(said, /ask_user/);
});

test('the steps are numbered in the order they were given', () => {
  // The order is the lifecycle, and a project may reorder it. Numbering from
  // the array rather than from a fixed list is what lets that work.
  const said = harnessPrompt({
    lifecycle: [{ stage: 'TEST', gate: 'AUTO' }, { stage: 'PLAN', gate: 'AUTO' }],
  });
  assert.ok(said.indexOf('1. **TEST**') < said.indexOf('2. **PLAN**'));
});

test('all three blocks coexist, each under its own heading', () => {
  const said = harnessPrompt({
    instincts: [INSTINCT],
    briefing: 'Half done.',
    lifecycle: [{ stage: 'PLAN', gate: 'ASK' }],
    repoConfig: 'From the repo.',
  });
  for (const heading of [
    'How work is done here', AI_CONFIG, 'Where this work had got to', 'The steps to work in',
  ]) {
    assert.ok(said.includes(heading), `missing: ${heading}`);
  }
});

test('the repository file is read when it is there, and its absence is not an error', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cawdev-aiconfig-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Not having one is the ordinary case.
  assert.equal(await readRepoConfig(dir), null);

  await writeFile(join(dir, AI_CONFIG), '  Migrations are Flyway only.  \n');
  assert.equal(await readRepoConfig(dir), 'Migrations are Flyway only.');
});

test('a repository that committed a document instead of a page is refused, and says so', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cawdev-aiconfig-big-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, AI_CONFIG), 'x'.repeat(40 * 1024));

  const said = await readRepoConfig(dir);
  // Refused rather than truncated, and the reason is in the prompt: this goes
  // into an opening prompt, and silently crowding out the task is the failure.
  assert.match(said, /was not read/);
  assert.doesNotMatch(said, /xxxx/);
});

test('an empty file is the same as no file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cawdev-aiconfig-empty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, AI_CONFIG), '   \n\n');
  assert.equal(await readRepoConfig(dir), null);
});

// --- R124: the plan the implementation phase has to follow --------------------

test('the plan is handed on verbatim, under a heading that says what it is', () => {
  const said = harnessPrompt({
    plan: { body: 'Change AccessGuard.require, then the two callers.' },
  });

  assert.match(said, /## The plan for this card/);
  // VERBATIM, for stagePrompt's reason: a session that re-derived the plan from
  // a précis would be planning again, which is the one thing a phase after an
  // approved plan must not do.
  assert.match(said, /Change AccessGuard\.require, then the two callers\./);
});

test('a stale plan carries the warning in the SAME block as the plan', () => {
  const said = harnessPrompt({
    plan: {
      body: 'The plan.',
      staleness: 'This plan was written against abc1234567 and you are working from def4567890.',
    },
  });

  // One block, not a warning somewhere else on the page. A plan and the reason
  // to doubt it belong together, or the plan gets read and the doubt does not.
  const block = said.slice(said.indexOf('## The plan for this card'));
  assert.match(block, /written against abc1234567/);
  assert.match(block, /The plan\./);
});

test('a fresh plan says nothing about staleness', () => {
  const said = harnessPrompt({ plan: { body: 'The plan.', staleness: null } });
  assert.doesNotMatch(said, /written against/);
});

test('no plan is no block at all', () => {
  // Every run that is not an implementation phase, and every card nobody has
  // planned. An empty heading would be cawdev announcing something it has not
  // got.
  assert.equal(harnessPrompt({ plan: null }), '');
  assert.equal(harnessPrompt({ plan: { body: '' } }), '');
});

test('the plan comes after where the work had got to, and before the steps', () => {
  const said = harnessPrompt({
    briefing: 'The last session got this far.',
    plan: { body: 'Do the thing.' },
    lifecycle: [{ stage: 'IMPLEMENT', gate: 'AUTO' }],
  });

  // The order a person would read them in: where the work had got to, what was
  // decided for this card, then what to do about it.
  assert.ok(said.indexOf('Where this work had got to')
    < said.indexOf('The plan for this card'));
  assert.ok(said.indexOf('The plan for this card') < said.indexOf('The steps to work in'));
});

// --- R147: the experts and skills are named, by the name the CLI answers to --

test('the experts and skills a run holds are listed under the qualified name', () => {
  const prompt = harnessPrompt({
    experts: [{ qualified: 'cawdev:architect', description: 'Designs how a change fits.' }],
    skills: [{ qualified: 'cawdev:dataviz', description: 'Charts.' }],
  });
  assert.match(prompt, /## What this session may reach/);
  assert.match(prompt, /`cawdev:architect` — Designs how a change fits\./);
  assert.match(prompt, /`cawdev:dataviz` — Charts\./);
  assert.match(prompt, /subagent_type` exactly as written/);
  // The bare key appears nowhere on its own: that is the name nothing answers to.
  assert.doesNotMatch(prompt, /Agent\(architect\)/);
});

test('a stage that cannot delegate is told so, and told nothing else about experts', () => {
  const prompt = harnessPrompt({
    experts: [],
    cannotDelegate: ['This stage cannot delegate; the experts are reached from IMPLEMENT.'],
  });
  assert.match(prompt, /cannot delegate/);
  assert.doesNotMatch(prompt, /subagent_type/);
});

test('a run with nothing to reach gets no such section', () => {
  assert.doesNotMatch(harnessPrompt({ experts: [], skills: [] }), /may reach/);
});

