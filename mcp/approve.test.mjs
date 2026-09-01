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
async function fakePlatform({
  rules = [],
  rulesStatus = 200,
  sessionRules = [],
  sessionRulesStatus = 200,
  decide = null,
  onApproval = () => {},
} = {}) {
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
      if (rulesStatus !== 200) {
        // An API too old to have the endpoint answers exactly like this.
        response.writeHead(rulesStatus, { 'content-type': 'application/json' });
        return response.end('{"status":404,"error":"Not Found"}');
      }
      return json(rules.map((pattern) => ({ pattern })));
    }
    // R60. Checked BEFORE the project's rules in the URL matching here only
    // because this path is the more specific one — it lives under the run.
    if (url.includes('/runs/run-1/tool-rules')) {
      if (sessionRulesStatus !== 200) {
        response.writeHead(sessionRulesStatus, { 'content-type': 'application/json' });
        return response.end('{"status":404,"error":"Not Found"}');
      }
      return json(sessionRules.map((pattern) => ({ pattern })));
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

test('rules that cannot be read mean ask, not deny', async () => {
  // The endpoint 404s — an API older than R51 does exactly this. That is a
  // fact about the platform and not an answer about this call, so it must not
  // short-circuit the question: a whole session was once reported blocked on
  // npm and ng with nothing ever reaching anybody's inbox.
  const platform = await fakePlatform({
    rulesStatus: 404,
    decide: { state: 'ALLOWED', reason: 'go on then' },
  });
  try {
    const decision = JSON.parse(
      await callTool(platform.url, 'approve', { tool_name: 'Bash', input: bash }),
    );
    assert.equal(decision.behavior, 'allow');
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

// --- R60: a grant that lasts as long as the run ------------------------------

test('a session grant covers the next call, and no person is asked again', async () => {
  const platform = await fakePlatform({ sessionRules: ['Bash(mvn *)'] });
  try {
    const decision = JSON.parse(
      await callTool(platform.url, 'approve', { tool_name: 'Bash', input: bash }),
    );
    assert.equal(decision.behavior, 'allow');
    assert.match(decision.reason, /allowed for this session/);
    // The point of it: nobody was asked. Without this the session stops on
    // every call, which is what "allow once" already did.
    assert.deepEqual(platform.asked, []);
  } finally {
    platform.close();
  }
});

test('a session grant is NOT filtered by this machine\'s ceiling', async () => {
  // The whole of R60's decision, in one assertion. A project rule with an
  // empty ceiling is dropped; a session grant with the same empty ceiling
  // stands, because a person is watching this run and it dies with it.
  const platform = await fakePlatform({ sessionRules: ['Bash'] });
  try {
    const decision = JSON.parse(
      await callTool(
        platform.url,
        'approve',
        { tool_name: 'Bash', input: { command: 'cd backend && ./mvnw test' } },
        { CAWDEV_GRANTABLE: '[]' },
      ),
    );
    assert.equal(decision.behavior, 'allow');
    assert.deepEqual(platform.asked, []);
  } finally {
    platform.close();
  }
});

test('a project rule with the same pattern IS filtered by the ceiling', async () => {
  // The other half, so the pair says which rule the ceiling is about. This one
  // asks a person, and here nobody comes.
  const platform = await fakePlatform({ rules: ['Bash'], decide: null });
  try {
    const decision = JSON.parse(
      await callTool(
        platform.url,
        'approve',
        { tool_name: 'Bash', input: bash },
        { CAWDEV_GRANTABLE: '[]' },
      ),
    );
    assert.equal(decision.behavior, 'deny');
    assert.equal(platform.asked.length, 1, 'the ceiling should have sent this to a person');
  } finally {
    platform.close();
  }
});

test('session rules that cannot be read mean ask, not allow and not deny', async () => {
  // An API too old to have the endpoint answers 404, which is the normal case
  // mid-upgrade. Not knowing what was granted is a fact about the platform,
  // not about this call, so the session asks — as it did before R60 existed.
  const platform = await fakePlatform({
    sessionRulesStatus: 404,
    decide: { state: 'ALLOWED', reason: 'go on' },
  });
  try {
    const decision = JSON.parse(
      await callTool(platform.url, 'approve', { tool_name: 'Bash', input: bash }),
    );
    assert.equal(decision.behavior, 'allow');
    assert.equal(platform.asked.length, 1, 'it should have asked a person');
  } finally {
    platform.close();
  }
});
