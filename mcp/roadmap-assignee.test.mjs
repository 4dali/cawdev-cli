// node --test tools/mcp/roadmap-assignee.test.mjs
//
// R331: what an agent sees of who a card is assigned to, and what it can say.
// Pinned through the real server over stdio, as roadmap-sprint.test.mjs, because
// the thing that matters is the TEXT a model reads and the BODY and QUERY the
// platform receives.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

const SERVER = new URL('./server.mjs', import.meta.url).pathname;

const IN_S1 = {
  number: 255,
  ref: 'R255',
  title: 'A run whose runner goes quiet',
  statusDisplay: 'IN DEVELOPMENT',
  section: 'Phase 7 — runs',
  assignee: { username: 'ben', email: 'ben@example.com' },
  body: 'The body.',
};

/**
 * A platform that answers the roadmap calls, recording what it was asked.
 *
 * `refuse` is a message the fake answers every roadmap call with as a 404 —
 * the API's own sentence when a sprint number names nothing.
 */
async function fakePlatform({ entry = IN_S1, refuse = null } = {}) {
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
      if (refuse && url.includes('/roadmap')) {
        response.writeHead(404, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ status: 404, message: refuse }));
      }
      if (url.startsWith('/api/projects/board/roadmap?')) {
        return json([entry]);
      }
      if (url.endsWith('/roadmap/255/plans') || url.endsWith('/roadmap/255/comments')) {
        return json([]);
      }
      if (url.includes('/roadmap/255') || url.endsWith('/roadmap')) {
        return json(entry);
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
  return { text: call.result.content[0].text, isError: call.result.isError === true };
}

test('a card prints its assignee by username, never the email', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  const { text } = await callTool(platform.url, 'roadmap_get', { number: 255 });

  assert.match(text, /^  assignee: ben$/m);
  assert.doesNotMatch(text, /ben@example\.com/);
});

test('a card with nobody prints no assignee line', async (t) => {
  const platform = await fakePlatform({ entry: { ...IN_S1, assignee: null } });
  t.after(() => platform.close());

  const { text } = await callTool(platform.url, 'roadmap_get', { number: 255 });

  assert.doesNotMatch(text, /assignee:/);
});

test('roadmap_update sends the assignee, "" clears, and leaving it out sends nothing', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  await callTool(platform.url, 'roadmap_update', { number: 255, assignee: 'ben' });
  await callTool(platform.url, 'roadmap_update', { number: 255, assignee: '' });
  await callTool(platform.url, 'roadmap_update', { number: 255, title: 'Renamed' });

  const patches = platform.seen.filter((call) => call.method === 'PATCH');
  assert.deepEqual(
    patches.map((call) => call.body),
    [{ assignee: 'ben' }, { assignee: '' }, { title: 'Renamed' }],
  );
});

test('roadmap_create can assign on the way in', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  await callTool(platform.url, 'roadmap_create', { title: 'New', assignee: 'ben' });

  const posted = platform.seen.find((call) => call.method === 'POST');
  assert.deepEqual(posted.body, { title: 'New', assignee: 'ben' });
});

test('roadmap_list passes assignee=me through', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  await callTool(platform.url, 'roadmap_list', { assignee: 'me' });

  const listed = platform.seen.find((call) => call.url.startsWith('/api/projects/board/roadmap?'));
  assert.equal(new URLSearchParams(listed.url.split('?')[1]).get('assignee'), 'me');
});

test('a refused assignee is passed through in the API\'s own words', async (t) => {
  const platform = await fakePlatform({
    refuse: 'ann@example.com has READER on board, and working on a card needs WRITER.',
  });
  t.after(() => platform.close());

  const { text, isError } = await callTool(platform.url, 'roadmap_update', {
    number: 255,
    assignee: 'ann',
  });

  assert.equal(isError, true);
  assert.match(text, /ann@example\.com has READER/);
});
