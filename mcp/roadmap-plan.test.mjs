// node --test tools/mcp/roadmap-plan.test.mjs
//
// R124: what an agent reading a card actually sees of the plan.
//
// `roadmap_get` is how every session finds out what a card is, and since R124
// the card carries a PLAN as well as a body. Pinned through the real server
// over stdio, like approve.test.mjs, because the thing that matters is the TEXT
// a model reads — a plan that arrives correctly and is formatted so it reads as
// part of the discussion has not arrived.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

const SERVER = new URL('./server.mjs', import.meta.url).pathname;

const ENTRY = {
  number: 60,
  title: 'Something worth planning',
  statusDisplay: 'PLANNED',
  body: 'What we want, in prose.',
};

/**
 * A platform that answers the three calls `roadmap_get` makes.
 *
 * `plans` null means the endpoint is MISSING — a platform that has not run V59,
 * which this server has to tolerate: it talks to whatever installation it was
 * pointed at, and a 404 for the plan must cost the plan rather than the card.
 */
async function fakePlatform({ plans = [], comments = [] } = {}) {
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    const json = (body) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    if (url.startsWith('/api/agent/whoami')) {
      return json({ runId: 'run-1', projects: [{ slug: 'board' }] });
    }
    if (url.endsWith('/roadmap/60/plans')) {
      if (plans === null) {
        response.writeHead(404, { 'content-type': 'application/json' });
        return response.end('{"status":404,"error":"Not Found"}');
      }
      return json(plans);
    }
    if (url.endsWith('/roadmap/60/comments')) {
      return json(comments);
    }
    if (url.endsWith('/roadmap/60')) {
      return json(ENTRY);
    }
    response.writeHead(404);
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function callTool(url, name, args) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      CAWDEV_URL: url,
      CAWDEV_TOKEN: 'cawdr_test',
      CAWDEV_PROJECT: 'board',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args },
    })}\n`,
  );
  child.stdin.end();
  await once(child, 'exit');

  const replies = out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const call = replies.find((reply) => reply.id === 2);
  assert.ok(call, `no reply to tools/call in: ${out}`);
  return call.result.content[0].text;
}

test('the card an agent reads carries the plan agreed for it', async (t) => {
  const platform = await fakePlatform({
    plans: [{
      id: 'plan-1',
      body: 'Change AccessGuard.require, then the two callers.',
      baseCommit: 'abc1234567890',
      authorEmail: null,
      createdAt: '2026-09-07T10:00:00Z',
    }],
  });
  t.after(() => platform.close());

  const text = await callTool(platform.url, 'roadmap_get', { number: 60 });

  assert.match(text, /Change AccessGuard\.require, then the two callers\./);
  // Labelled, and stamped with what it was written against: a plan a session
  // cannot date is a plan it cannot weigh against the code in front of it.
  assert.match(text, /--- the plan \(/);
  assert.match(text, /abc1234567/);
  // Short, not the full sha — this is prose for a reader, not a ref to check out.
  assert.doesNotMatch(text, /abc1234567890/);
});

test('the plan sits between the body and the discussion', async (t) => {
  const platform = await fakePlatform({
    plans: [{ id: 'p', body: 'How we mean to get it.', createdAt: '2026-09-07T10:00:00Z' }],
    comments: [{
      body: 'And here is why not the obvious way.',
      authorEmail: 'someone@example.com',
      createdAt: '2026-09-07T11:00:00Z',
    }],
  });
  t.after(() => platform.close());

  const text = await callTool(platform.url, 'roadmap_get', { number: 60 });

  // The order they are read in: what we want, how, and the argument about both.
  assert.ok(text.indexOf('What we want, in prose.') < text.indexOf('How we mean to get it.'));
  assert.ok(text.indexOf('How we mean to get it.') < text.indexOf('--- the discussion'));
});

test('only the plan of record, however many a card has had', async (t) => {
  const platform = await fakePlatform({
    plans: [
      { id: 'p2', body: 'On reflection, this.', createdAt: '2026-09-07T12:00:00Z' },
      { id: 'p1', body: 'The first thought.', createdAt: '2026-09-07T10:00:00Z' },
    ],
  });
  t.after(() => platform.close());

  const text = await callTool(platform.url, 'roadmap_get', { number: 60 });

  assert.match(text, /On reflection, this\./);
  // A card re-planned four times would otherwise fill the context of the
  // session this is meant to orient. What was thought before is on its page.
  assert.doesNotMatch(text, /The first thought\./);
});

test('a card nobody has planned says nothing about plans', async (t) => {
  const platform = await fakePlatform({ plans: [] });
  t.after(() => platform.close());

  const text = await callTool(platform.url, 'roadmap_get', { number: 60 });

  assert.match(text, /What we want, in prose\./);
  assert.doesNotMatch(text, /the plan \(/);
});

test('a platform too old to have plans still hands over the card', async (t) => {
  // This server talks to whatever installation it was pointed at, and one that
  // has not run V59 answers 404 here. Losing the card over that would be the
  // new feature breaking the old one.
  const platform = await fakePlatform({ plans: null });
  t.after(() => platform.close());

  const text = await callTool(platform.url, 'roadmap_get', { number: 60 });

  assert.match(text, /R60 — Something worth planning/);
  assert.match(text, /What we want, in prose\./);
  assert.doesNotMatch(text, /the plan \(/);
});
