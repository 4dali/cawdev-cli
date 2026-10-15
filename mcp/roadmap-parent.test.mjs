// node --test tools/mcp/roadmap-parent.test.mjs
//
// R336: what an agent sees of a card's epic, and what it can say about one.
// Pinned through the real server over stdio, like roadmap-sprint.test.mjs: the
// thing that matters is the TEXT a model reads and the BODY the platform gets.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

const SERVER = new URL('./server.mjs', import.meta.url).pathname;

const EPIC = {
  number: 300,
  ref: 'R300',
  title: 'Teams',
  statusDisplay: 'PLANNED',
  body: 'The epic body. '.repeat(80),
  parent: null,
  children: [
    { number: 301, ref: 'R301', title: 'One', status: 'MERGED', done: true },
    { number: 302, ref: 'R302', title: 'Two', status: 'PLANNED', done: false },
  ],
  progress: { done: 1, total: 2 },
};

const CHILD = {
  number: 301,
  ref: 'R301',
  title: 'One',
  statusDisplay: 'IN DEVELOPMENT',
  body: 'The child body.',
  parent: { number: 300, ref: 'R300', title: 'Teams' },
  children: [],
  progress: null,
};

async function fakePlatform({ epicMissing = false } = {}) {
  const seen = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      seen.push({ method: request.method, url, body: raw ? JSON.parse(raw) : null });
      const json = (body) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (url.startsWith('/api/agent/whoami')) {
        return json({ runId: 'run-1', projects: [{ slug: 'board' }] });
      }
      if (url.endsWith('/runs/run-1')) {
        return json({ state: 'RUNNING', branch: 'r301', entryRef: 'R301', startedByEmail: 'a@b.c' });
      }
      if (url.endsWith('/messages') || url.endsWith('/questions') || url.endsWith('/comments')
        || url.endsWith('/plans') || url.endsWith('/runs')) {
        return json([]);
      }
      if (url.endsWith('/roadmap/R300')) {
        if (epicMissing) {
          response.writeHead(404, { 'content-type': 'application/json' });
          return response.end('{"status":404,"message":"no"}');
        }
        return json(EPIC);
      }
      if (url.endsWith('/roadmap/R301') || url.endsWith('/roadmap/301') || url.endsWith('/roadmap')) {
        return json(CHILD);
      }
      response.writeHead(404);
      response.end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

async function callTool(url, name, args) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CAWDEV_URL: url, CAWDEV_TOKEN: 'cawdr_test', CAWDEV_PROJECT: 'board' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })}\n`,
  );
  child.stdin.end();
  await once(child, 'exit');
  const replies = out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const call = replies.find((reply) => reply.id === 2);
  assert.ok(call, `no reply to tools/call in: ${out}`);
  return { text: call.result.content[0].text, isError: call.result.isError === true };
}

test('create and update send parent, and "" reaches the platform', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  await callTool(platform.url, 'roadmap_create', { title: 'New', parent: 'R300' });
  await callTool(platform.url, 'roadmap_update', { number: 301, parent: '' });
  await callTool(platform.url, 'roadmap_update', { number: 301, title: 'Renamed' });

  assert.deepEqual(platform.seen.find((c) => c.method === 'POST').body, { title: 'New', parent: 'R300' });
  assert.deepEqual(
    platform.seen.filter((c) => c.method === 'PATCH').map((c) => c.body),
    [{ parent: '' }, { title: 'Renamed' }],
  );
});

test('a card prints its parent, and an epic its children with progress', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  const child = await callTool(platform.url, 'roadmap_get', { number: 301 });
  assert.match(child.text, /^  parent: R300 — Teams$/m);

  const epic = await callTool(platform.url, 'roadmap_get', { number: 'R300' });
  assert.match(epic.text, /^  children: 1 of 2 done — R301 \(MERGED\), R302 \(PLANNED\)$/m);
});

test('task_current leads with the epic the card was cut from', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  const { text } = await callTool(platform.url, 'task_current', {});

  assert.match(text, /This card is part of R300 — Teams:\nThe epic body\./);
  assert.ok(text.indexOf('This card is part of') < text.indexOf('R301 — One'));
  // Cut at a word, with an ellipsis, well under the whole body.
  assert.match(text, /The epic body\.…/);
});

test('task_current survives an epic it cannot read', async (t) => {
  const platform = await fakePlatform({ epicMissing: true });
  t.after(() => platform.close());

  const { text, isError } = await callTool(platform.url, 'task_current', {});

  assert.equal(isError, false);
  assert.doesNotMatch(text, /This card is part of/);
  assert.match(text, /R301 — One/);
});
