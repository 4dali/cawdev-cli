// node --test tools/mcp/roadmap-tags.test.mjs
//
// i272: the tags an agent reads from roadmap_get are in code-unit order.
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
  tags: ['runner', 'a-b', 'ab', 'x.y'],
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

test('roadmap_get prints tags in code-unit order', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  const { text } = await callTool(platform.url, 'roadmap_get', { number: 255 });

  assert.match(text, /^ {2}tags: #a-b #ab #runner #x\.y$/m);
});
