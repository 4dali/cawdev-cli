// node --test tools/mcp/backlog-file.test.mjs
//
// R372: feedback an agent files says who it came from. `agent` is added at
// the agent's own door, beside whatever sources the agent names. Pinned
// through the real server over stdio, as roadmap-assignee.test.mjs, because
// the thing that matters is the BODY the platform receives.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

const SERVER = new URL('./server.mjs', import.meta.url).pathname;

async function fakePlatform() {
  const seen = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      seen.push({ method: request.method, url, body: raw ? JSON.parse(raw) : null });
      response.writeHead(200, { 'content-type': 'application/json' });
      if (url.startsWith('/api/agent/whoami')) {
        return response.end(JSON.stringify({ runId: 'run-1', projects: [{ slug: 'board' }] }));
      }
      return response.end(JSON.stringify({ id: 'item-1', title: 'Slow board', tags: [] }));
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
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args },
  })}\n`);
  child.stdin.end();
  await once(child, 'exit');
  const call = out.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .find((reply) => reply.id === 2);
  assert.ok(call, `no reply to tools/call in: ${out}`);
  return { text: call.result.content[0].text, isError: call.result.isError === true };
}

const posted = (platform) =>
  platform.seen.find((call) => call.method === 'POST' && call.url.endsWith('/backlog')).body;

test('backlog_file tags the item `agent` when the agent names no source', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  const { isError } = await callTool(platform.url, 'backlog_file',
    { kind: 'ISSUE', title: 'Slow board', body: 'Noticed while coding.' });

  assert.equal(isError, false);
  assert.deepEqual(posted(platform),
    { kind: 'ISSUE', title: 'Slow board', body: 'Noticed while coding.', tags: ['agent'] });
});

test('backlog_file keeps the sources the agent names, and adds `agent` once', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  await callTool(platform.url, 'backlog_file',
    { kind: 'FEATURE', title: 'Export', body: 'A user asked.', tags: ['customer', 'agent'] });

  assert.deepEqual(posted(platform).tags, ['customer', 'agent']);
});
