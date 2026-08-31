#!/usr/bin/env node
// R10's "Done when": a scripted JSON-RPC session asks a question, a separate
// HTTP call answers it, and the tool call returns the answer — plus the
// ten-minute pending path, on a shortened timeout.
//
//   node tools/mcp/orchestration-smoke.mjs <project>
//
// Needs a session that can start a run (CAWDEV_BASE, CAWDEV_ADMIN_EMAIL,
// CAWDEV_ADMIN_PASSWORD), because starting a run is a person's act — an agent
// cannot start another agent, so this test cannot bootstrap itself from a token.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CAWDEV_BASE ?? 'http://localhost:8091';
const EMAIL = process.env.CAWDEV_ADMIN_EMAIL ?? 'admin@cawdev.local';
const PASSWORD = process.env.CAWDEV_ADMIN_PASSWORD ?? 'dev-admin-password';

const project = process.argv[2];
if (!project) {
  console.error('Usage: node tools/mcp/orchestration-smoke.mjs <project>');
  console.error('Use a scratch project: this starts a run and creates a roadmap entry.');
  process.exit(2);
}

// --- a session, for the things only a person may do -------------------------

let cookie = '';
let csrf = '';

function headers(json = true) {
  return {
    cookie,
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(csrf ? { 'x-xsrf-token': csrf } : {}),
  };
}

function remember(response) {
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(';');
    const [name, ...rest] = pair.split('=');
    if (name === 'XSRF-TOKEN') csrf = rest.join('=');
    const others = cookie.split('; ').filter((entry) => entry && !entry.startsWith(`${name}=`));
    cookie = [...others, pair].join('; ');
  }
}

async function session(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, { ...options, headers: headers() });
  remember(response);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} -> ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

await fetch(`${BASE}/api/auth/me`, { headers: headers(false) }).then(remember);
await session('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});

// A fresh entry and run. Any earlier live run would block this one.
for (const run of await session(`/api/projects/${project}/runs`)) {
  if (run.live) {
    await session(`/api/projects/${project}/runs/${run.id}/transition`, {
      method: 'POST',
      body: JSON.stringify({ state: 'CANCELLED', summary: 'Cleared by the orchestration smoke.' }),
    });
  }
}

const entry = await session(`/api/projects/${project}/roadmap`, {
  method: 'POST',
  body: JSON.stringify({
    title: 'orchestration smoke (safe to decline)',
    body: 'Created by tools/mcp/orchestration-smoke.mjs.\n\n**Build:** nothing, really.',
  }),
});

const started = await session(`/api/projects/${project}/runs`, {
  method: 'POST',
  body: JSON.stringify({ entryNumber: entry.number, branch: `r${entry.number}-smoke` }),
});
const runId = started.id;

// The runner's part: claim it and set it running, so the agent's token is
// working on a run that is actually going.
const runnerToken = (
  await session('/api/tokens', {
    method: 'POST',
    body: JSON.stringify({
      label: `orchestration smoke ${Date.now()}`,
      grants: { [project]: ['runner:operate'] },
    }),
  })
).secret;

async function asRunner(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runnerToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

const runner = await asRunner('/api/runners', { name: `smoke-${Date.now()}` });
// The claim is where the run token comes from — it goes straight to the runner,
// never to the person who started the run.
const claimed = await asRunner(`/api/runners/${runner.id}/claim/${runId}`);
await asRunner(`/api/projects/${project}/runs/${runId}/transition`, { state: 'RUNNING' });

// --- the agent's side, over real stdio ---------------------------------------

const server = spawn(process.execPath, [join(here, 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {
    ...process.env,
    CAWDEV_URL: BASE,
    CAWDEV_TOKEN: claimed.runToken,
    // Short, so the pending path can be exercised without waiting ten minutes.
    CAWDEV_ASK_TIMEOUT_SECONDS: '3',
  },
});

let buffer = '';
const waiting = new Map();
server.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const resolve = waiting.get(message.id);
    if (resolve) {
      waiting.delete(message.id);
      resolve(message);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`${method} timed out`)), 60_000).unref();
  });
}
const callTool = (name, args = {}) => request('tools/call', { name, arguments: args });
const textOf = (result) => result?.content?.map((part) => part.text).join('\n') ?? '';

const checks = [];
function check(description, condition, detail = '') {
  checks.push(Boolean(condition));
  console.log(
    `${condition ? 'ok  ' : 'FAIL'}  ${description}${detail && !condition ? `\n        ${detail}` : ''}`,
  );
}

try {
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });

  const current = await callTool('task_current');
  check(
    'task_current re-orients: entry, branch and run state',
    !current.result?.isError
      && textOf(current.result).includes(`r${entry.number}-smoke`)
      && textOf(current.result).includes('orchestration smoke'),
    textOf(current.result),
  );

  const progress = await callTool('report', { kind: 'progress', body: 'Read the entry.' });
  check('report progress keeps the run RUNNING',
    textOf(progress.result).includes('RUNNING'), textOf(progress.result));

  // The pending path: nobody answers within the shortened timeout.
  const pending = await callTool('ask_user', { question: 'Nobody will answer this one.' });
  check(
    'ask_user hands back a question_id when nobody answers',
    textOf(pending.result).includes('await_answer')
      && /question_id [0-9a-f-]{36}/.test(textOf(pending.result)),
    textOf(pending.result),
  );
  const pendingId = /question_id ([0-9a-f-]{36})/.exec(textOf(pending.result))?.[1];

  // R10's headline: the agent asks and blocks; something else answers; the
  // tool call returns the answer.
  const asking = callTool('ask_user', {
    question: 'Postgres or SQLite?',
    options: ['Postgres', 'SQLite'],
  });

  // Give the ask time to reach the platform, then answer it from outside.
  await new Promise((resolve) => setTimeout(resolve, 800));
  // Three groups since R36, not one list: what is on you, what you passed on,
  // and what somebody wants your opinion about. Nothing has been passed
  // anywhere here, so it is in the first.
  const inbox = await session('/api/inbox');
  const target = inbox.waitingOnYou.find(
    (item) => item.question.question === 'Postgres or SQLite?',
  );
  check('the question reached the inbox with its run context',
    target && target.projectSlug === project, JSON.stringify(inbox));

  await session(
    `/api/projects/${project}/runs/${runId}/questions/${target.question.id}/answer`,
    { method: 'POST', body: JSON.stringify({ answer: 'Postgres, to match the platform.' }) },
  );

  const answered = await asking;
  check(
    'the waiting ask_user call returns the answer',
    !answered.result?.isError
      && textOf(answered.result).includes('Postgres, to match the platform.')
      && textOf(answered.result).includes(EMAIL),
    textOf(answered.result),
  );

  // And await_answer resumes the one left pending.
  await session(`/api/projects/${project}/runs/${runId}/questions/${pendingId}/answer`, {
    method: 'POST',
    body: JSON.stringify({ answer: 'Answered late.' }),
  });
  const resumed = await callTool('await_answer', { question_id: pendingId });
  check('await_answer picks up the question ask_user handed back',
    textOf(resumed.result).includes('Answered late.'), textOf(resumed.result));

  const done = await callTool('report', {
    kind: 'done',
    body: `Nothing to build. Branch r${entry.number}-smoke exists only in this test.`,
  });
  check('report done ends the run, and says the token is spent',
    textOf(done.result).includes('FINISHED') && textOf(done.result).includes('expired'),
    textOf(done.result));

  // The run is over, so its token is too.
  const afterwards = await callTool('task_current');
  check('the run token stops working once the run has ended',
    afterwards.result?.isError, textOf(afterwards.result));
} finally {
  server.stdin.end();
  // Leave the entry declined rather than lying around as PLANNED — entries
  // cannot be deleted, so the least noise is an honest reason.
  await session(`/api/projects/${project}/roadmap/${entry.number}/decline`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'A smoke-test entry, declined by the test that made it.' }),
  }).catch(() => undefined);
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed.`);
process.exit(failed ? 1 : 0);
