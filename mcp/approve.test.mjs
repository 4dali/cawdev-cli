// node --test tools/mcp/approve.test.mjs
//
// R51's wire format, end to end through the real server over stdio.
//
// What this pins is the one thing no other test can: Claude Code reads the
// tool's result TEXT as JSON and acts on `behavior`. Get that shape wrong and
// the session does not fail loudly — it stops, which is the exact failure the
// whole entry exists to end. So the platform is faked and the server is real.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

const SERVER = new URL('./server.mjs', import.meta.url).pathname;

/**
 * A platform that answers only what `approve` asks it.
 *
 * `decide` says what the decision endpoint does: an object is returned as the
 * decision, and null keeps answering 204 — "still pending" — which is what the
 * agent's long poll sees while nobody has looked.
 */
async function fakePlatform({ rules = [], decide = null, onApproval = () => {} } = {}) {
  const asked = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    const json = (body) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    if (url.startsWith('/api/agent/whoami')) {
      return json({ runId: 'run-1', projects: [{ slug: 'board' }] });
    }
    if (url.startsWith('/api/projects/board/tool-rules')) {
      return json(rules.map((pattern) => ({ pattern })));
    }
    if (url.endsWith('/approvals') && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      return request.on('end', () => {
        asked.push(JSON.parse(body));
        onApproval();
        json({ id: 'approval-1', pending: true });
      });
    }
    if (url.includes('/approvals/approval-1/decision')) {
      if (!decide) {
        response.writeHead(204);
        return response.end();
      }
      return json(decide);
    }
    response.writeHead(404);
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, asked, close: () => server.close() };
}

/** Calls one tool on a fresh server process and returns its result text. */
async function callTool(url, name, args, env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      CAWDEV_URL: url,
      CAWDEV_TOKEN: 'cawdr_test',
      CAWDEV_PROJECT: 'board',
      // Short, so the "nobody came" path does not take sixteen minutes.
      CAWDEV_APPROVAL_TIMEOUT_SECONDS: '2',
      ...env,
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

  const replies = out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const call = replies.find((reply) => reply.id === 2);
  assert.ok(call, `no reply to tools/call in: ${out}`);
  return call.result.content[0].text;
}

const bash = { command: 'mvn --version' };

test('a person allowing it comes back as behavior: allow', async () => {
  const platform = await fakePlatform({
    decide: { state: 'ALLOWED', reason: 'go on then' },
  });
  try {
    const text = await callTool(platform.url, 'approve', {
      tool_name: 'Bash',
      input: bash,
      tool_use_id: 'toolu_1',
    });
    const decision = JSON.parse(text);
    assert.equal(decision.behavior, 'allow');
    // Echoed back unchanged: the handler says yes or no, it does not rewrite
    // what the agent was about to do behind its back.
    assert.deepEqual(decision.updatedInput, bash);

    // And what it asked a person to decide on.
    assert.equal(platform.asked[0].summary, 'mvn --version');
    assert.equal(platform.asked[0].suggestion, 'Bash(mvn *)');
    assert.equal(platform.asked[0].toolUseId, 'toolu_1');
  } finally {
    platform.close();
  }
});

test('a refusal carries the reason, and tells the agent not to work around it', async () => {
  const platform = await fakePlatform({
    decide: { state: 'DENIED', reason: 'Not from an unattended session.' },
  });
  try {
    const decision = JSON.parse(
      await callTool(platform.url, 'approve', { tool_name: 'Bash', input: bash }),
    );
    assert.equal(decision.behavior, 'deny');
    assert.match(decision.message, /Not from an unattended session/);
    assert.match(decision.message, /report/);
  } finally {
    platform.close();
  }
});

test('nobody answering denies rather than hanging', async () => {
  // The platform never decides. The agent must not wait for ever, and must be
  // told to stop rather than retry in a loop.
  const platform = await fakePlatform({ decide: null });
  try {
    const decision = JSON.parse(
      await callTool(platform.url, 'approve', { tool_name: 'Bash', input: bash }),
    );
    assert.equal(decision.behavior, 'deny');
    assert.match(decision.message, /report/i);
    assert.match(decision.message, /loop|retry/i);
  } finally {
    platform.close();
  }
});

test('a rule inside the ceiling settles it without asking anybody', async () => {
  const platform = await fakePlatform({ rules: ['Bash(mvn *)'] });
  try {
    const decision = JSON.parse(
      await callTool(
        platform.url,
        'approve',
        { tool_name: 'Bash', input: bash },
        { CAWDEV_GRANTABLE: JSON.stringify(['Bash(mvn *)']) },
      ),
    );
    assert.equal(decision.behavior, 'allow');
    assert.equal(platform.asked.length, 0, 'it should not have asked a person');
  } finally {
    platform.close();
  }
});

test('a rule outside the machine ceiling still asks', async () => {
  // The project allows Maven; this machine has not agreed to run it
  // unattended. The platform can narrow what runs here, never widen it.
  const platform = await fakePlatform({
    rules: ['Bash(mvn *)'],
    decide: { state: 'ALLOWED' },
  });
  try {
    const decision = JSON.parse(
      await callTool(
        platform.url,
        'approve',
        { tool_name: 'Bash', input: bash },
        { CAWDEV_GRANTABLE: JSON.stringify(['Bash(npm *)']) },
      ),
    );
    assert.equal(decision.behavior, 'allow'); // because a person said so
    assert.equal(platform.asked.length, 1, 'a person had to be asked');
  } finally {
    platform.close();
  }
});

test('an unreachable platform denies, and says so', async () => {
  // Fail closed. Whatever goes wrong, the answer is a well-formed decision:
  // a malformed one stops the session without saying why.
  const decision = JSON.parse(
    await callTool('http://127.0.0.1:1', 'approve', { tool_name: 'Bash', input: bash }),
  );
  assert.equal(decision.behavior, 'deny');
  assert.match(decision.message, /could not be asked/i);
});
