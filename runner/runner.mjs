#!/usr/bin/env node
// The cawdev runner daemon: the piece that lives on your machine.
//
//   node tools/runner/runner.mjs --config runner.config.json
//
// It holds the repositories and the Claude Code login; the platform holds
// neither. It connects **outbound** and polls, so there is no inbound port and
// NAT and firewalls are not anybody's problem — see R19 for the server-side
// alternative that was declined, and why.
//
// Plain Node, zero dependencies. You are about to let this spawn agent sessions
// against your working copies; it should be a file you can read first.

import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describeTurn } from '../lib/usage.mjs';

// --- configuration -----------------------------------------------------------

const DEFAULTS = {
  url: 'http://localhost:8091',
  name: 'this-machine',
  /**
   * How the agent is spawned. Overridable so the daemon can be exercised
   * without spending anybody's Claude usage, and so R17's second CLI is a
   * config change rather than a code change.
   */
  agentCommand: 'claude',
  /**
   * Verified against Claude Code 2.1.247.
   *
   * `--permission-mode acceptEdits` matters more than it looks: a spawned agent
   * has no terminal, so anything that stops to ask a human for permission stops
   * forever. acceptEdits lets it write files without that.
   *
   * It does NOT cover running commands, so a task needing tests or git will
   * still stall. A machine dedicated to this can set `bypassPermissions`
   * instead — that is a real decision about what an unattended agent may do in
   * your checkout, so it is yours to make rather than a default someone
   * inherits without noticing.
   */
  agentArgs: [
    '-p',
    '--output-format',
    'stream-json',
    // R22. Realtime streaming input: the session's stdin stays OPEN, so a
    // person can prompt it again without a second process. Verified against
    // 2.1.247 — one process, one session id, many turns.
    //
    // The cost of this is that the session no longer ends by itself when the
    // first turn finishes, which is why endSession() exists below.
    '--input-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
    // acceptEdits covers writing files. It does NOT cover MCP tools — and
    // without these the agent cannot read its task, move the entry, report, or
    // ask, which is the entire loop. A real session found this by being
    // denied `task_current` and stopping, correctly, rather than guessing what
    // it had been asked to do.
    //
    // Named explicitly rather than reached with bypassPermissions: these are
    // the tools the run needs, and nothing here should imply the agent may run
    // arbitrary commands.
    '--allowedTools',
    // The prompt tells the agent to commit its work, so the default must let
    // it: a default configuration that forbids what the default prompt asks
    // for is a broken default. A real session wrote the file, could not commit,
    // and reported blocked — correctly, and avoidably.
    //
    // git only. Tests and builds are per-project decisions, so a project that
    // needs them adds them.
    'Bash(git *)',
    'mcp__cawdev__task_current',
    'mcp__cawdev__report',
    'mcp__cawdev__ask_user',
    'mcp__cawdev__await_answer',
    'mcp__cawdev__roadmap_where',
    'mcp__cawdev__roadmap_statuses',
    'mcp__cawdev__roadmap_list',
    'mcp__cawdev__roadmap_get',
    'mcp__cawdev__roadmap_create',
    'mcp__cawdev__roadmap_update',
    'mcp__cawdev__roadmap_set_status',
    'mcp__cawdev__roadmap_decline',
    'mcp__cawdev__changelog_list',
    'mcp__cawdev__changelog_get',
    'mcp__cawdev__changelog_add',
    'mcp__cawdev__changelog_update',
  ],
  pollSeconds: 25,
  heartbeatSeconds: 30,
};

async function readConfig() {
  const index = process.argv.indexOf('--config');
  const path = index === -1 ? 'runner.config.json' : process.argv[index + 1];

  let file = {};
  try {
    file = JSON.parse(await readFile(path, 'utf8'));
  } catch (failure) {
    if (index !== -1) {
      throw new Error(`Could not read ${path}: ${failure.message}`);
    }
    // No config file is fine when everything comes from the environment.
  }

  const config = {
    ...DEFAULTS,
    ...file,
    url: (process.env.CAWDEV_URL ?? file.url ?? DEFAULTS.url).replace(/\/+$/, ''),
    token: process.env.CAWDEV_TOKEN ?? file.token,
    name: process.env.CAWDEV_RUNNER_NAME ?? file.name ?? DEFAULTS.name,
    agentCommand: process.env.CAWDEV_AGENT_COMMAND ?? file.agentCommand ?? DEFAULTS.agentCommand,
    // Which projects this runner serves, and where their working copies are.
    projects: normaliseProjects(file.projects ?? {}),
    /**
     * Permissions ADDED to the defaults, not replacing them.
     *
     * `agentArgs` replaces the whole default array, which means adding one
     * permission used to mean repeating all sixteen MCP tool names. Nobody
     * should have to do that to let a project run its own build.
     */
    allowedTools: file.allowedTools ?? [],
  };

  if (!config.token) {
    throw new Error(
      'No CAWDEV_TOKEN. Mint one in the console under Agent tokens with the runner:operate ' +
        'scope on the projects this runner should serve.',
    );
  }
  if (!Object.keys(config.projects).length) {
    throw new Error(
      'No projects configured. Add a "projects" map of slug to working-copy path:\n\n' +
        '  { "projects": { "cawdev": "/Users/you/code/cawdev" } }',
    );
  }
  return config;
}

/**
 * A project is a path, or a path with permissions of its own.
 *
 * Both forms are accepted because most projects only need a path, and a config
 * that forces the long form on everybody to accommodate the one project that
 * runs Maven is a worse config.
 *
 *   "dycrypt": "/Users/you/code/dycrypt"
 *   "dycrypt": { "path": "…", "allowedTools": ["Bash(mvn *)", "mcp__roadmap"] }
 */
function normaliseProjects(projects) {
  const normalised = {};
  for (const [slug, value] of Object.entries(projects)) {
    normalised[slug] = typeof value === 'string'
      ? { path: value, allowedTools: [] }
      : { path: value.path, allowedTools: value.allowedTools ?? [] };
  }
  return normalised;
}

// --- talking to cawdev -------------------------------------------------------

async function api(config, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${config.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? safeJson(text) : null;
  if (!response.ok) {
    throw new Error(parsed?.message ?? `${method} ${path} -> ${response.status}`);
  }
  return parsed;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

// --- git ---------------------------------------------------------------------

function git(cwd, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolvePromise(out.trim())
        : reject(new Error(`git ${args.join(' ')} failed: ${err.trim() || out.trim()}`)),
    );
  });
}

/**
 * Prepares the working copy: fetch, refuse if dirty, branch off the default.
 *
 * **Refusing a dirty tree is the important part.** An agent let loose in a
 * checkout with uncommitted work will at best confuse itself and at worst
 * commit somebody's half-finished thoughts. Better to stop and say so.
 */
async function prepareWorkingCopy(path, branch, defaultBranch) {
  await access(join(path, '.git')).catch(() => {
    throw new Error(`${path} is not a git repository.`);
  });

  const dirty = await git(path, ['status', '--porcelain']);
  if (dirty) {
    throw new Error(
      `${path} has uncommitted changes:\n${dirty}\n\n` +
        'Commit or stash them first. An agent should not start work on top of yours.',
    );
  }

  await git(path, ['fetch', '--prune', 'origin']).catch((failure) => {
    // A repository with no remote is legitimate for local experiments.
    log(`  fetch skipped: ${failure.message.split('\n')[0]}`);
  });

  const base = defaultBranch || 'main';
  const exists = await git(path, ['branch', '--list', branch]);
  if (exists) {
    await git(path, ['checkout', branch]);
  } else {
    // Branch off the *remote* default when there is one, so the agent starts
    // from what everyone else has, not from whatever this checkout was left on.
    const startPoint = await git(path, ['rev-parse', '--verify', `origin/${base}`])
      .then(() => `origin/${base}`)
      .catch(() => base);
    await git(path, ['checkout', '-b', branch, startPoint]);
  }
  return git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

// --- the prompt --------------------------------------------------------------

/**
 * What the spawned session is told.
 *
 * It deliberately teaches the method rather than the task: the task is in the
 * roadmap entry, which the agent reads for itself with `task_current`. Telling
 * it the task here would be a second copy that can disagree with the entry.
 */
function promptFor(run) {
  if (run.kind === 'MANUAL') {
    // A manual session has no entry to read and no "Done when" to satisfy.
    // What it has is what the person typed, and the branch it is on — so say
    // that and get out of the way. Teaching it the roadmap method here would
    // be instructions for work it has not been asked to do.
    return `You are in a working copy on branch ${run.branch}, in a session somebody started
from the cawdev console. They are watching this session and can send you more
instructions while you work, so finish a thought and stop rather than guessing
at what they might want next.

If a decision is genuinely theirs, use the cawdev MCP tool \`ask_user\` and wait.

Their instruction:

${run.openingPrompt}`;
  }

  return `You are working on a roadmap entry in the cawdev platform, on branch ${run.branch}.

Start by calling the cawdev MCP tool \`task_current\`. It gives you the entry, its
branch, and everything already said on this run — including, if you are resuming,
what you said before.

The working method here:

1. You are already on branch ${run.branch}. Move the entry to CODING naming that
   branch (\`roadmap_set_status\`) before your first commit, if it is not there
   already. The roadmap should be able to answer "what is being worked on right
   now" without asking anyone.
2. Build what the entry's "Done when" list asks for. Read the repository's
   CLAUDE.md and follow it.
3. Call \`report\` with kind "progress" as you go — someone is watching.
4. If a decision is genuinely the user's — an architectural choice, a trade-off
   with no right answer, something the entry does not settle — call \`ask_user\`
   and wait. Do not guess and carry on. Do not use it to check work you can
   check yourself.
5. Finish with \`report\` kind "done", naming the branch and, if this repository
   has a remote, the pushed branch or PR. If something stops you that a person
   must resolve, use kind "blocked" instead and say what is in the way.

Commit your work. Never push to main.`;
}

// --- the transcript ----------------------------------------------------------

/**
 * A stream-json event, as lines worth keeping.
 *
 * The session emits far more than a person wants to read: the `init` event
 * alone is several kilobytes of tool inventory. What belongs in a transcript is
 * what the agent said, what it ran, and how a turn ended — so this summarises
 * rather than forwards, and anything unrecognised is dropped rather than
 * dumped. R17's second CLI plugs in here and nowhere else.
 */
function linesOf(event, raw) {
  if (!event) {
    // Not JSON at all. A CLI that writes plain text to stdout still deserves to
    // be readable, so it goes in verbatim.
    return raw ? [{ kind: 'SYSTEM', body: raw.slice(0, 4000) }] : [];
  }

  switch (event.type) {
    case 'system':
      // The init event names the model and the session; the rest of what it
      // carries is inventory nobody reads.
      if (event.subtype === 'init') {
        return [{
          kind: 'SYSTEM',
          body: `session ${short(event.session_id)} started on ${event.model ?? 'an unknown model'}`
            + ` in ${event.cwd ?? 'an unknown directory'}`,
        }];
      }
      return [];

    case 'assistant': {
      const lines = [];
      for (const part of event.message?.content ?? []) {
        if (part.type === 'text' && part.text?.trim()) {
          lines.push({ kind: 'ASSISTANT', body: part.text.trim() });
        } else if (part.type === 'thinking' && part.thinking?.trim()) {
          lines.push({ kind: 'THINKING', body: part.thinking.trim() });
        } else if (part.type === 'tool_use') {
          lines.push({ kind: 'TOOL', body: `${part.name} ${describeInput(part.input)}`.trim() });
        }
      }
      return lines;
    }

    case 'user': {
      // Tool results come back as a user message. The agent's own prompts do
      // too, but those are already in the transcript from the console side.
      const lines = [];
      for (const part of event.message?.content ?? []) {
        if (part.type === 'tool_result') {
          lines.push({ kind: 'TOOL_RESULT', body: flatten(part.content) });
        }
      }
      return lines;
    }

    case 'result':
      // Tokens, not dollars. `total_cost_usd` is a list-price equivalent, not a
      // bill — the event says so itself with `costBasis: "list"` — so showing
      // it to somebody on a subscription names a number they will never be
      // charged. See tools/lib/usage.mjs.
      return [{ kind: event.is_error ? 'ERROR' : 'SYSTEM', body: describeTurn(event) }];

    default:
      return [];
  }
}

/** A tool's input as one short line — the arguments that identify the call. */
function describeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const interesting = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'number', 'kind'];
  for (const key of interesting) {
    if (typeof input[key] === 'string' || typeof input[key] === 'number') {
      return String(input[key]).slice(0, 300);
    }
  }
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 199)}…` : json;
}

/** Tool results arrive as a string or as content parts. */
function flatten(content) {
  const text = typeof content === 'string'
    ? content
    : (content ?? []).map((part) => part?.text ?? '').join('\n');
  return text.trim().slice(0, 4000) || '(no output)';
}

function short(id) {
  return typeof id === 'string' ? id.slice(0, 8) : '?';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The MCP servers a working copy declares for itself.
 *
 * Read rather than ignored, because a repository that ships its own agent
 * tooling means it: dycrypt's roadmap server is how an agent working there is
 * expected to touch its roadmap. A malformed file is skipped with a note — it
 * is the project's business, and it should not stop a run.
 */
async function projectMcpServers(cwd) {
  try {
    const raw = await readFile(join(cwd, '.mcp.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const servers = parsed?.mcpServers ?? {};
    const names = Object.keys(servers).filter((name) => name !== 'cawdev');
    if (names.length) {
      log(`  passing through the project's own MCP servers: ${names.join(', ')}`);
      log('    their tools need naming in allowedTools, as mcp__<server>__<tool>');
    }
    return Object.fromEntries(names.map((name) => [name, servers[name]]));
  } catch (failure) {
    if (failure.code !== 'ENOENT') {
      log(`  ignoring the project's .mcp.json: ${failure.message}`);
    }
    return {};
  }
}

/**
 * Batches transcript lines to the platform.
 *
 * A session can emit dozens of events in a second, and one HTTP request each
 * would spend more time in the network than the agent spends thinking. Lines
 * are held for a beat and sent together, in order, one request at a time —
 * because two batches in flight can arrive out of order, and a transcript out
 * of order is worse than a transcript a half-second late.
 */
class Transcript {
  constructor(config, run, { every = 400, max = 100 } = {}) {
    this.config = config;
    this.run = run;
    this.every = every;
    this.max = max;
    this.pending = [];
    this.sending = null;
    this.timer = null;
  }

  push(line) {
    if (!line?.body) return;
    this.pending.push(line);
    if (this.pending.length >= this.max) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.every);
      this.timer.unref?.();
    }
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // One request at a time: awaiting the previous send is what keeps the
    // transcript in the order the session produced it.
    this.sending = (this.sending ?? Promise.resolve()).then(() => this.send());
    await this.sending;
  }

  async send() {
    const lines = this.pending.splice(0, this.pending.length);
    if (!lines.length) return;
    await api(this.config, `/api/projects/${this.run.projectSlug}/runs/${this.run.id}/output`, {
      method: 'POST',
      body: { lines },
      // A dropped line is not worth failing a run over. Say so and carry on:
      // the session is still working, and the person watching would rather see
      // the rest than nothing.
    }).catch((failure) => log(`  could not record output: ${failure.message}`));
  }
}

// --- talking to a live session -----------------------------------------------

/** One user message, in the shape `--input-format stream-json` expects. */
function writeUserMessage(child, text) {
  child.stdin.write(
    `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    })}\n`,
  );
}

/**
 * Long-polls for prompts typed in the console and writes them into the session.
 *
 * Delivery is acknowledged only after the write, so a prompt that never reached
 * stdin stays queued and is retried rather than being silently lost.
 */
function deliverPrompts(config, run, child) {
  let stopped = false;

  (async () => {
    while (!stopped) {
      const pending = await api(
        config,
        `/api/projects/${run.projectSlug}/runs/${run.id}/prompts/pending?wait=20`,
      ).catch((failure) => {
        log(`  could not read prompts: ${failure.message}`);
        return null;
      });

      if (stopped) return;
      if (!pending?.length) {
        // A refusal or an empty poll: pause briefly so a persistent failure
        // does not become a busy loop.
        if (!pending) await sleep(2000);
        continue;
      }

      const delivered = [];
      for (const prompt of pending) {
        if (stopped || child.stdin.destroyed) break;
        log(`  prompt from the console: ${prompt.body.slice(0, 80)}`);
        writeUserMessage(child, prompt.body);
        delivered.push(prompt.id);
      }
      if (delivered.length) {
        await api(
          config,
          `/api/projects/${run.projectSlug}/runs/${run.id}/prompts/delivered`,
          { method: 'POST', body: { promptIds: delivered } },
        ).catch((failure) => log(`  could not acknowledge prompts: ${failure.message}`));
      }
    }
  })();

  return { stop: () => { stopped = true; } };
}

// --- running one run ---------------------------------------------------------

const running = new Map();

/**
 * Runs we have decided to take, from the moment we decide.
 *
 * Separate from `running`, which only fills once a child exists: claiming and
 * preparing a working copy take a second or two, and the queue keeps offering
 * the run for that whole window. Without this the daemon claims the same run
 * twice and the second claim fails.
 */
const taken = new Set();

async function startRun(config, offered) {
  const run = offered.run;
  const project = config.projects[run.projectSlug];
  const path = project?.path;
  let runToken;
  let defaultBranch;

  try {
    log(`claiming ${run.projectSlug} ${run.label} on ${run.branch}`);
    // The claim is where the run token comes from. It appears once, here, and
    // goes straight into the child's environment — never into a file that
    // outlives the run, and never near the operator's own token.
    const claimed = await api(config, `/api/runners/${config.runnerId}/claim/${run.id}`, {
      method: 'POST',
    });
    runToken = claimed.runToken;
    // The claim carries everything needed to prepare the working copy, so the
    // runner never touches the project API — which is session-only anyway.
    defaultBranch = claimed.defaultBranch;
  } catch (failure) {
    // Losing the race is normal when two runners serve one project, and is not
    // this run's failure — somebody else has it.
    log(`  not ours: ${failure.message}`);
    taken.delete(run.id);
    return;
  }

  try {
    const branch = await prepareWorkingCopy(resolve(path), run.branch, defaultBranch);
    log(`  working copy ${path} is on ${branch}`);

    await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/transition`, {
      method: 'POST',
      body: { state: 'RUNNING' },
    });

    await spawnAgent(config, run, runToken, resolve(path));
  } catch (failure) {
    // Anything that goes wrong before or during the spawn is the run's failure,
    // and the reason belongs on the run where someone will see it.
    log(`  failed: ${failure.message}`);
    await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/transition`, {
      method: 'POST',
      body: { state: 'FAILED', summary: failure.message },
    }).catch((second) => log(`  could not record the failure: ${second.message}`));
  } finally {
    running.delete(run.id);
    taken.delete(run.id);
  }
}

/**
 * Spawns the agent with the run's own token, and nothing else.
 *
 * The user's `cawd_` token never reaches this process. The child gets a
 * `cawdr_` token bound to one run, which expires with it — so the worst a
 * confused or misbehaving session can do is act on the run it was started for.
 */
async function spawnAgent(config, run, runToken, cwd) {
  const mcpDirectory = await mkdtemp(join(tmpdir(), 'cawdev-runner-'));
  const mcpConfigPath = join(mcpDirectory, 'mcp.json');

  const serverPath = new URL('../mcp/server.mjs', import.meta.url).pathname;

  // The project's own MCP servers, folded into the config we pass.
  //
  // A server discovered from a repository's .mcp.json is project-scoped, and
  // Claude Code asks whether you trust it — a question a spawned session has no
  // terminal to answer, so it auto-denies and the repository's own tooling is
  // simply missing. Passing them through --mcp-config instead makes them
  // trusted the same way cawdev's own server is.
  //
  // cawdev's entry is written last, so a project cannot shadow it with a server
  // of the same name and intercept the run's own token.
  const mcpServers = { ...(await projectMcpServers(cwd)) };
  mcpServers.cawdev = {
    command: process.execPath,
    args: [serverPath],
    env: {
      CAWDEV_URL: config.url,
      CAWDEV_TOKEN: runToken,
      CAWDEV_PROJECT: run.projectSlug,
    },
  };
  await writeFile(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2));

  // The prompt goes on stdin, NOT as an argument.
  //
  // `--mcp-config <configs...>` is variadic, so a prompt after it is swallowed
  // as a second config file — which fails with "ENAMETOOLONG: name too long"
  // and names neither the flag nor the prompt. Stdin also sidesteps
  // argument-length limits, and prompts are not short.
  // --mcp-config goes FIRST: both it and --allowedTools are variadic, and a
  // variadic option swallows whatever follows it.
  // Extra permissions land at the END, inside the variadic --allowedTools the
  // defaults finish with. If a custom agentArgs has no --allowedTools at all,
  // the flag is added rather than the extras being silently swallowed by
  // whatever option happened to come last.
  const extras = [
    ...(config.allowedTools ?? []),
    ...(config.projects[run.projectSlug]?.allowedTools ?? []),
  ];
  const agentArgs = [...config.agentArgs];

  // Which model answers. Passed through verbatim — the CLI validates it, and a
  // run that names none is spawned exactly as it was before R23.
  //
  // Before --allowedTools, which is variadic and would swallow it.
  if (run.model) {
    agentArgs.unshift('--model', run.model);
  }
  if (extras.length) {
    if (!agentArgs.includes('--allowedTools')) {
      agentArgs.push('--allowedTools');
    }
    agentArgs.push(...extras);
  }
  const args = ['--mcp-config', mcpConfigPath, ...agentArgs];
  log(`  spawning: ${config.agentCommand} ${args.join(' ')} (prompt on stdin)`);

  return new Promise((resolvePromise) => {
    const child = spawn(config.agentCommand, args, {
      cwd,
      // Its own process group, so cancelling can take down the whole tree
      // rather than leaving orphaned children behind.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CAWDEV_URL: config.url,
        CAWDEV_TOKEN: runToken,
        CAWDEV_PROJECT: run.projectSlug,
      },
    });

    child.cawdevProjectSlug = run.projectSlug;
    running.set(run.id, child);

    // The opening instruction, as a user message. stdin is NOT closed: the
    // session stays open for whatever a person types next.
    writeUserMessage(child, promptFor(run));

    let lastText = '';
    const transcript = new Transcript(config, run);

    // stream-json arrives in chunks that split mid-line, so buffer until a
    // newline rather than assuming one chunk is one event.
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = safeJson(line);
        if (event?.type === 'result' && typeof event.result === 'string') {
          lastText = event.result;
        }
        for (const recorded of linesOf(event, line)) {
          transcript.push(recorded);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (!text) return;
      log(`  agent stderr: ${text.slice(0, 400)}`);
      transcript.push({ kind: 'ERROR', body: text.slice(0, 4000) });
    });

    // Prompts typed in the console, written into the live session.
    const prompts = deliverPrompts(config, run, child);

    child.on('error', async (failure) => {
      prompts.stop();
      await transcript.flush();
      await finish(config, run, 'FAILED', `Could not spawn the agent: ${failure.message}`);
      await rm(mcpDirectory, { recursive: true, force: true });
      resolvePromise();
    });

    child.on('exit', async (code, signal) => {
      prompts.stop();
      // Flushed before the transition, so the last thing the session said is
      // already readable when its state changes to FINISHED.
      await transcript.flush();
      await rm(mcpDirectory, { recursive: true, force: true });
      log(`  agent exited (code ${code}, signal ${signal ?? 'none'})`);

      // The agent normally ends the run itself with report(done|blocked). This
      // only catches a session that died without saying anything — otherwise
      // the run would sit RUNNING forever with nobody coming back.
      const current = await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}`)
        .catch(() => null);
      if (current?.live) {
        const summary = signal
          ? `The agent was terminated (${signal}).`
          : `The agent exited with code ${code} without reporting. ${lastText}`.trim();
        await finish(config, run, code === 0 ? 'FINISHED' : 'FAILED', summary);
      }
      resolvePromise();
    });
  });
}

async function finish(config, run, state, summary) {
  await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/transition`, {
    method: 'POST',
    body: { state, summary },
  }).catch((failure) => log(`  could not finish the run: ${failure.message}`));
}

// --- cancellation ------------------------------------------------------------

/**
 * A cancelled run reaches the runner on its next poll, and the child's whole
 * process group goes with it — an agent that spawns a build should not leave it
 * running.
 */
async function reapCancelled(config) {
  for (const [runId, child] of running) {
    const slug = child.cawdevProjectSlug;
    if (!slug) {
      continue;
    }
    // Not swallowed silently: a refusal here means cancellation stops working,
    // and a quiet `catch(() => null)` hid exactly that once — the daemon
    // cheerfully kept a cancelled run's agent alive because it could not read
    // the run and treated that as "nothing to do".
    const run = await api(config, `/api/projects/${slug}/runs/${runId}`).catch((failure) => {
      log(`  could not check run ${runId}: ${failure.message}`);
      return null;
    });
    if (run && !run.live) {
      log(`run ${runId} is ${run.state}; stopping the agent`);
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (failure) {
        log(`  could not stop it: ${failure.message}`);
      }
      running.delete(runId);
    }
  }
}

// --- the loop ----------------------------------------------------------------

async function main() {
  const config = await readConfig();

  const runner = await api(config, '/api/runners', {
    method: 'POST',
    body: {
      name: config.name,
      capabilities: JSON.stringify({
        projects: Object.keys(config.projects),
        agent: config.agentCommand,
      }),
    },
  });
  config.runnerId = runner.id;

  log(`registered as "${runner.name}" (${runner.id}) against ${config.url}`);
  log(`serving: ${Object.entries(config.projects).map(([s, p]) => `${s} -> ${p.path}`).join(', ')}`);

  const heartbeat = setInterval(() => {
    api(config, `/api/runners/${config.runnerId}/heartbeat`, { method: 'POST' })
      .catch((failure) => log(`heartbeat failed: ${failure.message}`));
  }, config.heartbeatSeconds * 1000);
  heartbeat.unref?.();

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log('stopping; leaving any live run to the platform’s staleness sweep');
      stopping = true;
      clearInterval(heartbeat);
      for (const child of running.values()) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // Already gone.
        }
      }
      process.exit(0);
    });
  }

  while (!stopping) {
    try {
      await reapCancelled(config);

      // One run at a time per working copy: runs share a checkout, so a second
      // session in the same directory would fight the first.
      const busy = new Set(
        [...running.values()].map((child) => child.cawdevProjectSlug).filter(Boolean),
      );

      const offers = await api(
        config,
        `/api/runners/${config.runnerId}/queue?wait=${config.pollSeconds}`,
      );

      for (const offered of offers) {
        const slug = offered.run.projectSlug;
        if (!config.projects[slug]) {
          continue; // Not ours to run.
        }
        if (taken.has(offered.run.id)) {
          continue; // Already being claimed or prepared by us.
        }
        if (busy.has(slug)) {
          log(`${slug} already has a run here; leaving "${offered.run.label}" queued`);
          continue;
        }
        busy.add(slug);
        taken.add(offered.run.id);
        void startRun(config, offered);
      }
    } catch (failure) {
      log(`poll failed: ${failure.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((failure) => {
  console.error(failure.message);
  process.exit(1);
});
