// node --test tools/mcp/issue-affected.test.mjs
//
// R378: the versions an issue was found in — what an agent can say when it
// files or edits one, and what it reads back. Through the real server over
// stdio, like roadmap-sprint.test.mjs: the BODY the platform receives and the
// TEXT a model reads.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

const SERVER = new URL('./server.mjs', import.meta.url).pathname;

const ISSUE = {
  number: 7,
  ref: 'i7',
  title: 'The board forgets its order',
  statusDisplay: 'CONFIRMED',
  affectedVersions: ['v1.0.9', 'v1.0.10'],
  body: 'The body.',
};

async function fakePlatform(entry = ISSUE) {
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
      if (url.endsWith('/plans') || url.endsWith('/comments')) {
        return json([]);
      }
      return json(entry);
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
  const call = out.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((r) => r.id === 2);
  assert.ok(call, `no reply to tools/call in: ${out}`);
  return { text: call.result.content[0].text };
}

test('issue_file forwards affectedVersions in the body', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  await callTool(platform.url, 'issue_file', {
    title: 'The board forgets its order',
    severity: 'MEDIUM',
    affectedVersions: ['v1.0.9', 'V1.0.10'],
  });

  const filed = platform.seen.find((call) => call.method === 'POST' && call.url.endsWith('/issues'));
  assert.ok(filed, `no filing in ${JSON.stringify(platform.seen)}`);
  assert.deepEqual(filed.body.affectedVersions, ['v1.0.9', 'V1.0.10']);
});

test('roadmap_update forwards affectedVersions, and [] with it', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  await callTool(platform.url, 'roadmap_update', { number: 'i7', affectedVersions: [] });

  const patched = platform.seen.find((call) => call.method === 'PATCH');
  assert.ok(patched, `no PATCH in ${JSON.stringify(platform.seen)}`);
  assert.deepEqual(patched.body.affectedVersions, []);
});

test('an issue prints affects:, shipped or not', async (t) => {
  const shipped = { ...ISSUE, statusDisplay: 'FIXED', version: 'v1.0.11' };
  for (const entry of [ISSUE, shipped]) {
    const platform = await fakePlatform(entry);
    t.after(() => platform.close());
    const { text } = await callTool(platform.url, 'roadmap_get', { number: 'i7' });
    assert.match(text, /^ {2}affects: v1\.0\.9, v1\.0\.10$/m);
  }
});

test('an issue found nowhere prints no affects line', async (t) => {
  const platform = await fakePlatform({ ...ISSUE, affectedVersions: [] });
  t.after(() => platform.close());
  const { text } = await callTool(platform.url, 'roadmap_get', { number: 'i7' });
  assert.doesNotMatch(text, /affects:/);
});
