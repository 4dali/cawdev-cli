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

// A stable name, not one per process: registering is idempotent by
// (owner, name), and a pid in it bred a new runner on every run — eighteen of
// them before anybody noticed the list was mostly litter.
const runner = await asToken(runnerToken, '/api/runners', { name: 'console-smoke' });

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

  // --- the discussion under the entry ---------------------------------------

  const comment = await console_(`/api/projects/${project}/roadmap/${entry.number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: 'What the console smoke had to say about it.' }),
  });
  check('a comment comes back attributed to the person who wrote it',
    comment.authorEmail === EMAIL && !comment.authorRunId, JSON.stringify(comment));
  check('and not marked as edited, because it has not been',
    comment.editedAt === null || comment.editedAt === undefined, JSON.stringify(comment.editedAt));

  const discussion = await console_(`/api/projects/${project}/roadmap/${entry.number}/comments`);
  check('the entry page reads the discussion back', discussion.length === 1
    && discussion[0].id === comment.id, JSON.stringify(discussion));

  const corrected = await console_(
    `/api/projects/${project}/roadmap/${entry.number}/comments/${comment.id}`,
    { method: 'PATCH', body: JSON.stringify({ body: 'Corrected, and it says so.' }) },
  );
  check('correcting your own wording stamps editedAt',
    corrected.body === 'Corrected, and it says so.' && !!corrected.editedAt,
    JSON.stringify(corrected));

  // The board draws this on the card, so it has to arrive with the list rather
  // than needing a request per entry.
  const carded = (await console_(`/api/projects/${project}/roadmap?brief=true`))
    .find((each) => each.number === entry.number);
  check('the board card carries the count', carded?.commentCount === 1,
    JSON.stringify(carded?.commentCount));

  // There is no delete, here or anywhere: the absence of the endpoint is the
  // guarantee, so the smoke asks for it and expects to be refused.
  await console_(`/api/projects/${project}/roadmap/${entry.number}/comments/${comment.id}`, {
    method: 'DELETE',
    expect: 405,
  });
  check('and no way to delete one', true);

  // --- start ---------------------------------------------------------------

  const started = await console_(`/api/projects/${project}/runs`, {
    method: 'POST',
    // Blank rather than absent: the console sends '' when the picker is left
    // on "the runner's default", and that must mean the same as omitting it.
    body: JSON.stringify({ entryNumber: entry.number, branch, model: '   ' }),
  });
  check('a blank model means the runner default, not a model called "   "',
    started.model === null, JSON.stringify(started.model));
  // R33: effort is the other dial, and it has to survive the round trip or the
  // picker is decoration.
  check('and a blank effort means the same', started.effort === null,
    JSON.stringify(started.effort));
  runId = started.id;
  check('start returns a queued run on the entry', started.state === 'QUEUED'
    && started.entryNumber === entry.number && started.branch === branch, JSON.stringify(started));
  // The platform deliberately does *not* move the entry: the agent moves it to
  // CODING itself, naming the branch, before its first commit. If starting did
  // it, CODING would mean "queued" rather than "someone is working on this".
  check('starting leaves the entry where it was — moving it is the agent\'s first act',
    (await console_(`/api/projects/${project}/roadmap/${entry.number}`)).status === 'PLANNED');

  // Runs share a working copy, so only one RUNS at a time — but a second is
  // queued behind it rather than refused. Being told to come back later and
  // remember to press the button again is not a queue.
  const second = await console_(`/api/projects/${project}/runs`, {
    method: 'POST',
    body: JSON.stringify({ entryNumber: entry.number, branch: `${branch}-again` }),
  });
  check('a second run is queued behind the first, not refused',
    second.state === 'QUEUED' && second.queuedBehind === 1,
    `${second.state} / behind ${second.queuedBehind}`);
  check('the first is still at the front of the queue',
    (await console_(`/api/projects/${project}/runs/${runId}`)).queuedBehind === 0);

  // R34: the start forms name a machine, and the run comes back saying which.
  // Null there is "any runner that serves this project", which is what the two
  // runs above sent and what every caller written before R34 means.
  check('an untargeted run says so rather than naming a machine',
    started.targetRunnerName === null && started.targetRunnerAlive === null,
    JSON.stringify([started.targetRunnerName, started.targetRunnerAlive]));

  const targeted = await console_(`/api/projects/${project}/runs`, {
    method: 'POST',
    body: JSON.stringify({
      entryNumber: entry.number,
      branch: `${branch}-here`,
      targetRunnerId: runner.id,
    }),
  });
  check('a targeted run comes back naming the machine it is for',
    targeted.targetRunnerName === runner.name && targeted.targetRunnerAlive === true,
    JSON.stringify([targeted.targetRunnerName, targeted.targetRunnerAlive]));

  await console_(`/api/projects/${project}/runs/${targeted.id}/transition`, {
    method: 'POST',
    body: JSON.stringify({ state: 'CANCELLED', summary: 'Target check done.' }),
  });

  // Tidied away so it does not hold the project's queue for the rest of this.
  await console_(`/api/projects/${project}/runs/${second.id}/transition`, {
    method: 'POST',
    body: JSON.stringify({ state: 'CANCELLED', summary: 'Queue check done.' }),
  });

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
    body: JSON.stringify({
      prompt: 'Look at the README and tell me what this is.',
      model: 'sonnet',
    }),
  });
  check('a session carries the model it was started with', session.model === 'sonnet',
    JSON.stringify(session.model));
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

  // --- R24: the working copy, and committing it -----------------------------

  await asToken(runnerToken, `${sessionPath}/working-copy`, {
    files: 2,
    insertions: 120,
    deletions: 8,
    detail: JSON.stringify([
      { path: 'src/one.ts', insertions: 100, deletions: 8 },
      { path: 'src/two.ts', insertions: 20, deletions: 0 },
    ]),
  });
  const withCopy = await console_(sessionPath);
  check('the run carries what the runner saw in the checkout',
    withCopy.workingCopy?.files === 2 && withCopy.workingCopy.insertions === 120
      && withCopy.workingCopy.detail?.length === 2,
    JSON.stringify(withCopy.workingCopy));

  const cardTitle = `a card from a session ${entry.number}`;
  const queuedCommit = await console_(`${sessionPath}/commit`, {
    method: 'POST',
    body: JSON.stringify({ message: 'Commit from the console smoke.', entryTitle: cardTitle }),
  });
  check('a commit is queued for the runner, not asked of the agent',
    queuedCommit.state === 'QUEUED' && queuedCommit.kind === 'COMMIT', JSON.stringify(queuedCommit));

  const claimed2 = await asToken(runnerToken, `${sessionPath}/actions/claim`, {});
  check('the runner claims it', claimed2.length === 1 && claimed2[0].id === queuedCommit.id,
    JSON.stringify(claimed2));

  const cardsBefore = (await console_(`/api/projects/${project}/roadmap?brief=true`)).length;
  const settled = await asToken(runnerToken,
    `${sessionPath}/actions/${queuedCommit.id}/finished`, { ok: true, result: 'abc1234' });
  check('the action settles with the sha', settled.state === 'DONE' && settled.result === 'abc1234',
    JSON.stringify(settled));

  const after = await console_(`/api/projects/${project}/roadmap?brief=true`);
  const card = after.find((e) => e.title === cardTitle);
  check('a successful commit creates the named card, as CODING on the branch',
    after.length === cardsBefore + 1 && card?.status === 'CODING'
      && card.branch === session.branch,
    JSON.stringify(card));

  const adopted = await console_(sessionPath);
  check('the session is attached to the card it produced',
    adopted.entryNumber === card?.number, `${adopted.entryNumber} vs ${card?.number}`);

  // Nothing to commit must be refused BEFORE a card is created — entries
  // cannot be deleted, so a stray one would be permanent.
  await asToken(runnerToken, `${sessionPath}/working-copy`,
    { files: 0, insertions: 0, deletions: 0 });
  const refused2 = await console_(`${sessionPath}/commit`, {
    method: 'POST',
    expect: 409,
    body: JSON.stringify({ message: 'nothing here', entryTitle: 'should never exist' }),
  });
  check('committing a clean tree is refused readably',
    /nothing to commit/i.test(refused2?.message ?? ''), JSON.stringify(refused2));
  check('and no card was created for it',
    (await console_(`/api/projects/${project}/roadmap?brief=true`))
      .every((e) => e.title !== 'should never exist'));

  // --- R25: what the run committed, and whether it left --------------------

  await asToken(runnerToken, `${sessionPath}/commits`, {
    baseCommit: '0000000000000000000000000000000000000000',
    pushState: 'NOT_PUSHED',
    commits: [
      { sha: 'aaa1111', subject: 'the first thing', author: 'agent',
        files: 2, insertions: 30, deletions: 4 },
      { sha: 'bbb2222', subject: 'the second thing', author: 'agent',
        files: 1, insertions: 5, deletions: 0 },
    ],
  });
  const recorded = await console_(`${sessionPath}/commits`);
  check('the run records what it committed, oldest first',
    recorded.length === 2 && recorded[0].sha === 'aaa1111' && recorded[1].insertions === 5,
    JSON.stringify(recorded));
  check('and how far it got out of the machine',
    (await console_(sessionPath)).pushState === 'NOT_PUSHED');

  // The runner reports as commits land, so the same sha arrives again.
  await asToken(runnerToken, `${sessionPath}/commits`, {
    pushState: 'PUSHED',
    prUrl: 'https://github.com/example/repo/pull/7',
    commits: [
      { sha: 'aaa1111', subject: 'the first thing, reworded', author: 'agent',
        files: 2, insertions: 31, deletions: 4 },
      { sha: 'bbb2222', subject: 'the second thing', author: 'agent',
        files: 1, insertions: 5, deletions: 0 },
      { sha: 'ccc3333', subject: 'a third', author: 'agent',
        files: 1, insertions: 1, deletions: 1 },
    ],
  });
  const again = await console_(`${sessionPath}/commits`);
  check('re-reporting updates rather than duplicating',
    again.length === 3 && again[0].subject === 'the first thing, reworded',
    JSON.stringify(again.map((c) => c.sha)));
  const pushed = await console_(sessionPath);
  check('push state and the PR link are carried on the run',
    pushed.pushState === 'PUSHED' && pushed.prUrl?.endsWith('/pull/7'),
    JSON.stringify([pushed.pushState, pushed.prUrl]));

  // --- R27: a session that talks about cawdev rather than coding ------------

  const question = await console_(`/api/projects/${project}/runs/ask`, {
    method: 'POST',
    body: JSON.stringify({
      prompt: 'Which cards are in CODING?',
      alsoReaches: [],
      effort: 'high',
    }),
  });
  check('the effort a person chose is carried on the run', question.effort === 'high',
    JSON.stringify(question.effort));
  // R28 split what a run is ABOUT (kind) from what it may DO (profile): a
  // question is a MANUAL run with an ASK profile, not a kind of its own.
  check('a question has no branch, because nothing is prepared for it',
    question.profile === 'ASK' && question.kind === 'MANUAL' && question.branch === null,
    JSON.stringify([question.kind, question.profile, question.branch]));
  check('and it reaches the project it was asked in',
    question.reaches?.includes(project), JSON.stringify(question.reaches));

  // Asking ABOUT a card records the card, so the console can link to it and the
  // runner can name it — rather than it living only in the wording.
  const aboutCard = await console_(`/api/projects/${project}/runs/ask`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'Why this one?', aboutEntry: entry.number }),
  });
  check('a question about a card records the card, and is still not a CODE run',
    aboutCard.entryNumber === entry.number && aboutCard.profile === 'ASK'
      && aboutCard.branch === null,
    JSON.stringify([aboutCard.entryNumber, aboutCard.profile, aboutCard.branch]));
  check('and the label is the question, not a preamble about the card',
    aboutCard.label === 'Why this one?', aboutCard.label);

  const noSuchCard = await console_(`/api/projects/${project}/runs/ask`, {
    method: 'POST',
    expect: 400,
    body: JSON.stringify({ prompt: 'x', aboutEntry: 99999 }),
  });
  check('a card the project does not have is refused, rather than silently dropped',
    /no R99999/.test(noSuchCard?.message ?? ''), JSON.stringify(noSuchCard));

  await console_(`/api/projects/${project}/runs/${aboutCard.id}/transition`, {
    method: 'POST',
    body: JSON.stringify({ state: 'CANCELLED', summary: 'Card-reference check done.' }),
  });

  // A run token is granted every project the question spans, and no others.
  const asker = await asToken(runnerToken, `/api/runners/${runner.id}/claim/${question.id}`);
  const reachable = await fetch(`${BASE}/api/projects/${project}/roadmap?brief=true`, {
    headers: { authorization: `Bearer ${asker.runToken}` },
  });
  check('its token can read the roadmap it was asked about', reachable.status === 200);

  // What a session creates is recorded, not read out of its prose.
  const madeByRun = await asToken(asker.runToken,
    `/api/projects/${project}/roadmap`,
    { title: `a card from R${entry.number}'s question`, body: '**Build:** nothing.' });
  const afterCreate = await console_(`/api/projects/${project}/runs/${question.id}`);
  check('the run reports the card its session created',
    afterCreate.created?.some((each) => each.number === madeByRun.number),
    JSON.stringify(afterCreate.created));

  // And a person's card afterwards is not attributed to it.
  await console_(`/api/projects/${project}/roadmap`, {
    method: 'POST',
    body: JSON.stringify({ title: 'a card a person added, not the session' }),
  });
  check('a person’s card is not attributed to the run',
    (await console_(`/api/projects/${project}/runs/${question.id}`)).created.length
      === afterCreate.created.length);

  await console_(`/api/projects/${project}/runs/${question.id}/transition`, {
    method: 'POST',
    body: JSON.stringify({ state: 'CANCELLED', summary: 'Question check done.' }),
  });

  // --- R28: profiles, and what an audit proposes ----------------------------

  const audit = await console_(`/api/projects/${project}/runs/ask`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'look at everything', profile: 'AUDIT' }),
  });
  check('an audit has no branch and its own profile',
    audit.profile === 'AUDIT' && audit.kind === 'MANUAL' && audit.branch === null,
    JSON.stringify([audit.kind, audit.profile, audit.branch]));

  const coding = await console_(`/api/projects/${project}/runs/ask`, {
    method: 'POST',
    expect: 400,
    body: JSON.stringify({ prompt: 'x', profile: 'CODE' }),
  });
  check('a CODE profile is refused by the endpoint for sessions that do not code',
    /writes code/i.test(coding?.message ?? ''), JSON.stringify(coding));

  const auditor = await asToken(runnerToken, `/api/runners/${runner.id}/claim/${audit.id}`);
  const finding = await asToken(auditor.runToken,
    `/api/projects/${project}/runs/${audit.id}/proposals`,
    { severity: 'CRITICAL', title: 'a finding', body: '**Build:** fix it.' });
  check('an audit proposes rather than creating', finding.accepted === false,
    JSON.stringify(finding));
  check('and nothing reached the roadmap',
    (await console_(`/api/projects/${project}/runs/${audit.id}`)).created.length === 0);

  const accepted = await console_(
    `/api/projects/${project}/runs/${audit.id}/proposals/${finding.id}/accept`,
    {
      method: 'POST',
      body: JSON.stringify({ section: 'Phase 9 — the smoke test', status: 'CONSIDERING' }),
    });
  check('a person accepting it creates the entry',
    accepted.accepted && typeof accepted.entryNumber === 'number', JSON.stringify(accepted));

  // R44: the card is named after the finding, files where the person said, and
  // shows the severity rather than spending its title on it.
  const acceptedCard = await console_(`/api/projects/${project}/roadmap/${accepted.entryNumber}`);
  check('the card takes the finding’s title, with no severity welded on',
    acceptedCard.title === 'a finding', JSON.stringify(acceptedCard.title));
  check('it lands in the section the person chose, at the status they chose',
    acceptedCard.section === 'Phase 9 — the smoke test' && acceptedCard.status === 'CONSIDERING',
    JSON.stringify([acceptedCard.section, acceptedCard.status]));
  check('and it still says what the audit thought, and which audit',
    acceptedCard.audit?.severity === 'CRITICAL' && acceptedCard.audit?.runId === audit.id,
    JSON.stringify(acceptedCard.audit));

  const boarded = (await console_(`/api/projects/${project}/roadmap?brief=true`))
    .find((entry) => entry.number === accepted.entryNumber);
  check('the board carries the finding too, without a body',
    boarded?.audit?.severity === 'CRITICAL' && !boarded.body, JSON.stringify(boarded));

  const secondFinding = await asToken(auditor.runToken,
    `/api/projects/${project}/runs/${audit.id}/proposals`,
    { severity: 'MINOR', title: 'a second finding', body: 'Smaller.' });
  const unfiled = await console_(
    `/api/projects/${project}/runs/${audit.id}/proposals/${secondFinding.id}/accept`,
    { method: 'POST' });
  const unfiledCard = await console_(`/api/projects/${project}/roadmap/${unfiled.entryNumber}`);
  check('accepting without saying where files it under a named bucket, at PLANNED',
    unfiledCard.section === 'Found by an audit' && unfiledCard.status === 'PLANNED',
    JSON.stringify([unfiledCard.section, unfiledCard.status]));

  const thirdFinding = await asToken(auditor.runToken,
    `/api/projects/${project}/runs/${audit.id}/proposals`,
    { severity: 'MEDIUM', title: 'a third finding', body: 'Also real.' });
  const refusedStart = await console_(
    `/api/projects/${project}/runs/${audit.id}/proposals/${thirdFinding.id}/accept`,
    {
      method: 'POST',
      expect: 400,
      body: JSON.stringify({ status: 'IN_PROGRESS' }),
    });
  check('a finding cannot land as started — nobody has started it',
    /PLANNED/.test(refusedStart?.message ?? ''), JSON.stringify(refusedStart));

  const twice = await console_(
    `/api/projects/${project}/runs/${audit.id}/proposals/${finding.id}/accept`,
    { method: 'POST', expect: 409 });
  check('accepting twice is refused — entries cannot be deleted',
    /already on the roadmap/i.test(twice?.message ?? ''), JSON.stringify(twice));

  await console_(`/api/projects/${project}/runs/${audit.id}/transition`, {
    method: 'POST',
    body: JSON.stringify({ state: 'CANCELLED', summary: 'Audit check done.' }),
  });

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
  // R31: what happened, not only what is happening. The run just ended, so it
  // is the newest thing in history — and must NOT be in the live scope.
  const history = await console_('/api/runs/sessions?scope=done&limit=50');
  check('a finished session is in history, with its prompt kept',
    history.some((row) => row.id === session.id && row.openingPrompt),
    JSON.stringify(history.slice(0, 2).map((r) => [r.id, r.state])));
  const stillLive = await console_('/api/runs/sessions?scope=live&limit=50');
  check('and is not in the live scope, which is the point of the split',
    !stillLive.some((row) => row.id === session.id));
  const elsewhere = await console_('/api/runs/sessions?scope=done&project=no-such-project');
  check('a project you cannot see narrows to nothing rather than 403',
    Array.isArray(elsewhere) && elsewhere.length === 0, JSON.stringify(elsewhere));

  check('ending a session drops it off the live page',
    (await console_('/api/runs/live')).every((each) => each.run.id !== session.id));

  // The record is the point: it must survive the run ending.
  check('what it committed outlives the run',
    (await console_(`${sessionPath}/commits`)).length === 3);
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
