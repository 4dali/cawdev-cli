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
// the platform through the same MCP tools, and it exits. What it does *not* do
// is think — it follows a fixed script, which is exactly what a test wants.
//
// The script is chosen by CAWDEV_STUB_SCRIPT:
//   report-and-finish  (default) progress, then done
//   ask-then-finish              ask a question, wait for the answer, then done
//   permission-then-finish       ask permission for a command, wait, then done
//   crash                        exit non-zero without reporting
//   hang                         never exit, for testing cancellation

const url = (process.env.CAWDEV_URL ?? 'http://localhost:8091').replace(/\/+$/, '');
const token = process.env.CAWDEV_TOKEN;
const project = process.env.CAWDEV_PROJECT;
const script = process.env.CAWDEV_STUB_SCRIPT ?? 'report-and-finish';

function say(text) {
  // The real CLI emits stream-json; the runner only reads `result` events, so
  // this is enough to look like one.
  process.stdout.write(`${JSON.stringify({ type: 'result', result: text })}\n`);
}

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
      process.exit(0);
    }
    if (decision.state !== 'ALLOWED') {
      await report('BLOCKED', `Refused (${decision.state}): ${decision.reason ?? 'no reason given'}`);
      process.exit(0);
    }
    await report('PROGRESS', 'Allowed. Pretending to run mvn --version.');
  }

  await report('DONE', 'Stub agent finished. No code was written, which is the point.');
  say('done');
  process.exit(0);
}
