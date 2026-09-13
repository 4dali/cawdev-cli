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
