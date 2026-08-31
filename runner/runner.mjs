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
import { withinCeiling } from '../lib/tool-rules.mjs';
import { serveControl } from './control.mjs';

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
    // The operator's own ~/.claude/settings.json does NOT apply to a run.
    //
    // Without this the spawned agent silently inherits whatever the person who
    // started the daemon has allowed themselves — proved by spike: with
    // settings loading, `echo hello` ran without the permission tool being
    // consulted at all. That makes what a run may do depend on an invisible
    // file on whichever laptop happened to claim it, and makes the ceiling
    // below decorative. What a run may do is: these defaults, plus the
    // project's rules, filtered by this machine's `grantable`.
    '--setting-sources',
    '',
    '--permission-mode',
    'acceptEdits',
    // R51. What happens when none of the above covers a call: instead of
    // denying it silently, the CLI asks cawdev's own MCP server, which asks a
    // person and blocks until they answer.
    //
    // This is the difference between a session that stops dead three hours in
    // — which is how R35 and R36 both ended — and one that says "I need mvn"
    // and waits. Hidden from `claude --help` on 2.1.251 but accepted; the
    // daemon probes for it at boot rather than discovering it at the first
    // denial.
    '--permission-prompt-tool',
    'mcp__cawdev__approve',
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
    // The permission tool itself. Claude Code allows it implicitly, but a
    // permission handler that could itself need permission would be a deadlock
    // with no way to break it, so it is named.
    'mcp__cawdev__approve',
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
  /**
   * What this machine will let a STORED rule allow, with nobody watching.
   *
   * R51's asymmetry, and the reason a project's rules may live on the platform
   * at all. Two paths, two risks:
   *
   *   - a person deciding one call in the moment needs no ceiling: they are
   *     there, and they are looking at the command;
   *   - a rule saved earlier applies to sessions nobody is watching, so the
   *     machine's owner has the last word on what it may cover.
   *
   * Empty by default, which is the safe reading rather than a cautious one: a
   * machine that has declared nothing still works, it just asks every time.
   * Widening this is a decision about what an unattended agent may run in your
   * checkout, so it is yours to make rather than a default you inherit.
   *
   *   "grantable": ["Bash(mvn *)", "Bash(npm *)"]
   */
  grantable: [],
  pollSeconds: 25,
  heartbeatSeconds: 30,
  /**
   * How often to read each served repository for the project's Git tab.
   *
   * Deliberately slow, and on a timer of its own rather than riding the
   * heartbeat: this reading runs `git fetch` per project, which is a network
   * round trip nobody should pay for every thirty seconds. It is a background
   * reading, not something worth a round trip per page view — and the console
   * says when it was taken, so nothing pretends to be live.
   */
  gitSurveySeconds: 300,
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
    /** The machine's ceiling on stored rules. Per project ones add to it. */
    grantable: file.grantable ?? DEFAULTS.grantable,
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
      ? { path: value, allowedTools: [], grantable: [] }
      : {
          path: value.path,
          allowedTools: value.allowedTools ?? [],
          // A ceiling for this project alone, added to the machine's. A laptop
          // that will let one repository run Maven unattended has not said the
          // same about the other three.
          grantable: value.grantable ?? [],
        };
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

/**
 * The socket this daemon offers, once it has one — R52.
 *
 * Module-level rather than threaded through every function, because the two
 * things worth publishing — the log, and each line of transcript — are produced
 * in a dozen places that have no business knowing whether anybody is watching.
 * Null until `main` opens it, and null for ever if opening failed, so every use
 * is optional.
 */
let control = null;

/**
 * Whether this process's terminal belongs to the attached UI — `--attach`.
 *
 * The daemon's log and a full-screen UI cannot share a terminal: one paints
 * over the other, and the result is unreadable for both. So in that mode the
 * log goes ONLY to the socket, where the UI shows it on `g` — the same lines,
 * in a pane, instead of on top of everything.
 *
 * Kept until the socket exists, so a daemon that dies during startup still has
 * something to print. Silence plus a stack trace is a bad way to find out your
 * token is wrong.
 */
let quiet = false;
const beforeQuiet = [];

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts
    .map((part) => (typeof part === 'string' ? part : String(part)))
    .join(' ')}`;
  if (quiet) {
    beforeQuiet.push(line);
    if (beforeQuiet.length > 200) beforeQuiet.shift();
  } else {
    console.log(`[${new Date().toISOString()}]`, ...parts);
  }
  // The daemon's own running commentary is half of what makes attaching worth
  // it: "claiming…", "no free workspace", "agent stderr". None of it reaches
  // the platform, and it is what explains the runs that are NOT moving.
  control?.publish({
    type: 'log',
    line: parts.map((part) => (typeof part === 'string' ? part : String(part))).join(' '),
    at: new Date().toISOString(),
  });
}

/** Multi-line detail, set in from the log line it belongs to. */
function indent(text) {
  return text.split('\n').map((line) => `    ${line}`).join('\n');
}

/**
 * What a project has decided its agents may do without asking — R51.
 *
 * Read once per run, at spawn, and never cached: a rule granted an hour ago
 * should apply to the run starting now. A failure here is not fatal — it means
 * the session asks about things it need not have, which is the direction this
 * whole mechanism is supposed to fail in.
 */
async function projectRules(config, slug) {
  try {
    const rules = await api(config, `/api/projects/${slug}/tool-rules`);
    return (rules ?? []).map((rule) => rule.pattern).filter(Boolean);
  } catch (failure) {
    log(`  could not read ${slug}'s tool rules (${failure.message}); the session will ask`);
    return [];
  }
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
 * Prepares the working copy: fetch, check for dirt, branch off the default.
 *
 * **A dirty tree is a warning, not a wall.** An agent let loose in a checkout
 * with uncommitted work will at best confuse itself and at worst commit
 * somebody's half-finished thoughts — so the person starting the run is shown
 * what is uncommitted and decides. That decision arrives as `allowDirty`, and
 * this is where it is honoured.
 *
 * Refusing here is still the default, because a run that arrives without the
 * flag is one nobody was warned about: the composer's picture of the checkout
 * is a heartbeat old, and a tree that went dirty inside that window would
 * otherwise be worked on by an agent while somebody has edits open.
 */
async function prepareWorkingCopy(path, branch, defaultBranch, allowDirty) {
  await access(join(path, '.git')).catch(() => {
    throw new Error(`${path} is not a git repository.`);
  });

  const dirty = await git(path, ['status', '--porcelain']);
  if (dirty && !allowDirty) {
    throw new Error(
      `${path} has uncommitted changes:\n${dirty}\n\n` +
        'Commit or stash them first, or start the run again and choose to work ' +
        'on top of them. An agent should not start work on top of yours by accident.',
    );
  }
  if (dirty) {
    // Loudly, and on the run's own transcript by way of the log: "why does this
    // diff contain changes I did not make" is a question best answered before
    // it is asked.
    log(`  starting on top of uncommitted work, as asked:\n${indent(dirty)}`);
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

/** At most this many paths travel in a heartbeat; the count still tells the truth. */
const SURVEY_FILE_CAP = 20;

/**
 * What every served working copy looks like right now, for the composer.
 *
 * The console cannot see these machines, so the only moment it can learn that a
 * checkout is dirty is when the runner tells it — and the only regular moment
 * is the heartbeat. This is deliberately the cheap reading: porcelain status,
 * capped, with no line counts. It answers "should I warn before starting work
 * here", not "what has this session changed", which is R24's question and is
 * asked per run.
 *
 * A project that cannot be read at all reports `unreadable` rather than
 * vanishing: "I could not look" and "I looked and it was clean" must not
 * arrive at the console as the same answer.
 */
/**
 * One porcelain line, split into its status and its path.
 *
 * <p>By token, not by column, and that is not fussiness: `git()` trims what it
 * returns, so the leading space of an unstaged `" M path"` is gone from the
 * *first* line and present on every other one. Slicing at a fixed offset ate
 * the first character of the first filename and nothing else — the kind of
 * thing that reads as correct in every test with two files in it.
 *
 * <p>A rename arrives as `R  old -> new`; keeping the whole remainder as the
 * path says what happened rather than inventing a field for it.
 */
function statusAndPath(line) {
  const match = /^\s*(\S+)\s+(.*)$/.exec(line);
  return match ? { status: match[1], path: match[2] } : { status: '?', path: line.trim() };
}

async function surveyWorkingCopies(config) {
  const survey = [];
  for (const [slug, project] of Object.entries(config.projects)) {
    const path = resolve(project.path);
    try {
      await access(join(path, '.git'));
      const porcelain = await git(path, ['status', '--porcelain']);
      const lines = porcelain ? porcelain.split('\n').filter((line) => line.trim()) : [];
      survey.push({
        project: slug,
        path,
        dirty: lines.length,
        files: lines.slice(0, SURVEY_FILE_CAP).map(statusAndPath),
      });
    } catch (failure) {
      survey.push({
        project: slug,
        path,
        unreadable: failure.message.split('\n')[0],
      });
    }
  }
  return survey;
}

// --- reading the repository for the Git tab -----------------------------------
//
// R39. cawdev knew a great deal about git and could show almost none of it: what
// existed was per-run and nothing else. The project-level questions — what has
// landed lately, which branches are open, which are merged, and which card each
// belongs to — were unanswerable.
//
// **This machine answers them.** R25 settled the same question the same way for
// pull request URLs: the runner already holds the credentials, so it looks and
// the platform never needs a git-host token of its own. Everything here READS.
// No merging, no branch deletion, no pushing.

/**
 * The field separator inside one line of git output.
 *
 * A record separator rather than anything a person can type, for the reason
 * `readCommits` gives: a commit subject can contain anything, and splitting on
 * a character somebody might use is how a parser meets its first
 * "fix: handle | in input".
 *
 * Worth checking after any tool has rewritten this file:
 * an unprintable character in a source file survives every editor and diff tool
 * until the one that eats it, and `''` is indistinguishable from `''` on
 * screen while splitting a string into individual characters.
 */
const FIELD = '';

/** How much of the default branch's history travels in one reading. */
const GIT_SURVEY_COMMITS = 30;

/**
 * Which branch this checkout thinks is the default.
 *
 * Asked of the repository rather than taken from the project's settings: the
 * platform's `defaultBranch` is what somebody typed into a form, and what
 * matters for `--merged` is what the checkout actually resolves. `origin/HEAD`
 * is the honest answer when it exists; the fallbacks are for a clone made with
 * `--single-branch`, where it does not.
 */
async function defaultBranchOf(path) {
  const symbolic = await git(path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    .catch(() => '');
  if (symbolic) {
    return symbolic.replace(/^origin\//, '');
  }
  for (const candidate of ['main', 'master']) {
    const exists = await git(path, ['rev-parse', '--verify', `origin/${candidate}`])
      .then(() => true)
      .catch(() => false);
    if (exists) {
      return candidate;
    }
  }
  return 'main';
}

/** One `for-each-ref` line, split into the fields asked for. */
function refFields(line) {
  const [name, sha, subject, author, committedAt] = line.split(FIELD);
  return {
    name,
    headSha: sha || null,
    subject: subject || null,
    author: author || null,
    committedAt: committedAt || null,
  };
}

/**
 * Every branch on the remote, and every local branch whose remote is gone.
 *
 * `for-each-ref` rather than `git branch`, because `git branch` formats for a
 * person: it decorates the current branch with an asterisk, abbreviates, and
 * changes its mind about colour depending on whether it is talking to a
 * terminal. `for-each-ref` prints exactly the fields asked for.
 *
 * **Gone is not the same as absent.** A branch merged and deleted on the remote
 * leaves a local branch whose `%(upstream:track)` reads `[gone]`, and that is
 * worth saying out loud. A branch nobody ever pushed is simply not in this
 * reading at all, which is a different sentence for the console to write.
 */
async function readBranches(path, base) {
  const format = ['%(refname:short)', '%(objectname)', '%(contents:subject)', '%(authorname)',
    '%(committerdate:iso-strict)'].join(FIELD);

  const remote = await git(path, ['for-each-ref', 'refs/remotes/origin', `--format=${format}`])
    .catch(() => '');
  const merged = new Set(
    (await git(path, ['for-each-ref', 'refs/remotes/origin', '--merged', base,
      '--format=%(refname:short)']).catch(() => ''))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );

  const bare = base.replace(/^origin\//, '');
  const branches = [];
  for (const line of remote.split('\n')) {
    if (!line.trim()) continue;
    const ref = refFields(line);
    // `origin/HEAD` is a pointer at another branch in this list, not a branch.
    if (!ref.name || ref.name === 'origin/HEAD') continue;
    const name = ref.name.replace(/^origin\//, '');
    // The default branch is what everything else is measured against, not one
    // of the things being measured.
    if (name === bare) continue;
    branches.push({ ...ref, name, merged: merged.has(ref.name), gone: false });
  }

  // A local branch whose upstream has been deleted. This is the case the whole
  // entry turns on: a card in CODING naming a branch that was merged and
  // deleted a month ago looks exactly like work in progress.
  const localFormat = `${format}${FIELD}%(upstream:track)`;
  const local = await git(path, ['for-each-ref', 'refs/heads', `--format=${localFormat}`])
    .catch(() => '');
  for (const line of local.split('\n')) {
    if (!line.trim()) continue;
    const track = line.split(FIELD)[5] ?? '';
    if (!track.includes('gone')) continue;
    const ref = refFields(line);
    branches.push({ ...ref, merged: merged.has(`origin/${ref.name}`), gone: true });
  }

  return branches;
}

/** The tail of the default branch's history, newest first. */
async function readRecentCommits(path, base, branch) {
  const format = ['%H', '%s', '%an', '%aI'].join(FIELD);
  const out = await git(path, ['log', `--format=${format}`, '-n', String(GIT_SURVEY_COMMITS), base])
    .catch(() => '');

  const commits = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [sha, subject, author, committedAt] = line.split(FIELD);
    if (!sha) continue;
    commits.push({
      sha,
      subject: subject || '(no subject)',
      author: author || null,
      committedAt: committedAt || null,
      branch,
    });
  }
  return commits;
}

/**
 * One repository, read.
 *
 * `fetch --prune` is skipped when an agent is working in this checkout: it is
 * the only part of this reading that writes anything — remote-tracking refs —
 * and taking the ref lock out from under a session to refresh a background page
 * is a bad trade. The rest reads local refs, so the reading still happens; it is
 * merely as fresh as the last fetch, which is all the page claims anyway.
 */
async function surveyProjectGit(path, { fetch = true } = {}) {
  await access(join(path, '.git')).catch(() => {
    throw new Error(`${path} is not a git repository.`);
  });

  if (fetch) {
    await git(path, ['fetch', '--prune', 'origin']).catch((failure) => {
      // A repository with no remote is legitimate for local experiments, and a
      // network that is down should not throw away the rest of the reading.
      log(`  git survey: fetch skipped: ${failure.message.split('\n')[0]}`);
    });
  }

  const branch = await defaultBranchOf(path);
  const base = await git(path, ['rev-parse', '--verify', `origin/${branch}`])
    .then(() => `origin/${branch}`)
    .catch(() => branch);

  return {
    defaultBranch: branch,
    headSha: await git(path, ['rev-parse', base]).catch(() => null),
    commits: await readRecentCommits(path, base, branch),
    branches: await readBranches(path, base),
  };
}

/**
 * Reads every served repository and tells the platform.
 *
 * One request per project, and a project that could not be read reports the
 * reason rather than nothing: "I could not look" and "I looked and there is
 * nothing there" must not arrive at the console as the same answer. The platform
 * keeps the last good reading either way and labels it — a project whose runner
 * is down should show stale data marked stale, not an empty page.
 */
async function surveyGit(config) {
  for (const [slug, project] of Object.entries(config.projects)) {
    const path = resolve(project.path);
    const busy = [...running.values()].some(
      (child) => child.cawdevProjectSlug === slug && child.cawdevWritesCode,
    );

    const reading = await surveyProjectGit(path, { fetch: !busy }).catch((failure) => ({
      error: failure.message.split('\n')[0],
    }));

    await api(config, `/api/runners/${config.runnerId}/git/${slug}`, {
      method: 'POST',
      body: reading,
    }).catch((failure) => log(`  could not report git for ${slug}: ${failure.message}`));
  }
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
    // Tee'd to anybody attached before it is batched for the platform. The
    // socket is the local view and should not wait on a 400ms flush window, let
    // alone on the network.
    control?.publish({
      type: 'output',
      runId: this.run.id,
      line: { ...line, at: new Date().toISOString() },
    });
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

// --- what became of the branch, after the run is over ------------------------
//
// R25 answered "did the work leave the machine" and stopped there, because it
// only ever asked while a session was alive. A merge happens AFTER the run ends
// — somebody reviews the pull request — so the one event worth recording is the
// one event that design could never be present for.
//
// The platform still asks no git question of its own. It says WHICH branches;
// this says WHAT HAPPENED to them. R19 and R25's division of labour is
// unchanged: the credentials are here, so the answers are here too.

/** How often the merge pass runs, in minutes. A merge is a human-timescale event. */
const MERGE_CHECK_MINUTES = 10;

/**
 * What `gh` says about the branch's pull request.
 *
 * The pull request URL is preferred over the branch name when we have a real
 * one, because `gh pr view <branch>` stops finding anything once the branch is
 * deleted — which is precisely when this question gets interesting. A URL keeps
 * answering after the branch it belonged to is gone.
 *
 * A `/compare/` URL is not a pull request: `findPullRequest` falls back to one
 * as a link somebody can click, and asking `gh` about it would be asking about
 * a page that does not exist.
 */
async function askGitHub(cwd, branch, prUrl) {
  const target = prUrl && !prUrl.includes('/compare/') ? prUrl : branch;
  if (!target) {
    return null;
  }
  const out = await new Promise((resolvePromise) => {
    const child = spawn(
      'gh',
      ['pr', 'view', target, '--json', 'state,mergedAt,mergeCommit'],
      { cwd, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let text = '';
    child.stdout.on('data', (chunk) => (text += chunk));
    child.on('error', () => resolvePromise(null));
    child.on('exit', (code) => resolvePromise(code === 0 ? text.trim() : null));
  });
  if (!out) {
    return null;
  }

  const parsed = safeJson(out);
  if (!parsed?.state) {
    return null;
  }
  // gh's states are OPEN, CLOSED and MERGED. CLOSED here means closed WITHOUT
  // merging — gh reports a merged PR as MERGED, never as CLOSED — which is the
  // distinction worth keeping: it is a card that needs a person, not a status
  // change.
  const state = { OPEN: 'OPEN', MERGED: 'MERGED', CLOSED: 'CLOSED' }[parsed.state];
  if (!state) {
    return null;
  }
  return {
    state,
    mergeCommit: parsed.mergeCommit?.oid ?? null,
    mergedAt: parsed.mergedAt ?? null,
  };
}

/**
 * Whether the run's head is on the default branch, for any remote at all.
 *
 * By SHA rather than by branch name, and that is the whole point: a merged
 * branch is usually deleted, but its last commit stays reachable from the
 * default branch for ever. `git branch --merged` cannot answer for a branch
 * that no longer exists; this can.
 *
 * The merge commit is the FIRST merge on the ancestry path from head to the
 * default branch — the commit that actually brought the work in, rather than
 * whatever landed next.
 */
async function askGit(cwd, head, defaultBranch) {
  if (!head) {
    return null;
  }
  const base = defaultBranch || 'main';
  const target = await git(cwd, ['rev-parse', '--verify', `origin/${base}`])
    .then(() => `origin/${base}`)
    .catch(() => git(cwd, ['rev-parse', '--verify', base]).then(() => base).catch(() => null));
  if (!target) {
    return null;
  }

  const merged = await new Promise((resolvePromise) => {
    const child = spawn('git', ['merge-base', '--is-ancestor', head, target], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('error', () => resolvePromise(null));
    // 0 is "yes", 1 is "no", anything else is "I could not tell" — a missing
    // object after a prune reports 128, and treating that as "not merged" is
    // how a merged run would be quietly downgraded.
    child.on('exit', (code) => resolvePromise(code === 0 ? true : code === 1 ? false : null));
  });
  if (merged === null) {
    return { landed: 'CANNOT_TELL' };
  }
  if (!merged) {
    return { landed: 'NO' };
  }

  const mergeCommit = await git(cwd, [
    'log', '--ancestry-path', '--merges', '--reverse', '--format=%H', `${head}..${target}`,
  ]).then((out) => out.split('\n')[0]?.trim() || null).catch(() => null);

  return { landed: 'YES', mergeCommit };
}

/**
 * What became of one branch.
 *
 * `gh` first, because it is the only thing that can see a SQUASH merge: a
 * squashed branch's commits never appear on the default branch at all, so the
 * ancestry test below would confidently and wrongly say "not merged".
 *
 * That is also why the git fallback never returns OPEN or CLOSED for a branch
 * that has left the remote. Proving a merge is possible; disproving one is not,
 * and UNKNOWN is the honest answer rather than a guess dressed as a reading.
 */
async function readMergeState(cwd, { branch, defaultBranch, head, prUrl }) {
  const viaGh = await askGitHub(cwd, branch, prUrl).catch(() => null);
  if (viaGh) {
    return viaGh;
  }

  const viaGit = await askGit(cwd, head, defaultBranch)
    .catch(() => null)
    .then((result) => result ?? { landed: 'CANNOT_TELL' });

  if (viaGit.landed === 'YES') {
    return { state: 'MERGED', mergeCommit: viaGit.mergeCommit, mergedAt: null };
  }
  if (viaGit.landed === 'CANNOT_TELL') {
    return { state: 'UNKNOWN', mergeCommit: null, mergedAt: null };
  }

  // Ancestry says it has not landed. That is only half an answer: if the branch
  // is still on the remote it is genuinely open and waiting, but if it is gone
  // we cannot tell a squash merge from an abandoned branch — and must not
  // pretend to.
  const remotes = await git(cwd, ['remote']).catch(() => '');
  if (!remotes.trim()) {
    return { state: 'UNKNOWN', mergeCommit: null, mergedAt: null };
  }
  const remote = remotes.split('\n')[0].trim();
  const onRemote = await git(cwd, ['ls-remote', '--heads', remote, branch])
    .then((out) => Boolean(out.trim()))
    .catch(() => false);

  return { state: onRemote ? 'OPEN' : 'UNKNOWN', mergeCommit: null, mergedAt: null };
}

/**
 * The periodic pass: ask the platform which branches to look at, and answer.
 *
 * Rides the loop the daemon already has rather than getting a timer of its own,
 * so there is one outbound conversation and no second half to fall out of step
 * with the first.
 *
 * A project this runner does not serve is skipped in silence — reporting
 * UNKNOWN for a checkout we were never asked to hold would blank another
 * machine's good answer. A project we DO serve but can no longer read reports
 * UNKNOWN, which is the honest answer and better than a stale OPEN.
 */
async function checkMerges(config) {
  const pending = await api(config, `/api/runners/${config.runnerId}/branches`).catch((failure) => {
    log(`could not ask which branches to check: ${failure.message}`);
    return null;
  });
  if (!pending?.length) {
    return;
  }

  // One fetch per project, not one per branch: twenty-five branches in one
  // repository are twenty-five questions about the same set of refs.
  const fetched = new Set();
  const readings = [];

  for (const branch of pending) {
    const project = config.projects[branch.projectSlug];
    if (!project) {
      continue; // Not ours to answer for.
    }
    const cwd = resolve(project.path);

    try {
      await access(join(cwd, '.git'));
    } catch {
      readings.push({ runId: branch.runId, state: 'UNKNOWN' });
      continue;
    }

    if (!fetched.has(cwd)) {
      fetched.add(cwd);
      // Refs only. This never touches the working tree, so it is safe beside a
      // live session in the same checkout.
      await git(cwd, ['fetch', '--prune', 'origin']).catch(() => null);
    }

    const reading = await readMergeState(cwd, branch).catch(() => null);
    readings.push({
      runId: branch.runId,
      state: reading?.state ?? 'UNKNOWN',
      mergeCommit: reading?.mergeCommit ?? null,
      mergedAt: reading?.mergedAt ?? null,
    });
  }

  if (!readings.length) {
    return;
  }
  const recorded = await api(config, `/api/runners/${config.runnerId}/merges`, {
    method: 'POST',
    body: { readings },
  }).catch((failure) => {
    log(`could not record what became of the branches: ${failure.message}`);
    return null;
  });
  if (recorded?.merged?.length) {
    log(`${recorded.merged.length} of ${recorded.recorded} branch(es) have merged`);
  }
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
    // And the permission-prompt tool. A profile's permissions are the whole
    // point of the profile: an ASK session that can have a person grant it the
    // shell is an ASK session that can write code, which is exactly what R28
    // decided it must not be. "Cannot" must not quietly become "not yet".
    if (agentArgs[i] === '--permission-prompt-tool') {
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
 *
 * A Map, not a Set, and the value is what makes the checkout gate correct: it
 * holds the project each claimed run belongs to and whether that run writes
 * code. `busy` is rebuilt from `running` on every poll, so a run that has been
 * claimed but has not spawned yet was invisible to it — and with a full queue
 * the long poll returns instantly, so the next poll lands squarely inside that
 * window. Two agents went into one checkout that way, which is the failure this
 * whole gate exists to prevent.
 */
const taken = new Map();

/**
 * Runs we have already said we are leaving queued.
 *
 * The queue re-offers them on every poll, and saying so every time buries
 * anything worth reading. Said once, and again only if the run goes away and
 * comes back.
 */
const noted = new Map();

function noteQueued(run, why) {
  if (noted.has(run.id)) {
    return;
  }
  // A Map since R52, and the value is the point: the REASON a run is waiting is
  // knowledge that exists nowhere but here. The platform sees a queued run; only
  // this daemon knows it is queued because the checkout is busy rather than
  // because nothing has picked it up.
  noted.set(run.id, { label: run.label, projectSlug: run.projectSlug, why });
  log(`${why}; leaving "${run.label}" queued`);
}

/**
 * This machine, as somebody attached to it sees it — R52.
 *
 * Three states in one list because they are three answers to one question:
 * what is this laptop doing? A claimed run is not yet running and is not
 * queued either, and a console that only knows about the first and third makes
 * the gap between them look like nothing happening.
 */
function snapshotRuns() {
  const runs = [];
  for (const [id, child] of running) {
    const run = child.cawdevRun ?? {};
    runs.push({
      id,
      state: 'running',
      projectSlug: run.projectSlug ?? child.cawdevProjectSlug,
      label: run.label ?? '(a session)',
      branch: run.branch ?? null,
      profile: run.profile ?? 'CODE',
      writesCode: child.cawdevWritesCode === true,
      startedAt: child.cawdevStartedAt ?? null,
    });
  }
  for (const [id, claim] of taken) {
    if (running.has(id)) continue; // Already counted, and further along.
    runs.push({
      id,
      state: 'claiming',
      projectSlug: claim.projectSlug,
      label: claim.label ?? '(claiming)',
      branch: null,
      profile: claim.writes ? 'CODE' : null,
      writesCode: claim.writes === true,
      startedAt: null,
    });
  }
  for (const [id, waiting] of noted) {
    if (running.has(id) || taken.has(id)) continue;
    runs.push({
      id,
      state: 'queued',
      projectSlug: waiting.projectSlug,
      label: waiting.label,
      branch: null,
      profile: null,
      writesCode: false,
      startedAt: null,
      why: waiting.why,
    });
  }
  return runs;
}

async function startRun(config, offered) {
  const run = offered.run;
  const project = config.projects[run.projectSlug];
  const path = project?.path;
  let runToken;
  let defaultBranch;
  let allowDirty = false;
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
    // Whether somebody was shown the uncommitted work and started anyway.
    allowDirty = claimed.allowDirty === true;
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
      const prepared = await prepareWorkingCopy(
        resolve(path), run.branch, defaultBranch, allowDirty);
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
    // The transcript of a run that is over is on the platform, where it belongs.
    // Holding four thousand lines of it here for ever is how a daemon that runs
    // for a week ends up being restarted for no reason anybody can name.
    control?.forget(run.id);
  }
}

/** Whether this run is the kind that writes code, before the child exists. */
function writesCodeProfile(run) {
  return !run.profile || run.profile === 'CODE';
}

/**
 * Spawns the agent with the run's own token, and nothing else.
 *
 * The user's `cawd_` token never reaches this process. The child gets a
 * `cawdr_` token bound to one run, which expires with it — so the worst a
 * confused or misbehaving session can do is act on the run it was started for.
 */
async function spawnAgent(config, run, runToken, cwd, baseCommit) {
  // R51: what this machine will let a STORED rule cover. The project's rules
  // are filtered through it before they go anywhere near a spawn, so the
  // platform can narrow what runs here and never widen it.
  //
  // FIRST in this function, and it has to be: the MCP server's environment is
  // written a few lines below and carries the ceiling, so a declaration further
  // down is a ReferenceError on every single spawn. That shipped, and every
  // coding run failed with "Cannot access 'ceiling' before initialization"
  // until somebody tried to start one.
  const ceiling = [
    ...(config.grantable ?? []),
    ...(config.projects[run.projectSlug]?.grantable ?? []),
  ];
  // Only a coding session can be given anything by a rule. Asked in the same
  // breath as the ceiling so the two cannot drift apart.
  const stored = writesCodeProfile(run) ? await projectRules(config, run.projectSlug) : [];
  const admitted = stored.filter((pattern) => withinCeiling(ceiling, pattern));
  const refused = stored.filter((pattern) => !withinCeiling(ceiling, pattern));

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
      // The ceiling travels with the server, so the half that answers
      // permission questions mid-run enforces the same limit the spawn did.
      CAWDEV_GRANTABLE: JSON.stringify(ceiling),
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
        ...admitted,
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
  const writesCode = writesCodeProfile(run);
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
        CAWDEV_GRANTABLE: JSON.stringify(ceiling),
      },
    });

    child.cawdevProjectSlug = run.projectSlug;
    // Enough of the run for the socket to name it. The child is the only handle
    // the daemon keeps once a session is going, so what somebody attaching
    // needs to read has to hang off it.
    child.cawdevRun = {
      projectSlug: run.projectSlug,
      label: run.label,
      branch: run.branch,
      profile: run.profile ?? 'CODE',
    };
    child.cawdevStartedAt = new Date().toISOString();
    // What kind it is, so the queue knows whether it holds the working copy.
    // Whether it holds the working copy, which is what the queue serialises on.
    child.cawdevWritesCode = writesCode;
    running.set(run.id, child);

    // The opening instruction, as a user message. stdin is NOT closed: the
    // session stays open for whatever a person types next.
    writeUserMessage(child, promptFor(run));

    let lastText = '';
    const transcript = new Transcript(config, run);

    // A rule the project granted that this machine will not apply unattended.
    // Said on the RUN, not only in the daemon's log: "I clicked allow and
    // nothing happened" needs an answer where the person is looking, and the
    // person is looking at the session.
    for (const pattern of refused) {
      const line = `${pattern} is allowed by this project but not by this machine's `
        + `grantable list, so this session will still ask before using it.`;
      log(`  ${line}`);
      transcript.push({ kind: 'SYSTEM', body: line });
    }

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

/**
 * What this machine says it can do, as the platform stores it.
 *
 * The shape is documented — DEVELOPING.md, "What a runner says about itself" —
 * and the console reads it: R35 gives every runner a row saying which projects
 * it serves and how many sessions at once it will take, which used to be
 * knowable only by reading this file on the machine itself.
 *
 * Stringified, like `workingCopies` and R24's per-file detail: the column is
 * free-form JSON and the platform stores what the runner said rather than a
 * reading of it. Sent on every heartbeat and not only at registration, so a
 * daemon restarted with a project added does not leave the console showing
 * yesterday's answer.
 */
function capabilities(config) {
  return JSON.stringify({
    projects: Object.keys(config.projects),
    // The gate the queue loop actually enforces. Without it the console can say
    // a machine is live and serving a project, and still not explain why a
    // fourth run is sitting there while three others go.
    maxSessions: config.maxSessions,
    agent: config.agentCommand,
  });
}

/**
 * Does this agent CLI still accept `--permission-prompt-tool`?
 *
 * Asked at boot, because the alternative is finding out at the first denial —
 * three hours into a session, in a transcript nobody is watching. The flag is
 * hidden from `claude --help` on 2.1.251, so the probe cannot read the help
 * text: it offers the flag with no prompt and reads the complaint. A CLI that
 * accepts it complains about the missing prompt; one that does not complains
 * about the option.
 *
 * Never fatal. A daemon that refuses to start because it could not classify a
 * message from a CLI it does not own is worse than one that says so and runs.
 */
async function probePermissionPrompt(config) {
  const said = await new Promise((done) => {
    let text = '';
    let child;
    try {
      child = spawn(config.agentCommand, ['-p', '--permission-prompt-tool', 'mcp__cawdev__approve'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (failure) {
      return done(`could not be run: ${failure.message}`);
    }
    const give_up = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      done(text);
    }, 10_000);
    give_up.unref?.();

    child.stdout.on('data', (chunk) => (text += chunk));
    child.stderr.on('data', (chunk) => (text += chunk));
    child.on('error', (failure) => {
      clearTimeout(give_up);
      done(`could not be run: ${failure.message}`);
    });
    child.on('exit', () => {
      clearTimeout(give_up);
      done(text);
    });
    // Nothing to say: the missing prompt is what we want it to complain about.
    child.stdin.end();
  });

  if (/unknown option.*permission-prompt-tool/i.test(said)) {
    log(
      `WARNING: ${config.agentCommand} does not accept --permission-prompt-tool. Sessions that ` +
        `need a command nobody allowed in advance will be denied outright rather than asking ` +
        `you. See R51 and tools/runner/README.md.`,
    );
    return false;
  }
  if (said.startsWith('could not be run:')) {
    log(`WARNING: ${config.agentCommand} ${said}`);
    return false;
  }
  return true;
}

async function main() {
  // Read before anything can log, so the very first line already goes the
  // right way.
  quiet = attaching;

  const config = await readConfig();

  const runner = await api(config, '/api/runners', {
    method: 'POST',
    body: {
      name: config.name,
      capabilities: capabilities(config),
    },
  });
  config.runnerId = runner.id;

  log(`registered as "${runner.name}" (${runner.id}) against ${config.url}`);
  log(`serving: ${Object.entries(config.projects).map(([s, p]) => `${s} -> ${p.path}`).join(', ')}`);
  if (config.grantable.length) {
    log(`stored rules may cover: ${config.grantable.join(', ')}`);
  }

  // Before anything is claimed, so the warning is at the top of the log rather
  // than buried under a session that then fails for a reason it explains.
  await probePermissionPrompt(config);

  // R52. Nothing here is load-bearing for running an agent, so a daemon that
  // cannot open a socket says so and carries on: trading the ability to run
  // work for the ability to watch it would be the wrong way round.
  try {
    control = await serveControl({
      runner: {
        id: config.runnerId,
        name: config.name,
        url: config.url,
        projects: Object.keys(config.projects),
        maxSessions: config.maxSessions,
      },
      snapshot: snapshotRuns,
    });
    log(`watchable at ${control.path} — attach with: node runner.mjs attach`);
  } catch (failure) {
    log(`no control socket (${failure.message}); the daemon runs, you just cannot attach`);
  }

  // Published on a timer rather than from the dozen places that change it.
  // Cheap — a few hundred bytes compared against the last one — and it cannot
  // fall out of step with the truth the way a dozen call sites would.
  let lastPublished = '';
  const publishRuns = setInterval(() => {
    if (!control) return;
    const runs = snapshotRuns();
    const now = JSON.stringify(runs);
    if (now === lastPublished) return;
    lastPublished = now;
    control.publish({ type: 'runs', runs });
  }, 1000);
  publishRuns.unref?.();

  // One beat straight away. Waiting a full interval would leave the composer
  // with no picture of this machine's checkouts for the first thirty seconds
  // after a restart — and warning nobody is exactly the failure this fixes.
  const beat = async () => {
    // What we are actually driving, not merely that we are alive. A restarted
    // daemon is alive and drives nothing, and the runs it abandoned used to sit
    // RUNNING for ever because the platform was watching the wrong thing.
    //
    // The whole set every time, so the platform can tell an abandoned run from
    // one it has never heard about.
    //
    // The survey rides along rather than getting a beat of its own: it is the
    // same statement — "here is this machine as it stands" — and a second timer
    // would only let the two halves disagree.
    const workingCopies = await surveyWorkingCopies(config).catch((failure) => {
      log(`could not survey the working copies: ${failure.message}`);
      return null;
    });
    api(config, `/api/runners/${config.runnerId}/heartbeat`, {
      method: 'POST',
      body: {
        name: config.name,
        running: [...running.keys()],
        capabilities: capabilities(config),
        // Stringified, as `capabilities` and R24's detail are: the platform
        // stores what this machine said, not its own reading of it.
        workingCopies: workingCopies ? JSON.stringify(workingCopies) : null,
      },
    }).catch((failure) => log(`heartbeat failed: ${failure.message}`));
  };

  await beat();
  const heartbeat = setInterval(beat, config.heartbeatSeconds * 1000);
  heartbeat.unref?.();

  // The Git tab's reading, on a timer of its own because it is a different
  // question asked at a different rate: the heartbeat says "this machine is
  // alive" every thirty seconds, and this says "here is what these repositories
  // look like" every few minutes, having paid for a fetch to find out.
  //
  // Once immediately, for the same reason the heartbeat beats immediately — a
  // console showing an empty Git tab for five minutes after a restart has told
  // somebody the repository has no branches.
  const readGit = () => {
    void surveyGit(config).catch((failure) => log(`git survey failed: ${failure.message}`));
  };
  readGit();
  const gitSurvey = setInterval(readGit, config.gitSurveySeconds * 1000);
  gitSurvey.unref?.();

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
      clearInterval(gitSurvey);
      clearInterval(publishRuns);
      // Removed here rather than left for the next start: a socket file that
      // outlives its daemon is what makes the next `attach` report a machine
      // that is not there.
      await control?.close().catch(() => undefined);
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

  // R52's second half: one command that starts the machine and shows it to you.
  //
  // In the SAME process, deliberately. A detached daemon would outlive the
  // window and then have to be found and stopped by pid, which is a worse
  // problem than the one being solved. One command, one process, one Ctrl-C —
  // and quitting with sessions live asks first, because `q` must not be a way
  // to lose three hours of work by leaning on the keyboard.
  if (attaching) {
    const { attach } = await import('./attach.mjs');
    void attach(process.argv.slice(2), {
      socketPath: control?.path,
      // Its own daemon, so quitting means stopping: raised as a signal rather
      // than an exit, so the run goes through the same goodbye and the same
      // termination of children as a Ctrl-C would.
      onQuit: () => process.kill(process.pid, 'SIGINT'),
      liveSessions: () => running.size,
    }).catch((failure) => {
      console.error(`could not attach: ${failure.message}`);
    });
  }

  // Long ago enough that the first pass happens on the first poll: a daemon
  // that has just started is exactly when somebody wants to know what landed
  // while it was off.
  let lastMergeCheck = 0;

  while (!stopping) {
    try {
      await reapCancelled(config);

      // On the loop the daemon already has, not a timer of its own. Before the
      // long poll rather than after, because the poll blocks for up to
      // pollSeconds and work queued behind it should not wait on git.
      if (Date.now() - lastMergeCheck >= MERGE_CHECK_MINUTES * 60_000) {
        lastMergeCheck = Date.now();
        await checkMerges(config);
      }

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
      const busy = new Set([
        ...[...running.values()]
          .filter((child) => child.cawdevWritesCode)
          .map((child) => child.cawdevProjectSlug),
        // Claimed but not yet spawned counts too. Anything else leaves a hole
        // exactly as wide as a claim plus a fetch and a checkout.
        ...[...taken.values()]
          .filter((claim) => claim.writes)
          .map((claim) => claim.projectSlug),
      ].filter(Boolean));

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
        taken.set(offered.run.id, { projectSlug: slug, writes, label: offered.run.label });
        noted.delete(offered.run.id);
        claimable += 1;
        void startRun(config, offered);
      }

      // Forget runs that are no longer offered, so one that comes back around
      // is reported again rather than staying silently skipped forever.
      for (const id of [...noted.keys()]) {
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

/**
 * Two programs in one file, told apart by the first argument.
 *
 * `attach` is a client and needs none of what a daemon needs — no token, no
 * projects, no config at all — so it is dispatched BEFORE `readConfig`, which
 * refuses to return without them. Somebody watching a machine should not have
 * to hold the credential that machine runs on.
 */
/** `--attach`: start the daemon and watch it, in one process and one terminal. */
const attaching = process.argv.includes('--attach');

if (process.argv[2] === 'attach') {
  const { attach } = await import('./attach.mjs');
  attach(process.argv.slice(3)).catch((failure) => {
    console.error(failure.message);
    process.exit(1);
  });
} else {
  main().catch((failure) => {
    // Whatever the daemon managed to say before the UI took the terminal. A
    // daemon that dies during startup in --attach mode would otherwise fail in
    // silence.
    if (quiet) {
      for (const line of beforeQuiet) console.error(line);
    }
    console.error(failure.message);
    process.exit(1);
  });
}
