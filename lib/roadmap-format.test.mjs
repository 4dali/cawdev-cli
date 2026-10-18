// node --test tools/lib/roadmap-format.test.mjs
//
// The round trip is the thing that must not regress: if parse and render stop
// agreeing, the generated ROADMAP.md churns on every export and the diff stops
// meaning "the roadmap changed".

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseRoadmap,
  renderIssues,
  renderRoadmap,
  sectionOf,
  statusFromDisplay,
  unlistedSections,
} from './roadmap-format.mjs';

const PREAMBLE = '# Roadmap\n\nSome prose.\n';

function roundTrip(entries) {
  const rendered = renderRoadmap(entries, { preamble: PREAMBLE });
  const { entries: parsed, problems } = parseRoadmap(rendered);
  assert.deepEqual(problems, [], 'parsing our own output should raise no problems');
  return { rendered, parsed };
}

test('an entry survives render → parse unchanged', () => {
  const entry = {
    number: 4,
    title: 'roadmap entries: the six statuses, per project',
    status: 'IN_DEVELOPMENT',
    branch: 'r4-roadmap-entries',
    version: null,
    reason: null,
    related: [3],
    section: 'Phase 1 — the roadmap platform, usable on its own',
    body: 'The core object.\n\n**Build:**\n- one thing\n- another',
  };

  const { parsed } = roundTrip([entry]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].number, 4);
  assert.equal(parsed[0].title, entry.title);
  assert.equal(parsed[0].status, 'IN_DEVELOPMENT');
  assert.equal(parsed[0].branch, 'r4-roadmap-entries');
  assert.deepEqual(parsed[0].related, [3]);
  assert.equal(parsed[0].section, entry.section);
  assert.equal(parsed[0].body, entry.body);
});

test('render is a fixed point: rendering what we parsed gives the same bytes', () => {
  const entries = [
    {
      number: 1,
      title: 'first',
      status: 'SHIPPED',
      version: 'v0.1.0',
      related: [],
      section: 'Phase 1 — the platform',
      body: 'Body one.',
    },
    {
      number: 2,
      title: 'second',
      status: 'DECLINED',
      reason: 'Costs more than it buys.',
      related: [1],
      section: 'Phase 1 — the platform',
      body: 'Reason: Costs more than it buys.',
    },
    {
      number: 3,
      title: 'third',
      status: 'CONSIDERING',
      related: [],
      section: 'Phase 1 — the platform',
      body: 'Open questions.',
    },
    {
      // R257: a card in a sprint, as the API says it.
      number: 4,
      title: 'fourth',
      status: 'PLANNED',
      related: [],
      section: 'Phase 1 — the platform',
      sprint: { number: 1, ref: 'S1', name: 'Notifications', state: 'OPEN' },
      body: 'In S1.',
    },
  ];

  const first = renderRoadmap(entries, { preamble: PREAMBLE });
  const { entries: parsed } = parseRoadmap(first);
  const second = renderRoadmap(parsed, { preamble: PREAMBLE });

  assert.equal(second, first, 'export → import → export must be byte-identical');
});

test('a section separator does not leak into the last entry of a section', () => {
  // This is the bug that broke the fixed point the first time: the "---" before
  // the next "##" was collected as body text and reappeared on the next export.
  const entries = [
    { number: 1, title: 'a', status: 'PLANNED', related: [], section: 'One', body: 'Body.' },
    { number: 2, title: 'b', status: 'PLANNED', related: [], section: 'Two', body: 'Body.' },
  ];

  const { parsed } = roundTrip(entries);
  assert.equal(parsed[0].body, 'Body.');
  assert.ok(!parsed[0].body.includes('---'));
});

test('SHIPPED carries its version on the status line', () => {
  const rendered = renderRoadmap(
    [{ number: 9, title: 'x', status: 'SHIPPED', version: 'v1.2.3', related: [], body: '' }],
    { preamble: PREAMBLE },
  );
  assert.ok(rendered.includes('Status: SHIPPED v1.2.3'));

  const { entries } = parseRoadmap(rendered);
  assert.equal(entries[0].status, 'SHIPPED');
  assert.equal(entries[0].version, 'v1.2.3');
});

test('MERGED carries the merge on its own line, and not the branch', () => {
  // R42: the branch of a MERGED entry is expected to be deleted, so printing it
  // would put a claim in the file that `roadmap.mjs --live` then fails on — the
  // exact bind that kept sixteen entries in CODING.
  const rendered = renderRoadmap(
    [
      {
        number: 42,
        title: 'a card that has merged has somewhere to go',
        status: 'MERGED',
        branch: 'r42-medium-a-card-that-has',
        merge: '#26',
        related: [],
        body: '',
      },
    ],
    { preamble: PREAMBLE },
  );
  assert.ok(rendered.includes('Status: MERGED'));
  assert.ok(rendered.includes('Merged: #26'));
  assert.ok(!rendered.includes('Branch:'));

  const { entries } = parseRoadmap(rendered);
  assert.equal(entries[0].status, 'MERGED');
  assert.equal(entries[0].merge, '#26');
  assert.equal(entries[0].branch, null);
});

test('IN DEVELOPMENT keeps its branch, its development line, and its section', () => {
  // R84, and the mirror image of MERGED below: a card being built still has the
  // branch the work is on, so the file prints it and `--live` checks it. The
  // Development line is the WORK ITEM's status — how far that branch has got —
  // and it is a second line rather than a fifth spelling of Status, which is
  // the whole of R84. And a card in development is not a status-derived
  // section: work in flight is still part of the phase it belongs to.
  const entries = [
    {
      number: 64,
      title: 'a status between CODING and MERGED',
      status: 'IN_DEVELOPMENT',
      branch: 'r64-a-status-between-coding-and',
      development: 'REVIEW',
      related: [],
      section: 'Phase 3 — the console becomes the workplace',
      body: 'Body.',
    },
  ];

  const first = renderRoadmap(entries, { preamble: PREAMBLE });
  assert.ok(first.includes('Status: IN DEVELOPMENT'));
  assert.ok(first.includes('Branch: r64-a-status-between-coding-and'));
  assert.ok(first.includes('Development: REVIEW'));
  assert.ok(first.includes('## Phase 3 — the console becomes the workplace'));

  const { entries: parsed } = parseRoadmap(first);
  assert.equal(parsed[0].status, 'IN_DEVELOPMENT');
  assert.equal(parsed[0].branch, 'r64-a-status-between-coding-and');
  assert.equal(parsed[0].development, 'REVIEW');
  assert.equal(renderRoadmap(parsed, { preamble: PREAMBLE }), first);
});

test('the development line comes from the API view as well as from the file', () => {
  // The exporter is handed what /api/projects/{slug}/roadmap returns, where the
  // work item is a nested object; the parser produces a flat `development`.
  // Both have to render the same line, or an export and a re-export of the same
  // roadmap would differ — which is exactly the drift R41 exists to catch.
  const fromApi = renderRoadmap(
    [{
      number: 84, title: 'x', status: 'IN_DEVELOPMENT', branch: 'r84-work-item',
      workItem: { status: 'CODING' }, related: [], body: 'Body.',
    }],
    { preamble: PREAMBLE },
  );
  assert.ok(fromApi.includes('Development: CODING'));
  assert.equal(renderRoadmap(parseRoadmap(fromApi).entries, { preamble: PREAMBLE }), fromApi);
});

test('a MERGED entry survives export → import → export unchanged', () => {
  const entries = [
    {
      number: 8,
      title: 'the MCP server',
      status: 'MERGED',
      merge: 'a7eae30',
      related: [],
      section: 'Phase 2 — the MCP server',
      body: 'Body.',
    },
  ];

  const first = renderRoadmap(entries, { preamble: PREAMBLE });
  const { entries: parsed } = parseRoadmap(first);
  assert.equal(renderRoadmap(parsed, { preamble: PREAMBLE }), first);
});

test('IN DEVELOPMENT is written with a space and stored with an underscore', () => {
  assert.equal(statusFromDisplay('IN DEVELOPMENT'), 'IN_DEVELOPMENT');

  const rendered = renderRoadmap(
    [{ number: 1, title: 'x', status: 'IN_DEVELOPMENT', branch: 'b', related: [], body: '' }],
    { preamble: PREAMBLE },
  );
  assert.ok(rendered.includes('Status: IN DEVELOPMENT'));
  assert.equal(parseRoadmap(rendered).entries[0].status, 'IN_DEVELOPMENT');
});

test('a CONSIDERING or DECLINED entry is filed by status, not by its stored section', () => {
  // Otherwise a declined entry stays filed under a phase it is no longer part of.
  assert.equal(
    sectionOf({ status: 'DECLINED', section: 'Phase 1 — whatever' }),
    'Declined — decided against, with the reason',
  );
  assert.equal(
    sectionOf({ status: 'CONSIDERING', section: 'Phase 3 — whatever' }),
    'Considering — wanted, not settled',
  );
  assert.equal(sectionOf({ status: 'PLANNED', section: 'Phase 2 — the MCP server' }),
    'Phase 2 — the MCP server');
});

test('a BACKLOG entry is filed under the backlog, before what is considered — R371', () => {
  assert.equal(
    sectionOf({ status: 'BACKLOG', section: 'Phase 9 — the board' }),
    'Backlog — waiting to be brought in',
  );
  const rendered = renderRoadmap(
    [
      { number: 2, title: 'Thinking', status: 'CONSIDERING' },
      { number: 1, title: 'Waiting', status: 'BACKLOG' },
    ],
    { preamble: '# Roadmap' },
  );
  assert.ok(rendered.indexOf('## Backlog') < rendered.indexOf('## Considering'));
  assert.equal(parseRoadmap(rendered).entries.find((e) => e.title === 'Waiting').status, 'BACKLOG');
});

test('the Format section\'s example heading is not read as an entry', () => {
  // "### R7 — a short title" appears in the preamble as an example. Parsing the
  // whole file picks it up and shifts every real number after it by one.
  const withExample = [
    '# Roadmap',
    '',
    'Every entry is a level-3 heading:',
    '',
    '```markdown',
    '### R7 — a short title',
    '',
    'Status: PLANNED',
    '```',
    '',
    '---',
    '',
    '## Phase 1 — real',
    '',
    '### R1 — the real first entry',
    '',
    'Status: PLANNED',
    '',
  ].join('\n');

  const { entries } = parseRoadmap(withExample);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].number, 1);
  assert.equal(entries[0].title, 'the real first entry');
});

test('related ids are sorted, so an export does not churn on insertion order', () => {
  const rendered = renderRoadmap(
    [
      { number: 1, title: 'a', status: 'PLANNED', related: [], body: '' },
      { number: 2, title: 'b', status: 'PLANNED', related: [], body: '' },
      { number: 3, title: 'c', status: 'PLANNED', related: [2, 1], body: '' },
    ],
    { preamble: PREAMBLE },
  );
  assert.ok(rendered.includes('Related: R1, R2'));
});

test('comments do not reach the export — R37 keeps the discussion in the platform', () => {
  // ROADMAP.md is a generated document of decisions, and R7's fixed-point
  // property is worth more than putting an argument in a file. The exporter
  // reads named fields, so this holds by construction — which is exactly the
  // kind of thing that stops holding when somebody renders an entry generically.
  const entry = {
    number: 1,
    title: 'an entry with an argument attached',
    status: 'PLANNED',
    related: [],
    section: 'Phase 1 — the platform',
    body: 'What was decided.',
  };

  const withoutDiscussion = renderRoadmap([entry], { preamble: PREAMBLE });
  const withDiscussion = renderRoadmap(
    [
      {
        ...entry,
        commentCount: 3,
        comments: [
          { body: 'This should not appear in the file.', authorEmail: 'someone@example.test' },
        ],
      },
    ],
    { preamble: PREAMBLE },
  );

  assert.equal(withDiscussion, withoutDiscussion, 'an export is byte-identical with comments present');
  assert.ok(!withDiscussion.includes('should not appear'));
});

test('sections appear in the given order, then any others, then the status sections', () => {
  const entries = [
    { number: 1, title: 'a', status: 'PLANNED', related: [], section: 'Phase 2', body: '' },
    { number: 2, title: 'b', status: 'CONSIDERING', related: [], section: 'Phase 1', body: '' },
    { number: 3, title: 'c', status: 'PLANNED', related: [], section: 'Phase 1', body: '' },
    { number: 4, title: 'd', status: 'PLANNED', related: [], body: '' },
  ];

  const rendered = renderRoadmap(entries, {
    preamble: PREAMBLE,
    sectionOrder: ['Phase 1', 'Phase 2'],
  });
  const headings = rendered.split('\n').filter((line) => line.startsWith('## '));

  assert.deepEqual(headings, [
    '## Phase 1',
    '## Phase 2',
    '## Roadmap',
    '## Considering — wanted, not settled',
  ]);
});

test('a section the export does not know about is reported, not swallowed', () => {
  // The bug this exists to stop (R45): an unlisted section is appended in
  // silence, so the file degrades a little with each new phase and nobody sees
  // it. Appending is right; appending quietly is not.
  const entries = [
    { number: 1, title: 'a', status: 'PLANNED', related: [], section: 'Phase 1', body: '' },
    { number: 2, title: 'b', status: 'PLANNED', related: [], section: 'Phase 4', body: '' },
    { number: 3, title: 'c', status: 'PLANNED', related: [], section: 'Phase 4', body: '' },
    { number: 4, title: 'd', status: 'PLANNED', related: [], body: '' },
  ];

  assert.deepEqual(unlistedSections(entries, ['Phase 1']), [
    { section: 'Phase 4', count: 2 },
    { section: 'Roadmap', count: 1 },
  ]);
});

test('the status-derived sections are never reported as unlisted', () => {
  // They belong to the format, not to any exporter's list, so requiring every
  // sectionOrder to repeat them would only invite one to forget them.
  const entries = [
    { number: 1, title: 'a', status: 'CONSIDERING', related: [], section: 'Phase 1', body: '' },
    { number: 2, title: 'b', status: 'DECLINED', related: [], body: 'Reason: no.' },
  ];

  assert.deepEqual(unlistedSections(entries, []), []);
});

test('the file ends with exactly one newline', () => {
  const rendered = renderRoadmap(
    [{ number: 1, title: 'a', status: 'PLANNED', related: [], body: 'x' }],
    { preamble: PREAMBLE },
  );
  assert.ok(rendered.endsWith('\n'));
  assert.ok(!rendered.endsWith('\n\n'));
});

// --- R127: an issue is written i90, and a roadmap card R90 -------------------

test('an issue renders with an i, and a roadmap card with an R', () => {
  const rendered = renderIssues(
    [{ number: 90, kind: 'ISSUE', title: 'A thing is broken', status: 'NEW',
       severity: 'MEDIUM', related: [], body: '' }],
    { preamble: '# Issues\n' },
  );
  assert.match(rendered, /^### i90 — A thing is broken$/m);
  assert.doesNotMatch(rendered, /### R90/);

  const card = renderRoadmap(
    [{ number: 90, kind: 'ROADMAP', title: 'A thing to build', status: 'PLANNED',
       related: [], body: '' }],
    { preamble: PREAMBLE },
  );
  assert.match(card, /^### R90 — A thing to build$/m);
});

test('render → parse → render is a fixed point for an issue naming both kinds', () => {
  // The one that would break silently: if the parser dropped the refs and kept
  // only the numbers, `i91` would come back as `R91` on the next export and
  // ISSUES.md would churn on every CI run.
  const entries = [
    { number: 90, kind: 'ISSUE', title: 'Broken', status: 'NEW', severity: 'CRITICAL',
      related: [12, 91], relatedRefs: ['R12', 'i91'], body: 'Names R12 and i91.' },
  ];
  const first = renderIssues(entries, { preamble: '# Issues\n' });
  assert.match(first, /^Related: R12, i91$/m);

  const { entries: parsed, problems } = parseRoadmap(first);
  assert.deepEqual(problems, []);
  assert.equal(parsed[0].kind, 'ISSUE');
  assert.deepEqual(parsed[0].related, [12, 91]);
  assert.deepEqual(parsed[0].relatedRefs, ['R12', 'i91']);

  assert.equal(renderIssues(parsed, { preamble: '# Issues\n' }), first);
});

test('Related: i221, R221 — two cards sharing a number round-trip as two refs (R221)', () => {
  // The case R85 made impossible and R221 makes ordinary: a roadmap card and
  // an issue with the same number. Keyed by number the pair would collapse to
  // one; the pair is kept together, sorted with the card first, and a bare
  // token is a roadmap card — which is what it meant before R221.
  const entries = [
    { number: 5, title: 'Names both', status: 'PLANNED',
      related: [221, 221], relatedRefs: ['i221', 'R221'],
      after: [3, 3], afterRefs: ['i3', 'R3'], body: '' },
  ];
  const first = renderRoadmap(entries, { preamble: '# Roadmap\n' });
  assert.match(first, /^Related: R221, i221$/m);
  assert.match(first, /^After: R3, i3$/m);

  const { entries: parsed, problems } = parseRoadmap(first);
  assert.deepEqual(problems, []);
  assert.deepEqual(parsed[0].related, [221, 221]);
  assert.deepEqual(parsed[0].relatedRefs, ['R221', 'i221']);
  assert.deepEqual(parsed[0].afterRefs, ['R3', 'i3']);
  assert.equal(renderRoadmap(parsed, { preamble: '# Roadmap\n' }), first);

  // Hand-written variants normalise to the one spelling the server writes.
  const hand = parseRoadmap('# R\n\n---\n\n## S\n\n### R5 — x\n\nStatus: PLANNED\nRelated: 7, r8, I9\n');
  assert.deepEqual(hand.entries[0].relatedRefs, ['R7', 'R8', 'i9']);
});

test('a file headed ### R90 still parses, so an old export still imports', () => {
  // R127 changed how an issue is written; every ISSUES.md exported before it
  // says R, and import.mjs has to keep reading those.
  const { entries, problems } = parseRoadmap(
    '# Issues\n\n---\n\n## Open\n\n### R90 — Broken\n\nStatus: New\nSeverity: MEDIUM\nRelated: R12\n',
  );
  assert.deepEqual(problems, []);
  assert.equal(entries[0].number, 90);
  assert.equal(entries[0].kind, 'ROADMAP');
  assert.deepEqual(entries[0].related, [12]);
});

test('After: renders from numbers or from the API cards, and parses back to the same — R181', () => {
  // The parser gives numbers beside the refs as written; the API gives cards.
  // Both spell the same line, sorted by number, and the round trip is a fixed
  // point for the reasons Related's is.
  const fromTheFile = renderRoadmap(
    [
      {
        number: 40,
        title: 'a card that waits',
        status: 'PLANNED',
        related: [],
        after: [40 - 28, 30],
        afterRefs: ['R12', 'i30'],
        body: '',
      },
    ],
    { preamble: PREAMBLE },
  );
  assert.ok(fromTheFile.includes('After: R12, i30'));

  const { entries } = parseRoadmap(fromTheFile);
  assert.deepEqual(entries[0].after, [12, 30]);
  assert.deepEqual(entries[0].afterRefs, ['R12', 'i30']);
  assert.equal(renderRoadmap(entries, { preamble: PREAMBLE }), fromTheFile);

  const fromTheApi = renderRoadmap(
    [
      {
        number: 40,
        title: 'a card that waits',
        status: 'PLANNED',
        related: [],
        after: [
          { number: 30, ref: 'i30', title: 'an issue', status: 'NEW', landed: false },
          { number: 12, ref: 'R12', title: 'a card', status: 'MERGED', landed: true },
        ],
        body: '',
      },
    ],
    { preamble: PREAMBLE },
  );
  assert.equal(fromTheApi, fromTheFile);
});

test('Sprint: renders a team sprint from the API shape, parses back, and re-renders the same — R257, R489', () => {
  // The API's `sprint` carries `label` (`Core team · S1`); the parser reads it
  // back into {team, number, ref, label, name}, so the export is a fixed point
  // whichever side rendered it. The state is not written: the file says which
  // sprint a card is in, and whether it is still active is the database's.
  const fromTheApi = renderRoadmap(
    [
      {
        number: 255,
        title: 'a card in a sprint',
        status: 'PLANNED',
        related: [],
        after: [{ number: 12, ref: 'R12', title: 'a card', status: 'MERGED', landed: true }],
        sprint: {
          number: 1, ref: 'S1', label: 'Core team · S1', teamName: 'Core team', name: 'Notifications', state: 'COMPLETED',
        },
        body: 'Body.',
      },
    ],
    { preamble: PREAMBLE },
  );
  // After After:, before the body — a line on the card, never a heading.
  assert.ok(fromTheApi.includes('After: R12\nSprint: Core team · S1 Notifications\n\nBody.'));
  assert.doesNotMatch(fromTheApi, /^## .*S1/m);

  const { entries } = parseRoadmap(fromTheApi);
  assert.deepEqual(entries[0].sprint, {
    team: 'Core team', number: 1, ref: 'S1', label: 'Core team · S1', name: 'Notifications',
  });
  assert.equal(renderRoadmap(entries, { preamble: PREAMBLE }), fromTheApi);
});

test('the pre-teams `Sprint: S1 Name` line still parses, with no team, and renders unchanged — R489', () => {
  const old = renderRoadmap(
    [{ number: 9, title: 'old', status: 'PLANNED', related: [], sprint: { number: 1, ref: 'S1', name: 'Notifications' }, body: '' }],
    { preamble: PREAMBLE },
  );
  assert.ok(old.includes('Sprint: S1 Notifications'));
  const { entries } = parseRoadmap(old);
  assert.deepEqual(entries[0].sprint, { team: null, number: 1, ref: 'S1', label: 'S1', name: 'Notifications' });
  assert.equal(renderRoadmap(entries, { preamble: PREAMBLE }), old);
  // A name with a dot in the middle is not a team.
  const dotted = old.replace('S1 Notifications', 'S1 Auth · login');
  assert.equal(parseRoadmap(dotted).entries[0].sprint.team, null);
});

test('a card in no sprint writes no Sprint: line, and parses to sprint: null — R257', () => {
  const text = renderRoadmap(
    [{ number: 7, title: 'plain', status: 'PLANNED', related: [], sprint: null, body: '' }],
    { preamble: PREAMBLE },
  );
  assert.doesNotMatch(text, /Sprint:/);
  const { entries } = parseRoadmap(text);
  assert.equal(entries[0].sprint, null);
});

test('Tags: renders sorted, parses back, and re-renders the same — R315', () => {
  const fromTheApi = renderRoadmap(
    [
      {
        number: 315,
        title: 'a tagged card',
        status: 'PLANNED',
        related: [],
        tags: ['runner', 'backend', 'frontend'],
        body: 'Body.',
      },
    ],
    { preamble: PREAMBLE },
  );
  assert.ok(fromTheApi.includes('Tags: backend, frontend, runner'));

  const { entries } = parseRoadmap(fromTheApi);
  assert.deepEqual(entries[0].tags, ['backend', 'frontend', 'runner']);
  assert.equal(renderRoadmap(entries, { preamble: PREAMBLE }), fromTheApi);
});

test('a card with no tags writes no Tags: line, and parses to tags: undefined — R315', () => {
  const text = renderRoadmap(
    [{ number: 8, title: 'plain', status: 'PLANNED', related: [], body: '' }],
    { preamble: PREAMBLE },
  );
  assert.doesNotMatch(text, /Tags:/);
  const { entries } = parseRoadmap(text);
  assert.equal(entries[0].tags, undefined);
});

test('Origin: is computed from the API\'s object, never sent by import, and is a fixed point once parsed — R315', () => {
  const fromTheApi = renderRoadmap(
    [
      {
        number: 316,
        title: 'a SonarQube issue',
        status: 'NEW',
        related: [],
        origin: { kind: 'SONARQUBE', label: 'java:S2259', url: 'https://sonar.example/issue' },
        body: 'Body.',
      },
    ],
    { preamble: PREAMBLE },
  );
  assert.ok(fromTheApi.includes('Origin: SonarQube'));

  const { entries } = parseRoadmap(fromTheApi);
  // Parsed back as the plain word — the parser never reconstructs the
  // {kind, label, url} object, because nothing sends it anywhere that needs to.
  assert.equal(entries[0].origin, 'SonarQube');
  assert.equal(renderRoadmap(entries, { preamble: PREAMBLE }), fromTheApi);
});

test('a card with no origin (or NONE) writes no Origin: line — R315', () => {
  const noOrigin = renderRoadmap(
    [{ number: 9, title: 'plain', status: 'PLANNED', related: [], body: '' }],
    { preamble: PREAMBLE },
  );
  assert.doesNotMatch(noOrigin, /Origin:/);

  const none = renderRoadmap(
    [
      {
        number: 10,
        title: 'a person wrote this',
        status: 'PLANNED',
        related: [],
        origin: { kind: 'NONE', label: null, url: null },
        body: '',
      },
    ],
    { preamble: PREAMBLE },
  );
  assert.doesNotMatch(none, /Origin:/);
});

test('a DECLINED entry with a body and a separate reason writes "Reason:" after the body — i232', () => {
  // The API keeps the reason in its own column (`declinedReason`); the file's
  // only place for it is a "Reason:" paragraph, which the parser folds back
  // into `reason`. R14 and R95 exported without one for as long as the
  // renderer wrote only the body.
  const entry = {
    number: 14,
    title: 'notifications when an agent is waiting on you',
    status: 'DECLINED',
    declinedReason: 'Superseded by R233 and the section it opens.',
    related: [12],
    section: 'Phase 1 — the platform',
    body: 'A question sitting unanswered is a stalled session. Open: email vs. push.',
  };

  const { rendered, parsed } = roundTrip([entry]);
  assert.match(
    rendered,
    /Open: email vs\. push\.\n\nReason: Superseded by R233 and the section it opens\.\n/,
  );
  assert.equal(parsed[0].reason, 'Superseded by R233 and the section it opens.');

  // The parser's `reason` is honoured as well as the API's `declinedReason`.
  const fromParser = renderRoadmap(
    [{ ...entry, declinedReason: undefined, reason: entry.declinedReason }],
    { preamble: PREAMBLE },
  );
  assert.equal(fromParser, rendered);

  // Once the paragraph is in the body, it is not written twice: export →
  // import → export stays a fixed point.
  const second = renderRoadmap(parsed, { preamble: PREAMBLE });
  assert.equal(second, rendered, 'export → import → export must be byte-identical');
  assert.equal(second.match(/Reason:/g).length, 1);
});

test('a DECLINED entry with no body writes the reason as its only paragraph — i232', () => {
  const { rendered, parsed } = roundTrip([
    { number: 95, title: 'set itself up', status: 'DECLINED', declinedReason: 'Done by R93.', related: [], body: '' },
  ]);
  assert.match(rendered, /Status: DECLINED\n\nReason: Done by R93\.\n/);
  assert.equal(parsed[0].reason, 'Done by R93.');
  assert.equal(renderRoadmap(parsed, { preamble: PREAMBLE }), rendered);
});

test('an Assignee: line survives render → parse → render, and a card with nobody writes none', () => {
  const base = {
    number: 12,
    title: 'with a person',
    status: 'PLANNED',
    related: [],
    section: 'Phase 1 — the platform',
    body: 'Body.',
  };
  const entries = [
    { ...base, assignee: { username: 'ben', email: 'ben@example.com' } },
    { ...base, number: 13, title: 'with nobody', assignee: null },
  ];

  const { rendered, parsed } = roundTrip(entries);
  assert.equal(parsed[0].assignee.username, 'ben');
  assert.equal(parsed[1].assignee, undefined);
  assert.match(rendered, /^Assignee: ben$/m);
  assert.equal(rendered.match(/Assignee:/g).length, 1);
  assert.doesNotMatch(rendered, /ben@example\.com/);

  const again = renderRoadmap(parsed, { preamble: PREAMBLE });
  assert.equal(again, rendered);
});

const card = (number, extra = {}) => ({
  number,
  title: `Card ${number}`,
  status: 'PLANNED',
  related: [],
  section: 'Phase 1',
  body: 'Body.',
  ...extra,
});

test('Priority: HIGH renders after the status, parses back, and re-renders the same — R335', () => {
  const { rendered, parsed } = roundTrip([card(1, { priority: 'HIGH' })]);
  assert.match(rendered, /Status: PLANNED\nPriority: HIGH\n/);
  assert.equal(parsed[0].priority, 'HIGH');
  assert.equal(renderRoadmap(parsed, { preamble: PREAMBLE }), rendered);
});

test('MEDIUM writes no Priority: line, and a card without one parses to none — R335', () => {
  const { rendered, parsed } = roundTrip([card(1, { priority: 'MEDIUM' }), card(2)]);
  assert.doesNotMatch(rendered, /Priority:/);
  assert.equal(parsed[0].priority, undefined);
});

test('Due: and Estimate: render after the priority, parse back, and re-render the same — R351', () => {
  const { rendered, parsed } = roundTrip([card(1, { priority: 'HIGH', due: '2026-11-01', estimate: 5 })]);
  assert.match(rendered, /Priority: HIGH\nDue: 2026-11-01\nEstimate: 5\n/);
  assert.equal(parsed[0].due, '2026-11-01');
  assert.equal(parsed[0].estimate, 5);
  assert.equal(renderRoadmap(parsed, { preamble: PREAMBLE }), rendered);
});

test('Target: renders after the estimate, parses back, and is dropped once the card has shipped — R358', () => {
  const { rendered, parsed } = roundTrip([card(1, { estimate: 2, targetVersion: 'v1.2' })]);
  assert.match(rendered, /Estimate: 2\nTarget: v1.2\n/);
  assert.equal(parsed[0].targetVersion, 'v1.2');
  assert.equal(renderRoadmap(parsed, { preamble: PREAMBLE }), rendered);
  const shipped = renderRoadmap([card(2, { status: 'SHIPPED', version: 'v1.3', targetVersion: 'v1.3' })], { preamble: PREAMBLE });
  assert.doesNotMatch(shipped, /Target:/);
});

test('Affects: renders after Target:, survives shipping, and parses back — R378', () => {
  const issue = { ...card(1, { targetVersion: 'v1.2' }), affectedVersions: ['v1.0.9', 'v1.0.10'] };
  const { rendered, parsed } = roundTrip([issue]);
  assert.match(rendered, /Target: v1.2\nAffects: v1.0.9, v1.0.10\n/);
  assert.deepEqual(parsed[0].affectedVersions, ['v1.0.9', 'v1.0.10']);
  assert.equal(renderRoadmap(parsed, { preamble: PREAMBLE }), rendered);
  const shipped = renderRoadmap([{ ...issue, status: 'SHIPPED', version: 'v1.3' }], { preamble: PREAMBLE });
  assert.match(shipped, /Affects: v1.0.9, v1.0.10\n/);
});

test('a card with neither writes neither line, and parses to neither — R351', () => {
  const { rendered, parsed } = roundTrip([card(1, { due: null, estimate: null }), card(2)]);
  assert.doesNotMatch(rendered, /Due:|Estimate:/);
  assert.equal(parsed[0].due, undefined);
  assert.equal(parsed[0].estimate, undefined);
});

test('a Due: that is not a date and an Estimate: that is not a count are problems, by heading — R351', () => {
  const text = renderRoadmap([card(1)], { preamble: PREAMBLE })
    .replace('Status: PLANNED', 'Status: PLANNED\nDue: next week\nEstimate: big');
  const { problems } = parseRoadmap(text);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /R1.*Due "next week" is not a date/);
  assert.match(problems[1], /R1.*Estimate "big" is not a positive whole number/);
});

test('the order given is the order written, and parse keeps file order — R335', () => {
  const entries = [card(5), card(2), card(9)];
  const first = renderRoadmap(entries, { preamble: PREAMBLE });
  assert.ok(first.indexOf('### R5') < first.indexOf('### R2'));
  const { entries: parsed } = parseRoadmap(first);
  assert.deepEqual(parsed.map((e) => e.number), [5, 2, 9]);
  assert.equal(renderRoadmap(parsed, { preamble: PREAMBLE }), first);
});

test('issues keep the given order inside a severity — R335', () => {
  const issue = (number, severity) => ({
    number, kind: 'ISSUE', title: `Issue ${number}`, status: 'NEW', severity, related: [], body: 'B.',
  });
  const text = renderIssues([issue(1, 'MINOR'), issue(7, 'CRITICAL'), issue(3, 'CRITICAL')], {
    preamble: '# Issues\n',
  });
  assert.ok(text.indexOf('### i7') < text.indexOf('### i3'));
  assert.ok(text.indexOf('### i3') < text.indexOf('### i1'));
});

test('Parent: is written from the API shape and the parsed shape, and a card without one writes none — R336', () => {
  const { rendered, parsed } = roundTrip([
    card(1),
    card(2, { parent: { number: 1, ref: 'R1', title: 'Card 1' } }),
  ]);
  assert.match(rendered, /^Parent: R1$/m);
  assert.equal(rendered.match(/Parent:/g).length, 1);
  assert.equal(parsed[1].parentRef, 'R1');
  assert.equal(parsed[0].parentRef, undefined);
  // From the parsed shape too.
  assert.equal(renderRoadmap(parsed, { preamble: PREAMBLE }), rendered);
});

test('Parent: follows After: and a bare number is written in full — R336', () => {
  const { rendered } = roundTrip([
    card(1),
    card(2),
    card(3, { after: [1], afterRefs: ['R1'], parentRef: '2' }),
  ]);
  assert.match(rendered, /After: R1\nParent: R2\n/);
});

test('children are filed directly under their parent, in their own order; export → parse → export is identical — R336', () => {
  const kid = (number) => card(number, { parent: { number: 3, ref: 'R3', title: 'Card 3' } });
  const entries = [card(1), card(3), card(4), kid(5), card(6), kid(7), kid(9), card(10)];
  const { rendered, parsed } = roundTrip(entries);
  const order = [...rendered.matchAll(/^### (R\d+)/gm)].map((m) => m[1]);
  assert.deepEqual(order, ['R1', 'R3', 'R5', 'R7', 'R9', 'R4', 'R6', 'R10']);
  assert.equal(renderRoadmap(parsed, { preamble: PREAMBLE }), rendered);
});

test('a child is nested only within its parent\'s section — R336', () => {
  const entries = [
    card(1, { section: 'Phase 1' }),
    card(2, { section: 'Phase 2' }),
    card(3, { section: 'Phase 2', parent: { number: 1, ref: 'R1', title: 'Card 1' } }),
    card(4, { section: 'Phase 2' }),
  ];
  const { rendered } = roundTrip(entries);
  const order = [...rendered.matchAll(/^### (R\d+)/gm)].map((m) => m[1]);
  assert.deepEqual(order, ['R1', 'R2', 'R3', 'R4']);
});

test('issues get the Parent: line but are not nested — R336', () => {
  const issue = (number, extra = {}) => ({
    number, kind: 'ISSUE', title: `Issue ${number}`, status: 'NEW', severity: 'MEDIUM',
    related: [], body: 'B.', ...extra,
  });
  const text = renderIssues(
    [issue(1), issue(2), issue(3, { parent: { number: 1, ref: 'i1', title: 'Issue 1' } })],
    { preamble: '# Issues\n' },
  );
  assert.match(text, /### i3[^]*\nParent: i1\n/);
  assert.ok(text.indexOf('### i2') < text.indexOf('### i3'));
});
