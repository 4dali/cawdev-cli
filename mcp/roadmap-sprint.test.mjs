// node --test tools/mcp/roadmap-sprint.test.mjs
//
// R257: what an agent sees of a card's sprint, and what it can say about one.
//
// An agent's whole reach on sprints is reading which one a card is in and
// filing a card into one; opening and closing are a person's acts and there
// is deliberately no tool for them. Pinned through the real server over stdio,
// like roadmap-plan.test.mjs, because the thing that matters is the TEXT a
// model reads and the BODY the platform receives.

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
  sprint: {
    id: 'sp-1', teamId: 't-1', teamName: 'Core team', number: 1, ref: 'S1', label: 'Core team · S1',
    name: 'Notifications', state: 'ACTIVE',
  },
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
      if (url.startsWith('/api/projects/board/sprints')) {
        return json([
          {
            id: 'sp-1', ref: 'S1', label: 'Core team · S1', name: 'Notifications', state: 'ACTIVE',
            goal: 'Ship the bell', counts: { cards: 9, landed: 4 },
          },
          { id: 'sp-2', ref: 'S2', label: 'Web · S2', name: '', state: 'UPCOMING', counts: { cards: 0, landed: 0 } },
        ]);
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

test('roadmap_list narrows to a sprint by number', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  const { text } = await callTool(platform.url, 'roadmap_list', { sprint: 1 });

  const listed = platform.seen.find((call) => call.url.startsWith('/api/projects/board/roadmap?'));
  assert.ok(listed, `no listing in ${JSON.stringify(platform.seen)}`);
  const query = new URLSearchParams(listed.url.split('?')[1]);
  assert.equal(query.get('sprint'), '1');
  assert.equal(query.get('brief'), 'true');
  assert.match(text, /R255 — A run whose runner goes quiet/);
});

test('a card in a sprint says so, under its section', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  const { text } = await callTool(platform.url, 'roadmap_get', { number: 255 });

  assert.match(text, /^  sprint: Core team · S1 Notifications \(active\)$/m);
  assert.ok(text.indexOf('section: Phase 7') < text.indexOf('sprint: Core team'));
});

test('a completed sprint is printed as completed', async (t) => {
  const platform = await fakePlatform({
    entry: { ...IN_S1, sprint: { ...IN_S1.sprint, state: 'COMPLETED' } },
  });
  t.after(() => platform.close());

  const { text } = await callTool(platform.url, 'roadmap_get', { number: 255 });

  assert.match(text, /^  sprint: Core team · S1 Notifications \(completed\)$/m);
});

test('a sprint written before teams (no label) still prints its ref', async (t) => {
  const platform = await fakePlatform({
    entry: { ...IN_S1, sprint: { number: 1, ref: 'S1', name: 'Notifications' } },
  });
  t.after(() => platform.close());

  const { text } = await callTool(platform.url, 'roadmap_get', { number: 255 });

  assert.match(text, /^  sprint: S1 Notifications$/m);
});

test('a card in no sprint prints no sprint line', async (t) => {
  const platform = await fakePlatform({ entry: { ...IN_S1, sprint: null } });
  t.after(() => platform.close());

  const { text } = await callTool(platform.url, 'roadmap_get', { number: 255 });

  assert.doesNotMatch(text, /sprint:/);
});

test('roadmap_update files a card into a sprint in any spelling, and 0 or "" takes it out', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  await callTool(platform.url, 'roadmap_update', { number: 255, sprint: 1 });
  await callTool(platform.url, 'roadmap_update', { number: 255, sprint: 'S1' });
  await callTool(platform.url, 'roadmap_update', { number: 255, sprint: 'Core team · S1' });
  await callTool(platform.url, 'roadmap_update', { number: 255, sprint: 0 });
  await callTool(platform.url, 'roadmap_update', { number: 255, sprint: '' });
  // Leaving it out leaves it alone: no `sprint` key reaches the platform.
  await callTool(platform.url, 'roadmap_update', { number: 255, title: 'Renamed' });

  const patches = platform.seen.filter((call) => call.method === 'PATCH');
  assert.deepEqual(
    patches.map((call) => call.body),
    [
      { sprint: 1 }, { sprint: 'S1' }, { sprint: 'Core team · S1' }, { sprint: 0 }, { sprint: '' },
      { title: 'Renamed' },
    ],
  );
});

test('roadmap_create can file the new card straight into a sprint', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  await callTool(platform.url, 'roadmap_create', { title: 'New', sprint: 'Core team · S1' });

  const posted = platform.seen.find((call) => call.method === 'POST');
  assert.deepEqual(posted.body, { title: 'New', sprint: 'Core team · S1' });
});

test('roadmap_list passes a string spelling through as ?sprint=', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  await callTool(platform.url, 'roadmap_list', { sprint: 'Core team · S1' });

  const listed = platform.seen.find((call) => call.url.startsWith('/api/projects/board/roadmap?'));
  assert.equal(new URLSearchParams(listed.url.split('?')[1]).get('sprint'), 'Core team · S1');
});

test('sprint_list prints one line per sprint, active and upcoming by default', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  const { text } = await callTool(platform.url, 'sprint_list', {});

  const asked = platform.seen.find((call) => call.url.startsWith('/api/projects/board/sprints'));
  assert.equal(new URLSearchParams(asked.url.split('?')[1]).get('state'), 'ACTIVE,UPCOMING');
  assert.match(text, /^Core team · S1 Notifications — active — 4 of 9 landed$/m);
  assert.match(text, /^    goal: Ship the bell$/m);
  assert.match(text, /^Web · S2 — upcoming — 0 of 0 landed$/m);

  await callTool(platform.url, 'sprint_list', { state: 'COMPLETED' });
  const again = platform.seen.filter((call) => call.url.startsWith('/api/projects/board/sprints'));
  assert.equal(new URLSearchParams(again[1].url.split('?')[1]).get('state'), 'COMPLETED');
});

test('a sprint the project does not have is refused in the API\'s own words', async (t) => {
  const platform = await fakePlatform({
    refuse: 'board has no S4; its sprints are Core team · S1 Notifications.',
  });
  t.after(() => platform.close());

  const { text, isError } = await callTool(platform.url, 'roadmap_list', { sprint: 4 });

  // The sentence names what exists, so the agent recovers in one call — the
  // reason the server passes the API's message through and adds nothing.
  assert.equal(isError, true);
  assert.equal(text, 'board has no S4; its sprints are Core team · S1 Notifications.');
});
