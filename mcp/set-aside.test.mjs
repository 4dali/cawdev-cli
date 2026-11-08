// node --test tools/mcp/set-aside.test.mjs
//
// R630, end to end through the real server over stdio: a question the agent
// stops waiting on is set aside, with a short delay first so the ordinary
// "call await_answer again" does not flip the run between waiting and running.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const SERVER = new URL('./server.mjs', import.meta.url).pathname;

/** A platform that records every request and never answers the question. */
async function fakePlatform({ setAsideStatus = 200 } = {}) {
  const seen = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    seen.push(`${request.method} ${url.split('?')[0]}`);
    const json = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.startsWith('/api/agent/whoami')) {
      return json(200, { runId: 'run-1', projects: [{ slug: 'board' }] });
    }
    if (url.includes('/set-aside')) {
      return setAsideStatus === 200
        ? json(200, { id: 'q-1', setAside: request.method === 'POST' })
        : json(setAsideStatus, { message: 'no' });
    }
    if (url.includes('/questions/q-1/answer')) {
      // Slow enough that the server's own poll loop does not spin.
      return setTimeout(() => {
        response.writeHead(204);
        response.end();
      }, 300);
    }
    return json(200, []);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => server.close(),
  };
}

/** One server process that stays up across several tool calls. */
function session(url) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      CAWDEV_URL: url,
      CAWDEV_TOKEN: 'cawdr_test',
      CAWDEV_PROJECT: 'board',
      CAWDEV_ASK_TIMEOUT_SECONDS: '1',
      CAWDEV_SET_ASIDE_GRACE_SECONDS: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
    }
  });
  let next = 1;
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return {
    ready: () => send('initialize', {}),
    call: async (name, args) =>
      (await send('tools/call', { name, arguments: args })).result.content[0].text,
    stop: () => child.kill(),
  };
}

const setAsides = (seen) => seen.filter((line) => line.includes('/set-aside'));

test('the timer firing sets the question aside, once', async () => {
  const platform = await fakePlatform();
  const agent = session(platform.url);
  try {
    await agent.ready();
    const text = await agent.call('await_answer', { question_id: 'q-1' });
    assert.match(text, /set aside/);
    assert.match(text, /closed/);
    await sleep(1500);
    assert.deepEqual(setAsides(platform.seen), ['POST /api/projects/board/runs/run-1/questions/q-1/set-aside']);
  } finally {
    agent.stop();
    platform.close();
  }
});

test('waiting again at once cancels the timer with no request', async () => {
  const platform = await fakePlatform();
  const agent = session(platform.url);
  try {
    await agent.ready();
    await agent.call('await_answer', { question_id: 'q-1' });
    await agent.call('await_answer', { question_id: 'q-1' });
    assert.deepEqual(setAsides(platform.seen), []);
  } finally {
    agent.stop();
    platform.close();
  }
});

test('waiting again after it fired takes the set-aside back', async () => {
  const platform = await fakePlatform();
  const agent = session(platform.url);
  try {
    await agent.ready();
    await agent.call('await_answer', { question_id: 'q-1' });
    await sleep(1500);
    await agent.call('await_answer', { question_id: 'q-1' });
    const aside = platform.seen.filter((line) => line.includes('set-aside') || line.includes('/answer'));
    const post = aside.findIndex((line) => line.startsWith('POST'));
    const del = aside.findIndex((line) => line.startsWith('DELETE'));
    assert.ok(post >= 0 && del > post, `POST then DELETE expected in ${aside}`);
    assert.equal(aside.filter((line) => line.startsWith('POST')).length, 1);
    assert.equal(aside.filter((line) => line.startsWith('DELETE')).length, 1);
    // and the wait itself resumed after the DELETE
    assert.ok(aside.slice(del + 1).some((line) => line.startsWith('GET')));
  } finally {
    agent.stop();
    platform.close();
  }
});

test('any other tool call sets it aside first', async () => {
  const platform = await fakePlatform();
  const agent = session(platform.url);
  try {
    await agent.ready();
    await agent.call('await_answer', { question_id: 'q-1' });
    const before = platform.seen.length;
    await agent.call('roadmap_list', {});
    const after = platform.seen.slice(before);
    assert.match(after[0], /^POST .*\/questions\/q-1\/set-aside$/);
    assert.ok(after.length > 1, 'the tool itself still ran');
  } finally {
    agent.stop();
    platform.close();
  }
});

test('a refused set-aside does not break the tool', async () => {
  const platform = await fakePlatform({ setAsideStatus: 401 });
  const agent = session(platform.url);
  try {
    await agent.ready();
    await agent.call('await_answer', { question_id: 'q-1' });
    const text = await agent.call('roadmap_list', {});
    assert.ok(text.length > 0);
    assert.doesNotMatch(text, /Unauthorized|401/);
    const again = await agent.call('await_answer', { question_id: 'q-1' });
    assert.match(again, /Still nothing/);
  } finally {
    agent.stop();
    platform.close();
  }
});
