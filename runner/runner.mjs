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
   * How many agent processes this machine will host at once.
   *
   * Only ASK runs can be concurrent — the others hold a working copy each — so
   * in practice this bounds how many questions can be in flight. Without a
   * bound, a queue of them is a fork bomb with better manners.
   */
  maxSessions: 4,
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
    maxSessions: file.maxSessions ?? DEFAULTS.maxSessions,
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

  // HEAD *now* is the base: "what did this run produce" means what it added,
  // not everything on the branch. A resumed branch already carries a previous
  // run's commits, and attributing those to this one would be a lie.
  return {
    branch: await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    base: await git(path, ['rev-parse', 'HEAD']).catch(() => null),
  };
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
  if (run.profile && run.profile !== 'CODE') {
    return promptForProfile(run);
  }

  if (run.kind === 'ASK') {
    // No working method, because there is no work: this session exists to use
    // cawdev's own tools and answer. It has no permission to edit or run
    // anything, so telling it to "build" would be instructions it cannot follow.
    return `You are answering a question about cawdev itself — its roadmap, its
changelog, and what its agents have been doing. You have the cawdev MCP tools and
nothing else: no file edits, no shell, no git.

Start with \`roadmap_where\` to see which platform and projects you can reach.
${run.reaches?.length > 1 ? `This question spans ${run.reaches.join(', ')} — pass \`project\` on each call.` : ''}

Use \`roadmap_list\`, \`roadmap_get\` and \`changelog_list\` to find things out
rather than guessing, and say plainly when the answer is not there.

If you are asked to change something — add an entry, correct a changelog line —
do it with the tools and say what you did. If a decision is genuinely the
person's, use \`ask_user\` and wait.

Report your answer with \`report\` kind "done" when you are finished. That is how
they see it.

They asked:

${run.openingPrompt}`;
  }

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

// --- the working copy --------------------------------------------------------

/**
 * What is uncommitted, as counts.
 *
 * `--numstat` against HEAD covers staged and unstaged together, which is what
 * a person means by "what has it changed". Untracked files are counted
 * separately: numstat cannot see them, and a session that writes three new
 * files and edits nothing would otherwise report a clean tree.
 */
async function readWorkingCopy(cwd) {
  const files = new Map();

  const numstat = await git(cwd, ['diff', '--numstat', 'HEAD']).catch(() => '');
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const [added, removed, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!path) continue;
    // A binary file reports "-" for both. Counting those as zero is honest:
    // "3 lines changed" for a PNG would not be.
    files.set(path, {
      path,
      insertions: Number(added) || 0,
      deletions: Number(removed) || 0,
    });
  }

  // Untracked files, counted as wholly new.
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']).catch(() => '');
  for (const path of untracked.split('\n')) {
    if (!path.trim() || files.has(path)) continue;
    const lines = await countLines(join(cwd, path));
    files.set(path, { path, insertions: lines, deletions: 0 });
  }

  const detail = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: detail.length,
    insertions: detail.reduce((sum, file) => sum + file.insertions, 0),
    deletions: detail.reduce((sum, file) => sum + file.deletions, 0),
    detail: JSON.stringify(detail),
  };
}

/** Lines in a new file. Unreadable or binary counts as zero rather than failing. */
async function countLines(path) {
  try {
    const text = await readFile(path, 'utf8');
    if (text.includes('\0')) {
      return 0;
    }
    return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  } catch {
    return 0;
  }
}

/**
 * Keeps the platform's picture of the checkout current, and performs whatever
 * a person has asked of it.
 *
 * One loop for both because they are the same concern and share a cadence: a
 * commit changes the working copy, so reporting immediately after one is how
 * the counts drop to zero in the console without waiting for the next tick.
 */
function watchWorkingCopy(config, run, cwd, baseCommit) {
  let stopped = false;
  let lastHead = baseCommit;

  (async () => {
    let last = null;
    while (!stopped) {
      const state = await readWorkingCopy(cwd).catch((failure) => {
        log(`  could not read the working copy: ${failure.message}`);
        return null;
      });

      if (stopped) return;

      // Only when it changed: a session that thinks for a minute should not
      // generate a request a second saying the same thing.
      const fingerprint = state && `${state.files}:${state.insertions}:${state.deletions}`;
      if (state && fingerprint !== last) {
        last = fingerprint;
        await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/working-copy`, {
          method: 'POST',
          body: state,
        }).catch((failure) => log(`  could not report the working copy: ${failure.message}`));
      }

      // Commits as they land, not only at the end: an hour-long run should
      // show its work while it works.
      const head = await git(cwd, ['rev-parse', 'HEAD']).catch(() => null);
      if (head && head !== lastHead) {
        lastHead = head;
        await reportCommits(config, run, cwd, baseCommit);
      }

      const actions = await api(
        config,
        `/api/projects/${run.projectSlug}/runs/${run.id}/actions/claim`,
        { method: 'POST' },
      ).catch((failure) => {
        log(`  could not read actions: ${failure.message}`);
        return [];
      });

      for (const action of actions ?? []) {
        if (stopped) return;
        await perform(config, run, cwd, action);
        last = null; // The tree changed; report it on the next pass.
      }

      await sleep(3000);
    }
  })();

  return { stop: () => { stopped = true; } };
}

/** Does what was asked, and says how it went either way. */
async function perform(config, run, cwd, action) {
  let ok = false;
  let result;

  if (action.kind === 'COMMIT') {
    log(`  committing on ${run.branch}: ${(action.message ?? '').slice(0, 60)}`);
    try {
      await git(cwd, ['add', '-A']);
      // --no-verify is deliberately NOT passed: a repository's hooks are its
      // own business, and a commit that its own hooks reject should fail here
      // rather than land because it came from a button.
      await git(cwd, ['commit', '-m', action.message ?? 'Committed from the cawdev console']);
      result = await git(cwd, ['rev-parse', '--short', 'HEAD']);
      ok = true;
    } catch (failure) {
      result = failure.message;
    }
  } else {
    result = `This runner does not know how to ${action.kind}.`;
  }

  await api(
    config,
    `/api/projects/${run.projectSlug}/runs/${run.id}/actions/${action.id}/finished`,
    { method: 'POST', body: { ok, result: String(result).slice(0, 4000) } },
  ).catch((failure) => log(`  could not report the action: ${failure.message}`));
}

// --- what the run committed --------------------------------------------------

/**
 * The commits this run produced, from where its branch was cut.
 *
 * A record separator rather than newlines between fields: a commit subject can
 * contain anything, and splitting on something a human can type is how a parser
 * meets its first "fix: handle \n in input" and breaks.
 */
async function readCommits(cwd, base) {
  if (!base) {
    return [];
  }
  const SEP = '';
  const format = ['%H', '%s', '%an', '%aI'].join(SEP);
  const log = await git(cwd, ['log', '--reverse', `--format=${format}`, `${base}..HEAD`])
    .catch(() => '');

  const commits = [];
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    const [sha, subject, author, committedAt] = line.split(SEP);
    if (!sha) continue;
    commits.push({
      sha,
      subject: subject ?? '(no subject)',
      author: author ?? null,
      committedAt: committedAt ?? null,
      ...(await statOf(cwd, sha)),
    });
  }
  return commits;
}

/** One commit's diffstat. A merge or a root commit reports nothing, not zero-ish. */
async function statOf(cwd, sha) {
  const numstat = await git(cwd, ['show', '--numstat', '--format=', sha]).catch(() => '');
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const [added, removed] = line.split('\t');
    files += 1;
    insertions += Number(added) || 0;
    deletions += Number(removed) || 0;
  }
  return { files, insertions, deletions };
}

/**
 * Whether the work left the machine.
 *
 * Four answers rather than a boolean, because "on the remote but behind what
 * the run committed" is exactly how somebody ships nothing while believing they
 * shipped — and it is the state a run that could not push ends in.
 */
async function readPushState(cwd, branch) {
  const remotes = await git(cwd, ['remote']).catch(() => '');
  if (!remotes.trim()) {
    return 'NO_REMOTE';
  }
  const remote = remotes.split('\n')[0].trim();

  // Ask the remote rather than trusting a stale remote-tracking ref: the branch
  // may have been pushed from elsewhere since this checkout last fetched.
  const remoteHead = await git(cwd, ['ls-remote', '--heads', remote, branch])
    .catch(() => '')
    .then((out) => out.split('\t')[0]?.trim() ?? '');

  if (!remoteHead) {
    return 'NOT_PUSHED';
  }
  const localHead = await git(cwd, ['rev-parse', 'HEAD']).catch(() => '');
  return remoteHead === localHead ? 'PUSHED' : 'AHEAD';
}

/**
 * A pull request for this branch, if one exists.
 *
 * **Found, never created.** `gh` answers when it is installed and authenticated;
 * otherwise a compare URL is built from the remote, which is a link somebody can
 * click to open a PR themselves rather than a claim that one exists.
 *
 * This is where R15's open question — credential custody — settles: the runner
 * already holds the credentials, so the runner answers and the platform never
 * needs a token of its own.
 */
async function findPullRequest(cwd, branch) {
  const viaGh = await new Promise((resolvePromise) => {
    const child = spawn('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => resolvePromise(null));
    child.on('exit', (code) => resolvePromise(code === 0 ? out.trim() : null));
  });
  if (viaGh) {
    return viaGh;
  }

  // No gh, or no PR yet. A compare URL is honest: it is where you would go to
  // open one, and it is obviously not a claim that one exists.
  const origin = await git(cwd, ['remote', 'get-url', 'origin']).catch(() => '');
  const github = /github\.com[:/](.+?)(?:\.git)?$/.exec(origin.trim());
  return github ? `https://github.com/${github[1]}/compare/${encodeURIComponent(branch)}` : null;
}

/** Reads the run's history out of git and tells the platform. */
async function reportCommits(config, run, cwd, base) {
  const commits = await readCommits(cwd, base).catch((failure) => {
    log(`  could not read the commits: ${failure.message}`);
    return null;
  });
  if (!commits) {
    return;
  }
  const pushState = await readPushState(cwd, run.branch).catch(() => null);
  // Only worth looking for a PR once something has been pushed: a branch that
  // has never left the machine cannot have one.
  const prUrl = pushState === 'PUSHED' || pushState === 'AHEAD'
    ? await findPullRequest(cwd, run.branch).catch(() => null)
    : null;

  await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/commits`, {
    method: 'POST',
    body: { commits, pushState, prUrl, baseCommit: base },
  }).catch((failure) => log(`  could not record the commits: ${failure.message}`));
}

// --- talking to a live session -----------------------------------------------

// --- what each profile may do ------------------------------------------------
//
// The profile decides the PERMISSIONS, not merely the prompt. A session told
// not to touch the code but able to is one refusal away from touching it; a
// session that cannot has nothing to decide, and nothing to be talked out of.

/** Every cawdev MCP tool the runner knows about, from the coding defaults. */
const CAWDEV_TOOLS = DEFAULTS.agentArgs.filter((arg) => arg.startsWith('mcp__cawdev__'));

const READ_ONLY_CAWDEV = CAWDEV_TOOLS.filter(
  (tool) => !/(create|update|set_status|decline|add)$/.test(tool),
);

const ROADMAP_WRITE_CAWDEV = CAWDEV_TOOLS;

/**
 * Reading the code without being able to change it.
 *
 * Named individually rather than reached with a permission mode: `Read` and
 * `Grep` are the tools an audit needs, and `Edit`, `Write` and `Bash` are
 * exactly the ones it must not have.
 */
const READ_FILES = ['Read', 'Grep', 'Glob'];

const PROFILE_TOOLS = {
  ASK: READ_ONLY_CAWDEV,
  ROADMAP: ROADMAP_WRITE_CAWDEV,
  AUDIT: [...READ_ONLY_CAWDEV, 'mcp__cawdev__propose_entry', ...READ_FILES],
};

/**
 * The spawn arguments for a session that does not write code.
 *
 * Everything up to `--allowedTools` is kept — the output format, the streaming
 * input, the model — and the permissions are replaced with the profile's own.
 * `--permission-mode acceptEdits` goes too: a session that cannot write files
 * has no use for permission to.
 */
function argsForProfile(agentArgs, profile) {
  const kept = [];
  for (let i = 0; i < agentArgs.length; i++) {
    if (agentArgs[i] === '--allowedTools') {
      break; // variadic: everything after it is a permission
    }
    if (agentArgs[i] === '--permission-mode') {
      i += 1;
      continue;
    }
    kept.push(agentArgs[i]);
  }
  return [...kept, '--allowedTools', ...(PROFILE_TOOLS[profile] ?? READ_ONLY_CAWDEV)];
}

/** What each profile is asked to do, in its own words. */
function promptForProfile(run) {
  const spans = run.reaches?.length > 1
    ? `This spans ${run.reaches.join(', ')} — pass \`project\` on each call.\n`
    : '';

  // Which card, when the session is about one. The run records it rather than
  // the question carrying "About R3 —" on its front, so this is where the agent
  // is told — and `roadmap_get` is named because the title alone is not the
  // entry, and guessing from a title is how you answer about the wrong card.
  const about = run.entryNumber
    ? `This is about **R${run.entryNumber} — ${run.entryTitle}**. Read it with `
      + `\`roadmap_get\` before you answer.\n`
    : '';

  if (run.profile === 'ROADMAP') {
    return `You are working on a roadmap in the cawdev platform. You have the cawdev MCP
tools and nothing else: you cannot edit files, run commands, or use git, and you
should not offer to.
${spans}${about}
Start with \`roadmap_where\`, then \`roadmap_list\` to see what is already recorded.
Read two or three existing entries before writing one, and match their shape: prose
saying what and why, a **Build:** list, and a **Done when:** condition somebody
could check.

If a decision is genuinely the person's, use \`ask_user\` and wait. Report what you
did with \`report\` kind "done".

They asked:

${run.openingPrompt}`;
  }

  if (run.profile === 'AUDIT') {
    return `You are auditing this repository for the cawdev platform. You can READ the code
and the roadmap; you cannot change either. No edits, no commands, no git — and no
creating roadmap entries directly.
${about}
What you find becomes a **proposal** with \`propose_entry\`, one per finding, each
with a severity:

- \`critical\` — it is broken, unsafe, or loses data
- \`medium\` — it will hurt, but not today
- \`minor\` — worth doing, nobody is bleeding

A person decides which proposals become roadmap entries, so write each one as an
entry would be written: a title somebody can scan, then prose, a **Build:** list
and a **Done when:** condition. Say where in the code you saw it.

Then \`report\` kind "done" with the report itself — what you looked at, what you
found, and what you deliberately did not check. Twenty vague findings are worth
less than four you can point at.

They asked:

${run.openingPrompt}`;
  }

  // ASK
  return `You are answering a question about cawdev itself — its roadmap, its changelog,
and what its agents have been doing. You have read-only cawdev tools and nothing
else: no file edits, no shell, no git, and you cannot change the roadmap. If you
are asked to change something, say that this session cannot and what could.
${spans}${about}
Start with \`roadmap_where\`. Use \`roadmap_list\`, \`roadmap_get\` and
\`changelog_list\` to find things out rather than guessing, and say plainly when
the answer is not there.

Report your answer with \`report\` kind "done". That is how they see it.

They asked:

${run.openingPrompt}`;
}

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

/**
 * Runs we have already said we are leaving queued.
 *
 * The queue re-offers them on every poll, and saying so every time buries
 * anything worth reading. Said once, and again only if the run goes away and
 * comes back.
 */
const noted = new Set();

function noteQueued(run, why) {
  if (noted.has(run.id)) {
    return;
  }
  noted.add(run.id);
  log(`${why}; leaving "${run.label}" queued`);
}

async function startRun(config, offered) {
  const run = offered.run;
  const project = config.projects[run.projectSlug];
  const path = project?.path;
  let runToken;
  let defaultBranch;
  // Where the branch stood when this run took it over.
  let baseCommit;

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
    let branch = run.branch;
    if (run.profile && run.profile !== 'CODE') {
      // Nothing is prepared. It cuts no branch, and a dirty tree does not stop
      // it, because it is not going to write to one — refusing here would make
      // "what is R12 about?" unanswerable while somebody has edits open.
      log(`  a ${run.profile.toLowerCase()} session: no branch, nothing prepared`);
    } else {
      const prepared = await prepareWorkingCopy(resolve(path), run.branch, defaultBranch);
      branch = prepared.branch;
      baseCommit = prepared.base;
    }
    log(`  working copy ${path} is on ${branch}`);

    await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/transition`, {
      method: 'POST',
      body: { state: 'RUNNING' },
    });

    await spawnAgent(config, run, runToken, resolve(path), baseCommit);
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
async function spawnAgent(config, run, runToken, cwd, baseCommit) {
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
  // An ASK session gets the cawdev tools and NOTHING else — no edits, no
  // shell, no git. A session asked a question should not be able to answer it
  // by changing something, and the project's own permissions are exactly what
  // must not apply here.
  // A project's own permissions apply to coding only. A project that permits
  // `mvn` for building has said nothing about permitting it to a session that
  // was asked a question.
  const extras = run.profile && run.profile !== 'CODE'
    ? []
    : [
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

  // How hard it is told to think: --effort low|medium|high|xhigh|max. Passed
  // through verbatim for the same reason as the model — the CLI validates it,
  // and a run naming none is spawned exactly as it was before.
  if (run.effort) {
    agentArgs.unshift('--effort', run.effort);
  }
  if (extras.length) {
    if (!agentArgs.includes('--allowedTools')) {
      agentArgs.push('--allowedTools');
    }
    agentArgs.push(...extras);
  }
  const writesCode = !run.profile || run.profile === 'CODE';
  const args = [
    '--mcp-config',
    mcpConfigPath,
    ...(writesCode ? agentArgs : argsForProfile(agentArgs, run.profile)),
  ];
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
    // What kind it is, so the queue knows whether it holds the working copy.
    // Whether it holds the working copy, which is what the queue serialises on.
    child.cawdevWritesCode = writesCode;
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
    // And what the console can see of the checkout, plus anything it asks of it.
    const workingCopy = watchWorkingCopy(config, run, cwd, baseCommit);

    child.on('error', async (failure) => {
      prompts.stop();
      workingCopy.stop();
      await transcript.flush();
      await finish(config, run, 'FAILED', `Could not spawn the agent: ${failure.message}`);
      await rm(mcpDirectory, { recursive: true, force: true });
      resolvePromise();
    });

    child.on('exit', async (code, signal) => {
      prompts.stop();
      workingCopy.stop();
      // The last reading, after the agent has stopped changing things. It
      // usually lands *after* the run is already FINISHED, because the agent
      // ends its own run by reporting — which the API allows for exactly this.
      await reportCommits(config, run, cwd, baseCommit);
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
    // What we are actually driving, not merely that we are alive. A restarted
    // daemon is alive and drives nothing, and the runs it abandoned used to sit
    // RUNNING for ever because the platform was watching the wrong thing.
    //
    // The whole set every time, so the platform can tell an abandoned run from
    // one it has never heard about.
    api(config, `/api/runners/${config.runnerId}/heartbeat`, {
      method: 'POST',
      body: { name: config.name, running: [...running.keys()] },
    }).catch((failure) => log(`heartbeat failed: ${failure.message}`));
  }, config.heartbeatSeconds * 1000);
  heartbeat.unref?.();

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (stopping) {
        // A second Ctrl-C means "now", not "again".
        process.exit(0);
      }
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

      // Say so, rather than letting the console offer this runner for another
      // two minutes while it waits out the staleness window. Bounded, because
      // an unreachable platform must not be able to hang a shutdown — the
      // silence will settle it either way.
      await Promise.race([
        api(config, `/api/runners/${config.runnerId}/goodbye`, { method: 'POST' })
          .then(() => log('told the platform this runner has stopped'))
          .catch((failure) => log(`  could not say goodbye: ${failure.message}`)),
        sleep(2000),
      ]);
      process.exit(0);
    });
  }

  while (!stopping) {
    try {
      await reapCancelled(config);

      const offers = await api(
        config,
        `/api/runners/${config.runnerId}/queue?wait=${config.pollSeconds}`,
      );

      // One run at a time per working copy — but only for runs that USE one.
      //
      // ENTRY and MANUAL runs share a checkout, so a second in the same
      // directory would fight the first. An ASK run prepares nothing and writes
      // nothing, so it has no reason to wait behind them: making it queue meant
      // you could not ask a question about a project while anything was running
      // there, which is exactly when you would want to.
      //
      // Computed AFTER the poll, not before. The poll blocks for up to
      // pollSeconds, so a set built before it is a snapshot of the world as it
      // was when the wait began — and a run that started during the wait was
      // invisible. Two agents went into one checkout that way.
      const busy = new Set(
        [...running.values()]
          .filter((child) => child.cawdevWritesCode)
          .map((child) => child.cawdevProjectSlug)
          .filter(Boolean),
      );

      let claimable = 0;
      let skipped = 0;

      for (const offered of offers) {
        const slug = offered.run.projectSlug;
        if (!config.projects[slug]) {
          continue; // Not ours to run.
        }
        if (taken.has(offered.run.id)) {
          continue; // Already being claimed or prepared by us.
        }
        const writes = !offered.run.profile || offered.run.profile === 'CODE';
        if (writes && busy.has(slug)) {
          noteQueued(offered.run, `${slug} already has a run here`);
          skipped += 1;
          continue;
        }
        if (running.size >= config.maxSessions) {
          // A bound on how many agent processes this machine will host at once.
          // Without it a queue of questions is a fork bomb with better manners.
          noteQueued(offered.run, `at ${config.maxSessions} sessions`);
          skipped += 1;
          continue;
        }
        busy.add(slug);
        taken.add(offered.run.id);
        noted.delete(offered.run.id);
        claimable += 1;
        void startRun(config, offered);
      }

      // Forget runs that are no longer offered, so one that comes back around
      // is reported again rather than staying silently skipped forever.
      for (const id of [...noted]) {
        if (!offers.some((offer) => offer.run.id === id)) {
          noted.delete(id);
        }
      }

      // The queue's long poll returns IMMEDIATELY when anything is waiting —
      // that is what makes it useful. But a run we cannot take stays waiting,
      // so asking again at once is a busy-wait: the loop spun at ~15ms and
      // flooded the log with the same line. Nothing we are waiting for changes
      // faster than a run finishing, so sleep before asking again.
      if (!claimable && skipped) {
        await sleep(config.pollSeconds * 1000);
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
