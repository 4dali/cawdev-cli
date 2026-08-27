#!/usr/bin/env node
// R12's "Done when": the requirement-6-to-8 loop, driven entirely through the
// endpoints the console calls — start on an entry, watch messages arrive,
// answer a question from the inbox, see the finish report carrying the branch.
//
//   node tools/console/console-smoke.mjs <project>
//
// Every person-side call here is one `frontend/src/app/core/runs.service.ts`
// makes, in the order the console makes it, on a real session cookie with the
// CSRF header the browser sends. That is the point: this passes only if the
// console's own surface is complete, so a missing endpoint fails here rather
// than in someone's browser.
//
// The agent's half is a stand-in — the loop under test is the console's, not
// the CLI's, and tools/mcp/orchestration-smoke.mjs already covers the agent
// side over real stdio. It writes to the platform on a run token obtained the
// way a runner obtains one, by claiming.
//
// Needs CAWDEV_BASE, CAWDEV_ADMIN_EMAIL, CAWDEV_ADMIN_PASSWORD.

const BASE = process.env.CAWDEV_BASE ?? 'http://localhost:8091';
const EMAIL = process.env.CAWDEV_ADMIN_EMAIL ?? 'admin@cawdev.local';
const PASSWORD = process.env.CAWDEV_ADMIN_PASSWORD ?? 'dev-admin-password';

const project = process.argv[2];
if (!project) {
  console.error('Usage: node tools/console/console-smoke.mjs <project>');
  console.error('Use a scratch project: this creates a roadmap entry and starts a run.');
  process.exit(2);
}

const checks = [];
function check(description, condition, detail = '') {
  checks.push(Boolean(condition));
  console.log(
    `${condition ? 'ok  ' : 'FAIL'}  ${description}${detail && !condition ? `\n        ${detail}` : ''}`,
  );
}

// --- the browser's half: a session cookie and the CSRF header ----------------

let cookie = '';
let csrf = '';

function remember(response) {
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(';');
    const [name, ...rest] = pair.split('=');
    if (name === 'XSRF-TOKEN') csrf = rest.join('=');
    const others = cookie.split('; ').filter((entry) => entry && !entry.startsWith(`${name}=`));
    cookie = [...others, pair].join('; ');
  }
}

/** A call the console makes. `expect` asserts a refusal instead of a result. */
async function console_(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      cookie,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(csrf ? { 'x-xsrf-token': csrf } : {}),
    },
  });
  remember(response);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (options.expect) {
    if (response.status !== options.expect) {
      throw new Error(`${path} -> ${response.status}, wanted ${options.expect}: ${text}`);
    }
    return body;
  }
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} -> ${response.status}: ${text}`);
  }
  return body;
}

await fetch(`${BASE}/api/auth/me`, { headers: { cookie } }).then(remember);
await console_('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});

// --- the agent's half: a runner, and the token claiming hands it -------------

const runnerToken = (
  await console_('/api/tokens', {
    method: 'POST',
    body: JSON.stringify({
      label: `console smoke ${new Date().toISOString()}`,
      grants: { [project]: ['runner:operate'] },
    }),
  })
).secret;

async function asToken(token, path, body, method = 'POST') {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status}: ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

const runner = await asToken(runnerToken, '/api/runners', {
  name: `console-smoke-${process.pid}`,
});

// The console clears the way: an earlier live run would refuse this one, and
// cancelling is a console action too.
for (const run of await console_(`/api/projects/${project}/runs`)) {
  if (run.live) {
    await console_(`/api/projects/${project}/runs/${run.id}/transition`, {
      method: 'POST',
      body: JSON.stringify({ state: 'CANCELLED', summary: 'Cleared by the console smoke.' }),
    });
  }
}

const entry = await console_(`/api/projects/${project}/roadmap`, {
  method: 'POST',
  body: JSON.stringify({
    title: 'console smoke (safe to decline)',
    body: 'Created by tools/console/console-smoke.mjs.\n\n**Build:** nothing.',
  }),
});

let runId;
try {
  // --- what the entry page shows before you press start ---------------------

  const runners = await console_('/api/runners');
  const live = runners.filter((each) => each.alive);
  check(
    'the entry page can see which runners are live',
    live.some((each) => each.id === runner.id),
    JSON.stringify(runners),
  );

  // The branch the console proposes. Kept in step with proposeBranch() in
  // runs.service.ts, and with the working method that names branches after the
  // entry — roadmap.mjs --live checks CODING branches exist.
  const branch = `r${entry.number}-${entry.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 5)
    .join('-')}`;
  check('the proposed branch names the entry', branch === `r${entry.number}-console-smoke-safe-to-decline`, branch);

  // --- start ---------------------------------------------------------------

  const started = await console_(`/api/projects/${project}/runs`, {
    method: 'POST',
    body: JSON.stringify({ entryNumber: entry.number, branch }),
  });
  runId = started.id;
  check('start returns a queued run on the entry', started.state === 'QUEUED'
    && started.entryNumber === entry.number && started.branch === branch, JSON.stringify(started));
  // The platform deliberately does *not* move the entry: the agent moves it to
  // CODING itself, naming the branch, before its first commit. If starting did
  // it, CODING would mean "queued" rather than "someone is working on this".
  check('starting leaves the entry where it was — moving it is the agent\'s first act',
    (await console_(`/api/projects/${project}/roadmap/${entry.number}`)).status === 'PLANNED');

  // One live run per project, because runs share a working copy. This is the
  // refusal the entry page has to render, so it must read like a sentence.
  const refused = await console_(`/api/projects/${project}/runs`, {
    method: 'POST',
    expect: 409,
    body: JSON.stringify({ entryNumber: entry.number, branch }),
  });
  check('a second live run in the project is refused readably',
    typeof refused?.message === 'string' && /run/i.test(refused.message), JSON.stringify(refused));

  // --- watch ---------------------------------------------------------------

  const claimed = await asToken(runnerToken, `/api/runners/${runner.id}/claim/${runId}`);
  await asToken(runnerToken, `/api/projects/${project}/runs/${runId}/transition`, {
    state: 'RUNNING',
  });
  const runToken = claimed.runToken;

  const runPath = `/api/projects/${project}/runs/${runId}`;
  await asToken(runToken, `${runPath}/messages`, {
    kind: 'PROGRESS',
    body: 'Read the entry. Nothing to build.',
  });

  // What the runner streams: the session's own output, not the agent's reports.
  await asToken(runnerToken, `${runPath}/output`, {
    lines: [
      { kind: 'SYSTEM', body: 'session 1a2b3c4d started on claude-opus-5' },
      { kind: 'ASSISTANT', body: 'Reading the entry.' },
      { kind: 'TOOL', body: 'Read README.md' },
    ],
  });
  await console_(`${runPath}/prompts`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'A prompt from the console smoke.' }),
  });

  const watching = await console_(`/api/projects/${project}/runs/${runId}`);
  check('the run detail shows it running on the runner that claimed it',
    watching.state === 'RUNNING' && watching.runnerName === runner.name, JSON.stringify(watching));
  const messages = await console_(`/api/projects/${project}/runs/${runId}/messages`);
  check('the message the agent reported is on the run detail',
    messages.some((message) => message.body.includes('Nothing to build.')), JSON.stringify(messages));

  // --- answer --------------------------------------------------------------

  // The agent asks and blocks on the long poll. The console has to notice
  // without being told.
  const asked = await asToken(runToken, `${runPath}/questions`, {
    question: 'Postgres or SQLite?',
    options: ['Postgres', 'SQLite'],
  });
  const asking = asToken(
    runToken, `${runPath}/questions/${asked.id}/answer?wait=25`, undefined, 'GET',
  );

  // The shell's badge: the same long poll, which should return as soon as the
  // question exists rather than after its full wait.
  const before = Date.now();
  const inbox = await console_('/api/inbox?wait=20');
  const waited = Math.round((Date.now() - before) / 1000);
  const item = inbox.find((each) => each.runId === runId);
  check('the inbox long poll returns the question as soon as it is asked',
    item && waited < 15, `waited ${waited}s: ${JSON.stringify(inbox)}`);
  check('the inbox item carries enough to route to the run',
    item?.projectSlug === project && item?.entryNumber === entry.number
      && item?.question.options.length === 2, JSON.stringify(item));

  check('the run is waiting on a person, and says so',
    (await console_(`/api/projects/${project}/runs/${runId}`)).state === 'WAITING_ON_USER');

  await console_(
    `/api/projects/${project}/runs/${runId}/questions/${item.question.id}/answer`,
    { method: 'POST', body: JSON.stringify({ answer: 'Postgres, to match the platform.' }) },
  );

  const resumed = await asking;
  check('answering from the console unblocks the waiting agent',
    resumed?.answer === 'Postgres, to match the platform.', JSON.stringify(resumed));

  const thread = await console_(`/api/projects/${project}/runs/${runId}/questions`);
  check('the thread shows who answered and when',
    thread[0]?.answered && thread[0].answeredByEmail === EMAIL && thread[0].answeredAt,
    JSON.stringify(thread));
  check('the badge clears once nothing is waiting',
    (await console_('/api/inbox')).every((each) => each.runId !== runId));

  // --- the finish report ---------------------------------------------------

  await asToken(runToken, `${runPath}/messages`, {
    kind: 'DONE',
    body: `Nothing to build. Left on \`${branch}\`.`,
  });

  const finished = await console_(`/api/projects/${project}/runs/${runId}`);
  check('the run detail shows the finish report, with the branch',
    finished.state === 'FINISHED' && !finished.live
      && finished.exitSummary?.includes(branch) && finished.branch === branch,
    JSON.stringify(finished));

  const listed = (await console_(`/api/projects/${project}/runs`)).find((run) => run.id === runId);
  check('the runs page lists it as finished, newest first',
    listed?.state === 'FINISHED' && listed.entryTitle === entry.title, JSON.stringify(listed));

  // --- R22: the transcript, and talking to a live session -------------------

  const transcript = await console_(`${runPath}/output`);
  check('the transcript carries what the runner streamed, in order',
    transcript.length >= 2
      && transcript.every((line, i) => i === 0 || line.seq > transcript[i - 1].seq),
    JSON.stringify(transcript));
  check('the prompt the console sent is in the transcript, attributed to a person',
    transcript.some((line) => line.kind === 'USER' && line.body.includes('the console smoke')),
    JSON.stringify(transcript.filter((line) => line.kind === 'USER')));

  const afterFirst = await console_(`${runPath}/output?after=${transcript[0].seq}`);
  check('a reader resumes from a sequence number rather than re-reading everything',
    afterFirst.length === transcript.length - 1 && afterFirst[0].seq === transcript[1].seq,
    `${afterFirst.length} vs ${transcript.length}`);

  // --- a manual session: a prompt instead of an entry -----------------------

  const session = await console_(`/api/projects/${project}/runs/sessions`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'Look at the README and tell me what this is.' }),
  });
  check('a session starts with a prompt and no entry',
    session.kind === 'MANUAL' && session.entryNumber === null
      && session.label.startsWith('Look at the README'),
    JSON.stringify(session));
  check('a session takes the project default branch when none is given',
    typeof session.branch === 'string' && session.branch.length > 0, session.branch);

  const sessionPath = `/api/projects/${project}/runs/${session.id}`;
  const queued = await asToken(runnerToken, `${sessionPath}/prompts`, undefined, 'GET');
  check('the opening prompt is not queued as a message — it is the spawn argument',
    queued.length === 0, JSON.stringify(queued));

  await console_(`${sessionPath}/prompts`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'And now the second turn.' }),
  });
  const pending = await asToken(runnerToken, `${sessionPath}/prompts/pending`, undefined, 'GET');
  check('a prompt typed in the console reaches the runner\'s delivery queue',
    pending.length === 1 && pending[0].body === 'And now the second turn.',
    JSON.stringify(pending));

  await asToken(runnerToken, `${sessionPath}/prompts/delivered`,
    { promptIds: [pending[0].id] });
  const afterDelivery =
    await asToken(runnerToken, `${sessionPath}/prompts/pending`, undefined, 'GET');
  check('an acknowledged prompt leaves the queue', afterDelivery.length === 0,
    JSON.stringify(afterDelivery));

  const sessionThread = await console_(`${sessionPath}/prompts`);
  check('the thread says who sent the prompt and that it was delivered',
    sessionThread[0]?.sentByEmail === EMAIL && sessionThread[0].delivered === true,
    JSON.stringify(sessionThread));

  const liveNow = await console_('/api/runs/live');
  const thisOne = liveNow.find((each) => each.run.id === session.id);
  check('the live page shows the session across projects, with its tail',
    thisOne && Array.isArray(thisOne.tail)
      && thisOne.tail.some((line) => line.body.includes('And now the second turn.')),
    JSON.stringify(thisOne?.tail));

  await console_(`${sessionPath}/transition`, {
    method: 'POST',
    body: JSON.stringify({ state: 'CANCELLED', summary: 'Ended by the console smoke.' }),
  });
  check('ending a session drops it off the live page',
    (await console_('/api/runs/live')).every((each) => each.run.id !== session.id));
} finally {
  if (runId) {
    await console_(`/api/projects/${project}/runs/${runId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ state: 'CANCELLED', summary: 'Cleared by the console smoke.' }),
    }).catch(() => undefined);
  }
  // Entries cannot be deleted, so the least noise is an honest reason.
  await console_(`/api/projects/${project}/roadmap/${entry.number}/decline`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'A smoke-test entry, declined by the test that made it.' }),
  }).catch(() => undefined);
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed.`);
process.exit(failed ? 1 : 0);
