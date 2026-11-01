import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardsFrom, countWords, importCards, projectFor, resultLines } from './card-import.mjs';

const plain = new Proxy({}, { get: () => (text) => text });

test('a bare list and a {cards} object are both a file of cards', () => {
  assert.equal(cardsFrom('[{"title":"a"},{"title":"b"}]').length, 2);
  assert.equal(cardsFrom('{"cards":[{"title":"a"}]}').length, 1);
});

test('what is not a list of cards is refused before anything is sent', () => {
  assert.throws(() => cardsFrom('{"title":'), /not JSON/);
  assert.throws(() => cardsFrom('{"title":"a"}'), /a list of cards/);
  assert.throws(() => cardsFrom('[]'), /no cards/);
  assert.throws(() => cardsFrom('[{"title":"a"}, "b"]'), /card 2 is not an object/);
  assert.throws(() => cardsFrom(JSON.stringify(Array.from({ length: 201 }, () => ({ title: 'x' })))),
    /at most 200/);
});

test('one call, the dry run in the query and the batch status beside the cards', async () => {
  const calls = [];
  const session = { request: async (path, options) => { calls.push([path, options]); return {}; } };
  await importCards(session, 'me-board', [{ title: 'a' }], { dryRun: true, status: 'BACKLOG' });
  await importCards(session, 'me-board', [{ title: 'a' }]);
  assert.deepEqual(calls[0], ['/api/projects/me-board/roadmap/import?dryRun=true',
    { method: 'POST', body: { cards: [{ title: 'a' }], status: 'BACKLOG' } }]);
  assert.deepEqual(calls[1][1].body, { cards: [{ title: 'a' }] });
  await importCards(session, 'me-board', [{ title: 'a' }], { allowDuplicates: true });
  assert.deepEqual(calls[2][1].body, { cards: [{ title: 'a' }], allowDuplicates: true });
  assert.match(calls[1][0], /dryRun=false$/);
});

test('the result names every refusal by its place in the file, counting from 1', () => {
  const lines = resultLines({
    dryRun: false,
    filed: [{ index: 0, ref: 'i4', kind: 'ISSUE', title: 'Scraper' }],
    refused: [{ index: 2, title: 'Bad', reason: '"HIGH" is not a severity here' }],
  }, 'me-board', plain);
  assert.equal(lines[0], '  filed 1 issue on me-board · 1 refused');
  assert.equal(lines[1], '    i4 Scraper');
  assert.equal(lines[2], '    #3 Bad — "HIGH" is not a severity here');
  assert.equal(countWords([{ kind: 'ISSUE' }, { kind: 'ISSUE' }, { kind: 'ROADMAP' }]),
    '2 issues and 1 roadmap card');
});

test('the project is the checkout you stand in, else the only one served', () => {
  const tools = { pathsOf: (entry) => (typeof entry === 'string' ? [entry] : entry.workspaces),
    absolute: (path) => path };
  const projects = { 'me-a': '/code/a', 'me-ab': { workspaces: ['/code/a/b', '/code/ab-2'] } };
  assert.equal(projectFor(projects, '/code/a/src', tools), 'me-a');
  assert.equal(projectFor(projects, '/code/a/b/x', tools), 'me-ab');
  assert.equal(projectFor(projects, '/code/ab', tools), null);
  assert.equal(projectFor({ 'me-a': '/code/a' }, '/elsewhere', tools), 'me-a');
  assert.equal(projectFor(undefined, '/elsewhere', tools), null);
});

test('a duplicate names what it repeats: the project card, or the earlier one in the file', () => {
  const lines = resultLines({
    dryRun: true,
    filed: [{ index: 0, ref: null, kind: 'ROADMAP', title: 'Passkeys' }],
    refused: [],
    duplicates: [
      { index: 1, title: 'Scraper', ref: 'i4', sameAs: null },
      { index: 2, title: 'passkeys', ref: null, sameAs: 0 },
    ],
  }, 'me-board', plain);
  assert.equal(lines[0], '  1 roadmap card would be filed on me-board · 2 skipped as duplicates');
  assert.equal(lines[1], '    #2 Scraper — already i4');
  assert.equal(lines[2], '    #3 passkeys — same as #1');
});
