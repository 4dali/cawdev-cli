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

const BASE = process.env.CAWDEV_BASE ?? 'http://localhost:4200';
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
// Capabilities in the shape R35 documented (DEVELOPING.md, "What a runner says
// about itself"), because the Runners page and `?serving=` both read it.
const runner = await asToken(runnerToken, '/api/runners', {
  name: 'console-smoke',
  capabilities: JSON.stringify({ projects: [project], maxSessions: 1, agent: 'smoke' }),
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

  // R35. Two questions of one endpoint: the Runners page wants your machines
  // in full, and the start form's badge wants only "is anything up here".
  const runners = await console_('/api/runners');
  const mine = runners.find((each) => each.id === runner.id);
  check(
    'the Runners page sees your own machine, flagged as yours',
    mine?.yours === true,
    JSON.stringify(runners),
  );
  check(
    'and what it says it serves and drives',
    JSON.parse(mine?.capabilities ?? '{}').projects?.includes(project)
      && Array.isArray(mine?.driving),
    JSON.stringify(mine),
  );

  const serving = await console_(`/api/runners?serving=${project}`);
  const live = serving.filter((each) => each.alive);
  check(
    'the entry page can see which runners are live',
    live.some((each) => each.id === runner.id),
    JSON.stringify(serving),
  );
  check(
    'and ?serving= hands out a name and a liveness, not the inventory',
    serving.every((each) => !('ownerEmail' in each) && !('workingCopies' in each)),
    JSON.stringify(serving),
  );

  // Forgetting is refused while the machine is beating: it would register
  // itself again on its next heartbeat, so the button would appear to work.
  const beating = await console_(`/api/runners/${runner.id}/forget`, {
    method: 'POST',
    expect: 409,
  });
  check(
    'a machine that is still beating cannot be forgotten',
    /still beating/i.test(beating?.message ?? ''),
    JSON.stringify(beating),
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
  // The claim is in the name: a blank must not become a MODEL. What it becomes
  // instead is `modelFor`'s answer — the card's, else the person's default,
  // else null — and asserting `=== null` made this pass only for an operator
  // who has never set one. It failed for anybody who had, which is a test
  // reporting whose account ran it.
  check('a blank model means the runner default, not a model called "   "',
    started.model === null || started.model.trim() !== '',
    JSON.stringify(started.model));
  // R33: effort is the other dial, and it has to survive the round trip or the
  // picker is decoration.
  check('and a blank effort means the same', started.effort === null,
    JSON.stringify(started.effort));
  runId = started.id;
  check('start returns a queued run on the entry', started.state === 'QUEUED'
    && started.entryNumber === entry.number && started.branch === branch, JSON.stringify(started));
  // R84: starting moves the card to IN DEVELOPMENT, and there is no halfway
  // house any more. R72 went to IN_PROGRESS first, meaning "started, no branch
  // yet", because CODING had to mean "an agent is writing this second" and a
  // queued run had nothing else to be. The WORK ITEM is that something else —
  // it sits at READY until a machine takes it — so the distinction R72 was
  // drawing is kept, on the object it was always about.
  const afterStart = await console_(`/api/projects/${project}/roadmap/${entry.number}`);
  check('starting moves the card to IN DEVELOPMENT',
    afterStart.status === 'IN_DEVELOPMENT',
    `${afterStart.status} / ${afterStart.branch}`);

  // R63: a second session on the SAME card is refused, and the refusal is
  // actionable — it names the run in the way and hands back its id, which is
  // what lets the console offer "Watch it" rather than a dead end.
  const clash = await console_(`/api/projects/${project}/runs`, {
    method: 'POST',
    body: JSON.stringify({ entryNumber: entry.number, branch: `${branch}-again` }),
    expect: 409,
  });
  check('a second session on one card is refused, naming the first',
    clash.runId === runId && /already has a session/i.test(clash.message ?? ''),
    JSON.stringify(clash));

  // Runs share a working copy, so only one RUNS at a time — but a second, on
  // another card, is queued behind it rather than refused. Being told to come
  // back later and remember to press the button again is not a queue.
  const otherCard = await console_(`/api/projects/${project}/roadmap`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'console smoke, the second card (safe to decline)',
      body: 'Created by tools/console/console-smoke.mjs — the queue needs two cards.',
    }),
  });
  const second = await console_(`/api/projects/${project}/runs`, {
    method: 'POST',
    body: JSON.stringify({ entryNumber: otherCard.number, branch: `r${otherCard.number}-queued` }),
  });
  check('a second run on another card is queued behind the first, not refused',
    second.state === 'QUEUED' && second.queuedBehind === 1,
    `${second.state} / behind ${second.queuedBehind}`);
  check('the first is still at the front of the queue',
    (await console_(`/api/projects/${project}/runs/${runId}`)).queuedBehind === 0);

  // Tidied away so it does not hold the project's queue — or its own card —
  // for the rest of this.
  await console_(`/api/projects/${project}/runs/${second.id}/transition`, {
    method: 'POST',
    body: JSON.stringify({ state: 'CANCELLED', summary: 'Queue check done.' }),
  });

  // R34: the start forms name a machine, and the run comes back saying which.
  // Null there is "any runner that serves this project", which is what the two
  // runs above sent and what every caller written before R34 means.
  check('an untargeted run says so rather than naming a machine',
    started.targetRunnerName === null && started.targetRunnerAlive === null,
    JSON.stringify([started.targetRunnerName, started.targetRunnerAlive]));

  const targeted = await console_(`/api/projects/${project}/runs`, {
    method: 'POST',
    body: JSON.stringify({
      entryNumber: otherCard.number,
      branch: `r${otherCard.number}-here`,
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

  // --- several at once (R67) ------------------------------------------------
  //
  // The board's action bar. Two cards of its own rather than reusing the one
  // above: the interesting half is what happens to a card that CANNOT start,
  // and the card above already has a run on it — which is exactly the case to
  // put in the batch.

  const alsoCards = [];
  for (const which of ['one', 'two']) {
    alsoCards.push(await console_(`/api/projects/${project}/roadmap`, {
      method: 'POST',
      body: JSON.stringify({
        title: `console smoke batch ${which} (safe to decline)`,
        body: 'Created by tools/console/console-smoke.mjs.\n\n**Build:** nothing.',
        // PLANNED, said out loud, since R124. A card now arrives at
        // CONSIDERING — the first of three phases — and `canStartWork` has
        // always refused that status. This loop is about the batch, not about
        // which statuses may be started, so it says what it needs rather than
        // leaning on a default that has moved.
        status: 'PLANNED',
      }),
    }));
  }

  const batch = await console_(`/api/projects/${project}/runs/batch`, {
    method: 'POST',
    body: JSON.stringify({
      strategy: 'ONE_BRANCH_IN_ORDER',
      branch: `${branch}-together`,
      targetRunnerId: runner.id,
      cards: [
        { entryNumber: alsoCards[0].number },
        { entryNumber: alsoCards[1].number },
        // The card the first run above is still sitting on. It must be named
        // rather than quietly dropped.
        { entryNumber: entry.number },
      ],
    }),
  });

  check('a batch starts the cards that can start and names the one that cannot',
    batch.started.length === 2 && batch.refused.length === 1
      && batch.refused[0].entryNumber === entry.number,
    JSON.stringify(batch.refused));
  check('the answer says which strategy was in force, in words',
    /one branch/i.test(batch.strategyNote ?? ''), JSON.stringify(batch.strategyNote));
  check('every run in it landed on the one branch and the one machine',
    batch.started.every((run) => run.branch === `${branch}-together`
      && run.targetRunnerName === runner.name),
    JSON.stringify(batch.started.map((run) => [run.branch, run.targetRunnerName])));
  // The whole reason this is a batch endpoint: the second one is not offered
  // to any machine until the first has ended, and it says so by card.
  check('and the second waits for the first, by card',
    batch.started[0].waitingFor === null
      && batch.started[1].waitingFor?.entryNumber === alsoCards[0].number,
    JSON.stringify(batch.started.map((run) => run.waitingFor)));

  const offered = await asToken(
    runnerToken, `/api/runners/${runner.id}/queue?wait=0`, undefined, 'GET');
  check('the runner is offered the first of them and not the second',
    offered.some((offer) => offer.run.id === batch.started[0].id)
      && !offered.some((offer) => offer.run.id === batch.started[1].id),
    JSON.stringify(offered.map((offer) => offer.run.id)));

  // Two cards on one branch at the same time is the concurrent-start race, and
  // the batch refuses the WHOLE thing rather than starting one of them.
  const clashing = await console_(`/api/projects/${project}/runs/batch`, {
    method: 'POST',
    expect: 400,
    body: JSON.stringify({
      strategy: 'QUEUED_ON_ONE',
      targetRunnerId: runner.id,
      cards: [
        { entryNumber: alsoCards[0].number, branch: `${branch}-clash` },
        { entryNumber: alsoCards[1].number, branch: `${branch}-clash` },
      ],
    }),
  });
  check('two cards on one branch at the same time is refused outright',
    /concurrent-start race/i.test(clashing?.message ?? ''), JSON.stringify(clashing));

  for (const run of batch.started) {
    await console_(`/api/projects/${project}/runs/${run.id}/transition`, {
      method: 'POST',
      body: JSON.stringify({ state: 'CANCELLED', summary: 'Batch check done.' }),
    });
  }
  for (const card of alsoCards) {
    await console_(`/api/projects/${project}/roadmap/${card.number}/decline`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Created by the console smoke.' }),
    });
  }

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
  // Three groups since R36. Nothing has been passed on yet, so it is in the
  // first one and the badge counts it.
  const item = inbox.waitingOnYou.find((each) => each.runId === runId);
  check('the inbox long poll returns the question as soon as it is asked',
    item && waited < 15, `waited ${waited}s: ${JSON.stringify(inbox)}`);
  check('the badge counts what is stopped on you', inbox.badge >= 1, JSON.stringify(inbox));
  check('the inbox item carries enough to route to the run',
    item?.projectSlug === project && item?.entryNumber === entry.number
      && item?.question.options.length === 2, JSON.stringify(item));
  // R58: whose question it is, which is what the console reads to decide
  // between an answer box and the sentence naming who it is waiting on. This
  // script starts the run itself, so the answer is this script.
  check('the question names the person it is waiting on',
    item?.question.waitingOnEmail === EMAIL, JSON.stringify(item?.question));

  check('the run is waiting on a person, and says so',
    (await console_(`/api/projects/${project}/runs/${runId}`)).state === 'WAITING_ON_USER');

  // R78: the prompt box stops lying. A session blocked inside `ask_user` cannot
  // read a prompt — it queued and turned up as a stray remark after somebody
  // had answered in the inbox — so the API refuses one and names where the
  // words belong instead. The console hides the box; this is the rule under it.
  const swallowed = await console_(`${runPath}/prompts`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'Postgres — typed into the wrong box.' }),
    expect: 409,
  });
  check('a prompt is refused while the session is stopped on a question',
    /answer it/i.test(swallowed?.message ?? ''), JSON.stringify(swallowed));

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
    (await console_('/api/inbox')).waitingOnYou.every((each) => each.runId !== runId));

  // --- R36: passing a question on ------------------------------------------

  // A second question, so the whole share loop has something to act on.
  const shared = await asToken(runToken, `${runPath}/questions`, {
    question: 'Rename the endpoint, or keep the old one beside it?',
  });

  const candidates = await console_(
    `${runPath}/questions/${shared.id}/share-candidates`,
  );
  check('the picker answers, and never offers you yourself',
    Array.isArray(candidates) && candidates.every((who) => who.email !== EMAIL),
    JSON.stringify(candidates));
  check('anyone who could not answer is named with the reason, not hidden',
    candidates.every((who) => who.eligible || who.why), JSON.stringify(candidates));

  const colleague = candidates.find((who) => who.eligible);
  if (!colleague) {
    console.log(
      'skip  passing a question on — this project has no other member holding WRITER.\n' +
      '        Add one and re-run to exercise the share loop.',
    );
  } else {
    await console_(`${runPath}/questions/${shared.id}/shares`, {
      method: 'POST',
      body: JSON.stringify({
        withUserId: colleague.userId,
        kind: 'OPINION',
        note: 'You wrote the old one — what breaks?',
      }),
    });

    const passed = await console_('/api/inbox');
    const mine = passed.youAsked.find((each) => each.question.id === shared.id);
    check('a question you passed on moves to "you asked someone"',
      mine && !passed.waitingOnYou.some((each) => each.question.id === shared.id),
      JSON.stringify(passed));
    check('asking for an opinion does not unblock the run',
      (await console_(`/api/projects/${project}/runs/${runId}`)).state === 'WAITING_ON_USER');
    check('it still counts toward the badge — the session is still stopped',
      passed.badge >= 1, JSON.stringify(passed));

    // An opinion is not an answer: it lands on the question and leaves the run
    // exactly where it was.
    await console_(`${runPath}/questions/${shared.id}/opinions`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Keep both for one release, then drop it.' }),
    });

    const withOpinion = (await console_(`${runPath}/questions`))
      .find((each) => each.id === shared.id);
    check('the opinion lands on the question without answering it',
      withOpinion?.opinions.length === 1 && !withOpinion.answered,
      JSON.stringify(withOpinion));
    check('the run is still waiting on a person',
      (await console_(`/api/projects/${project}/runs/${runId}`)).state === 'WAITING_ON_USER');

    // Sharing must never be a way to grant access. A non-member is refused,
    // and the refusal says why rather than pretending they do not exist.
    const outsider = candidates.find((who) => !who.eligible);
    if (outsider) {
      const refused = await console_(`${runPath}/questions/${shared.id}/shares`, {
        method: 'POST',
        expect: 403,
        body: JSON.stringify({ withUserId: outsider.userId, kind: 'DECIDE' }),
      });
      check('sharing with somebody who could not answer is refused, with a reason',
        typeof refused?.message === 'string' && refused.message.length > 0,
        JSON.stringify(refused));
    }

    await console_(
      `${runPath}/questions/${shared.id}/answer`,
      { method: 'POST', body: JSON.stringify({ answer: 'Keep both, drop it in v0.3.' }) },
    );
    const settled = (await console_(`${runPath}/questions`))
      .find((each) => each.id === shared.id);
    check('answering closes the share it was passed under',
      settled?.shares.every((share) => !share.open && share.resolution === 'ANSWERED'),
      JSON.stringify(settled?.shares));
  }

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
  check('a successful commit creates the named card, in development on the branch',
    after.length === cardsBefore + 1 && card?.status === 'IN_DEVELOPMENT'
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

  // --- R69: the follow-up, in the same conversation --------------------------

  const followed = await console_(`/api/projects/${project}/runs/ask`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'What does the runner do with a question?' }),
  });
  const followedPath = `/api/projects/${project}/runs/${followed.id}`;
  const firstClaim = await asToken(runnerToken, `/api/runners/${runner.id}/claim/${followed.id}`);
  await asToken(runnerToken, `${followedPath}/transition`, { state: 'RUNNING' });

  // The handle the whole entry turns on, read by the runner off the CLI's
  // `init` event. Without it there is nothing to resume, and the console says so
  // rather than offering a button that cannot work.
  await asToken(runnerToken, `${followedPath}/session`, { agentSessionId: 'smoke-session-1' });
  await asToken(firstClaim.runToken, `${followedPath}/messages`,
    { kind: 'DONE', body: 'It long-polls.' });

  const ended = await console_(followedPath);
  check('a finished ask says it can be picked back up',
    ended.state === 'FINISHED' && ended.resumable === true && ended.openUntilClosed === false,
    JSON.stringify([ended.state, ended.resumable, ended.openUntilClosed]));

  const resumedRun = await console_(`${followedPath}/resume`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'No, I meant the runner side.', runnerId: runner.id }),
  });
  check('resuming queues the SAME run, held open',
    resumedRun.id === followed.id && resumedRun.state === 'QUEUED'
      && resumedRun.openUntilClosed === true,
    JSON.stringify([resumedRun.id === followed.id, resumedRun.state, resumedRun.openUntilClosed]));

  const resumedTranscript = await console_(`${followedPath}/output`);
  check('the follow-up is on the transcript, in order, as the person said it',
    resumedTranscript.some((line) => line.kind === 'USER'
      && line.body === 'No, I meant the runner side.'),
    JSON.stringify(resumedTranscript.map((line) => line.kind)));

  const secondClaim = await asToken(runnerToken,
    `/api/runners/${runner.id}/claim/${followed.id}`);
  check('the claim carries the conversation and the follow-up, and nothing else changes',
    secondClaim.resume?.agentSessionId === 'smoke-session-1'
      && secondClaim.resume?.prompt === 'No, I meant the runner side.'
      && secondClaim.run.profile === 'ASK' && secondClaim.run.branch === null,
    JSON.stringify(secondClaim.resume));

  await asToken(runnerToken, `${followedPath}/transition`, { state: 'RUNNING' });
  await asToken(secondClaim.runToken, `${followedPath}/messages`,
    { kind: 'DONE', body: 'Ah — the daemon writes it to stdin.' });

  const stillOpen = await console_(followedPath);
  check('a resumed session does not end itself: done is an answer, not a goodbye',
    stillOpen.state === 'RUNNING' && stillOpen.live === true,
    JSON.stringify([stillOpen.state, stillOpen.live]));

  // Being live is what makes it answerable — R22's prompt box, on a session that
  // is only still there because somebody resumed it.
  await console_(`${followedPath}/prompts`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'And if the daemon restarts?' }),
  });

  const closed = await console_(`${followedPath}/close`, { method: 'POST', body: '{}' });
  check('closing is explicit, and closed means closed',
    closed.state === 'FINISHED' && closed.openUntilClosed === false && closed.live === false,
    JSON.stringify([closed.state, closed.openUntilClosed, closed.live]));

  const closedTwice = await console_(`${followedPath}/close`, {
    method: 'POST', expect: 409, body: '{}',
  });
  check('and closing it again is refused rather than silently doing nothing',
    /already/.test(closedTwice?.message ?? ''), JSON.stringify(closedTwice));

  // --- R96: the CTO Interview, and a round of questions ----------------------

  const interview = await console_(`/api/projects/${project}/runs/interview`, {
    method: 'POST',
    body: '{}',
  });
  check('an interview starts with nothing typed, on a branch of its own',
    interview.profile === 'INTERVIEW' && interview.branch === 'cto-interview',
    JSON.stringify([interview.profile, interview.branch]));

  const interviewer = await asToken(runnerToken,
    `/api/runners/${runner.id}/claim/${interview.id}`);
  check('and the claim tells the machine where the brief goes',
    interviewer.brief?.index === 'docs/brief/README.md'
      // Not a COUNT. This said six, the brief has eight, and a number here
      // pins the one thing about the layout nobody promised to keep — while
      // saying nothing about the thing that matters, which is that every
      // section tells a machine where to write and what belongs there.
      && interviewer.brief?.sections?.length > 0
      && interviewer.brief.sections.every(
        (each) => each.path?.startsWith('docs/brief/') && each.title && each.about),
    JSON.stringify(interviewer.brief));

  // The RUNNER's token, not the run's. A run token carries roadmap, changelog,
  // report and ask — deliberately NOT `runner:operate`, because moving a run
  // through its states is the machine's act and not the session's. This asked
  // with the run's token and had been answered 403 on every push since R96.
  await asToken(runnerToken,
    `/api/projects/${project}/runs/${interview.id}/transition`, { state: 'RUNNING' });

  const round = await asToken(interviewer.runToken,
    `/api/projects/${project}/runs/${interview.id}/question-groups`,
    {
      title: 'CTO Interview',
      intro: 'How this thing is released.',
      questions: [
        { question: 'Who may cut a release?', options: ['anybody', 'two people'] },
        { question: 'What breaks most often?' },
      ],
    });
  check('a round arrives under one title, with its questions in order',
    round.title === 'CTO Interview' && round.questions.length === 2
      && round.questions[0].group.position === 1,
    JSON.stringify([round.title, round.questions.length]));

  const roundInbox = await console_('/api/inbox');
  check('the round is in the inbox, as questions that know what they came with',
    roundInbox.waitingOnYou.some((row) => row.question.group?.title === 'CTO Interview'),
    JSON.stringify(roundInbox.waitingOnYou.map((row) => row.question.group?.title)));

  const halfARound = await console_(
    `/api/projects/${project}/runs/${interview.id}/question-groups/${round.id}/answers`,
    {
      method: 'POST',
      expect: 400,
      body: JSON.stringify({ answers: { [round.questions[0].id]: 'Two people.' } }),
    });
  check('half a round is refused rather than half stored',
    /whole round/i.test(halfARound?.message ?? ''), JSON.stringify(halfARound));

  const wholeRound = await console_(
    `/api/projects/${project}/runs/${interview.id}/question-groups/${round.id}/answers`,
    {
      method: 'POST',
      body: JSON.stringify({
        answers: {
          [round.questions[0].id]: 'Two people, never on a Friday.',
          [round.questions[1].id]: 'The nightly import.',
        },
      }),
    });
  check('and answering it on one form releases the session',
    wholeRound.length === 2 && wholeRound.every((each) => each.answered)
      && (await console_(`/api/projects/${project}/runs/${interview.id}`)).state === 'RUNNING',
    JSON.stringify(wholeRound.map((each) => each.answer)));

  await console_(`/api/projects/${project}/runs/${interview.id}/transition`, {
    method: 'POST',
    body: JSON.stringify({ state: 'CANCELLED' }),
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
      // R85: an accepted finding is an ISSUE, and an issue's statuses are its
      // own — NEW, CONFIRMED and the shared four. `CONSIDERING` is a roadmap
      // status and the API refuses it here, which it had been doing on every
      // push since R85.
      body: JSON.stringify({ section: 'Phase 9 — the smoke test', status: 'CONFIRMED' }),
    });
  check('a person accepting it creates the entry',
    accepted.accepted && typeof accepted.entryNumber === 'number', JSON.stringify(accepted));

  // R44: the card is named after the finding, files where the person said, and
  // shows the severity rather than spending its title on it.
  const acceptedCard = await console_(`/api/projects/${project}/roadmap/${accepted.entryNumber}`);
  check('the card takes the finding’s title, with no severity welded on',
    acceptedCard.title === 'a finding', JSON.stringify(acceptedCard.title));
  check('it lands in the section the person chose, at the status they chose',
    acceptedCard.section === 'Phase 9 — the smoke test' && acceptedCard.status === 'CONFIRMED',
    JSON.stringify([acceptedCard.section, acceptedCard.status]));
  check('and it still says what the audit thought, and which audit',
    acceptedCard.audit?.severity === 'CRITICAL' && acceptedCard.audit?.runId === audit.id,
    JSON.stringify(acceptedCard.audit));

  // R85: an accepted finding is an ISSUE, so it is on the ISSUES board. This
  // looked on the roadmap's, found nothing, and had been failing ever since —
  // which is the entry working exactly as it said it would.
  const boarded = (await console_(`/api/projects/${project}/issues?brief=true`))
    .find((entry) => entry.number === accepted.entryNumber);
  check('the issues board carries the finding too, without a body',
    boarded?.audit?.severity === 'CRITICAL' && !boarded.body, JSON.stringify(boarded));
  check('and it is NOT on the roadmap board, which asks a different question',
    !(await console_(`/api/projects/${project}/roadmap?brief=true`))
      .some((entry) => entry.number === accepted.entryNumber));

  const secondFinding = await asToken(auditor.runToken,
    `/api/projects/${project}/runs/${audit.id}/proposals`,
    { severity: 'MINOR', title: 'a second finding', body: 'Smaller.' });
  const unfiled = await console_(
    `/api/projects/${project}/runs/${audit.id}/proposals/${secondFinding.id}/accept`,
    { method: 'POST' });
  const unfiledCard = await console_(`/api/projects/${project}/roadmap/${unfiled.entryNumber}`);
  // R85: NEW, not PLANNED — "filed, nobody has looked" is where a finding
  // starts, and PLANNED is a roadmap answer to a question issues do not ask.
  check('accepting without saying where files it under a named bucket, at NEW',
    unfiledCard.section === 'Found by an audit' && unfiledCard.status === 'NEW',
    JSON.stringify([unfiledCard.section, unfiledCard.status]));

  const thirdFinding = await asToken(auditor.runToken,
    `/api/projects/${project}/runs/${audit.id}/proposals`,
    { severity: 'MEDIUM', title: 'a third finding', body: 'Also real.' });
  const refusedStart = await console_(
    `/api/projects/${project}/runs/${audit.id}/proposals/${thirdFinding.id}/accept`,
    {
      method: 'POST',
      expect: 400,
      body: JSON.stringify({ status: 'IN_DEVELOPMENT' }),
    });
  check('a finding cannot land as started — nobody has started it',
    /NEW/.test(refusedStart?.message ?? '') && /CONFIRMED/.test(refusedStart?.message ?? ''),
    JSON.stringify(refusedStart));

  // R214: an audit says what kind of thing it found. A card proposal has no
  // severity, lands on the ROADMAP board at CONSIDERING, and still names the
  // audit that raised it — with nothing to say about a ranking there was not.
  const fourthFinding = await asToken(auditor.runToken,
    `/api/projects/${project}/runs/${audit.id}/proposals`,
    { kind: 'ROADMAP', title: 'a fourth finding', body: 'Should also do this.' });
  check('an audit proposes a roadmap card, with no severity',
    fourthFinding.kind === 'ROADMAP' && fourthFinding.severity == null,
    JSON.stringify(fourthFinding));
  const asCard = await console_(
    `/api/projects/${project}/runs/${audit.id}/proposals/${fourthFinding.id}/accept`,
    { method: 'POST', body: JSON.stringify({}) });
  const proposedCard = await console_(`/api/projects/${project}/roadmap/${asCard.entryNumber}`);
  check('accepted with the defaults, it is a roadmap card at CONSIDERING with no severity',
    proposedCard.kind === 'ROADMAP' && proposedCard.status === 'CONSIDERING'
      && proposedCard.severity == null,
    JSON.stringify([proposedCard.kind, proposedCard.status, proposedCard.severity]));
  check('and it still links back to the audit, ranked by nobody',
    proposedCard.audit?.runId === audit.id && proposedCard.audit?.severity == null,
    JSON.stringify(proposedCard.audit));
  const roadmapNow = await console_(`/api/projects/${project}/roadmap?brief=true`);
  check('it is on the roadmap board, and the issues board does not have it',
    roadmapNow.some((entry) => entry.number === asCard.entryNumber
      && entry.audit?.runId === audit.id)
      && !(await console_(`/api/projects/${project}/issues?brief=true`))
        .some((entry) => entry.number === asCard.entryNumber));

  let rankedCard = null;
  try {
    await asToken(auditor.runToken, `/api/projects/${project}/runs/${audit.id}/proposals`,
      { kind: 'ROADMAP', severity: 'MINOR', title: 'a ranked card', body: 'No.' });
  } catch (failure) {
    rankedCard = failure.message;
  }
  check('a roadmap proposal with a severity is refused, not silently unranked',
    /-> 400/.test(rankedCard ?? '') && /no severity/.test(rankedCard ?? ''),
    JSON.stringify(rankedCard));

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

  // --- the three boards, and the dashboard over them (R84, R85, R88) --------

  const board = await console_(`/api/projects/${project}/work-items`);
  check('the development board answers, and a branch is a card on it',
    Array.isArray(board), JSON.stringify(board).slice(0, 200));

  const filed = await console_(`/api/projects/${project}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'A smoke-test issue',
      severity: 'MINOR',
      body: 'Filed by the console smoke, and declined by it.',
    }),
  });
  check('an issue is filed at NEW with its severity, on the roadmap numbering',
    filed.kind === 'ISSUE' && filed.severity === 'MINOR' && filed.status === 'NEW',
    JSON.stringify(filed).slice(0, 200));

  const issues = await console_(`/api/projects/${project}/issues`);
  check('it is on the issues board and not on the roadmap',
    issues.some((each) => each.number === filed.number)
      && (await console_(`/api/projects/${project}/roadmap`))
        .every((each) => each.number !== filed.number));

  const reRanked = await console_(
    `/api/projects/${project}/issues/${filed.number}/severity`,
    { method: 'POST', body: JSON.stringify({ severity: 'MEDIUM' }) },
  );
  check('triage re-ranks it, because an audit\'s severity is its own guess',
    reRanked.severity === 'MEDIUM');

  const overview = await console_(`/api/projects/${project}/overview`);
  check('the dashboard counts all three boards at once',
    Array.isArray(overview.roadmap?.byStatus)
      && Array.isArray(overview.issues?.openBySeverity)
      && Array.isArray(overview.development?.byStatus),
    JSON.stringify(overview).slice(0, 200));
  check('and its issue count matches the issues board',
    overview.issues.openBySeverity.reduce((total, row) => total + row.count, 0)
      === issues.filter((each) =>
        ['NEW', 'CONFIRMED', 'IN_DEVELOPMENT'].includes(each.status)).length);

  const home = await console_('/api/overview');
  check('the home page lists every project you can see',
    home.projects.some((each) => each.slug === project));

  // Declined rather than left: entries cannot be deleted, and a smoke-test
  // issue sitting open on a real board is noise somebody has to triage.
  await console_(`/api/projects/${project}/roadmap/${filed.number}/decline`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'A smoke-test issue, declined by the test that made it.' }),
  }).catch(() => undefined);
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
