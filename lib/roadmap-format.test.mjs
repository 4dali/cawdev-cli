// node --test tools/lib/roadmap-format.test.mjs
//
// The round trip is the thing that must not regress: if parse and render stop
// agreeing, the generated ROADMAP.md churns on every export and the diff stops
// meaning "the roadmap changed".

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRoadmap, renderRoadmap, sectionOf, statusFromDisplay } from './roadmap-format.mjs';

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
    status: 'CODING',
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
  assert.equal(parsed[0].status, 'CODING');
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

test('IN PROGRESS is written with a space and stored with an underscore', () => {
  assert.equal(statusFromDisplay('IN PROGRESS'), 'IN_PROGRESS');

  const rendered = renderRoadmap(
    [{ number: 1, title: 'x', status: 'IN_PROGRESS', related: [], body: '' }],
    { preamble: PREAMBLE },
  );
  assert.ok(rendered.includes('Status: IN PROGRESS'));
  assert.equal(parseRoadmap(rendered).entries[0].status, 'IN_PROGRESS');
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

test('the file ends with exactly one newline', () => {
  const rendered = renderRoadmap(
    [{ number: 1, title: 'a', status: 'PLANNED', related: [], body: 'x' }],
    { preamble: PREAMBLE },
  );
  assert.ok(rendered.endsWith('\n'));
  assert.ok(!rendered.endsWith('\n\n'));
});
