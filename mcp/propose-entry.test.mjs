// node --test tools/mcp/propose-entry.test.mjs
//
// R214: what `propose_entry` sends, and what the audit reads back.
//
// Pinned through the real server over stdio, like roadmap-plan.test.mjs: the
// two things that matter are the body the platform receives — an audit written
// before there was a `kind` must still file an issue — and the sentence the
// model reads, which has to say what it proposed and that nobody has decided.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

const SERVER = new URL('./server.mjs', import.meta.url).pathname;

/** A platform that answers whoami and echoes a proposal back with a seq. */
async function fakePlatform({ refuse = null } = {}) {
  const posted = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    const json = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.startsWith('/api/agent/whoami')) {
      return json(200, { runId: 'run-1', projects: [{ slug: 'board' }] });
    }
    if (url.endsWith('/runs/run-1/proposals') && request.method === 'POST') {
      let raw = '';
      request.on('data', (chunk) => (raw += chunk));
      request.on('end', () => {
        const body = JSON.parse(raw);
        posted.push(body);
        if (refuse) {
          return json(400, { status: 400, message: refuse });
        }
        return json(200, { id: 'p-1', seq: posted.length, ...body });
      });
      return undefined;
    }
    response.writeHead(404);
    return response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, posted, close: () => server.close() };
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

test('a finding with no kind is an issue, exactly as every audit before R214 filed it', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  const text = await callTool(platform.url, 'propose_entry', {
    severity: 'medium', title: 'The runner leaks a token', body: 'In runner.mjs.',
  });

  assert.deepEqual(platform.posted, [{
    kind: 'ISSUE', severity: 'MEDIUM', title: 'The runner leaks a token', body: 'In runner.mjs.',
  }]);
  assert.match(text, /Proposed #1 as an issue \(MEDIUM\) — The runner leaks a token\./);
  // Not on the roadmap, not on the issues board: on neither, until a person says.
  assert.match(text, /not on any board: somebody will decide/);
});

test('a roadmap proposal carries no severity, and says it is a card', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  const text = await callTool(platform.url, 'propose_entry', {
    kind: 'roadmap', title: 'The Git tab shows the card behind a branch', body: 'Should.',
  });

  // `severity` is absent, not null: the API's rule is "refused for a card",
  // and an explicit null would be a value to refuse.
  assert.deepEqual(platform.posted, [{
    kind: 'ROADMAP', title: 'The Git tab shows the card behind a branch', body: 'Should.',
  }]);
  assert.match(text, /Proposed #1 as a roadmap card — The Git tab shows the card behind a branch\./);
});

test('the platform decides whether the kind and severity agree, and its sentence reaches the audit', async (t) => {
  // The tool does not second-guess the rule: a card with a severity is the
  // API's 400, worded for a reader, and that wording is what the model sees.
  const platform = await fakePlatform({
    refuse: 'A roadmap proposal has no severity: it is something to build, not something broken.',
  });
  t.after(() => platform.close());

  const text = await callTool(platform.url, 'propose_entry', {
    kind: 'roadmap', severity: 'minor', title: 'A card', body: 'x',
  });

  assert.equal(platform.posted[0].kind, 'ROADMAP');
  assert.equal(platform.posted[0].severity, 'MINOR');
  assert.match(text, /A roadmap proposal has no severity/);
});
