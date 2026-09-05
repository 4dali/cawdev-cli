// node --test tools/mcp/ask-group.test.mjs
//
// R96's wire format, end to end through the real server over stdio.
//
// What this pins is the thing an interview depends on and no other test covers:
// a round is asked in ONE call, the session blocks until EVERY question in it
// has been answered, and what comes back pairs each answer with the question it
// belongs to. An agent matching six answers to six questions by counting is an
// agent one skipped question away from acting on the wrong one.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

const SERVER = new URL('./server.mjs', import.meta.url).pathname;

/**
 * A platform that answers only what `ask_group` asks it.
 *
 * `answers` is what the wait returns: null keeps answering 204 — "some of it is
 * still unanswered" — which is what the agent sees while the form sits in
 * somebody's inbox half filled in.
 */
async function fakePlatform({ answers = null } = {}) {
  const asked = [];
  let waits = 0;
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    const json = (body) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    if (url.startsWith('/api/agent/whoami')) {
      return json({ runId: 'run-1', projects: [{ slug: 'board' }] });
    }
    if (url.endsWith('/question-groups') && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      return request.on('end', () => {
        asked.push(JSON.parse(body));
        json({ id: 'group-1', runId: 'run-1', title: JSON.parse(body).title, seq: 1 });
      });
    }
    if (url.includes('/question-groups/group-1/answers')) {
      waits += 1;
      if (!answers) {
        response.writeHead(204);
        return response.end();
      }
      return json(answers);
    }
    response.writeHead(404);
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    asked,
    waited: () => waits,
    close: () => server.close(),
  };
}

async function callTool(url, name, args) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      CAWDEV_URL: url,
      CAWDEV_TOKEN: 'cawdr_test',
      CAWDEV_PROJECT: 'board',
      // Short, so the "nobody finished the form" path does not take ten minutes.
      CAWDEV_ASK_TIMEOUT_SECONDS: '2',
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
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    })}\n`,
  );
  child.stdin.end();
  await once(child, 'exit');

  const replies = out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const call = replies.find((reply) => reply.id === 2);
  assert.ok(call, `no reply to tools/call in: ${out}`);
  return call.result.content[0].text;
}

const round = {
  title: 'CTO Interview',
  intro: 'How this thing is released.',
  questions: [
    { question: 'Who may cut a release?', options: ['anybody', 'two people'] },
    { question: 'What breaks most often in production?' },
  ],
};

test('a whole round is asked in one call, under its own title', async () => {
  const platform = await fakePlatform({
    answers: [
      {
        id: 'q1',
        question: 'Who may cut a release?',
        answer: 'Two people, and never on a Friday.',
        answeredByEmail: 'lead@example.com',
      },
      {
        id: 'q2',
        question: 'What breaks most often in production?',
        answer: 'The nightly import.',
        answeredByEmail: 'lead@example.com',
      },
    ],
  });
  try {
    const text = await callTool(platform.url, 'ask_group', round);

    // One request, carrying the whole round — not one per question, which is
    // the interruption this entry exists to remove.
    assert.equal(platform.asked.length, 1);
    assert.equal(platform.asked[0].title, 'CTO Interview');
    assert.equal(platform.asked[0].questions.length, 2);

    // And what comes back pairs each answer with its own question.
    assert.match(text, /Who may cut a release\?/);
    assert.match(text, /Two people, and never on a Friday\./);
    assert.match(text, /The nightly import\./);
  } finally {
    platform.close();
  }
});

test('an unfinished round hands back a group_id rather than guessing', async () => {
  // The whole point of asking: the agent must not invent the answers and carry
  // on, and it must have something to wait on again.
  const platform = await fakePlatform({ answers: null });
  try {
    const text = await callTool(platform.url, 'ask_group', round);
    assert.match(text, /group-1/);
    assert.match(text, /await_group/);
    assert.match(text, /Do not guess/i);
    assert.ok(platform.waited() > 0, 'it should have waited at least once');
  } finally {
    platform.close();
  }
});

test('await_group picks the same round back up', async () => {
  const platform = await fakePlatform({
    answers: [{ id: 'q1', question: 'Who may cut a release?', answer: 'Two people.' }],
  });
  try {
    const text = await callTool(platform.url, 'await_group', { group_id: 'group-1' });
    assert.match(text, /Who may cut a release\?/);
    assert.match(text, /Two people\./);
    // Nothing was asked a second time: resuming a wait is not asking again.
    assert.equal(platform.asked.length, 0);
  } finally {
    platform.close();
  }
});
