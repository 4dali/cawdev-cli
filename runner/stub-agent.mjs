#!/usr/bin/env node
// A stand-in for `claude`, for exercising the runner without spending anybody's
// Claude usage.
//
// Point the runner at it with an ABSOLUTE path and no args:
//
//   { "agentCommand": "/…/tools/runner/stub-agent.mjs", "agentArgs": [] }
//
// Not `node` with the script as an argument: the runner puts `--mcp-config`
// first (see runner.mjs), so node would be handed a flag it does not know and
// exit with "bad option". The shebang runs it instead, and the cawdev flags
// land in its argv where it ignores them — which is exactly what `claude` does
// with the ones it does not need either.
//
// Absolute, because the child's cwd is the working copy, not this repository.
//
// It behaves like the real thing in the ways that matter to the runner: it is
// spawned in the working copy with CAWDEV_TOKEN in its environment, it talks to
// the platform through the same MCP tools, and — since the stage walk hung on
// exactly this — it does NOT exit when its turn ends. What it does *not* do is
// think: it follows a fixed script, which is exactly what a test wants.
//
// That last point used to read "and it exits", and the claim was the problem.
// The real CLI is spawned with `--input-format stream-json` and its stdin held
// open (R22), so when a turn finishes it sits there waiting for the next one
// and leaves only when its input closes. A stub that called process.exit()
// instead modelled away the single fact the daemon's stage walk depends on, and
// a walk that waited for a process which was never going to leave looked
// perfectly healthy against it. So: say the turn is over, then wait to be
// dismissed. CAWDEV_STUB_EXIT=1 restores the old, less honest behaviour for
// anything that genuinely wants a one-shot process.
//
// The script is chosen by CAWDEV_STUB_SCRIPT:
//   report-and-finish  (default) progress, then done
//   ask-then-finish              ask a question, wait for the answer, then done
//   permission-then-finish       ask permission for a command, wait, then done
//   crash                        exit non-zero without reporting
//   hang                         never say anything, for testing cancellation
//   usage-limit                  say the window is closed, end the turn with
//                                SUCCESS, and then LINGER — which is what the
//                                real CLI did, and the reason a limited run sat
//                                RUNNING for forty-three minutes holding the
//                                machine's only slot
//
// It announces a session id on `init`, like the real CLI, so R69's resume path
// has something to record and hand back.

const url = (process.env.CAWDEV_URL ?? 'http://localhost:4200').replace(/\/+$/, '');
const token = process.env.CAWDEV_TOKEN;
const project = process.env.CAWDEV_PROJECT;
const script = process.env.CAWDEV_STUB_SCRIPT ?? 'report-and-finish';

// The real CLI leaves when its input closes, and not before. Modelling that is
// the whole reason this file is not three lines shorter.
function leave(code = 0) {
  if (code !== 0 || process.env.CAWDEV_STUB_EXIT) {
    process.exit(code);
  }
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  process.stdin.resume();
}

function say(text) {
  // The real CLI emits stream-json; the runner only reads `result` events, so
  // this is enough to look like one.
  process.stdout.write(`${JSON.stringify({ type: 'result', result: text })}\n`);
}

// R69. The real CLI announces its session id on `init`, and that is the handle
// `--resume` takes — so the stub announces one too, or the whole resume path is
// untested by anything that runs against the stub.
//
// A resumed stub keeps the id it was resumed with. The real CLI is free to hand
// back a different one, which the runner reports either way; keeping it here
// makes the stub's own script readable, and the runner's "always report the
// latest" rule is exercised by the platform's tests rather than guessed at.
const resumed = process.argv[process.argv.indexOf('--resume') + 1];
const sessionId =
  process.argv.includes('--resume') && resumed ? resumed : `stub-${Date.now().toString(36)}`;
process.stdout.write(
  `${JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'stub',
    cwd: process.cwd(),
  })}\n`,
);

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

const identity = await api('/api/agent/whoami');
const runId = identity.runId;
if (!runId) {
  console.error('stub-agent: no run on this token');
  process.exit(2);
}

const report = (kind, body) =>
  api(`/api/projects/${project}/runs/${runId}/messages`, {
    method: 'POST',
    body: { kind, body },
  });

if (script === 'crash') {
  say('about to crash');
  process.exit(3);
}

if (script === 'hang') {
  say('hanging around');
  // Long enough for a cancellation test, and harmless if one never comes.
  setTimeout(() => process.exit(0), 10 * 60 * 1000);
} else if (script === 'usage-limit') {
  // The exact sentence, middle dot and all, because that is what made the
  // matcher's earlier patterns miss it. And then it STAYS — no exit, no error
  // code, nothing for a close handler to read. A stub that exited here would
  // model away the one fact that made this a forty-three minute hang rather
  // than a run that ended badly.
  say("You've hit your session limit · resets 4am (Africa/Tunis)");
  setTimeout(() => process.exit(0), 10 * 60 * 1000);
} else {
  await report('PROGRESS', `Stub agent, script "${script}", in ${process.cwd()}.`);

  if (script === 'ask-then-finish') {
    const question = await api(`/api/projects/${project}/runs/${runId}/questions`, {
      method: 'POST',
      body: { question: 'Stub agent asking: shall I carry on?', options: ['Yes', 'No'] },
    });

    // The same wait the MCP server does, in miniature.
    let answer = null;
    const deadline = Date.now() + 60_000;
    while (!answer && Date.now() < deadline) {
      const response = await fetch(
        `${url}/api/projects/${project}/runs/${runId}/questions/${question.id}/answer?wait=5`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (response.status === 200) {
        answer = (await response.json()).answer;
      }
    }
    if (!answer) {
      await report('BLOCKED', 'Nobody answered the stub agent.');
      say('nobody answered');
      // Straight out, unlike the finish below: this is the stub giving up, and
      // there is nothing after it worth staying open for.
      process.exit(0);
    }
    await report('PROGRESS', `Got the answer: ${answer}`);
  }

  if (script === 'permission-then-finish') {
    // R51's loop, in miniature: the real CLI does this through
    // --permission-prompt-tool, which calls the MCP server, which calls these
    // same two endpoints. Exercising it here costs nothing and is the only way
    // to test the whole path — inbox, decision, release — without a live
    // model deciding for itself that it does not need Maven after all.
    const asked = await api(`/api/projects/${project}/runs/${runId}/approvals`, {
      method: 'POST',
      body: {
        toolName: 'Bash',
        toolInput: JSON.stringify({ command: 'mvn --version' }),
        summary: 'mvn --version',
        suggestion: 'Bash(mvn *)',
        toolUseId: 'stub-tool-use',
      },
    });

    let decision = null;
    const until = Date.now() + 60_000;
    while (!decision && Date.now() < until) {
      const response = await fetch(
        `${url}/api/projects/${project}/runs/${runId}/approvals/${asked.id}/decision?wait=5`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (response.status === 200) {
        decision = await response.json();
      }
    }
    if (!decision) {
      await report('BLOCKED', 'Nobody decided the stub agent\'s permission request.');
      say('nobody decided');
      process.exit(0);
    }
    if (decision.state !== 'ALLOWED') {
      await report('BLOCKED', `Refused (${decision.state}): ${decision.reason ?? 'no reason given'}`);
      say('refused');
      process.exit(0);
    }
    await report('PROGRESS', 'Allowed. Pretending to run mvn --version.');
  }

  await report('DONE', 'Stub agent finished. No code was written, which is the point.');
  say('done');
  leave();
}
