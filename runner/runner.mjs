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
import { createHash } from 'node:crypto';
import {
  access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';

import { join, resolve } from 'node:path';
import { spawnFailureSaid, workspaceProblem, workspaceProblemSaid } from './workspace-check.mjs';
import { changedLines } from './changed-lines.mjs';
import { adapterFor, hostFor, repoOf } from './git-host.mjs';
import { describeTurn, totalsOf } from '../lib/usage.mjs';
import { withinCeiling } from '../lib/tool-rules.mjs';
import { serveControl } from './control.mjs';
import { painter } from '../lib/ansi.mjs';
import { bannerLines, tintLog } from './banner.mjs';
import { codeMapOf } from '../lib/code-map.mjs';
import { usageLimitOf } from '../lib/usage-limit.mjs';
import { TranscriptBatch } from '../lib/transcript-batch.mjs';
import { parseUsage } from '../lib/usage-report.mjs';
import {
  ANTIGRAVITY_EXPERTS_PLUGIN, qualified, writeAntigravityExpertsPlugin, writeRunPlugin,
} from '../lib/run-plugin.mjs';
import { AI_CONFIG, harnessPrompt, readRepoConfig } from '../lib/harness-prompt.mjs';
import { loadToken, storedUrls } from './token-store.mjs';
import {
  CARD_WRITE, CAWDEV_READS, GIT_READS, beforeTheWorkExists, driftedFrom, readOnlyExpert,
  toolsForStage,
} from '../lib/stage-tools.mjs';
import { capabilityIn, describeCall } from '../lib/tool-line.mjs';
import { findSecret } from '../lib/secrets.mjs';
import { BackgroundShells } from '../lib/background-shells.mjs';
import { cliVersion, isBelow } from '../lib/version.mjs';
import { reloadableFor, restartNeededFor } from '../lib/runner-config.mjs';
import {
  createAutoWorkspace, discoverAutoWorkspaces, isAutoWorkspace,
} from './auto-workspaces.mjs';
import { agentOfCommand, needsEverything } from '../lib/agents.mjs';
import { cawdevToolNames, codexArgs, translateCodexEvent } from '../lib/codex.mjs';
import {
  drivingPath, isAlive, killedByRestart, leftBehind, memoryMaxOf, probeScope, readDriving,
  restartSummary, scoped, snapshotOf, writeDriving,
} from './restart.mjs';
import { COMMITS_ITS_WORK, settleBranch } from '../lib/finish-check.mjs';

// --- configuration -----------------------------------------------------------

const DEFAULTS = {
  /**
   * The platform this machine talks to when nothing says otherwise.
   *
   * The CONSOLE's origin, not the API's. It was `:8091` — the API direct, on
   * the reasoning that the daemon calls `/api` and has no use for a page — and
   * that is true of the call and wrong about everything around it.
   *
   * One origin is a hard constraint here: in production nginx serves the
   * console and proxies `/api`, and `:8091` does not exist from outside at all,
   * so the API's own port is a development-only back door and a poor thing for
   * a default to describe. R81's session and R93's token are both filed under
   * the URL, so a default naming one door while a person signs in at the other
   * files a live credential under a name the daemon never looks up.
   *
   * The default now names cawdev's own hosted instance, `app.cawdev.com`,
   * rather than a local address — a machine with no config talks to that
   * instance until told otherwise. A self-hosted deployment says so in its
   * config, which is one line and the thing configs are for.
   */
  url: 'https://app.cawdev.com',
  name: 'this-machine',
  /**
   * The agent this machine spawns.
   *
   * There was no default here, and every config that worked happened to name
   * one or inherit `CAWDEV_AGENT_COMMAND` from the shell that started the
   * daemon. R93's generated config names neither — `configFor` writes the
   * smallest file that boots, and this was not in it — so a machine set up by
   * the walk spawned `undefined` and every run on it died with
   * `The "file" argument must be of type string`, which names no cause and no
   * cure. A default that is simply the thing this daemon exists to run costs
   * nothing and cannot be missing.
   */
  agentCommands: ['claude'],
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
    // first turn finishes, which is why endSession() exists below. It is
    // called for a STAGE and never for a run: a stage has one turn and nobody
    // to prompt it, and for four months nothing called it at all — which is
    // the deadlock its own comment describes, sitting in the file unnoticed
    // because the only agent any test ever spawned exited by itself.
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
    // R77. Reading the map is how a session finds its way around a repository
    // without a dozen searches, so it is allowed by default like every other
    // read here — asking permission to look at a map cawdev computed itself
    // would be a question with one sensible answer.
    'mcp__cawdev__code_map',
    'mcp__cawdev__file_deps',
    // R302. The SonarQube reading — a read, allowed by default like the map.
    // Through READ_ONLY_CAWDEV this reaches REVIEW and AUDIT as the card
    // asks, and ASK, SCOPE, MERGE, RELEASE and INTERVIEW as well: it is a
    // read and harmless there, and subtracting it from five lists would be
    // five lists to keep in step. PLAN is the one profile that drops it —
    // `beforeTheWorkExists`, below — because the card says so.
    'mcp__cawdev__quality_get',
    'mcp__cawdev__roadmap_statuses',
    'mcp__cawdev__roadmap_list',
    'mcp__cawdev__sprint_list',
    'mcp__cawdev__roadmap_get',
    // The MCP server has served this since R37, its README documents it, and
    // the REVIEW prompt below TELLS a session to file its findings with it —
    // and it was in no allow-list at all, so no run could call it. A non-coding
    // profile is spawned without `--permission-prompt-tool` (argsForProfile
    // drops it on purpose), so there was not even a question to answer: the
    // call was refused outright and the findings died in the transcript.
    'mcp__cawdev__roadmap_comment',
    // R85's board, read. Served and never allowed either, which left an ASK
    // session — whose whole job is answering questions about this project —
    // unable to be asked what is broken in it.
    'mcp__cawdev__issue_list',
    'mcp__cawdev__roadmap_create',
    'mcp__cawdev__roadmap_update',
    'mcp__cawdev__roadmap_set_status',
    'mcp__cawdev__roadmap_decline',
    'mcp__cawdev__changelog_list',
    'mcp__cawdev__changelog_get',
    'mcp__cawdev__changelog_add',
    'mcp__cawdev__changelog_update',
    // R85's other half, and R37's. `issue_file` and `propose_entry` were served
    // and allowed by nobody — the third and fourth time this list has been
    // caught a tool short, after `roadmap_comment` and `issue_list` above. A
    // served tool that no run may call is a tool that does not exist, and the
    // failure is silent: a non-coding profile is spawned without
    // `--permission-prompt-tool`, so the call is refused with no question asked.
    'mcp__cawdev__issue_file',
    'mcp__cawdev__propose_entry',
    // R199. Feedback that is not a card, for a session that noticed something
    // and is not sure it deserves one. A writer, like issue_file: a read-only
    // stage is refused it by shape and not by this list.
    'mcp__cawdev__backlog_file',
    // R368. Ticks one item of the card's Done-when checklist as built. A
    // writer, like the three above: it is not in CAWDEV_READS, so a read-only
    // stage is refused it by shape and not by this list.
    'mcp__cawdev__done_when_tick',
    // R96's rounds. An interview is the one profile that cannot work without
    // these, and they were missing for the same reason as the two above.
    'mcp__cawdev__ask_group',
    'mcp__cawdev__await_group',
    'mcp__cawdev__interview_rounds',
    'mcp__cawdev__await_more_rounds',
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
  /**
   * Whether this machine applies rules set in the CONSOLE — R126.
   *
   * <p>Off, and it has to be. Every other rule the platform sends is filtered
   * through `grantable` above, which is what lets the comment on this file say
   * the platform can narrow what runs here and never widen it. A console rule
   * is the exception: it RAISES the ceiling.
   *
   * <p>So the machine agrees or it does not. Turning this on says: I want to
   * grant permissions from the web page, on this laptop, and I accept that
   * anything able to write to my cawdev can then widen what an unattended agent
   * does in my checkouts. That is a real decision and it is yours, which is
   * exactly the argument `bypassPermissions` gets a few lines above.
   */
  acceptsRulesFromConsole: false,
  pollSeconds: 25,
  heartbeatSeconds: 30,
  /**
   * Whether a run on this machine may drive Claude in Chrome — R61.
   *
   * **Off, and it has to be.** `--chrome` connects the session to the browser
   * extension in the operator's OWN Chrome — their logged-in sessions, their
   * cookies, their mail. That is a different kind of permission from
   * `Bash(mvn *)`, and it must not be reachable by writing a roadmap card in a
   * project this machine happens to serve.
   *
   * This is R51's asymmetry pointed at a browser: the platform records what was
   * asked for, and the machine decides whether it happens. A run that asks and
   * is refused is NOT failed — it runs without the browser and says so on its
   * own transcript, because a capability withheld and a broken run are
   * different things.
   */
  browser: false,
  /**
   * Where a skill's shared, per-repository state lives — R76.
   *
   * Outside every workspace, and that is the whole point. R47 gives each run a
   * checkout of its own and R48 will make those copy-on-write clones, so an
   * index that lived beside the checkout would be re-parsed by every run —
   * exactly the cost the skill exists to remove, paid once per run instead of
   * once per repository.
   */
  skillCache: null,
  /**
   * How long to spend building a skill's index before giving up — R76.
   *
   * Bounded because it happens between claiming a run and spawning it, and an
   * indexer that hangs would otherwise hold a run for ever with nothing said.
   * Giving up is not a failure: the session starts without the index, which is
   * what every session did before this existed.
   */
  skillPrepareSeconds: 300,
  /**
   * How long a session may say NOTHING before the daemon mentions it — R113.
   *
   * Nothing watched for silence before this. A run that stopped producing
   * output at two in the morning was RUNNING until somebody looked at it, and
   * the machine held its workspace the whole time — so the next coding run on
   * that project queued behind a session that was not doing anything.
   *
   * Twenty minutes, and it is a SETTING because the right number is a fact
   * about the repository: one whose test suite takes twelve minutes is not a
   * hung session, and a daemon that cried wolf at ten would be turned off.
   *
   * Zero switches it off, for a machine doing something genuinely long.
   */
  idleSeconds: 1200,
  /**
   * How long a stage gets to leave after its input is closed — see endSession.
   *
   * Generous, because closing stdin is a request and a CLI is entitled to
   * finish flushing before it honours one. Bounded, because the entire point
   * is that the walk cannot be made to wait on something that will not happen:
   * at this a SIGTERM goes to the process group, at twice it a SIGKILL.
   *
   * A setting rather than a constant for two reasons: a slow machine can be
   * given room, and an escalation nobody can trigger in under a minute is an
   * escalation no test will ever cover.
   */
  sessionExitSeconds: 30,
  /**
   * How often to take what a person has asked of a served checkout — R57.
   *
   * Faster than the heartbeat on purpose: these sit behind a button somebody is
   * watching press. Slower than a second, because an idle machine should not
   * spend its day saying "anything for me?".
   */
  workspacePollSeconds: 3,
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
  /**
   * How often to ask the CLI what is left of this machine's usage windows.
   *
   * <p>R73 could not ask at all and reported only refusals. 2.1.263 answers
   * `/usage` non-interactively, so the console can show the windows before a
   * run is refused rather than after.
   *
   * <p><strong>Slow, and the reason is the meter itself.</strong> Asking spawns
   * the CLI, and a meter that spends the thing it measures is a bad meter: at
   * ten minutes this is 144 asks a day against the thousands of requests a
   * working day makes, which is noise. At thirty seconds it would be a line
   * item. Nothing here changes fast enough to be worth more.
   *
   * <p>Zero switches it off, and then the console shows what R73 showed: the
   * last refusal, and nothing between refusals.
   */
  usageSeconds: 600,
};

/** The `--config` path this process was started with, or the default. */
function configPathFromArgv() {
  const index = process.argv.indexOf('--config');
  return index === -1 ? 'runner.config.json' : process.argv[index + 1];
}

async function readConfig() {
  const path = configPathFromArgv();

  let file = {};
  let fromFile = false;
  try {
    file = JSON.parse(await readFile(path, 'utf8'));
    fromFile = true;
  } catch (failure) {
    if (process.argv.includes('--config')) {
      throw new Error(`Could not read ${path}: ${failure.message}`);
    }
    // No config file is fine when everything comes from the environment.
  }

  const url = (process.env.CAWDEV_URL ?? file.url ?? DEFAULTS.url).replace(/\/+$/, '');

  const config = {
    ...DEFAULTS,
    ...file,
    url,
    /**
     * Three places, in the order somebody would expect: what they exported,
     * what the config says, and what this machine minted for itself.
     *
     * The store comes last because it is the one nobody typed — a token in the
     * environment or in the config is somebody having said which credential to
     * use, and preferring ours over theirs would be ignoring it. It comes at
     * all because a config is a file people keep beside their code, and a
     * credential does not belong in one.
     */
    token: process.env.CAWDEV_TOKEN ?? file.token ?? (await loadToken(url)),
    name: process.env.CAWDEV_RUNNER_NAME ?? file.name ?? DEFAULTS.name,
    agentCommands: file.agentCommands ?? (file.agentCommand ? [file.agentCommand] : null) ?? (process.env.CAWDEV_AGENT_COMMAND ? process.env.CAWDEV_AGENT_COMMAND.split(',').map(s => s.trim()) : null) ?? DEFAULTS.agentCommands,
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
    acceptsRulesFromConsole:
      file.acceptsRulesFromConsole ?? DEFAULTS.acceptsRulesFromConsole,
    /** Whether a run here may reach the operator's browser. Per project too. */
    browser: file.browser ?? DEFAULTS.browser,
    /**
     * How many checkouts per project this machine may CLONE by itself when a
     * coding run would otherwise wait for a free one — see auto-workspaces.mjs.
     * Absent is none: an actuator that spends disk and a clone's time is
     * switched on, never on by default.
     */
    autoWorkspaces: autoWorkspacesOf(file.autoWorkspaces),
    /**
     * R339: the memory ceiling each agent session is spawned under, as
     * systemd reads it (`6G`, `75%`) — Linux only, see restart.mjs. Absent is
     * none. Raw here; `main` probes whether this machine can apply it.
     */
    sessionMemoryMax: file.sessionMemoryMax ?? null,
    skillCache: file.skillCache ?? DEFAULTS.skillCache,
    skillPrepareSeconds: file.skillPrepareSeconds ?? DEFAULTS.skillPrepareSeconds,
    idleSeconds: file.idleSeconds ?? DEFAULTS.idleSeconds,
    usageSeconds: file.usageSeconds ?? DEFAULTS.usageSeconds,
    sessionExitSeconds: file.sessionExitSeconds ?? DEFAULTS.sessionExitSeconds,
    /**
     * The FILE this daemon booted from, absolute, or null when everything
     * came from the environment — R288. Published on the control socket so
     * the attached terminal's `c` key edits the config this process is
     * actually running on and not one it guessed at. Absolute because the
     * daemon's cwd is not the terminal's: `cawdev` starts it detached.
     */
    configPath: fromFile ? resolve(path) : null,
    /**
     * The file as it was when this daemon booted — R294. What every later
     * reading is compared against, so the daemon can say which of its
     * settings the file has moved on from and only a restart would apply.
     * The RAW file, not `config`: the question is what the operator changed,
     * and defaults filled in here are not something they wrote.
     */
    bootedFile: fromFile ? file : null,
  };

  if (!config.token) {
    // Reachable by a daemon started directly — `cawdev` mints one before it
    // gets here. So the way out is named, and it is a command rather than a
    // trip to the console with a secret in the clipboard.
    //
    // The other instances are named because of the way this went wrong once: a
    // token minted through the console's origin and filed under it, while the
    // config named the API's, so the store held a perfectly good credential and
    // the daemon reported none. "No token" and "no token *here*" are different
    // problems with different fixes, and only the message can tell them apart.
    const held = await storedUrls();
    const elsewhere = held.filter((each) => each !== config.url);
    throw new Error(
      'No runner token for ' + config.url + '.\n'
        + '  Run `cawdev` on this machine: it signs you in through your browser and mints one\n'
        + '  for the projects this config serves. Nothing is typed and nothing is pasted.'
        + (elsewhere.length
          ? '\n\n  This machine does hold a token for ' + elsewhere.join(', ') + '.\n'
            + '  If that is the same cawdev, point "url" in the config at it — that string is\n'
            + '  what the token is filed under.'
          : ''),
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
 * A project is a path, or a path with permissions of its own, or several
 * checkouts a run can be given one of.
 *
 * All three forms are accepted because most projects only need a path, and a
 * config that forces the long form on everybody to accommodate the one project
 * that runs three sessions at once is a worse config.
 *
 *   "dycrypt": "/Users/you/code/dycrypt"
 *   "dycrypt": { "path": "…", "allowedTools": ["Bash(mvn *)", "mcp__roadmap"] }
 *   "cawdev":  { "workspaces": ["/…/ws-1", "/…/ws-2", "/…/ws-3"] }
 *   "cawdev":  { "workspaces": [...], "quality": { "command": "sonar-scanner", "tokenEnv": "SONAR_TOKEN" } }
 *
 * R300: the fourth form adds a `quality` block — see `qualityBlockOf` — and a
 * project with one has its branches scanned after a coding run's TEST stage.
 * Captured here at boot, not hot-swapped: adding or changing the block needs
 * a restart, and `restartNeededFor` says so.
 *
 * R47: a bare path means ONE workspace, which is what every config meant
 * before workspaces existed. Concurrency for a project is
 * the number of workspaces — R109 removed the machine-wide cap that used to
 * also apply — and a run that waits now waits because there is no free checkout,
 * which is the truth rather than "that project already has a run here" standing
 * in for it.
 */
/** `autoWorkspaces` as a count: a whole number from 0, anything else is 0. */
function autoWorkspacesOf(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * The on-demand checkouts beside each project's first one, joined to its list
 * — at boot, and again on SIGHUP, when one may have been made or dropped by
 * somebody else. A checkout gone from disk leaves the list unless a run holds
 * it; one that appeared joins it. The configured checkouts are never touched.
 */
async function syncAutoWorkspaces(projects, held = new Set()) {
  for (const [slug, project] of Object.entries(projects)) {
    const first = project.workspaces[0];
    const found = await discoverAutoWorkspaces(first);
    const kept = project.workspaces.filter((path) => !isAutoWorkspace(first, path)
      || found.includes(path) || held.has(path));
    const added = found.filter((path) => !kept.includes(path));
    const dropped = project.workspaces.filter((path) => !kept.includes(path));
    project.workspaces = [...kept, ...added];
    for (const path of added) log(`  ${slug}: serving the checkout made on demand at ${path}`);
    for (const path of dropped) log(`  ${slug}: ${path} is gone — no longer serving it`);
  }
}

function normaliseProjects(projects) {
  const normalised = {};
  for (const [slug, value] of Object.entries(projects)) {
    const settings = typeof value === 'string' ? { path: value } : value;
    const workspaces = (settings.workspaces ?? (settings.path ? [settings.path] : []))
      .map((path) => resolve(path));

    if (!workspaces.length) {
      throw new Error(
        `Project "${slug}" has no path and no workspaces. Give it one:\n\n` +
          `  "${slug}": "/Users/you/code/${slug}"\n\n` +
          'or several, for runs that should go at the same time:\n\n' +
          `  "${slug}": { "workspaces": ["/…/ws-1", "/…/ws-2"] }`,
      );
    }
    const duplicated = workspaces.find((path, at) => workspaces.indexOf(path) !== at);
    if (duplicated) {
      // Two names for one directory is two runs in one checkout wearing a
      // disguise, and the gate below would wave both through.
      throw new Error(`Project "${slug}" lists ${duplicated} twice. A workspace is one directory.`);
    }

    normalised[slug] = {
      workspaces,
      // The first, for everything that reads a project rather than a run: the
      // Git tab's survey, the merge check. They want *a* checkout of this
      // project, not the one a particular run is using.
      path: workspaces[0],
      allowedTools: settings.allowedTools ?? [],
      // A ceiling for this project alone, added to the machine's. A laptop
      // that will let one repository run Maven unattended has not said the
      // same about the other three.
      grantable: settings.grantable ?? [],
      // And whether THIS project's runs may reach the browser — R61. Undefined
      // falls through to the machine's answer; `false` here refuses it for one
      // project on a machine that otherwise allows it.
      browser: settings.browser,
      // R300: whether, and how, this project's branches are scanned with
      // SonarQube after TEST. Null is the ordinary case and means never.
      quality: qualityBlockOf(slug, settings.quality),
    };
  }
  return normalised;
}

/**
 * A project's `quality` block, normalised — R300.
 *
 * The scan is opt-in TWICE: here, on the machine, and on the project, which
 * must have a SonarQube key (the claim carries it). A machine with no block
 * never scans and never says so; a machine with one and no scanner on its
 * PATH reports an `error` reading rather than nothing, so the page says the
 * scan could not run instead of showing a branch nobody looked at.
 *
 * `tokenEnv` names the variable this machine holds the scanner token in. The
 * platform never sends one: the project's SonarQube token (R304) is the
 * platform's reader credential and stays there; the scanner's is the
 * operator's and stays here. `url` overrides the platform's `sonarUrl` for
 * a machine that reaches the server by another name (a LAN hostname).
 *
 * `whenBranchesRefused` is what to do on a server that refuses
 * `sonar.branch.name` — Community Edition. The default, `skip`, reports an
 * error saying so; `main` re-runs the scan as the project's MAIN analysis,
 * which overwrites the project's dashboard with this branch's code and so
 * makes the platform's project reading describe whichever branch scanned
 * last; `project` — R316 — analyses the branch as its own scratch SonarQube
 * project instead, `<key>:branch:<branch>-<hash>`, overwritten on each run,
 * with "new" meaning a line the branch changed. Both are an operator's own
 * opt-in — nothing opts in for them — and `project` additionally needs the
 * scanner token to hold *Create Projects* on the server, and for the
 * server's default project visibility to not be public (or this publishes
 * the code).
 */
function qualityBlockOf(slug, block) {
  if (!block) return null;
  const when = block.whenBranchesRefused ?? 'skip';
  if (when !== 'skip' && when !== 'main' && when !== 'project') {
    throw new Error(
      `Project "${slug}": quality.whenBranchesRefused must be "skip", "main" or "project", not "${when}".`);
  }
  return {
    command: block.command ?? 'sonar-scanner',
    tokenEnv: block.tokenEnv ?? 'SONAR_TOKEN',
    url: block.url ?? null,
    whenBranchesRefused: when,
    timeoutSeconds: block.timeoutSeconds ?? 600,
  };
}


/**
 * What THIS daemon knows about a skill, beyond what the platform sent — R76.
 *
 * Data, not branches. The platform's row says what to spawn; this says the two
 * things only the machine can know — what environment the command needs here,
 * and what per-repository state it keeps that ought to be shared between
 * workspaces. Adding a skill that needs neither is not an entry here at all;
 * adding one that does is a key, which is the entry's promise: a row and a
 * config entry rather than a column and an `if`.
 *
 * A key that is absent is not an error. It means "spawn it as sent", which is
 * what most skills will want.
 */
const SKILLS_HERE = {
  codegraph: {
    /**
     * The npm package is a thin shim: the real artifact is a per-platform
     * binary shipped as an `optionalDependency` at the same exact version, and
     * when npm fails to deliver one the shim DOWNLOADS IT FROM GITHUB RELEASES
     * at run time. A pinned version whose contents can still arrive over an
     * unpinned path is not pinned, so that path is off. If the bundle really is
     * missing, the skill fails to start and the session says so — which is the
     * honest outcome of a supply-chain decision somebody made on purpose.
     */
    env: { CODEGRAPH_NO_DOWNLOAD: '1' },
    /**
     * The index it keeps beside the checkout, which is the part that is
     * genuinely cawdev's problem — R47. `CODEGRAPH_DIR` cannot be pointed
     * outside the project: the package's own docs say an override that is
     * absolute or contains a separator is ignored. So the index cannot simply
     * live in the cache and be read from there.
     */
    indexDir: '.codegraph',
    /**
     * How to turn the row's "serve" invocation into a "build" one. The row
     * carries `serve --mcp`, because that is what the CLI spawns; building the
     * graph is a different subcommand of the same pinned command.
     */
    serveArgs: ['serve', '--mcp'],
    buildArgs: ['init', '--yes'],
    /**
     * Files inside the index directory that are about a RUNNING daemon rather
     * than about the graph — and copying them is the one thing that would make
     * a shared index dangerous instead of merely useful.
     *
     * `daemon.pid` names a live process and the socket it is listening on. A
     * second workspace whose index directory contained another workspace's
     * pidfile would connect to THAT daemon, and every answer it gave would be
     * about a different checkout — a silent wrong answer, which is the one
     * failure this tool must never have. So the copy leaves them behind and
     * each run gets its own daemon over its own copy.
     */
    volatile: ['daemon.pid', 'daemon.sock', 'daemon.log'],
  },
};

/**
 * A project this machine serves but its token cannot reach — R173.
 *
 * The config names the projects a machine serves; the token names the
 * projects it may reach; and the two are set at different times. A slug added
 * to the config of a machine whose token was minted for another project gets
 * "No such project" once per poll — the platform's deliberate 404, which does
 * not admit the project exists — and a run queued there waits for ever with
 * nothing saying why. So the token's own account of itself (`whoami`, which is
 * the one thing a token may ask about projects) is compared with the config
 * ONCE, at startup, and the sentence names the way out: change the token's
 * access in the console, which R173 made possible, or mint one that covers it.
 *
 * Said, never acted on. A platform without `whoami` (or a fake one in a test)
 * answers with nothing, and nothing is the honest answer to compare against.
 */
async function sayWhichServedProjectsTheTokenCannotReach(config) {
  const served = Object.keys(config.projects ?? {});
  if (!served.length) return;
  const identity = await api(config, '/api/agent/whoami').catch(() => null);
  const reachable = new Set((identity?.projects ?? []).map((project) => project.slug));
  if (!identity || !Array.isArray(identity.projects)) return;
  for (const slug of served) {
    if (!reachable.has(slug)) {
      log(
        `this machine serves ${slug} but its token cannot reach it — nothing queued there ` +
          `will be claimed. In the console, under Agent tokens, change this token's access ` +
          `to include ${slug}, or mint one that does and put it in the config.`,
      );
    }
  }
}

// --- talking to cawdev -------------------------------------------------------

async function api(config, path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${config.url}${path}`, {
    method,
    headers: {
      // The MACHINE's token by default — `runner:operate`, which is what
      // claiming, reporting and transitioning need.
      //
      // `token` overrides it with the RUN's own, which carries `agent:ask`.
      // That is not a convenience: raising an approval is the run asking a
      // person something, and the credential for that is the one minted for
      // this run and dying with it. A daemon token that could raise approvals
      // could raise them for any run it has ever been offered.
      authorization: `Bearer ${token ?? config.token}`,
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
    const body = parts
      .map((part) => (typeof part === 'string' ? part : String(part)))
      .join(' ');
    // The timestamp is always dim: it is the least interesting thing on the
    // line and it is on every single one of them.
    console.log(`${ink.muted(`[${new Date().toISOString()}]`)} ${tintLog(body, ink)}`);
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
 * A copy of this daemon's own tooling, taken once at startup.
 *
 * The runner spawns the cawdev MCP server from `tools/mcp/server.mjs`, and
 * cawdev is its own first project — so a run working on cawdev checks THAT
 * DIRECTORY out onto another branch. The session is then handed whichever MCP
 * server happened to be on the branch it is working on. That is how a run on a
 * branch cut from `main` got a server with no `approve` tool while holding a
 * `--permission-prompt-tool` flag that named it, and died on its first call.
 *
 * The rule it establishes is worth keeping on its own: **a daemon's tooling is
 * frozen when the daemon starts.** Not because a newer one would be worse, but
 * because a session's lifeline to the platform must not change underneath it
 * when some other run switches a branch. To pick up a new MCP server, restart
 * the daemon — which is when its own code is reloaded too, so the two can no
 * longer disagree about what exists.
 *
 * The real fix is R47, where a run gets a workspace of its own and stops
 * mutating the directory the daemon lives in. This keeps the daemon standing
 * until then.
 */
async function snapshotTools() {
  const here = new URL('.', import.meta.url).pathname;
  const directory = await mkdtemp(join(tmpdir(), 'cawdev-tools-'));

  await mkdir(join(directory, 'mcp'), { recursive: true });
  await mkdir(join(directory, 'lib'), { recursive: true });
  await copyFile(join(here, '../mcp/server.mjs'), join(directory, 'mcp/server.mjs'));

  // Everything the server might import from lib. Copied wholesale rather than
  // by working out its imports: a dependency list kept here is a list that goes
  // stale the first time somebody adds one, and the symptom would be this same
  // failure wearing a different message.
  for (const file of await readdir(join(here, '../lib'))) {
    if (file.endsWith('.mjs') && !file.endsWith('.test.mjs')) {
      await copyFile(join(here, '../lib', file), join(directory, 'lib', file));
    }
  }
  return { directory, serverPath: join(directory, 'mcp/server.mjs') };
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

/**
 * The ceiling this machine declared for itself, flattened for reporting — R126.
 *
 * <p>The machine's own `grantable` plus every project's, which is what the
 * spawn actually assembles. Sent so the console can SHOW it beside what it
 * granted; it is never read back, because the file is the truth.
 */
function declaredCeiling(config) {
  const perProject = Object.entries(config.projects ?? {})
    .flatMap(([slug, settings]) => (settings.grantable ?? []).map((p) => `${slug}: ${p}`));
  return { machine: config.grantable ?? [], projects: perProject };
}

/**
 * What the CONSOLE has granted this machine — R126.
 *
 * <p>Only asked for when this machine says it accepts them. Not asking is the
 * enforcement: a daemon that fetched them and then filtered them would be one
 * config typo away from applying them, and the whole point is that the machine
 * decides.
 *
 * <p>Unreachable means none, like `projectRules` above: the session asks a
 * person instead, which is the safe direction to fail in.
 */
async function machineRules(config) {
  if (config.acceptsRulesFromConsole !== true || !config.runnerId) {
    return { patterns: [], everything: false };
  }
  try {
    const answer = await api(config, `/api/runners/${config.runnerId}/tool-rules`);
    return {
      patterns: (answer?.rules ?? []).map((rule) => rule.pattern).filter(Boolean),
      everything: answer?.allowsEverything === true,
    };
  } catch (failure) {
    log(`  could not read this machine's rules (${failure.message}); the session will ask`);
    return { patterns: [], everything: false };
  }
}

/**
 * What is left of this machine's usage windows, as the CLI reports them.
 *
 * <p>`claude -p "/usage"` and nothing cleverer. There is no API for this and no
 * file to read; the CLI is the only thing that knows, and it will answer a
 * program now where R73 found it would only answer a person.
 *
 * <p><strong>Never fatal, and never a guess.</strong> A CLI that has changed
 * its output, or is logged out, or is not this vendor's at all, yields nothing
 * — and nothing means the console keeps showing the last reading it had rather
 * than a zero somebody would act on. That is R20's rule and it is the whole
 * reason `parseUsage` is tolerant in one direction only.
 */
async function readUsage(config) {
  if (!config.usageSeconds || !config.runnerId) {
    return;
  }
  
  const allWindows = [];
  
  for (const agentCommand of config.agentCommands) {
    // Codex has no `-p /usage`: its `-p` is a PROFILE, and the bare command is
    // an interactive terminal. It reports no windows rather than a guess.
    if (agentOfCommand(agentCommand) === 'codex') {
      continue;
    }
    const said = await new Promise((resolve) => {
      let out = '';
      const child = spawn(agentCommand, ['-p', '/usage', '--output-format', 'text'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Bounded, because this runs on a timer for the life of the daemon: a CLI
      // that hangs here must not accumulate a process per tick.
      const giveUp = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch { /* already gone */ }
        resolve('');
      }, 60_000);
      giveUp.unref?.();
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (out += chunk));
      child.on('error', () => {
        clearTimeout(giveUp);
        resolve('');
      });
      child.on('close', () => {
        clearTimeout(giveUp);
        resolve(out);
      });
    });

    const windows = parseUsage(said);
    for (const each of windows) {
      allWindows.push({
        provider: agentOfCommand(agentCommand),
        window: each.kind,
        model: each.model,
        percentUsed: each.percent,
        // The counts stay null. The CLI gives a percentage and no totals, and
        // inventing `used: 25, limit: 100` would put units on a page that the
        // provider never stated — R20's rule, one level down.
        used: null,
        limit: null,
        resetsAt: each.resetsAt ? each.resetsAt.toISOString() : null,
      });
    }
  }

  if (!allWindows.length) {
    return;
  }
  await api(config, `/api/runners/${config.runnerId}/limits`, {
    method: 'POST',
    body: allWindows,
  }).catch((failure) => log(`  could not report usage: ${failure.message}`));
}

// --- skills (R76) ------------------------------------------------------------


/**
 * Which repositories this machine has a skill index for — R77.
 *
 * <p>The console cannot see these machines, so "is there a map of this project
 * yet" is only answerable by the daemon saying so. It rides on the heartbeat
 * beside `workingCopies`, for the reason that one does: it is the same
 * statement — here is this machine as it stands — and a second timer would only
 * let the two halves disagree.
 *
 * <p>Read off the cache rather than remembered in memory: a restarted daemon
 * must not report "no map" for a repository it indexed an hour ago, and the
 * stamp on disk is the only thing that outlives the process.
 */
async function surveySkillIndexes(config) {
  const found = [];
  for (const [slug, project] of Object.entries(config.projects)) {
    for (const key of Object.keys(SKILLS_HERE)) {
      const cache = skillCacheFor(config, { key }, slug);
      const stamp = await readJson(join(cache, 'index.json'));
      if (!stamp) {
        continue;
      }
      found.push({
        project: slug,
        skill: key,
        // What it was built from, so the console can say "indexed at abc1234"
        // rather than a bare tick — a map of a commit from last week is a map,
        // but not of what is there now.
        commit: stamp.commit ?? null,
        builtAt: stamp.builtAt ?? null,
        workspaces: project.workspaces.length,
      });
    }
  }
  return found;
}

/**
 * Runs one of a skill's own commands, and never lets it take the daemon down.
 *
 * Its own helper rather than `git`'s: this spawns a third-party binary that may
 * take minutes, so it is bounded, and a failure comes back as a string rather
 * than a rejection because nothing it can do is worth failing a run over. The
 * session runs without the skill, which is what every session did before R76.
 */
function runSkillCommand(command, args, { cwd, env, timeoutMs }) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (failure) {
      return done({ ok: false, said: failure.message });
    }
    let out = '';
    let err = '';
    let timer = setTimeout(() => {
      // The whole tree: an indexer spawns workers, and killing the parent alone
      // leaves them chewing through somebody's laptop after we stopped waiting.
      child.kill('SIGKILL');
      timer = null;
      done({ ok: false, said: `gave up after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', (failure) => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      done({ ok: false, said: failure.message });
    });
    child.on('close', (code) => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      done(code === 0
        ? { ok: true, said: out.trim() }
        : { ok: false, said: err.trim() || out.trim() || `exit ${code}` });
    });
  });
}

/** Whether a path exists, as a boolean rather than an exception. */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a skill's shared per-repository state lives on this machine.
 *
 * Keyed by project rather than by workspace, which is the point: R47 gives each
 * run a checkout of its own and R48 will make those clones, so anything keyed
 * by checkout is rebuilt per run.
 */
function skillCacheFor(config, skill, slug) {
  const root = config.skillCache
    ?? join(process.env.HOME ?? tmpdir(), '.cawdev', 'skills');
  return join(root, skill.key, slug);
}

/**
 * Gives a workspace a skill's index without parsing the repository again — R76.
 *
 * The shape of this is forced by two facts about CodeGraph, both read out of the
 * package rather than assumed:
 *
 *   - the index directory **cannot** be pointed outside the checkout —
 *     `CODEGRAPH_DIR` is a single path segment and an absolute one is ignored;
 *   - the daemon's pidfile and socket live INSIDE that directory, one per
 *     project root.
 *
 * So the obvious move — every workspace symlinking `.codegraph` at one shared
 * directory — is not untidy, it is wrong: the second workspace's server finds
 * the first's live daemon in the pidfile and answers questions about the FIRST
 * workspace's tree. A silent wrong answer, which is the one failure a pre-built
 * index must never have.
 *
 * What is shared is therefore the *build*, not the live index. The cache holds
 * one index per repository, stamped with the commit it was built at; a run
 * copies it in, minus anything about a running daemon, and the skill's own
 * incremental sync brings it forward from that commit. Two runs on one
 * repository parse it once, and each still has its own daemon over its own copy.
 *
 * Nothing here can fail a run. Every path returns a sentence for the transcript
 * instead.
 */
async function prepareSkillIndex(config, skill, local, forProject, cwd, baseCommit) {
  const inWorkspace = join(cwd, local.indexDir);
  // `forProject` is anything carrying a projectSlug — a claimed run on the way
  // in, or R77's INDEX request asked on its own. The index is keyed to the
  // repository, so which of them wanted it makes no difference to what is
  // built, and the parameter says so rather than being called `run`.
  const cache = skillCacheFor(config, skill, forProject.projectSlug);
  const kept = join(cache, 'index');
  const stampPath = join(cache, 'index.json');

  // The index is untracked work in somebody's checkout, and two things would
  // otherwise trip over it: `git status --porcelain`, which is how R46 decides a
  // tree is dirty and would refuse the NEXT run in this workspace, and R47's
  // `git clean -fd` between runs, which would delete it. `.git/info/exclude` is
  // the right place for both — it is per-checkout and local to this machine, so
  // it does not ask the project to carry a machine's `.gitignore` line.
  await excludeLocally(cwd, local.indexDir);

  if (await exists(inWorkspace)) {
    // This workspace already has one. Left alone: it is newer than anything in
    // the cache by construction, and the skill syncs it itself.
    return `${skill.name}: this checkout already has an index; it will be brought up to date `
      + 'by the skill rather than rebuilt.';
  }

  const fromCache = await takeCachedIndex(kept, stampPath, inWorkspace, local, baseCommit);
  if (fromCache) {
    return `${skill.name}: ${fromCache}`;
  }

  // Nothing to reuse. Build it once, here, and leave it in the cache so the
  // next run in any workspace of this repository gets it for nothing.
  const lock = join(cache, 'building.lock');
  if (!(await claimLock(cache, lock, config.skillPrepareSeconds * 1000))) {
    // Somebody else got here first. **Wait for them rather than giving up**,
    // which is the difference between "not parsed twice" and the thing the
    // entry actually asked for — two runs *sharing* one index. R47 starts
    // several runs on one repository within milliseconds of each other, so
    // this is the ordinary case and not the rare one: both check an empty
    // cache, one wins the lock, and the loser is the run that would otherwise
    // spend the whole session without the capability it was given.
    const shared = await waitForIndex(kept, lock, stampPath, inWorkspace, local,
        config.skillPrepareSeconds * 1000);
    if (shared) {
      return `${skill.name}: ${shared}`;
    }
    return `${skill.name}: another run on this machine is building this repository's index and `
      + 'it did not finish in time. This session starts without it and its own tools still work.';
  }

  // **Read the cache again, now that we hold the lock.** The check above and
  // this one are not the same check: R47 starts several runs on one repository
  // within milliseconds, so the ordinary sequence is both reading an empty
  // cache, one building and releasing, and the other then finding the lock free
  // and building the very thing that is now sitting there. Losing the lock is
  // the case people think of; this is the case that actually happened, and the
  // one the entry's last "done when" is about.
  const nowCached = await takeCachedIndex(kept, stampPath, inWorkspace, local, baseCommit);
  if (nowCached) {
    await rm(lock, { force: true });
    return `${skill.name}: ${nowCached}`;
  }

  // **The lock is held until the cache is populated, not until the build ends.**
  // Releasing it between those two was the bug: a waiter saw the lock vanish,
  // looked in the cache, found nothing yet, and built the very index the other
  // run was about to deposit. `finally`, so a throw in the deposit cannot leave
  // the lock behind for `claimLock`'s staleness rule to clear five minutes later.
  const started = Date.now();
  try {
    const built = await runSkillCommand(skill.command, buildArgsFor(skill, local), {
      cwd,
      env: { ...process.env, ...(local.env ?? {}) },
      timeoutMs: config.skillPrepareSeconds * 1000,
    });

    if (!built.ok) {
      return `${skill.name}: could not build this repository's index (${built.said}). The session `
        + 'is running without it — nothing else about the run is affected.';
    }

    const seconds = Math.round((Date.now() - started) / 1000);
    const deposited = await copyIndex(inWorkspace, kept, local.volatile);
    if (deposited.ok) {
      await writeFile(stampPath, JSON.stringify({
        commit: baseCommit ?? null,
        version: skill.version,
        builtAt: new Date().toISOString(),
        builtFrom: cwd,
      }, null, 2)).catch(() => { });
    } else {
      log(`  built the ${skill.key} index but could not keep it: ${deposited.said}`);
    }
    return `${skill.name}: built this repository's index in ${seconds}s and kept it outside the `
      + 'workspace, so the next run here does not parse it again.';
  } finally {
    await rm(lock, { force: true }).catch(() => { });
  }
}

/** The row's `serve --mcp` invocation, turned into the one that builds. */
function buildArgsFor(skill, local) {
  const serve = new Set(local.serveArgs ?? []);
  return [...(skill.args ?? []).filter((arg) => !serve.has(arg)), ...(local.buildArgs ?? [])];
}

/**
 * Copies an index directory, leaving behind anything about a running daemon.
 *
 * The exclusion is the whole reason this is not `cp -R`. See
 * `SKILLS_HERE.codegraph.volatile`: a copied pidfile points at another
 * workspace's daemon, and everything that daemon says is about another
 * workspace's files.
 */
async function copyIndex(from, to, volatile = []) {
  try {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (volatile.includes(entry.name)) continue;
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      if (entry.isDirectory()) {
        const nested = await copyIndex(source, target, volatile);
        if (!nested.ok) return nested;
      } else if (entry.isFile()) {
        await copyFile(source, target);
      }
      // Symlinks and sockets are skipped: neither is part of a graph, and
      // following one out of the cache is how a copy reaches somewhere nobody
      // meant it to.
    }
    return { ok: true };
  } catch (failure) {
    return { ok: false, said: failure.message };
  }
}

/**
 * One builder at a time per repository, without a queue.
 *
 * Two runs claimed in the same second would otherwise both parse the whole
 * project — the exact cost this exists to remove, paid twice. The loser does not
 * wait: waiting would hold a session for minutes on something it can work
 * without, so it starts without the index and says so.
 *
 * A stale lock is taken over rather than respected for ever, because the honest
 * reading of one older than the whole timeout is "a daemon died mid-build".
 */
async function claimLock(directory, lock, staleAfterMs) {
  await mkdir(directory, { recursive: true }).catch(() => { });
  try {
    await writeFile(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
    return true;
  } catch (failure) {
    if (failure.code !== 'EEXIST') return false;
    // Somebody holds it. Steal it ONLY on proof that it is old.
    //
    // The first version read the timestamp out of the file and stole the lock
    // whenever it could not parse one — and an unparseable read is exactly what
    // the loser of a close race gets, because the winner's `wx` create is
    // visible before its contents are. Two runs claiming one repository's index
    // within a millisecond of each other therefore BOTH won, which is the
    // ordinary case under R47 rather than a rare one.
    //
    // So: unsure means held, the same direction `tool-rules.mjs` fails in. The
    // file's own mtime is the fallback, because a lock whose contents we cannot
    // read still has a real age and a crashed run must not hold this forever.
    const held = await readFile(lock, 'utf8').catch(() => '');
    const said = Date.parse(held.split(' ')[1] ?? '');
    const at = Number.isFinite(said)
      ? said
      : await stat(lock).then((it) => it.mtimeMs).catch(() => Date.now());
    if (Date.now() - at < staleAfterMs) {
      return false;
    }
    await rm(lock, { force: true });
    return writeFile(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' })
      .then(() => true)
      .catch(() => false);
  }
}

/**
 * Copies a cached index into this workspace, or says there was nothing to take.
 *
 * <p>One function because it is asked three times and the answers must agree:
 * before the build lock, again after winning it, and by `waitForIndex` after
 * losing it. A cache we cannot copy is a cache, not a verdict — the caller
 * falls through and builds.
 */
async function takeCachedIndex(kept, stampPath, inWorkspace, local, baseCommit) {
  const stamp = await readJson(stampPath);
  if (!(await exists(join(kept, 'codegraph.db'))) && !(stamp && await exists(kept))) {
    return null;
  }
  const copied = await copyIndex(kept, inWorkspace, local.volatile);
  if (!copied.ok) {
    log(`  could not reuse a cached index: ${copied.said}`);
    return null;
  }
  const at = stamp?.commit ? `built at ${short(stamp.commit)}` : 'built earlier';
  const since = baseCommit && stamp?.commit && stamp.commit !== baseCommit
    ? ', and the skill will re-parse what has changed since'
    : '';
  return `reusing this repository's index, ${at}${since}. Nothing was parsed again for this run.`;
}

/**
 * Waits for whoever holds the build lock, then takes what they built.
 *
 * <p>Polling a lock file rather than anything cleverer, because the thing being
 * waited on is a sibling process on this machine and the wait is bounded by the
 * same timeout the build itself gets. A build that dies without releasing the
 * lock is covered by `claimLock`'s staleness rule on the next run rather than
 * by anything here.
 *
 * Returns the sentence for the transcript, or null if the wait ran out — the
 * caller says the other half. Never throws: a skill that cannot be prepared is
 * a session without a capability, not a failed run.
 */
async function waitForIndex(kept, lock, stampPath, inWorkspace, local, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(200);
    if (await exists(lock)) {
      continue;
    }
    // The lock is gone. Either they finished or they died; the cache says which.
    return takeCachedIndex(kept, stampPath, inWorkspace, local, null);
  }
  return null;
}

/** A line in this checkout's own ignore list, written once. */
async function excludeLocally(cwd, entry) {
  const path = join(cwd, '.git', 'info', 'exclude');
  try {
    const current = await readFile(path, 'utf8').catch(() => '');
    if (current.split('\n').some((line) => line.trim() === `/${entry}/`)) {
      return;
    }
    await mkdir(join(cwd, '.git', 'info'), { recursive: true });
    await writeFile(path, `${current}${current.endsWith('\n') || !current ? '' : '\n'}`
      + `# cawdev R76: a skill's index, kept out of this checkout's status\n/${entry}/\n`);
  } catch (failure) {
    // A worktree, a bare repository, a read-only .git — none of it is worth
    // failing over. The consequence is a dirty-looking checkout, which the
    // person starting the next run is shown and can decide about.
    log(`  could not add ${entry} to this checkout's local excludes: ${failure.message}`);
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Which skills this session actually gets, and what to say about the rest.
 *
 * Both halves always, which is R61's rule: what was attached is said out loud
 * because the first call will still stop and ask, and what was refused is said
 * out loud because "I clicked allow and nothing happened" needs an answer where
 * the person is looking. Neither is a failure.
 */
async function resolveSkills(config, run, cwd, baseCommit, asked) {
  if (!Array.isArray(asked) || !asked.length) {
    return { attached: [], notes: [] };
  }
  // A profile that writes no code is offered nothing by the platform, and this
  // says the same thing again on the machine — for the reason the ceiling is
  // enforced in two places: a claim from an older platform has never been
  // through the check at all. R96: the test is what it may WRITE, not whether
  // it took a checkout, so an interview is offered nothing either.
  if (!writesAnythingProfile(run)) {
    return { attached: [], notes: [] };
  }

  const attached = [];
  const notes = [];

  for (const skill of asked) {
    if (!skill?.key || !skill?.command || !Array.isArray(skill.args)) {
      notes.push(`A skill arrived that this daemon cannot read (${JSON.stringify(skill)}). `
        + 'It has not been attached.');
      continue;
    }
    // What the platform claims to be running, against what it actually sends.
    // Two facts, and a disagreement between them is worth saying out loud
    // rather than resolving quietly in favour of whichever was read second.
    if (skill.version && !skill.args.some((arg) => String(arg).includes(skill.version))) {
      notes.push(`${skill.name ?? skill.key} says it is pinned to ${skill.version}, and the `
        + 'command it sent does not name that version. Running what was sent, and somebody '
        + 'should look at the skill row.');
    }

    const local = SKILLS_HERE[skill.key] ?? {};
    if (local.indexDir) {
      notes.push(await prepareSkillIndex(config, skill, local, run, cwd, baseCommit));
    }
    attached.push({ skill, local });
    // R303. A required server says so where the person is looking, as the
    // expert line does. Whether a STAGE is actually asked for it is decided at
    // spawn — a read-only stage cannot call it and is not nudged for it.
    const must = skill.mode === 'REQUIRED'
      ? ' This project REQUIRES it: if a stage finishes without calling one of its tools, the '
        + 'session will be told.'
      : '';
    notes.push(`${skill.name ?? skill.key} is available to this session as `
      + `${skill.toolPrefix ?? `mcp__${skill.serverName}`}. The first call still asks a person — `
      + `allow ${skill.toolPrefix ?? `mcp__${skill.serverName}`} for the session to cover the `
      + `rest.${must}`);
  }
  return { attached, notes };
}

// --- git ---------------------------------------------------------------------

/**
 * Runs git and returns what it said.
 *
 * **Resolved on `close`, never on `exit`.** Node emits `exit` when the child
 * ends and `close` when its stdio has also been drained, and those are not the
 * same moment. Waiting on `exit` returns whatever happened to have arrived —
 * usually everything, which is why it looks correct for years.
 *
 * It is not correct. On a loaded Linux runner this returned an EMPTY string
 * for `git branch --list <branch>` in a repository that had the branch, so
 * `prepareWorkingCopy` took the "create it" path and failed the run with
 * "a branch named 'r57-work' already exists" — a contradiction inside one log
 * line. The same run logged `git fetch --prune origin failed:` with nothing
 * after the colon, which is the same loss showing through the error path.
 *
 * It does not reproduce on macOS at any output size, so this is not something
 * a local run will ever warn about. Do not put `exit` back.
 */
function git(cwd, args, { timeoutMs = 0 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolvePromise(out.trim())
        // Naming the code when there is nothing else to say. A bare "failed: "
        // is how the above hid for as long as it did.
        : reject(new Error(`git ${args.join(' ')} failed: ${
            err.trim() || out.trim() || `exit ${code}, and it said nothing`}`)),
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
/**
 * Clears what the last session left lying about — R47.
 *
 * `git clean -fd`, and deliberately WITHOUT `-x`: ignored files stay, which is
 * `.env`, `node_modules` and `target`. Nothing reinstalls those, and a
 * workspace that loses them every run is a workspace where every run begins
 * with a cold build.
 *
 * <strong>A workspace belongs to the daemon, not to you.</strong> This deletes
 * untracked files, so a directory listed as a workspace must not be one
 * somebody works in by hand. It is skipped entirely when the run was started
 * on top of uncommitted work, because there the untracked files are the point.
 */
async function resetWorkspace(path) {
  const leftovers = await git(path, ['clean', '-nd']).catch(() => '');
  if (!leftovers) {
    return;
  }
  // Said out loud, always. Deleting somebody's files quietly is how a tool
  // stops being trusted, even when it was right to delete them.
  log(`  clearing what a previous session left in ${path}:\n${indent(leftovers)}`);
  await git(path, ['clean', '-fd']).catch((failure) => {
    log(`  could not clear it: ${failure.message.split('\n')[0]}`);
  });
}

/**
 * Switches branch and brings the uncommitted work with it — R57.
 *
 * `git checkout` refuses when a local change would be overwritten, which is
 * what R46's *Start anyway* ran into: the flag travelled, the runner accepted
 * it, and then git said "Please commit your changes or stash them", one step
 * later than the refusal the whole feature existed to remove.
 *
 * Both paths need it, not only the existing-branch one. `checkout -b` off
 * `origin/main` fails identically when the edit conflicts with what is there;
 * it had simply not been hit yet, because a fresh branch usually starts from
 * something close to where the checkout already was.
 *
 * Stash and pop rather than `checkout -m`: a three-way merge would leave
 * conflict markers in somebody's uncommitted work and call it success. If the
 * pop cannot apply, this fails **naming the stash** — work parked in a stash
 * nobody was told about is work lost, and that is a worse outcome than the
 * refusal this replaced.
 */
async function checkoutCarrying(path, checkoutArgs, dirty) {
  if (!dirty) {
    await git(path, checkoutArgs);
    return;
  }

  const label = `cawdev: carried across ${checkoutArgs[checkoutArgs.length - 1]}`;
  await git(path, ['stash', 'push', '--include-untracked', '-m', label]);

  // Whether anything was actually parked. `stash push` exits 0 having done
  // nothing when there is nothing to park, and popping then takes somebody
  // else's older stash — which is the one bug in here that would be silent.
  const parked = (await git(path, ['stash', 'list', '--format=%gs', '-1']).catch(() => ''))
    .includes(label);

  try {
    await git(path, checkoutArgs);
  } catch (failure) {
    // Put it back where it was: the checkout is what failed, and leaving the
    // tree emptied as well would turn one problem into two.
    if (parked) await git(path, ['stash', 'pop']).catch(() => {});
    throw failure;
  }

  if (!parked) {
    return;
  }
  try {
    await git(path, ['stash', 'pop']);
  } catch (failure) {
    throw new Error(
      `${failure.message}\n\nThe uncommitted work is safe, in the stash as "${label}". ` +
        `Recover it with: git -C ${path} stash pop`,
    );
  }
}

/**
 * Parks a cancelled run's uncommitted work — R217.
 *
 * Called from the child's close handler and nowhere else: the one moment the
 * daemon knows the agent is dead and nothing else is about to be spawned for
 * this run. A stash taken a second earlier parks half a change. Never throws —
 * the run is already over, and a stash that could not be taken is a sentence
 * on the transcript, not a second failure.
 *
 * The same "did it actually park anything" check as `checkoutCarrying`:
 * `stash push` exits 0 having done nothing, and a transcript that named a
 * stash which is not on the list would send somebody popping a stranger's.
 */
async function stashAfterCancel(config, run, cwd) {
  const say = (body) =>
    api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/output`, {
      method: 'POST',
      body: { lines: [{ kind: 'SYSTEM', body }] },
    }).catch((failure) => log(`  could not record the stash: ${failure.message}`));

  const dirty = await git(cwd, ['status', '--porcelain']).catch(() => '');
  if (!dirty) {
    await say(`Nothing was uncommitted in ${cwd} when the agent stopped; there was nothing to stash.`);
    return;
  }
  const label = `cawdev: stashed when ${run.label ?? run.branch ?? run.id.slice(0, 8)} was cancelled`;
  try {
    await git(cwd, ['stash', 'push', '--include-untracked', '-m', label]);
    const parked = (await git(cwd, ['stash', 'list', '--format=%gs', '-1']).catch(() => ''))
      .includes(label);
    if (!parked) throw new Error('git stash push reported success but the stash is not on the list');
    const files = dirty.split('\n').filter(Boolean).length;
    log(`  stashed ${files} file(s) in ${cwd}, as asked when the run was cancelled`);
    await say(
      `Stashed ${files} uncommitted file(s) in ${cwd} as "${label}".\n` +
        `Recover it with: git -C ${cwd} stash pop`,
    );
  } catch (failure) {
    await say(
      `Could not stash the uncommitted work in ${cwd}: ${failure.message.split('\n')[0]}. ` +
        'The changes are still there.',
    );
  }
}

/**
 * Puts the checkout on the run's branch, cutting it if it is new.
 *
 * `baseBranch` is R260's: a sprint's branch, when the claim carried one. It
 * is what a NEW branch is cut from, and it has to be on origin — a base that
 * does not resolve is a throw, not the local fallback the default gets, because
 * a card cut from `main` under a sprint-branch name is a card whose pull
 * request will target the wrong place with nothing saying so. With no
 * `baseBranch` every path here is byte for byte what it was before R260.
 */
/** Read-only copies in use: path → how many sessions are reading in it. */
const reading = new Map();

/**
 * Where a session with no branch reads the code — a plan, a verify, an ask.
 *
 * It takes no checkout (R70), so it used to run in the project's FIRST
 * checkout as that checkout happened to be: on whatever branch the last run
 * left there, however old — a cancelled CTO Interview left `cto-interview`
 * checked out two hundred commits behind, and every plan after it read that
 * code. Moving that checkout is not the answer: a coding run may be working
 * in it this minute. So a session with no branch reads a copy of its own:
 * `<first checkout>-read`, a DETACHED worktree of it — sharing its objects,
 * touching neither its branch nor its tree — brought to origin's default
 * branch whenever nobody is reading in it. One per project rather than one
 * per run, because the CLI keys a resumable conversation on its directory
 * (R69) and an ASK carried on in a different folder would start over.
 * Detached, because `resetToOrigin` checks the default branch out in the
 * checkout and git refuses a branch checked out twice. Anything failing here
 * leaves the session where it always ran, and says why.
 */
async function readingCopy(source, defaultBranch) {
  const main = defaultBranch || 'main';
  const tip = `origin/${main}`;
  const read = `${source.replace(/\/+$/, '')}-read`;
  const inUse = reading.get(read) ?? 0;
  try {
    const there = await access(join(read, '.git')).then(() => true, () => false);
    await git(source, ['fetch', '--quiet', 'origin', main]).catch(() => undefined);
    if (!there) {
      await git(source, ['worktree', 'prune']).catch(() => undefined);
      await git(source, ['worktree', 'add', '--quiet', '--detach', read, tip]);
    } else if (!inUse) {
      await git(read, ['checkout', '--quiet', '--force', '--detach', tip]);
    }
    reading.set(read, inUse + 1);
    const at = (await git(read, ['rev-parse', '--short', 'HEAD'])).trim();
    return {
      path: read,
      said: inUse
        ? `reading ${read} at ${at} — another session is reading there, so it was not moved`
        : `reading ${tip} at ${at}, in ${read}`,
      release: () => reading.set(read, Math.max(0, (reading.get(read) ?? 1) - 1)),
    };
  } catch (failure) {
    return {
      path: source,
      said: `reading ${source} as it is — no reading copy: ${failure.message.split('\n')[0]}`,
      release: () => undefined,
    };
  }
}

async function prepareWorkingCopy(path, branch, defaultBranch, allowDirty, baseBranch = null) {
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

  const base = baseBranch || defaultBranch || 'main';
  const exists = await git(path, ['branch', '--list', branch]);
  if (exists) {
    await checkoutCarrying(path, ['checkout', branch], dirty);
    // R212 — a branch can now return to a checkout it left. Its last run here
    // may have been followed by runs elsewhere that pushed, so the local ref
    // is stale: strictly behind origin is brought up, and anything else — a
    // commit origin does not have — is exactly the case the pin protects and
    // is not touched. Skipped on a dirty carry, because a merge over
    // uncommitted changes can refuse half-way through and leave the tree in
    // a state the person did not put it in.
    if (!dirty) {
      const remoteRef = `origin/${branch}`;
      const onOrigin = await git(path, ['rev-parse', '--verify', '--quiet', remoteRef])
        .then(() => true)
        .catch(() => false);
      if (onOrigin) {
        await git(path, ['merge', '--ff-only', remoteRef])
          .then(() => log(`  ${branch} fast-forwarded to ${remoteRef}`))
          .catch(() => log(`  ${branch} has commits origin does not — kept as it is`));
      }
    }
  } else {
    // This checkout has never held the branch — but the branch itself may
    // already be on the remote, pushed by a run on one of the project's OTHER
    // checkouts (R47). `applyHandoff` makes the same check for the same
    // reason: cutting a fresh branch from the default branch here would give
    // it a history the remote's copy cannot fast-forward to, and every push
    // this checkout makes afterwards — not just this run's — would be
    // rejected as non-fast-forward. Seen live on `MERGE`: a clean `git merge`
    // needs no session and reports success, and the branch never reaches the
    // remote at all, silently, on whichever of the project's checkouts happens
    // not to have seen this branch before.
    const remoteRef = `origin/${branch}`;
    const onOrigin = await git(path, ['rev-parse', '--verify', '--quiet', remoteRef])
      .then(() => true)
      .catch(() => false);
    if (onOrigin) {
      await checkoutCarrying(path, ['checkout', '-b', branch, remoteRef], dirty);
      log(`  ${branch} was not here — checked out from ${remoteRef}`);
    } else {
      // Branch off the *remote* default when there is one, so the agent starts
      // from what everyone else has, not from whatever this checkout was left on.
      const startPoint = await git(path, ['rev-parse', '--verify', `origin/${base}`])
        .then(() => `origin/${base}`)
        .catch(() => {
          // R260. The local fallback exists for no-remote experiments and
          // stays for the default; a sprint's branch has no such excuse.
          if (baseBranch) {
            throw new Error(
              `${baseBranch} is not on origin, so ${branch} cannot be cut from it. ` +
                "The sprint's branch has to be cut before its cards are started.",
            );
          }
          return base;
        });
      await checkoutCarrying(path, ['checkout', '-b', branch, startPoint], dirty);
    }
  }

  // HEAD *now* is the base: "what did this run produce" means what it added,
  // not everything on the branch. A resumed branch already carries a previous
  // run's commits, and attributing those to this one would be a lie.
  return {
    branch: await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    base: await git(path, ['rev-parse', 'HEAD']).catch(() => null),
  };
}

/**
 * Merges the default branch into this branch, before anything is spawned — R155.
 *
 * `prepareWorkingCopy`'s sibling, and it runs straight after it. This is the
 * load-bearing part of the whole feature and the reason a merge session can be
 * narrowed at all: **the daemon does the `git merge` itself.** After it, `git
 * diff --name-only --diff-filter=U` is the conflicted set, and that set is the
 * session's entire write scope. A session cannot edit a file git did not put a
 * conflict marker in, so "it resolves the conflict and nothing else" is a
 * permission rather than a hope.
 *
 * **A merge commit, never a rebase.** R134 lands with `--squash`, so the extra
 * commit is collapsed away and never appears on the default branch; a
 * force-push would detach the review comments on a pull request somebody has
 * already approved, and branch protection can refuse it outright. And the
 * resolution stays readable: a merge commit is a diff on the pull request that
 * anybody can open and check, where a rebase smears it into rewritten commits
 * that cannot be diffed. The card's own condition is that a merge nobody can
 * read afterwards is too frightening to turn on.
 *
 * A clean merge is reported and NOT a failure. It is what happens whenever the
 * action was offered on a `gh pr merge` failure that was not really a conflict
 * — an older runner that did not say why — and it is the property that makes
 * being wrong there cost a fetch rather than a model.
 */
async function prepareMerge(cwd, branch, defaultBranch) {
  const base = defaultBranch || 'main';
  await git(cwd, ['fetch', '--prune', 'origin']).catch((failure) => {
    log(`  fetch skipped: ${failure.message.split('\n')[0]}`);
  });

  // `origin/<base>` or, in a checkout with no remote, the local branch. The
  // same fallback `prepareWorkingCopy` makes, for the same reason: a repository
  // with no remote is legitimate for local experiments.
  const into = await git(cwd, ['rev-parse', '--verify', `origin/${base}`])
    .then(() => `origin/${base}`)
    .catch(() => base);

  let clean = true;
  try {
    await git(cwd, ['merge', '--no-edit', into]);
  } catch (failure) {
    clean = false;
    log(`  ${into} did not merge cleanly: ${failure.message.split('\n')[0]}`);
  }

  // Asked even on the clean path. `git merge` can exit non-zero for reasons
  // that are not conflicts at all — an unrelated history, a hook — and a run
  // spawned with an EMPTY write scope on the strength of a non-zero exit would
  // be a session that can do nothing and cannot say why.
  const conflicted = await git(cwd, ['diff', '--name-only', '--diff-filter=U'])
    .then((said) => said.split('\n').map((line) => line.trim()).filter(Boolean))
    .catch(() => []);

  if (!clean && !conflicted.length) {
    // Nothing to resolve and the merge did not go through. Left for the run's
    // own failure path to report — inventing a resolution scope here would be
    // spawning a session to fix something it has no tool for.
    throw new Error(
      `${into} could not be merged into ${branch}, and git reported no conflicted files. `
      + 'This is not something a session can resolve; look at the checkout by hand.');
  }

  return {
    clean: clean && !conflicted.length,
    conflicted,
    into,
    head: await git(cwd, ['rev-parse', 'HEAD']).catch(() => null),
  };
}

/**
 * What the session left behind — R155, and it is judged strictly.
 *
 * `pushed` is false unless the tree has no conflict markers left AND the push
 * succeeded. A session that gave up is a FINISHED run with an unresolved tree,
 * and giving up is what the prompt asks for when the right side is not
 * knowable; reporting it as success would land conflict markers, which is the
 * one way this feature could do real damage.
 */
async function finishMerge(cwd, branch) {
  const stillConflicted = await git(cwd, ['diff', '--name-only', '--diff-filter=U'])
    .then((said) => said.split('\n').map((line) => line.trim()).filter(Boolean))
    .catch(() => []);
  if (stillConflicted.length) {
    log(`  the tree still has conflict markers in ${stillConflicted.length} file(s)`);
    return { pushed: false, mergeCommit: null, files: stillConflicted };
  }

  // Anything left staged or unstaged is the resolution not committed. Committed
  // here rather than refused: the session was told to commit, and a resolution
  // that exists on disk and not in a commit is work about to be thrown away by
  // the next `resetWorkspace`.
  const dirty = await git(cwd, ['status', '--porcelain']).catch(() => '');
  if (dirty) {
    await git(cwd, ['add', '-A']).catch(() => null);
    await git(cwd, ['commit', '--no-edit'])
      .catch(() => git(cwd, ['commit', '-m', `Merge into ${branch}`]))
      .catch((failure) => log(`  could not commit the resolution: ${failure.message.split('\n')[0]}`));
  }

  const pushed = await pushBranch(cwd, branch);
  if (!pushed.ok) {
    log(`  could not push ${branch}: ${pushed.result.split('\n')[0]}`);
  }
  return {
    pushed: pushed.ok,
    mergeCommit: await git(cwd, ['rev-parse', 'HEAD']).catch(() => null),
    files: [],
  };
}

/**
 * Reports what became of a merge run's branch, and ends the run — R155.
 *
 * <p>Both spawned and unspawned merges come through here, which is the point:
 * a clean merge and a resolved one leave the same two facts behind — did
 * something reach the remote, and what is the commit — and the platform reads
 * them the same way. The only difference is that one of them had a session and
 * a summary to quote.
 *
 * <p>Reported BEFORE the run is finished where the daemon controls the ending,
 * and after where the session ended itself. The platform waits for whichever
 * arrives second; see `RunService.settleAgentMerge`.
 */
async function finishTheMerge(config, run, cwd, branch, said) {
  const left = await finishMerge(cwd, branch);
  log(left.pushed
    ? `  ${branch} pushed at ${String(left.mergeCommit ?? '').slice(0, 7)}`
    : `  nothing was pushed: the conflict on ${branch} is still there`);

  await api(config, `/api/runners/${config.runnerId}/runs/${run.id}/merge/resolved`, {
    method: 'POST',
    body: {
      pushed: left.pushed,
      mergeCommit: left.mergeCommit,
      files: left.files,
      resolution: said ? capped(said) : null,
    },
  }).catch((failure) => log(`  could not report the resolution: ${failure.message}`));

  // Only where nothing else will. A session that ended itself with `report
  // done` has already moved the run, and finishing it again would be refused by
  // the state machine and logged as a failure that did not happen.
  const current = await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}`)
    .catch(() => null);
  if (current?.live) {
    await finish(config, run, left.pushed ? 'FINISHED' : 'FAILED', left.pushed
      ? `Merged and pushed ${branch}.`
      : `The conflict on ${branch} was not resolved; nothing was pushed.`);
  }
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
 *
 * **The order of this list matters, and it is `project.workspaces` order.**
 * R71/i258 has the console work out which checkout a run would be given by
 * taking the first free entry here whose `dirty` is 0, falling back to the
 * first free entry if none is known clean — the queue gate's `pickWorkspace`,
 * read from the other side of the wire. Sorting or de-duplicating this on the
 * way out would move the warning onto a checkout the run is not headed for,
 * and nothing would fail.
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
  // One entry per WORKSPACE since R47, not per project. With three checkouts of
  // one project, "what is uncommitted in cawdev" has three answers, and
  // reporting the first as though it were the only one tells somebody their
  // work is safe when it is sitting in the checkout next door.
  for (const [slug, project] of Object.entries(config.projects)) {
    for (const path of project.workspaces) {
      const held = heldBy(path);
      const problem = await workspaceProblem(path).catch(() => null);
      if (problem) {
        survey.push({
          project: slug,
          path,
          runId: held ?? null,
          unreadable: workspaceProblemSaid(slug, problem, { first: project.workspaces[0] }),
        });
        continue;
      }
      try {
        await access(join(path, '.git'));
        const porcelain = await git(path, ['status', '--porcelain']);
        const lines = porcelain ? porcelain.split('\n').filter((line) => line.trim()) : [];
        survey.push({
          project: slug,
          path,
          // Which run has it, so a dirty workspace can be read as "a session is
          // working" rather than "somebody left something behind".
          runId: held ?? null,
          dirty: lines.length,
          files: lines.slice(0, SURVEY_FILE_CAP).map(statusAndPath),
        });
      } catch (failure) {
        survey.push({
          project: slug,
          path,
          runId: held ?? null,
          unreadable: failure.message.split('\n')[0],
        });
      }
    }
  }
  return survey;
}

/** Bounds the claim-time `git status` probe — see `looksClean`. */
const CLEAN_PROBE_MS = 5000;

/**
 * Is `path`'s tree clean, read fresh, right now — i258.
 *
 * Three-valued on purpose: `true` clean, `false` dirty, `null` could not
 * tell (no `.git`, a timeout, any failure). `null` is grouped with dirty by
 * every caller — "I could not look" is not "it was clean" — so a probe that
 * cannot answer degrades to the old first-free behaviour rather than
 * starving the queue on a wedged filesystem.
 *
 * This does not reuse `surveyWorkingCopies`'s reading. That one runs on the
 * heartbeat and is not kept anywhere; caching it here would add a second
 * source of truth for a fact `pickWorkspace` is about to establish anyway,
 * and a 30-second-old reading reproduces R71/i258 in a smaller window.
 * `prepareWorkingCopy` runs the identical `git status --porcelain` seconds
 * after this one.
 */
async function looksClean(path) {
  const porcelain = await git(path, ['status', '--porcelain'], { timeoutMs: CLEAN_PROBE_MS })
    .catch(() => null);
  return porcelain === null ? null : porcelain === '';
}

/**
 * `workspaceProblem` for `path`, asked once per `problems` Map. The Map lives
 * for one poll pass, so a folder cloned meanwhile is picked up without a restart.
 */
async function problemOf(problems, path) {
  if (!problems.has(path)) problems.set(path, await workspaceProblem(path));
  return problems.get(path);
}

/**
 * The checkout a question about the project is read from — R377. The first
 * workspace nobody holds and that can be used; else null, and the caller
 * falls back to `project.path` as it always did. A missing `workspaces[0]` must not make the project read as
 * broken while `[1]` is fine.
 */
async function usableWorkspace(project, held, problems, { reading = false } = {}) {
  const usable = [];
  for (const path of project.workspaces) {
    const trouble = await problemOf(problems, path);
    // A reader has always been able to run in a folder with no `.git` — it
    // reads the files as they are (`readingCopy`) — so only a folder that is
    // not there at all stops it.
    if (!trouble || (reading && trouble.kind === 'not-git')) usable.push(path);
  }
  return usable.find((path) => !held.has(path)) ?? null;
}

/**
 * One log line per workspace that cannot be used — R377. Said at boot and on
 * SIGHUP so the operator hears it before a run is queued behind it.
 * Returns how many there were.
 */
async function sayWhichWorkspacesCannotBeUsed(config) {
  let found = 0;
  for (const [slug, project] of Object.entries(config.projects)) {
    for (const path of project.workspaces) {
      const problem = await workspaceProblem(path).catch(() => null);
      if (problem) {
        found += 1;
        log(`  ${workspaceProblemSaid(slug, problem, { first: project.workspaces[0] })}`);
      }
    }
  }
  return found;
}

/**
 * What every checkout on this machine holds — R87.
 *
 * Not the same question as `surveyWorkingCopies`, though it looks like it.
 * That one answers "is there uncommitted work in the way of a run about to
 * start", which is R46's warning. This one answers **"did this machine come
 * back with somebody's unfinished work in it"**, and the difference is the
 * commits: a checkout three commits ahead of `origin` holds work no clone has
 * ever seen, and nothing until now reported that at all.
 *
 * It runs on the beat, so a daemon restarted after a crash says what it has
 * within a second of coming up rather than when somebody thinks to look.
 *
 * Every reading is reported, clean ones included. The platform decides what is
 * worth showing — a runner that filtered would be a runner deciding what a
 * person is allowed to find out about their own machine.
 */
async function surveyWorkspaces(config) {
  const readings = [];
  for (const [slug, project] of Object.entries(config.projects)) {
    for (const path of project.workspaces) {
      const problem = await workspaceProblem(path).catch(() => null);
      if (problem) {
        readings.push({
          path,
          projectSlug: slug,
          error: workspaceProblemSaid(slug, problem, { first: project.workspaces[0] }),
        });
        continue;
      }
      try {
        await access(join(path, '.git'));
        const branch = (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        const head = (await git(path, ['rev-parse', '--short', 'HEAD']).catch(() => '')).trim();

        // Commits not on origin. `@{upstream}` is the honest question and it
        // throws on a branch that has none — which is not an error, it is the
        // answer: a branch nothing tracks has all of its commits unpushed.
        let ahead = null;
        const counted = await git(path, ['rev-list', '--count', '@{upstream}..HEAD'])
          .catch(() => null);
        if (counted !== null) {
          ahead = Number(counted.trim()) || 0;
        } else {
          const all = await git(path, ['rev-list', '--count', 'HEAD']).catch(() => null);
          ahead = all === null ? null : Number(all.trim()) || 0;
        }

        const porcelain = await git(path, ['status', '--porcelain']);
        const lines = porcelain ? porcelain.split('\n').filter((line) => line.trim()) : [];
        const stat = await git(path, ['diff', '--shortstat', 'HEAD']).catch(() => '');
        const insertions = Number(/(\d+) insertion/.exec(stat)?.[1] ?? 0);
        const deletions = Number(/(\d+) deletion/.exec(stat)?.[1] ?? 0);

        readings.push({
          path,
          projectSlug: slug,
          branch,
          head,
          ahead,
          dirtyFiles: lines.length,
          dirtyInsertions: insertions,
          dirtyDeletions: deletions,
        });
      } catch (failure) {
        // "I could not look" and "I looked and there is nothing there" must not
        // arrive at the console as the same answer — the same rule the git
        // survey follows, for the same reason.
        readings.push({ path, projectSlug: slug, error: failure.message.split('\n')[0] });
      }
    }
  }
  return readings;
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
    // R96. Whether the DEFAULT BRANCH has a brief, read from the ref rather
    // than from the working tree for the reason the code map is: a checkout is
    // usually sitting on somebody's branch, and "is there a brief" is a
    // question about the project. Sent so the console knows whether to offer an
    // interview; a machine that never looked says nothing, which is not the
    // same as saying no.
    brief: await git(path, ['cat-file', '-e', `${base}:${BRIEF.index}`])
      .then(() => true)
      .catch(() => false),
    commits: await readRecentCommits(path, base, branch),
    branches: await readBranches(path, base),
  };
}

/**
 * The shape of a repository: its files, and which of them import which — R77.
 *
 * <p>Read on the git survey's timer rather than per run: it is a fact about the
 * repository, not about a session, and the Map tab wants it to exist before
 * anybody starts anything.
 *
 * <p>Tracked files only, via `git ls-files` — `node_modules` and `target` are
 * not this project's code, and a map that included them would be a map of npm.
 * A file too big to be source is skipped rather than read: a checked-in
 * minified bundle is a megabyte of one line and nothing in it is an import
 * anybody wants to see.
 */
const BIGGEST_SOURCE_FILE = 400_000;

/**
 * Every file at a ref, and the text of the ones worth reading — R77.
 *
 * <p><strong>Read from the ref, never from the working tree.</strong> The first
 * version used `git ls-files`, which reads whatever branch the checkout happens
 * to be sitting on — and R47's survey deliberately picks a *free* workspace,
 * which is exactly the one left on somebody's abandoned branch. On this machine
 * that was the difference between a map of 481 files and a map of 474, chosen
 * at random by which checkout was idle. A map of the wrong branch is worse than
 * no map: it is confidently wrong about what exists.
 *
 * <p>`cat-file --batch` rather than a `git show` per file: four hundred
 * processes to read four hundred files is a minute of forks for a second of
 * work.
 */
async function readAtRef(path, ref) {
  const listed = await git(path, ['ls-tree', '-r', '--name-only', ref]);
  const paths = listed.split('\n').map((each) => each.trim()).filter(Boolean);

  const wanted = paths.filter((each) => /\.(java|mjs|js|ts|tsx|jsx)$/.test(each));
  const texts = await catFileBatch(path, ref, wanted);

  return paths.map((each) => (texts.has(each) ? { path: each, text: texts.get(each) }
    : { path: each }));
}

/**
 * The contents of many blobs, in one process.
 *
 * <p>`--batch` answers each request with a header line — `<sha> blob <size>` —
 * then exactly that many bytes and a newline. Counting BYTES rather than
 * splitting on newlines is the whole trick: source files contain blank lines,
 * and a parser that looked for them would tear every file in half.
 */
function catFileBatch(cwd, ref, paths) {
  return new Promise((done) => {
    const found = new Map();
    if (!paths.length) {
      done(found);
      return;
    }
    const child = spawn('git', ['cat-file', '--batch'], { cwd });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', () => done(found));
    child.on('close', () => {
      const all = Buffer.concat(chunks);
      let at = 0;
      for (const each of paths) {
        const newline = all.indexOf(10, at);
        if (newline === -1) break;
        const header = all.subarray(at, newline).toString('utf8');
        at = newline + 1;
        const parts = header.split(' ');
        // "<path> missing" for anything the ref does not have. Skipped rather
        // than guessed: a file that is not at this commit is not on this map.
        if (parts.length < 3) {
          continue;
        }
        const size = Number(parts[2]);
        if (!Number.isFinite(size)) break;
        if (size <= BIGGEST_SOURCE_FILE) {
          found.set(each, all.subarray(at, at + size).toString('utf8'));
        }
        at += size + 1;
      }
      done(found);
    });
    for (const each of paths) {
      child.stdin.write(`${ref}:${each}\n`);
    }
    child.stdin.end();
  });
}

/**
 * The shape of a repository at its default branch — R77.
 *
 * <p>The default branch and not the checkout's own HEAD, because the map is a
 * fact about the project rather than about somebody's session. That is also
 * what makes merging need no handling of its own: work becomes part of the map
 * when it lands on the default branch, which is the moment it becomes part of
 * the project.
 */
async function surveyCodeMap(path, ref) {
  return codeMapOf(await readAtRef(path, ref));
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
    // A free checkout for preference — R47. This reading is about the project
    // as a whole, and a workspace with a session in it is sitting on that
    // session's branch with its work uncommitted. Reading the pool's spare
    // gives the honest picture of the default branch instead.
    const held = heldWorkspaces();
    const free = await usableWorkspace(project, held, new Map());
    const path = free ?? resolve(project.path);
    // Busy means no free USABLE workspace.
    const busy = free === null;

    const reading = await surveyProjectGit(path, { fetch: !busy }).catch((failure) => ({
      error: failure.message.split('\n')[0],
    }));

    await api(config, `/api/runners/${config.runnerId}/git/${slug}`, {
      method: 'POST',
      body: reading,
    }).catch((failure) => log(`  could not report git for ${slug}: ${failure.message}`));

    // R77's Map, of the DEFAULT BRANCH — and only when it has moved.
    //
    // The head sha is the whole trigger, and it answers the merge question by
    // itself: a run's branch changes nothing here, and the moment that work
    // lands on the default branch the sha moves and the map is read again. No
    // hook on merging, because "the default branch moved" is the same event
    // said more honestly.
    //
    // Skipping an unchanged sha is not only thrift: re-reading four hundred
    // files every five minutes to produce identical bytes is how a background
    // task becomes the thing somebody turns off.
    await reportCodeMap(config, slug, path, reading.headSha ?? null,
        reading.defaultBranch ?? 'main');

    // R99. The brief, on the same trigger and for the same reason: it is a fact
    // about the default branch, and the platform holds no repository contents,
    // so a document it hands to sessions has to have been read by something
    // that has the checkout.
    await reportBrief(config, slug, path, reading.headSha ?? null,
        reading.defaultBranch ?? 'main');
  }
}

/**
 * Scans the run's branch with SonarQube and tells the platform — R300.
 *
 * Runs AFTER the TEST stage settles and BEFORE the next stage begins, on the
 * workspace the run just wrote, and it is the DAEMON that runs it: a session
 * that reported its own gate could lie about it (RunnerLimit's argument), so
 * the scanner is a subprocess this process starts and nothing the spawned
 * `claude` can call. Only a staged run with a TEST stage gets here — a
 * lifecycle without one, an unstaged run, a run whose gate refused TEST twice
 * or one that reported done inside TEST is not scanned, because there was no
 * settled TEST stage to scan after.
 *
 * The shape is `surveyGit`'s: every failure is CAUGHT and reported as an
 * `error` reading, never thrown to the walk — a failed scan never fails a
 * run. The two silent exits are the two ways the feature is off: no `quality`
 * block on this machine (nothing is logged; the operator never asked), and no
 * key on the project (logged, because the machine did ask and the project is
 * what is missing). Everything after that reports SOMETHING, so that "could
 * not scan" and "did not scan" never reach the page as the same answer.
 *
 * What is scanned is the WORKING TREE, which after TEST may hold edits the
 * session had not committed; `headSha` is HEAD, and says where the tree
 * started rather than that the tree equals it.
 *
 * The scanner's working directory is a temp dir OUTSIDE the checkout,
 * passed as `-Dsonar.working.directory=`: `.scannerwork/` inside it would
 * show up in the working-copy watcher and in `resetWorkspace`'s `git clean`
 * list — R76's `.codegraph` lesson, see `excludeLocally`. The token goes in
 * the child's ENVIRONMENT and never on its argv, which `ps` would show.
 *
 * R316: when the project SAYS its server refuses branches (`run.sonarBranches
 * === 'REFUSED'`, and only when this machine scans the same server the claim
 * names — see `trimSlash`), the branch attempt is skipped outright and the
 * machine's `whenBranchesRefused` runs straight away. Otherwise the branch
 * attempt still runs first and the refusal is still learnt from its failure,
 * exactly as before R316 — a project that has not said, or a machine
 * scanning a different server, gets today's behaviour unchanged.
 */
async function scanQuality(config, run, cwd, branch) {
  const slug = run.projectSlug;
  const quality = config.projects[slug]?.quality;
  if (!quality) return;
  if (!run.sonarProjectKey) {
    log(`  quality: ${slug} has no SonarQube key — not scanned`);
    return;
  }
  const key = run.sonarProjectKey;
  const report = async (reading) => {
    await api(config, `/api/runners/${config.runnerId}/quality/${slug}`, {
      method: 'POST',
      body: { runId: run.id, branch, ...reading },
    }).catch((failure) => log(`  could not report the quality of ${branch}: ${failure.message}`));
    if (reading.error) {
      log(`  quality: could not scan ${branch}: ${reading.error}`);
    } else {
      const problems = (reading.newBugs ?? 0) + (reading.newVulnerabilities ?? 0)
        + (reading.newSecurityHotspots ?? 0) + (reading.newCodeSmells ?? 0);
      log(`  quality: ${branch} gate ${reading.gate ?? 'NONE'} · ${problems} new problem${problems === 1 ? '' : 's'}`
        + (reading.warning ? ` · ${reading.warning}` : ''));
    }
  };

  const url = quality.url ?? run.sonarUrl;
  if (!url) {
    return report({ error: 'No SonarQube server: the platform has none configured and the quality block names no url.' });
  }
  const token = process.env[quality.tokenEnv];
  if (!token) {
    return report({ error: `The scanner token is not set: export ${quality.tokenEnv} on this machine.` });
  }

  // R316: the project's own word on whether its server refuses branches is
  // trusted only when this machine scans THAT server — a machine whose own
  // `quality.url` names a different one (a LAN hostname the platform cannot
  // reach) knows nothing about what that server does, and tries the branch
  // scan first, exactly as if the project had said nothing.
  const claimSpeaks = !quality.url || trimSlash(quality.url) === trimSlash(run.sonarUrl ?? '');
  const knownRefused = claimSpeaks && run.sonarBranches === 'REFUSED';

  let headSha = null;
  let workDir = null;
  try {
    headSha = await git(cwd, ['rev-parse', 'HEAD']);
    workDir = await mkdtemp(join(tmpdir(), 'cawdev-sonar-'));
    const deadline = Date.now() + quality.timeoutSeconds * 1000;
    const remaining = () => Math.max(1000, deadline - Date.now());
    const scannerArgs = (withBranch) => [
      `-Dsonar.host.url=${url}`,
      `-Dsonar.projectKey=${key}`,
      ...(withBranch ? [`-Dsonar.branch.name=${branch}`] : []),
      `-Dsonar.scm.revision=${headSha}`,
      `-Dsonar.working.directory=${workDir}`,
    ];
    const env = { ...process.env, SONAR_TOKEN: token };

    if (knownRefused) {
      if (quality.whenBranchesRefused === 'skip') {
        return report({
          headSha,
          error: "This project's SonarQube server does not analyse branches (Community Edition, set on the "
            + 'project). Set "whenBranchesRefused": "project" (a scratch SonarQube project per branch) or '
            + '"whenBranchesRefused": "main" in this machine\'s quality block.',
        });
      }
      if (quality.whenBranchesRefused === 'project') {
        // `await`, not `return`: a rejection has to be caught by THIS
        // function's own try/catch, which `return somePromise` would skip —
        // control leaves before the promise settles.
        return await scanAsScratchProject(
          { quality, run, cwd, branch, key, url, token, headSha, workDir, deadline, report });
      }
      // 'main', and known refused: no reason to run the branch scan first.
      const ran = await runSkillCommand(quality.command, scannerArgs(false), { cwd, env, timeoutMs: remaining() });
      if (!ran.ok) {
        if (/ENOENT/.test(ran.said)) {
          return report({ headSha, error: `${quality.command} is not installed on this machine (spawn ENOENT).` });
        }
        return report({ headSha, error: ran.said.split('\n')[0] || 'the scanner failed and said nothing' });
      }
      const reportTask = parseProperties(await readFile(join(workDir, 'report-task.txt'), 'utf8'));
      const askServer = sonarAsker((reportTask.serverUrl ?? url).replace(/\/$/, ''), token);
      const settled = await waitForAnalysis(askServer, reportTask.ceTaskId, deadline, quality.timeoutSeconds);
      return await reportBranchReading({
        ask: askServer, reportTask, settled, key, branch, analysedAs: 'MAIN',
        warning: "This server does not analyse branches; the branch was analysed as the project's main analysis.",
        headSha, report,
      });
    }

    // Today's behaviour: try the branch first, and learn what the server is
    // from a failure.
    let analysedAs = 'BRANCH';
    let warning = null;
    let ran = await runSkillCommand(quality.command, scannerArgs(true),
      { cwd, env, timeoutMs: remaining() });
    if (!ran.ok) {
      if (/ENOENT/.test(ran.said)) {
        return report({ headSha, error: `${quality.command} is not installed on this machine (spawn ENOENT).` });
      }
      if (/sonar\.branch\.name.*(Developer Edition|above is required)/is.test(ran.said)) {
        if (quality.whenBranchesRefused === 'project') {
          return await scanAsScratchProject(
            { quality, run, cwd, branch, key, url, token, headSha, workDir, deadline, report });
        }
        if (quality.whenBranchesRefused !== 'main') {
          return report({
            headSha,
            error: 'This SonarQube server does not analyse branches (Community Edition). Set '
              + '"whenBranchesRefused": "project" (a scratch SonarQube project per branch) or '
              + '"whenBranchesRefused": "main" in the quality block to analyse it as the main analysis instead '
              + "— or set this project's SonarQube-branches setting under Settings so this is known before the "
              + 'scan runs.',
          });
        }
        // The operator opted in: once more, as the project's main analysis.
        analysedAs = 'MAIN';
        warning = "This server does not analyse branches; the branch was analysed as the project's main analysis.";
        ran = await runSkillCommand(quality.command, scannerArgs(false),
          { cwd, env, timeoutMs: remaining() });
      }
    }
    if (!ran.ok) {
      return report({ headSha, error: ran.said.split('\n')[0] || 'the scanner failed and said nothing' });
    }

    // What the scanner left behind: where the server queued the analysis.
    const reportTask = parseProperties(await readFile(join(workDir, 'report-task.txt'), 'utf8'));
    const askServer = sonarAsker((reportTask.serverUrl ?? url).replace(/\/$/, ''), token);
    const settled = await waitForAnalysis(askServer, reportTask.ceTaskId, deadline, quality.timeoutSeconds);
    await reportBranchReading({ ask: askServer, reportTask, settled, key, branch, analysedAs, warning, headSha, report });
  } catch (failure) {
    await report({ headSha, error: failure.message.split('\n')[0] });
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Without a trailing slash, so two URLs that differ only by one still compare equal. */
function trimSlash(url) {
  return url.replace(/\/$/, '');
}

/** A GET against the SonarQube server a scan just reported to, authorised with the scanner's own token. */
function sonarAsker(serverUrl, token) {
  return async (path) => {
    const response = await fetch(`${serverUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) {
      throw new Error(`SonarQube answered ${response.status} to ${path.split('?')[0]}`);
    }
    return response.json();
  };
}

/**
 * Waits for a queued analysis to settle — shared by every scan path, BRANCH,
 * MAIN and PROJECT alike. Throws rather than reports: every caller runs
 * inside `scanQuality`'s own try/catch, which turns it into an error reading.
 */
async function waitForAnalysis(ask, ceTaskId, deadline, timeoutSeconds) {
  let settled = null;
  while (Date.now() < deadline) {
    const { task: current } = await ask(`/api/ce/task?id=${encodeURIComponent(ceTaskId)}`);
    if (['SUCCESS', 'FAILED', 'CANCELED'].includes(current?.status)) {
      settled = current;
      break;
    }
    await new Promise((wake) => setTimeout(wake, 3000));
  }
  if (!settled) {
    throw new Error(`SonarQube had not finished analysing after ${timeoutSeconds}s.`);
  }
  if (settled.status !== 'SUCCESS') {
    throw new Error(settled.errorMessage ?? `SonarQube ${settled.status.toLowerCase()} the analysis.`);
  }
  return settled;
}

/** The gate and the new-code measures, for a BRANCH or MAIN reading — never for PROJECT, which has neither. */
async function reportBranchReading({ ask, reportTask, settled, key, branch, analysedAs, warning, headSha, report }) {
  const { projectStatus } = await ask(`/api/qualitygates/project_status?analysisId=${encodeURIComponent(settled.analysisId)}`);
  const metrics = 'new_bugs,new_vulnerabilities,new_security_hotspots,new_code_smells,new_coverage';
  const { component } = await ask(`/api/measures/component?component=${encodeURIComponent(key)}`
    + `&metricKeys=${metrics}${analysedAs === 'BRANCH' ? `&branch=${encodeURIComponent(branch)}` : ''}`);
  const measure = (metric) => {
    const found = (component?.measures ?? []).find((each) => each.metric === metric);
    // New-code values sit in `period.value` — `periods[0].value` on older servers.
    const value = found?.period?.value ?? found?.periods?.[0]?.value ?? found?.value;
    return value === undefined || value === null || value === '' ? null : Number(value);
  };
  const integer = (metric) => {
    const value = measure(metric);
    return value === null ? null : Math.round(value);
  };

  await report({
    headSha,
    gate: projectStatus?.status ?? 'NONE',
    analysedAs,
    newBugs: integer('new_bugs'),
    newVulnerabilities: integer('new_vulnerabilities'),
    newSecurityHotspots: integer('new_security_hotspots'),
    newCodeSmells: integer('new_code_smells'),
    newCoverage: measure('new_coverage'),
    dashboardUrl: reportTask.dashboardUrl ?? null,
    warning,
  });
}

/**
 * SonarQube's own pages, `ps=500` at a time, up to the server's `p × ps`
 * ceiling worth trying — R313's `LIST_PAGES` argument, in the scanner
 * instead of the reader. `paging.total` (hotspots) or `total` (issues) is
 * wherever the server put it.
 */
async function pagedSearch(ask, pathWithQuery, itemsKey) {
  const items = [];
  for (let page = 1; page <= 20; page += 1) {
    const body = await ask(`${pathWithQuery}&ps=500&p=${page}`);
    const list = body[itemsKey] ?? [];
    items.push(...list);
    const total = body.paging?.total ?? body.total ?? items.length;
    if (items.length >= total || list.length === 0) {
      break;
    }
  }
  return items;
}

/** `sha1(text)`'s first six hex characters — enough to keep a scratch key readable and still collision-free per branch. */
function shortHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 6);
}

/**
 * The Community Edition fallback that never touches the project's own
 * dashboard — R316: the branch is analysed as its own scratch SonarQube
 * project, `<key>:branch:<branch>-<hash>`, overwritten on each run of the
 * branch. A fresh project has no new-code period to compare against, so
 * "new" is redefined as "on a line this branch changed since it left its
 * base" — {@link changedLines} against the merge-base — and the gate is
 * always `NONE`: a quality gate over a whole scratch project would judge
 * code this branch did not write.
 */
async function scanAsScratchProject({ quality, run, cwd, branch, key, url, token, headSha, workDir, deadline, report }) {
  const baseName = run.baseBranch ?? run.defaultBranch ?? 'main';
  const ref = await firstRef(cwd, [`origin/${baseName}`, baseName]);
  const mergeBase = ref ? await git(cwd, ['merge-base', 'HEAD', ref]).catch(() => null) : null;
  if (!mergeBase) {
    return report({ headSha, error: `could not find where ${branch} left ${baseName}` });
  }

  const scratchKey = `${key}:branch:${branch.replace(/[^A-Za-z0-9_.-]/g, '_')}-${shortHash(branch)}`;
  const env = { ...process.env, SONAR_TOKEN: token };
  const args = [
    `-Dsonar.host.url=${url}`,
    `-Dsonar.projectKey=${scratchKey}`,
    `-Dsonar.projectName=${key} · ${branch}`,
    `-Dsonar.scm.revision=${headSha}`,
    `-Dsonar.working.directory=${workDir}`,
  ];
  const ran = await runSkillCommand(quality.command, args,
    { cwd, env, timeoutMs: Math.max(1000, deadline - Date.now()) });
  if (!ran.ok) {
    if (/ENOENT/.test(ran.said)) {
      throw new Error(`${quality.command} is not installed on this machine (spawn ENOENT).`);
    }
    throw new Error(ran.said.split('\n')[0] || 'the scanner failed and said nothing');
  }

  const reportTask = parseProperties(await readFile(join(workDir, 'report-task.txt'), 'utf8'));
  const ask = sonarAsker((reportTask.serverUrl ?? url).replace(/\/$/, ''), token);
  await waitForAnalysis(ask, reportTask.ceTaskId, deadline, quality.timeoutSeconds);

  const changed = await changedLines(cwd, mergeBase);
  const counted = (component, line) => {
    const path = component.slice(scratchKey.length + 1);
    const entry = changed.get(path);
    if (!entry) return false;
    if (entry === 'ALL') return true;
    // A file-level finding (no line) counts when the file itself changed.
    if (line === undefined || line === null) return true;
    return entry.has(line);
  };

  const encodedKey = encodeURIComponent(scratchKey);
  const issues = await pagedSearch(ask,
    `/api/issues/search?componentKeys=${encodedKey}&resolved=false&types=BUG,VULNERABILITY,CODE_SMELL`, 'issues');
  const hotspots = await pagedSearch(ask,
    `/api/hotspots/search?projectKey=${encodedKey}&status=TO_REVIEW`, 'hotspots');

  let newBugs = 0;
  let newVulnerabilities = 0;
  let newCodeSmells = 0;
  for (const issue of issues) {
    if (!counted(issue.component, issue.line)) continue;
    if (issue.type === 'BUG') newBugs += 1;
    else if (issue.type === 'VULNERABILITY') newVulnerabilities += 1;
    else if (issue.type === 'CODE_SMELL') newCodeSmells += 1;
  }
  const newSecurityHotspots = hotspots.filter((hotspot) => counted(hotspot.component, hotspot.line)).length;

  await report({
    headSha,
    gate: 'NONE',
    analysedAs: 'PROJECT',
    newBugs,
    newVulnerabilities,
    newSecurityHotspots,
    newCodeSmells,
    newCoverage: null,
    dashboardUrl: reportTask.dashboardUrl ?? null,
    warning: 'This server does not analyse branches; the branch was analysed as its own SonarQube project, '
      + 'counting problems on the lines it changed. No gate was computed.',
  });
}

/** `key=value` lines — the shape of the scanner's `report-task.txt`. */
function parseProperties(text) {
  const parsed = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) {
      parsed[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  }
  return parsed;
}

/**
 * Reads and reports the code map, unless it would say the same thing again.
 *
 * <p>Remembered per project in this process rather than asked of the platform:
 * one extra request every five minutes to discover there is nothing to send is
 * the cost this exists to avoid. A restarted daemon reports once and then
 * settles, which is the right side to be wrong on.
 */
const lastMapped = new Map();

async function reportCodeMap(config, slug, path, headSha, defaultBranch, { force = false } = {}) {
  if (!force && headSha && lastMapped.get(slug) === headSha) {
    return;
  }
  // `origin/<default>` for preference: it is what everybody else has, and it is
  // what the checkout may not be on. A repository with no remote falls back to
  // the local branch, and then to HEAD, so a local experiment still gets a map.
  const ref = await firstRef(path, [`origin/${defaultBranch}`, defaultBranch, 'HEAD']);
  if (!ref) {
    log(`  no ref to map ${slug} from`);
    return;
  }

  const map = await surveyCodeMap(path, ref).catch((failure) => {
    log(`  could not read the code map for ${slug}: ${failure.message.split('\n')[0]}`);
    return null;
  });
  if (!map) {
    return;
  }
  // The sha OF THE REF WE READ, not of whatever the checkout is on — the map
  // and the commit it claims to be of have to be the same thing.
  const at = await git(path, ['rev-parse', ref]).catch(() => headSha);
  await api(config, `/api/runners/${config.runnerId}/git/${slug}/code-map`, {
    method: 'POST',
    body: { headSha: at, ...map },
  }).then(() => {
    lastMapped.set(slug, at);
    log(`  mapped ${slug} at ${short(at)}: ${map.files.length} files, ${map.edges.length} imports`);
  }).catch((failure) => log(`  could not report the code map: ${failure.message}`));
}

/**
 * Reads the brief off the default branch and reports it — R99.
 *
 * <p>Remembered per project like the map above, and skipped when it would say
 * the same thing twice. The EMPTY report is deliberately still sent once when a
 * brief disappears: "there is no brief here any more" is news, and a runner
 * that only ever reported files would leave a deleted document being handed to
 * every session for ever.
 */
const lastBriefed = new Map();

/** A file bigger than this is not prose somebody wrote for an agent to read. */
const BIGGEST_BRIEF_FILE = 200_000;

async function reportBrief(config, slug, path, headSha, defaultBranch) {
  const ref = await firstRef(path, [`origin/${defaultBranch}`, defaultBranch, 'HEAD']);
  if (!ref) {
    return;
  }
  const at = await git(path, ['rev-parse', ref]).catch(() => headSha);
  if (at && lastBriefed.get(slug) === at) {
    return;
  }

  const listed = await git(path, ['ls-tree', '-r', '--name-only', ref, '--', `${BRIEF.path}/`])
    .catch(() => '');
  const paths = listed.split('\n').map((each) => each.trim())
    .filter((each) => each.endsWith('.md'))
    .sort();

  const files = [];
  for (const each of paths) {
    const body = await git(path, ['show', `${ref}:${each}`]).catch(() => null);
    if (body === null) {
      continue;
    }
    if (body.length > BIGGEST_BRIEF_FILE) {
      log(`  ${each} is ${body.length} bytes; not reporting it as brief`);
      continue;
    }
    files.push({ path: each, title: firstHeadingOf(body), body });
  }

  // Nothing to say, and nothing was ever said: the ordinary case for every
  // project that has not been interviewed, and not worth a request.
  if (!files.length && !lastBriefed.has(slug)) {
    lastBriefed.set(slug, at);
    return;
  }

  await api(config, `/api/runners/${config.runnerId}/git/${slug}/brief`, {
    method: 'POST',
    body: { headSha: at, files },
  }).then(() => {
    lastBriefed.set(slug, at);
    log(files.length
      ? `  read ${slug}'s brief at ${short(at)}: ${files.length} file(s)`
      : `  ${slug} has no brief at ${short(at)} any more`);
  }).catch((failure) => log(`  could not report the brief: ${failure.message}`));
}

/**
 * The file's first markdown heading, so the console can list it without
 * parsing markdown in a browser. Null when it has none.
 */
function firstHeadingOf(body) {
  const heading = body.split('\n').find((line) => /^#{1,3}\s+\S/.test(line));
  return heading ? heading.replace(/^#{1,3}\s+/, '').trim() : null;
}

/** The first of these refs this repository actually has. */
async function firstRef(path, candidates) {
  for (const ref of candidates) {
    const found = await git(path, ['rev-parse', '--verify', '--quiet', ref]).catch(() => null);
    if (found) {
      return ref;
    }
  }
  return null;
}

// --- the prompt --------------------------------------------------------------

/**
 * What the spawned session is told.
 *
 * It deliberately teaches the method rather than the task: the task is in the
 * roadmap entry, which the agent reads for itself with `task_current`. Telling
 * it the task here would be a second copy that can disagree with the entry.
 */
/**
 * The one line every session with a checkout is given about the brief — R96.
 *
 * A brief nobody is told to read is a document that rots. It is a sentence
 * rather than a paragraph because it competes with the instruction that follows
 * it, and it says "if it is there" because most repositories have not had an
 * interview yet and a session hunting for a missing file is a session wasting a
 * turn.
 */
function briefLine(run) {
  const index = run.brief?.index ?? BRIEF.index;
  const text = run.brief?.indexText;

  // R99. Handed over rather than pointed at. A pointer is not a guarantee: the
  // file may have been deleted, the checkout may be behind, and a session that
  // never opened it looks exactly like one that did. When the platform has a
  // reading, the session starts already knowing what this project is.
  if (text) {
    const stale = run.brief?.current === false
      ? `\n(This was written at ${short(run.brief.writtenAtSha ?? '')} and the default branch `
        + `has moved since. Trust the files over this if they disagree.)\n`
      : '';
    return `=== WHAT THIS PROJECT IS — from \`${index}\`, written for you ===\n\n`
      + `${text.trim()}\n${stale}\n`
      + `=== end of the brief's index. The sections it names are in the checkout. ===\n\n`;
  }
  return `If \`${index}\` exists in this checkout, read it before anything else — `
    + `it is this project's brief, and it holds what the code cannot say.\n`;
}

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

${briefLine(run)}
If a decision is genuinely theirs, use the cawdev MCP tool \`ask_user\` and wait.

${run.branch ? `When what they asked is done, commit it on ${run.branch} — work left
uncommitted is work nothing can push or propose. Never commit to or push main.

` : ''}Their instruction:

${run.openingPrompt}`;
  }

  return `You are working on a roadmap entry in the cawdev platform, on branch ${run.branch}.

Start by calling the cawdev MCP tool \`task_current\`. It gives you the entry, its
branch, and everything already said on this run — including, if you are resuming,
what you said before.

${briefLine(run)}
${run.rejection ? `THIS CARD WAS REVIEWED AND SENT BACK. The work is already on branch
${run.branch}; a previous session finished on it. ${run.rejection.decidedByEmail ?? 'The reviewer'}
read it and said:

    ${String(run.rejection.note).split('\n').join('\n    ')}

Fix what is listed. Do not rebuild the card — its text below is the original
task, for context only. \`task_current\` carries the same note.

` : ''}The working method here:

1. You are already on branch ${run.branch}. Move the entry to CODING naming that
   branch (\`roadmap_set_status\`) before your first commit, if it is not there
   already. The roadmap should be able to answer "what is being worked on right
   now" without asking anyone.
2. Build what the entry's "Done when" list asks for. Read the repository's
   CLAUDE.md and follow it. Before searching around a part of the tree you do
   not know, call \`code_map\` — it is one call and it already knows every
   directory and what depends on what. \`file_deps\` on a file you are about to
   change tells you what imports it, which is the blast radius and the thing a
   search for the filename gets wrong.
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
          // R130. `describeCall` names a capability — Skill(key), Agent(key) —
          // and writes everything else exactly as this line did before. See
          // ../lib/tool-line.mjs: the platform parses these strings.
          lines.push({ kind: 'TOOL', body: describeCall(part.name, part.input) });
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
 *
 * The batching, the retry and the backoff are `../lib/transcript-batch.mjs`,
 * pure of the network for the same reason `code-map.mjs` is pure of a
 * repository: the hard part — a failed send kept rather than dropped, so a
 * reconnect (this run may by then be `UNREACHABLE` on the platform — see
 * `RunService#driving`) replays everything in the order it was produced — is
 * then testable without a socket. This subclass adds the two daemon-only
 * things: what a send actually POSTs to, and the tee to the attached
 * terminal, which should not wait on a flush window, let alone the network.
 */
class Transcript extends TranscriptBatch {
  constructor(config, run, opts) {
    super(
      (lines) => api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/output`, {
        method: 'POST',
        body: { lines },
      }),
      {
        ...opts,
        onRetry: ({ lines, delayMs, failure }) => log(
          `  could not record output (${lines.length} line${lines.length === 1 ? '' : 's'} `
          + `held, retrying in ${Math.round(delayMs / 1000)}s): ${failure.message}`),
      },
    );
    this.config = config;
    this.run = run;
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
    super.push(line);
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
      // R141: CODE alone. Every other profile is standing in a checkout it did
      // not prepare, so what `readWorkingCopy` sees there is not its work.
      if (state && fingerprint !== last && writesAnythingProfile(run)) {
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

      // `Array.isArray` rather than `?? []`, for the reason the closing-action
      // reader below spells out — and more sharply here, because this loop runs
      // for the whole life of a session. `??` only guards null: an answer that
      // is an object, a string, or an error body dressed as JSON reaches the
      // `for` intact and throws, and a throw here is not one run failing, it is
      // the daemon exiting and taking every other session on the machine with
      // it. That is exactly how it failed: a platform with no such endpoint
      // answered `{}`, and the runner died mid-session with
      // "(actions ?? []) is not iterable".
      for (const action of Array.isArray(actions) ? actions : []) {
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
  } else if (action.kind === 'PUSH') {
    log(`  pushing ${run.branch}${byRule(action)}`);
    ({ ok, result } = await pushBranch(cwd, run.branch));
  } else if (action.kind === 'OPEN_PR') {
    log(`  opening a pull request for ${run.branch} into ${run.baseBranch ?? 'the default branch'}${byRule(action)}`);
    ({ ok, result } = await openPullRequest(cwd, run, action.message));
  } else if (action.kind === 'MERGE') {
    log(`  MERGING ${run.branch} into ${run.baseBranch ?? 'the default branch'}${byRule(action)} — nobody is reading this diff`);
    ({ ok, result } = await mergePullRequest(cwd, run.branch, { declared: run.gitHost ?? null }));
  } else {
    result = `This runner does not know how to ${action.kind}.`;
  }

  await api(
    config,
    `/api/projects/${run.projectSlug}/runs/${run.id}/actions/${action.id}/finished`,
    { method: 'POST', body: { ok, result: String(result).slice(0, 4000) } },
  ).catch((failure) => log(`  could not report the action: ${failure.message}`));
}

/**
 * What a person asked of a checkout, done — R57.
 *
 * The other half of R46's warning. It named the files and then offered nothing:
 * you could not see what had changed in them, and the two ways out it
 * *recommended* — commit or stash — were the two things the console could not
 * do. All three land here, because this process is the only one that can see
 * the directory.
 *
 * Everything is capped and everything says it was capped. A diff that silently
 * stops halfway is one somebody reads to the end and then acts on.
 */
const WORKSPACE_RESULT_CAP = 120_000;

function capped(text) {
  const value = String(text ?? '');
  return value.length <= WORKSPACE_RESULT_CAP
    ? value
    : `${value.slice(0, WORKSPACE_RESULT_CAP)}\n\n[… truncated at ${WORKSPACE_RESULT_CAP} characters. `
      + 'The rest is in the checkout.]';
}

/** A patch bigger than this does not travel; commit some of it first. */
const HANDOFF_PATCH_CAP = 4 * 1024 * 1024;

/**
 * A checkout back to what the remote has — R87's RESET, as a function since
 * R148 because a hand-off ends the same way once the work is elsewhere.
 */
async function resetToOrigin(cwd, defaultBranchName) {
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const defaultBranch = defaultBranchName?.trim() || 'main';

  await git(cwd, ['reset', '--hard']);
  await git(cwd, ['clean', '-fd']);

  await git(cwd, ['fetch', '--prune', 'origin']).catch(() => null);
  const onOrigin = await git(cwd, ['rev-parse', '--verify', `origin/${branch}`])
    .then(() => true)
    .catch(() => false);

  if (onOrigin) {
    await git(cwd, ['reset', '--hard', `origin/${branch}`]);
    return `${cwd} is back to origin/${branch}.`;
  }
  if (branch === defaultBranch) {
    return `${cwd} is clean on ${branch}.`;
  }
  await git(cwd, ['checkout', defaultBranch]);
  await git(cwd, ['reset', '--hard', `origin/${defaultBranch}`]).catch(() => null);
  await git(cwd, ['branch', '-D', branch]).catch(() => null);
  return `${branch} was never pushed, so it is gone; ${cwd} is on ${defaultBranch}.`;
}

/**
 * A handed-off run's work, laid into a fresh checkout — R148.
 *
 * <p>The branch first: `prepareWorkingCopy` creates a branch it does not
 * have locally from the DEFAULT branch, which is right for a new run and
 * wrong for one whose commits are on the remote. So the checkout is put on
 * `origin/<branch>` when that exists. Then the patch, three-way so a file the
 * remote moved under it still lands; and if it will not apply, it is written
 * beside the checkout and the sentence returned says where — the session
 * reads that sentence before it reads anything else.
 */
async function applyHandoff(cwd, branch, handoff) {
  const parts = [];
  await git(cwd, ['fetch', '--prune', 'origin']).catch(() => null);
  const onOrigin = await git(cwd, ['rev-parse', '--verify', `origin/${branch}`])
    .then(() => true)
    .catch(() => false);
  if (onOrigin) {
    await git(cwd, ['checkout', '-B', branch, `origin/${branch}`]);
    parts.push(`Handed off: ${cwd} is on origin/${branch}`);
  } else {
    parts.push(`Handed off: ${branch} is not on the remote, so this checkout starts it from the `
      + 'default branch');
  }
  if (!handoff?.patch) {
    parts.push('nothing was uncommitted.');
    return parts.join('; ');
  }
  const patchFile = join(tmpdir(), `cawdev-handoff-${Date.now()}.patch`);
  await writeFile(patchFile, handoff.patch);
  try {
    await git(cwd, ['apply', '--3way', '--whitespace=nowarn', patchFile]);
    parts.push(`${handoff.files ?? 'the'} uncommitted file(s) were applied on top as a patch.`);
    await rm(patchFile, { force: true }).catch(() => null);
  } catch (failure) {
    parts.push(`the patch of ${handoff.files ?? 'the'} uncommitted file(s) did NOT apply cleanly `
      + `(${failure.message.split('\n')[0]}). It is at ${patchFile} — apply it by hand with `
      + `git apply --3way ${patchFile}, and check git status before relying on the tree.`);
  }
  return parts.join('; ');
}

// R218. The requests that leave the working tree different from how the last
// survey described it. `SHOW`, `INDEX`, `MERGE` and `TAG` are not here: a look,
// a map, a merge of a branch that is somewhere else, a question to the host.
const TOUCHES_THE_TREE = new Set(['STASH', 'COMMIT', 'RESET', 'HANDOFF']);

async function performWorkspaceRequest(config, request, afterTheTreeMoved = null) {
  const cwd = request.path;
  let ok = false;
  let result;
  // R155. Which KIND of failure, on a MERGE. Named apart from the `failure`
  // that every `catch` in this function binds — the shadowing would compile and
  // report the wrong thing.
  let failureKind = null;

  try {
    await access(join(cwd, '.git'));
  } catch {
    await reportWorkspaceRequest(config, request, false, `${cwd} is not a git repository.`);
    return;
  }

  if (request.kind === 'SHOW') {
    // Staged and unstaged together against HEAD, which is what a person means
    // by "what is uncommitted here". Untracked files are listed rather than
    // shown: `git diff` cannot see them, and inlining the whole of a new
    // node_modules-sized file somebody forgot to ignore helps nobody.
    try {
      const status = await git(cwd, ['status', '--porcelain']);
      const diff = await git(cwd, ['diff', 'HEAD']).catch(() => '');
      const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard'])
        .catch(() => '');
      const parts = [];
      if (status) parts.push(status);
      if (untracked) {
        parts.push(`--- untracked, not shown ---\n${untracked}`);
      }
      if (diff) parts.push(diff);
      result = parts.length ? parts.join('\n\n') : 'Nothing uncommitted.';
      ok = true;
    } catch (failure) {
      result = failure.message;
    }
  } else if (request.kind === 'INDEX') {
    // R77's map button. The same preparation a skill-enabled run does on its
    // way in, asked for on its own — because looking at a map should not cost
    // an agent session, a model, or a branch.
    //
    // The skill's row travels on the request, so this daemon does not have to
    // know what CodeGraph is: the platform says what to run and this runs it,
    // exactly as `resolveSkills` does at spawn.
    // R77. The map cawdev shows is refreshed FIRST and unconditionally, because
    // that is what the button in front of the person says it does. The skill's
    // own index is a separate thing that a session uses, and a project with no
    // skill turned on must still be able to redraw its map on demand — which is
    // the answer to "can I update it when I want".
    const branch = await git(cwd, ['symbolic-ref', '--short', 'HEAD']).catch(() => 'main');
    await reportCodeMap(config, request.projectSlug, cwd, null, branch, { force: true })
      .catch((failure) => log(`  could not refresh the map: ${failure.message}`));

    const skill = request.skill;
    if (!skill?.key || !skill?.command || !Array.isArray(skill.args)) {
      // Not a failure any more: the map is what was asked for and the map was
      // built. A project with no skill on has nothing else to do here.
      await reportWorkspaceRequest(config, request, true,
        'The map has been refreshed. No skill is turned on for this project, so there was no '
          + 'index to build beside it.');
      return;
    }
    log(`  building the ${skill.key} index for ${cwd}, as asked`);
    try {
      const local = SKILLS_HERE[skill.key] ?? {};
      const baseCommit = await git(cwd, ['rev-parse', 'HEAD']).catch(() => null);
      result = await prepareSkillIndex(config, skill, local, request, cwd, baseCommit);
      ok = true;
    } catch (failure) {
      // Never a throw out of here: the whole point of this channel is that a
      // machine answers, and a daemon that died mid-request answers nothing.
      result = failure.message;
    }
  } else if (request.kind === 'STASH') {
    log(`  stashing ${cwd}, as asked`);
    try {
      // --include-untracked, because a warning that counted an untracked file
      // and then left it behind would be a stash that did not do what the
      // count said it would.
      const label = request.message?.trim()
        || `cawdev: stashed from the console at ${new Date().toISOString()}`;
      const said = await git(cwd, ['stash', 'push', '--include-untracked', '-m', label]);
      // The name it can be recovered by, said out loud. A stash nobody can find
      // later has eaten somebody's work.
      const top = await git(cwd, ['stash', 'list', '-1']).catch(() => '');
      result = top ? `${said}\n\nRecover it with: git -C ${cwd} stash pop\n${top}` : said;
      ok = true;
    } catch (failure) {
      result = failure.message;
    }
  } else if (request.kind === 'COMMIT') {
    log(`  committing ${cwd}, as asked`);
    try {
      await git(cwd, ['add', '-A']);
      // --no-verify is deliberately NOT passed, for the reason the run action
      // does not pass it either: a repository's hooks are its own business, and
      // a commit its own hooks reject should fail here rather than land because
      // it came from a button.
      await git(cwd, ['commit', '-m',
        request.message?.trim() || 'Committed from the cawdev console']);
      const sha = await git(cwd, ['rev-parse', '--short', 'HEAD']);
      const subject = await git(cwd, ['log', '-1', '--format=%s']).catch(() => '');
      result = `${sha} ${subject}`.trim();
      ok = true;
    } catch (failure) {
      result = failure.message;
    }
  } else if (request.kind === 'RESET') {
    log(`  resetting ${cwd}, as asked`);
    try {
      result = await resetToOrigin(cwd, request.defaultBranch);
      ok = true;
    } catch (failure) {
      result = failure.message;
    }
  } else if (request.kind === 'HANDOFF') {
    // R148. Package the run's work and free the checkout: the branch goes to
    // the remote, the uncommitted tree goes to the platform as a patch, and
    // only THEN is the directory reset — nothing is dropped before it is
    // somewhere else.
    log(`  HANDING OFF ${cwd} — asked for from the console`);
    try {
      if (!request.runId) {
        throw new Error('This hand-off names no run, so there is nothing to report it against.');
      }
      const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      await git(cwd, ['add', '-A']);
      const patch = await git(cwd, ['diff', '--cached', '--binary']).catch(() => '');
      const files = (await git(cwd, ['diff', '--cached', '--name-only']).catch(() => ''))
        .split('\n').filter(Boolean).length;
      // Unstage again: the tree is untouched until the platform has the patch.
      await git(cwd, ['reset']).catch(() => null);
      const baseSha = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
      let pushed = false;
      try {
        await git(cwd, ['push', '-u', 'origin', branch]);
        pushed = true;
      } catch (failure) {
        log(`  could not push ${branch}: ${failure.message.split('\n')[0]}`);
      }
      if (patch.length > HANDOFF_PATCH_CAP) {
        throw new Error(`The uncommitted work is ${Math.round(patch.length / 1024)}kB as a patch, `
          + 'which is more than a hand-off carries. Commit some of it first.');
      }
      await api(config, `/api/runners/${config.runnerId}/runs/${request.runId}/handoff`, {
        method: 'POST',
        body: { baseSha, patch: patch || null, files, pushed },
      });
      const freed = await resetToOrigin(cwd, request.defaultBranch);
      result = `Handed off: ${files} uncommitted file(s) saved as a patch on ${baseSha.slice(0, 7)}, `
        + `branch ${branch} ${pushed ? 'pushed' : 'NOT pushed — push it by hand'}. ${freed}`;
      ok = true;
    } catch (failure) {
      result = failure.message;
    }
  } else if (request.kind === 'MERGE') {
    // R134's button, and the only kind on this channel whose effect is not in
    // the checkout. `gh pr merge` is a host-side operation: it resolves the
    // pull request from this clone's remote and touches no working tree, so
    // several branches merge safely from one directory and nothing here moves.
    const branch = (request.message ?? '').trim();
    if (!branch) {
      result = 'A merge has to name a branch. Nothing was merged.';
    } else {
      // R306: whose idea it was. A rule's merge lands with nobody reading
      // the diff, and the log is where an operator sees that happen.
      log(`  MERGING ${branch} — ${request.requestedByRule
        ? `by ${request.requestedByRule}, nobody is reading this diff`
        : 'asked for from the console'}`);
      // R261. A sprint's branch lands with a merge commit; every other branch
      // squashes as it always did. The claim says which.
      ({ ok, result, failure: failureKind } = await mergePullRequest(cwd, branch, {
        method: request.mergeMethod ?? null,
        declared: request.gitHost ?? null,
      }));
    }
  } else if (request.kind === 'TAG') {
    // R156's release. A read: it asks the HOST whether the tag is there, so it
    // needs a clone of the repository rather than any particular state of this
    // working tree, and it changes nothing in either.
    const version = (request.message ?? '').trim();
    if (!version) {
      result = 'A tag check has to name a version. Nothing was checked.';
    } else {
      log(`  checking for tag ${version} on the remote`);
      ({ ok, result } = await tagOnTheRemote(cwd, version));
    }
  } else if (request.kind === 'OPEN_PR') {
    // R261. The first half of a sprint merge: open the pull request from the
    // sprint's branch to the default — or find the one already there — and
    // report its URL on the first line. The platform cannot know whether one
    // exists (it holds no git-host credential), so it always asks this first
    // and queues the MERGE when this comes back ok. Host-side like MERGE: the
    // branch is on origin already (CUT_BRANCH put it there and every card
    // merged into it), so nothing is pushed and no working tree moves.
    const branch = (request.message ?? '').trim();
    if (!branch) {
      result = 'A pull request has to name a branch. Nothing was opened.';
    } else {
      const base = request.baseBranch ?? request.defaultBranch ?? 'main';
      log(`  OPENING a pull request for ${branch} → ${base} — asked for from the console`);
      // A card's branch may never have left this machine — a session whose
      // project does not push, which is why somebody is asking for the pull
      // request by hand. A sprint's is on origin already and this is a no-op.
      const empty = await nothingToPropose(cwd, branch, base);
      if (empty) {
        ok = false;
        result = empty;
      }
      const pushed = empty ? { failed: empty } : await pushIfOriginLacks(cwd, branch);
      if (pushed.failed) {
        ok = false;
        result = pushed.failed;
      } else {
        ({ ok, result } = await openPullRequestFor(cwd, {
          declared: request.gitHost ?? null,
          branch,
          base,
          title: request.title?.trim() || branch,
          // A sprint's title is its ref and name ("S1 Notifications"); a
          // card's is "R3 — …" (RunnerController reads either at claim).
          body: /^S\d+ /.test(request.title ?? '')
            ? `Opened by cawdev for the sprint branch \`${branch}\` — ${request.title.trim()}.\n\n`
              + `Merging it lands every card of the sprint on ${base}.`
            : `Opened by cawdev for \`${branch}\`${request.title ? ` — ${request.title.trim()}` : ''}.`,
        }));
        // The URL stays the FIRST line: the platform reads it off there.
        if (ok && pushed.said) {
          result = `${result}\n${pushed.said}`;
        }
      }
    }
  } else if (request.kind === 'CUT_BRANCH') {
    // R260. Put the sprint's branch on origin, from the default's tip. A branch
    // already there is a success, not a conflict — the sprint wanted one to
    // exist, and one does. Touches no working tree: the push names two refs
    // and this checkout's HEAD is not one of them.
    const name = (request.message ?? '').trim();
    if (!name) {
      result = 'A cut has to name a branch. Nothing was cut.';
    } else {
      log(`  cutting ${name} on origin from ${request.defaultBranch || 'main'}`);
      ({ ok, result } = await cutBranchOnOrigin(cwd, name, request.defaultBranch));
    }
  } else if (request.kind === 'CREATE_BRANCH') {
    // R379. Put a named branch on origin, cut from another branch's tip. Unlike
    // CUT_BRANCH an existing name is a REFUSAL: the person asked for a new
    // branch, and one that is already there may be somebody else's work.
    // Touches no working tree: the push names two refs and HEAD is neither.
    const name = (request.message ?? '').trim();
    const from = (request.fromBranch ?? '').trim();
    if (!name || !from) {
      result = 'A new branch has to name itself and the branch to cut it from. Nothing was created.';
    } else {
      log(`  creating ${name} on origin from ${from} — asked for from the console`);
      ({ ok, result } = await createBranchOnOrigin(cwd, name, from));
    }
  } else {
    result = `This runner does not know how to ${request.kind}.`;
  }

  // R218. The console's row draws the survey, not this answer: report the
  // tree as it is NOW, before saying the request is done, so the row is
  // right the moment the spinner stops. Done or failed — a reset that
  // half-happened has moved the tree too.
  if (afterTheTreeMoved && TOUCHES_THE_TREE.has(request.kind)) {
    await afterTheTreeMoved().catch((failure) => log(`  could not re-read the checkouts: ${failure.message}`));
  }

  await reportWorkspaceRequest(config, request, ok, result, failureKind);
}

function reportWorkspaceRequest(config, request, ok, result, failure = null) {
  return api(
    config,
    `/api/runners/${config.runnerId}/workspace-requests/${request.id}/finished`,
    // `failure` is R155's and is only ever sent beside a refusal. A platform
    // older than R155 ignores the extra field, which is how every other widening
    // on this channel has been done.
    { method: 'POST', body: { ok, result: capped(result), failure: ok ? null : failure } },
  ).catch((problem) => log(`  could not report the workspace request: ${problem.message}`));
}

/**
 * Whatever a person has asked of this machine's checkouts, taken and done.
 *
 * A poll of its own, and a fast one: these sit behind a button somebody is
 * watching, and riding the thirty-second heartbeat would mean pressing *Show
 * changes* and staring at a spinner for half a minute. It is one indexed read
 * of a table that is empty almost always — the cost of the cadence is a request
 * every few seconds, and the cost of not having it is a panel nobody uses.
 *
 * A path this daemon does not serve is refused rather than done. The platform
 * checked that the runner is yours; only this process knows which directories
 * it was actually given, and a request naming some other directory is one to
 * say no to rather than to run `git stash` in.
 *
 * `afterTheTreeMoved` (R218) is the daemon's own beat: awaited after a request
 * that changed a tree, before that request is reported finished, so the
 * platform holds the tree as it now is by the time the console hears "done".
 */
function watchWorkspaceRequests(config, { afterTheTreeMoved = null } = {}) {
  // Read on EVERY request, never captured once: a checkout cloned on demand
  // (`autoWorkspaces`) joins `project.workspaces` long after this started, and
  // a set taken at boot refused every request about one — `/pr` on a session
  // that ran in `saasng-auto-2` came back "This runner does not serve …".
  const served = () => new Set(
    Object.values(config.projects).flatMap((project) => project.workspaces ?? []),
  );

  const poll = async () => {
    const requests = await api(
      config,
      `/api/runners/${config.runnerId}/workspace-requests/claim`,
      { method: 'POST' },
    ).catch((failure) => {
      log(`could not read workspace requests: ${failure.message}`);
      return [];
    });

    // The same guard, for the same reason: this poll is on an interval, so a
    // throw becomes an unhandled rejection and the daemon stops.
    for (const request of Array.isArray(requests) ? requests : []) {
      if (!served().has(request.path)) {
        await reportWorkspaceRequest(config, request, false,
          `This runner does not serve ${request.path}.`);
        continue;
      }
      await performWorkspaceRequest(config, request, afterTheTreeMoved);
    }
  };

  return poll;
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
async function findPullRequest(cwd, branch, { declared = null, base = null } = {}) {
  const { host, adapter, originUrl } = await hostOf(cwd, declared);
  const viaCli = await adapter.find(cwd, branch);
  if (viaCli) {
    return viaCli;
  }

  // No CLI, or no PR yet. A compare URL is honest: it is where you would go to
  // open one, and it is obviously not a claim that one exists.
  const repo = repoOf(originUrl);
  const against = host === 'gitlab' && !base ? await defaultBranchOf(cwd) : base;
  return adapter.fallbackLink(repo, against, branch);
}

/**
 * Which host this checkout's origin is on, and the adapter that talks to it —
 * R379. `declared` is the project's own word (`GITHUB`/`GITLAB`), from the claim
 * or the request; with none, a GitLab-looking host is GitLab and everything else
 * is GitHub, as it has always been.
 */
async function hostOf(cwd, declared) {
  const originUrl = (await git(cwd, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
  const host = hostFor({ declared, originUrl });
  return { host, adapter: adapterFor(host), originUrl };
}

// --- what a project's rules asked for (R40) ----------------------------------
//
// Pushing, opening a pull request and merging happen HERE, and could not happen
// anywhere else: the platform holds no git-host credential and this process
// does. That is R19 and R25's division of labour, unchanged. What R40 adds is
// that the platform can now say it would like one of these done — as a
// run_action, on the queue R24 built for the Commit button, so that each one
// has a state, a result and a name in the console rather than being a sentence
// in a prompt the agent could ignore.
//
// Every one of them is refusable by this machine simply by not being able to do
// it, and says why when it cannot. A rule is a request, not a grant.

/** " (auto_pr)" — so the log says whose idea this was. */
function byRule(action) {
  return action.requestedByRule ? ` (${action.requestedByRule})` : '';
}

/**
 * What this project's rules will do when the run ends, said at claim time.
 *
 * Silence for a project with no rules, which is every project by default — a
 * daemon that logged "auto_push: no" four times per claim would train its
 * operator to stop reading. `auto_merge` gets a line of its own and a shouted
 * one, because it is the only rule here whose consequence cannot be undone by
 * clicking something afterwards.
 */
function announceRules(rules) {
  if (!rules) return; // An API older than R40. Nothing is queued, so nothing happens.
  const on = ['autoPush', 'autoPr', 'autoMerge', 'requireReview'].filter((name) => rules[name]);
  if (!on.length) return;
  log(`  this project's rules: ${on.join(', ')}`);
  if (rules.autoMerge) {
    // R306: not "when this run finishes" any more — the platform asks for the
    // merge when the branch reaches Done on the development board.
    log('  !! auto_merge is ON: its branch will be merged when it reaches Done on the '
      + 'board, with nobody reading it');
  }
}

/** The remote to push to. The first one, as `readPushState` also assumes. */
async function firstRemote(cwd) {
  const remotes = await git(cwd, ['remote']).catch(() => '');
  return remotes.split('\n')[0]?.trim() || null;
}


/**
 * The branch, on the remote.
 *
 * `--set-upstream` so the checkout can be used by hand afterwards, and
 * deliberately no `--force`: a rule that pushes should never be a rule that
 * overwrites somebody else's commits on the same branch. If the remote has
 * diverged, this fails and says so, which is the correct outcome.
 */
async function pushBranch(cwd, branch) {
  const remote = await firstRemote(cwd);
  if (!remote) {
    return { ok: false, result: 'No remote is configured in this checkout, so there is nowhere to push.' };
  }
  try {
    const said = await git(cwd, ['push', '--set-upstream', remote, branch]);
    return { ok: true, result: said || `${branch} → ${remote}` };
  } catch (failure) {
    return { ok: false, result: failure.message };
  }
}

/**
 * A pull request, opened rather than found.
 *
 * This is the line R25 wrote — "the PR is found, never created" — being
 * narrowly reopened, and it is worth being clear about what did and did not
 * change. R25 refused *cawdev* holding a git-host credential. It still does not
 * hold one. This runs on the machine whose `gh` is already authenticated, which
 * is where every other question about the git host has been answered since R19.
 *
 * It pushes first if the branch is not out yet: `gh pr create` cannot open a
 * request for a branch the host has never seen, and failing with the host's
 * wording of that would be a worse answer than simply doing the obvious thing.
 * An existing pull request is a success, not a conflict — the rule wanted one
 * to exist, and one does.
 */
/**
 * Why there is nothing to open a pull request FOR, or null when there is.
 *
 * A branch with no commit beyond its base is not a pull request — GitHub says
 * "There isn't anything to compare" — and before this `/pr` pushed it anyway
 * and handed back the compare link, so the person went to GitHub to learn
 * what this machine already knew. The usual reason is work sitting
 * UNCOMMITTED in the checkout, so that is counted and said, with where.
 *
 * Asked BEFORE anything is pushed, on the OPEN_PR a person asks for (`/pr`).
 * Not on the `auto_pr` rule: a finished run that committed nothing gets gh's
 * own refusal there, as it always has. A count that cannot be made (no such
 * ref, no origin) is not a verdict: null, and the old path decides as it did.
 */
async function nothingToPropose(cwd, branch, base) {
  const has = (ref) => git(cwd, ['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false);
  const tip = (await has(branch)) ? branch : (await has(`origin/${branch}`)) ? `origin/${branch}` : null;
  const against = base ? `origin/${base}` : 'origin/HEAD';
  if (!tip || !(await has(against))) return null;
  const ahead = Number(await git(cwd, ['rev-list', '--count', `${against}..${tip}`]).catch(() => 'x'));
  if (!Number.isFinite(ahead) || ahead > 0) return null;
  const dirty = (await git(cwd, ['status', '--porcelain']).catch(() => '')).split('\n').filter(Boolean).length;
  const onIt = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')) === branch;
  return `${branch} has no commit beyond ${against.replace(/^origin\//, '')}, so there is nothing to propose.`
    + (dirty && onIt
      ? ` ${dirty} file(s) are uncommitted in ${cwd} — commit them, then ask again.`
      : ' Nothing was pushed.');
}

async function openPullRequest(cwd, run, title) {
  const state = await readPushState(cwd, run.branch).catch(() => null);
  if (state === 'NO_REMOTE') {
    return { ok: false, result: 'No remote is configured in this checkout.' };
  }
  if (state !== 'PUSHED') {
    const pushed = await pushBranch(cwd, run.branch);
    if (!pushed.ok) {
      return { ok: false, result: `Could not push before opening it: ${pushed.result}` };
    }
  }

  return openPullRequestFor(cwd, {
    declared: run.gitHost ?? null,
    branch: run.branch,
    // R260. The sprint's branch, when the claim carried one; otherwise the
    // argv is byte for byte what it was and the host picks its own default.
    base: run.baseBranch ?? null,
    title: title?.trim() || run.label || run.branch,
    // The body says what opened it and why, because somebody will find this in
    // a review queue with no idea where it came from.
    body: `Opened by cawdev's \`auto_pr\` rule for **${run.label ?? run.branch}**.\n\n`
      + `Nobody clicked anything: this project's rules say a finished run opens a pull request. `
      + `The session's transcript, commits and reports are on the run in the cawdev console.`
      + (run.baseBranch ? `\n\nIts base is \`${run.baseBranch}\`, the branch of its sprint.` : ''),
  });
}

/**
 * The `gh pr create` itself, shared by the rule path above and R261's
 * `OPEN_PR` workspace request — one argv, so a sprint's pull request and a
 * card's are opened the same way. An existing pull request is a success, not
 * a conflict: whoever asked wanted one to exist, and one does. The URL is the
 * FIRST LINE of the result, the way `mergePullRequest` reports it, because the
 * platform reads that line as the evidence and nothing else.
 *
 * `--base` only when one is given: with no base the argv is byte for byte what
 * it was before R260 and the host picks its own default.
 */
/**
 * Pushes `branch` to origin when origin does not have it, or has an older
 * commit of it — and never otherwise.
 *
 * Before a pull request is opened for a branch a session wrote on this
 * machine: `gh pr create --head` names a branch on the HOST, and one that only
 * exists here fails with a message about the head that says nothing of why.
 * Only a fast-forward is pushed. Origin ahead, or diverged, is somebody else's
 * work on the branch, and pushing over it is not what "open the pull request"
 * asked for — that case goes to gh as it is and gh says what is wrong. Nothing
 * here moves the checkout: it is `<branch>:<branch>`, not the current HEAD.
 *
 * @returns `{ said }` when it pushed, `{}` when there was nothing to push, and
 *   `{ failed }` when a push was needed and git refused it.
 */
async function pushIfOriginLacks(cwd, branch) {
  const local = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    .catch(() => null);
  if (!local) {
    return {};
  }
  const listed = await git(cwd, ['ls-remote', '--heads', 'origin', branch]).catch(() => null);
  if (listed === null) {
    return {};
  }
  const remote = listed.split(/\s+/)[0] || null;
  if (remote === local) {
    return {};
  }
  if (remote) {
    const behind = await git(cwd, ['merge-base', '--is-ancestor', remote, local])
      .then(() => true, () => false);
    if (!behind) {
      return {};
    }
  }
  try {
    await git(cwd, ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: 120_000 });
    log(`  pushed ${branch} to origin first`);
    return { said: `pushed ${branch} to origin first` };
  } catch (failure) {
    return { failed: `Could not push ${branch} before opening its pull request: ${failure.message}` };
  }
}

async function openPullRequestFor(cwd, { branch, base, title, body, declared = null }) {
  const { adapter } = await hostOf(cwd, declared);
  const existing = await findPullRequest(cwd, branch, { declared, base }).catch(() => null);
  if (existing && !existing.includes('/compare/')) {
    return { ok: true, result: existing };
  }

  // R379: `gh pr create` or `glab mr create`; for GitHub it is the argv it always was.
  const opened = await adapter.create(cwd, { branch, base, title, body });
  if (opened.code === 0 && opened.out) {
    // The CLI prints the URL and the host is then asked whether it is really
    // there, because "asked for" is not "made", and a URL on the card that
    // 404s is worse than an honest failure.
    const printed = adapter.urlOf(opened);
    const confirmed = await findPullRequest(cwd, branch, { declared, base }).catch(() => null);
    if (confirmed && !confirmed.includes('/compare/')) {
      return { ok: true, result: confirmed };
    }
    return {
      ok: false,
      result: `${adapter.bin} said it opened ${printed}, but the host does not show a ${adapter.noun} for ${branch}.`,
    };
  }
  // The one failure somebody can fix in a minute, said with the fix — and the
  // link to open it by hand meanwhile, which `findPullRequest` builds without the CLI.
  if (opened.code === -1 && /not installed/.test(opened.err)) {
    const compare = await findPullRequest(cwd, branch, { declared, base }).catch(() => null);
    return {
      ok: false,
      result: `${opened.err} Install it and sign in (${adapter.installHint}), `
        + `then ask again${compare ? ` — or open it yourself: ${compare}` : '.'}`,
    };
  }
  return { ok: false, result: opened.err || opened.out || `${adapter.bin} ${adapter.name === 'gitlab' ? 'mr' : 'pr'} create failed without saying why.` };
}

/**
 * And merging it, with nobody reading the diff.
 *
 * The most dangerous eight lines in this file, and they are only ever reached
 * because somebody with OWNER on a project deliberately turned on a rule that
 * says so on a page that spells out what it does. It is refused outright while
 * that project requires review — in the API and in a database check constraint
 * both — so this cannot be how a review gets skipped.
 *
 * `--squash` because a rule-merged branch should land as one commit somebody
 * can revert, and `--delete-branch` because a branch merged by a machine is a
 * branch nobody is coming back to.
 *
 * R134 reaches the same function from the development board's Merge button,
 * unchanged in what it does: a rule-merged branch and a hand-merged one should
 * land the same way.
 *
 * **Except a sprint's branch — R261.** Nine card branches squashed onto
 * `s1-notifications` are nine commits, and squashing that onto the default
 * would collapse them into one nobody can revert on its own. The claim says
 * `mergeMethod: 'MERGE_COMMIT'` for a sprint item's merge and nothing for every
 * other, so a project with no sprints produces byte for byte the argv it did.
 * The second line of the result says which happened, and the platform quotes
 * it on every card of the sprint — the only way a daemon too old to read
 * `mergeMethod` (it would squash, silently) is ever noticed. (The release
 * convention wants a merge commit for a release branch too, for the same
 * reason; release branches are not worked through the development board
 * today, and if that changes this is the line that has to change with it.)
 *
 * **It waits out GitHub's not-yet-computed mergeability — R306.** The host
 * computes whether a pull request can merge lazily, and `gh pr merge` seconds
 * after `gh pr create` — which is exactly when a rule's merge arrives on a
 * project nobody reads first — can fail for no reason a person can act on.
 * So before merging, `gh pr view --json mergeable` is asked, and while it says
 * `UNKNOWN` this waits, bounded (`MERGEABILITY_POLLS` × `mergeabilityWaitMs()`),
 * for the rule, the board's button and a person's press alike. Any other
 * answer — `MERGEABLE`, `CONFLICTING`, an error, something that is not JSON —
 * proceeds at once: the merge itself is what says whether it could, and
 * `classifyMergeFailure` is unchanged.
 */
const MERGEABILITY_POLLS = 6;

/** Between two mergeability questions. Five seconds, unless the environment says otherwise — `gateTimeoutSeconds`'s shape. */
function mergeabilityWaitMs() {
  const configured = Number(process.env.CAWDEV_MERGEABILITY_WAIT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 5000;
}

async function mergePullRequest(cwd, branch, { method = null, declared = null } = {}) {
  const { adapter } = await hostOf(cwd, declared);
  const url = await findPullRequest(cwd, branch, { declared }).catch(() => null);
  if (!url || url.includes('/compare/')) {
    // R379. On GitLab a missing `glab` looks exactly like "no merge request" —
    // the lookup that would have found it never ran. Said as what it is.
    if (adapter.name === 'gitlab') {
      const probe = await adapter.run(cwd, ['--version']);
      if (probe.code === -1) {
        return { ok: false, failure: 'UNREACHABLE', result: probe.err };
      }
    }
    return {
      ok: false,
      failure: 'NO_PULL_REQUEST',
      result: 'There is no pull request for this branch to merge. Nothing was merged.',
    };
  }
  await waitOutUnknownMergeability(cwd, url, branch, adapter);
  const mergeCommit = method === 'MERGE_COMMIT';
  const merged = await adapter.merge(cwd, url, { mergeCommit });
  if (merged.code === 0) {
    // The URL on its own FIRST LINE — R134. The platform reads that line as the
    // evidence a merge happened and puts it on the card as the card's `merge`
    // field, which `MERGED` refuses to be blank. The sentence after it is for
    // whoever reads the result as text, which is what the run-action path does
    // — and, since R261, what the landing comment on a sprint's cards quotes.
    return {
      ok: true,
      failure: null,
      result: `${url}\n${mergeCommit ? 'merged with a merge commit' : 'squashed and merged'}; the branch is deleted.`,
    };
  }
  return {
    ok: false,
    // R155. WHICH kind of failure, so the console can offer Merge with an agent
    // on the one an agent can fix and stay quiet on the three it cannot.
    failure: await classifyMergeFailure(cwd, url, merged, adapter),
    // Unchanged: `gh`'s own words still reach the card. The classification is a
    // word beside them, never a replacement for them.
    result: merged.err || merged.out || `${adapter.bin} ${adapter.name === 'gitlab' ? 'mr' : 'pr'} merge failed without saying why.`,
  };
}

/**
 * While the host has not yet said whether the pull request can merge, wait —
 * bounded. See `mergePullRequest`. One log line if it waited at all, so a
 * merge that took thirty seconds says why.
 */
async function waitOutUnknownMergeability(cwd, url, branch, adapter) {
  let waited = 0;
  for (let poll = 0; poll < MERGEABILITY_POLLS; poll++) {
    // `UNKNOWN` is the only answer worth waiting out; an error, something that
    // is not JSON or any other word proceeds at once (the adapter says which).
    if ((await adapter.mergeability(cwd, url)) !== 'UNKNOWN') {
      if (waited) log(`  ${branch}: mergeability known after ${waited}s`);
      return;
    }
    await sleep(mergeabilityWaitMs());
    waited += mergeabilityWaitMs() / 1000;
  }
  log(`  ${branch}: the host still has not computed mergeability after ${waited}s; merging anyway`);
}

/**
 * Whether a tag exists ON THE REMOTE — R156.
 *
 * <p>The remote, not this clone, and the distinction is the whole point: a
 * local tag nobody pushed is exactly the state a release is trying to rule out,
 * and `git tag --list` cannot tell the two apart. `git ls-remote` asks the
 * host, which is also why any clone of the repository can answer — there is
 * nothing about this working tree that matters.
 *
 * <p>A read. It fetches nothing, writes nothing, and moves no ref.
 *
 * <p><strong>The SHA is the FIRST LINE</strong>, because the platform refuses
 * to believe `ok: true` without evidence it can parse — the rule
 * `WorkItemMergeService.evidenceIn` states for a merge, in the shape a tag
 * needs. A machine's word is not evidence; the sha is.
 *
 * <p>A tag that is not there comes back `ok: false` with a sentence, and that
 * is a LEGITIMATE ANSWER rather than an error: the release procedure pushes the
 * tag last, so the first check — queued seconds after somebody presses Release
 * — correctly finds nothing. That sentence is what a person reads mid-release.
 */
async function tagOnTheRemote(cwd, version) {
  // The fully-qualified ref, so `v0.6.1` cannot match a BRANCH called v0.6.1.
  const ref = `refs/tags/${version}`;
  let out;
  try {
    out = await git(cwd, ['ls-remote', '--tags', 'origin', ref]);
  } catch (failure) {
    // No remote, no network, no permission. Said as it was said: this daemon
    // has no more idea than the platform which of those it was, and inventing
    // a classification would be inventing one.
    return { ok: false, result: `Could not ask the remote about ${version}: ${failure.message}` };
  }

  // `ls-remote` prints "<sha><TAB><ref>" per line, and nothing at all when the
  // tag is absent — an empty answer with exit 0, which is why an absent tag
  // cannot be told from a failure by the exit code.
  const lines = out.split('\n').map((each) => each.trim()).filter(Boolean);
  // An annotated tag also answers `refs/tags/<v>^{}` — the commit it points at.
  // Either is proof the tag is on the remote; the plain ref is preferred, so the
  // sha reported is the TAG's, which is what `git show <v>` resolves.
  const line = lines.find((each) => each.endsWith(`\t${ref}`)) ?? lines[0];
  const sha = line ? line.split(/\s+/)[0] : null;

  if (!sha) {
    return { ok: false, result: `There is no tag ${version} on the remote yet.` };
  }
  return { ok: true, result: `${sha}\n${version} is on the remote.` };
}

/**
 * Puts a sprint's branch on origin — R260's `CUT_BRANCH`.
 *
 * `git push origin origin/<default>:refs/heads/<name>`: the source is the
 * REMOTE default's tip as of the fetch, not this checkout's, so what the
 * sprint's cards are cut from is what everyone else has. Already there is
 * `ok: true` — the request wanted the branch to exist and it does — and the
 * sha reported is wherever it is, which may not be the default's tip.
 */
async function cutBranchOnOrigin(cwd, name, defaultBranch) {
  const base = defaultBranch || 'main';
  const ref = `refs/heads/${name}`;
  await git(cwd, ['fetch', '--prune', 'origin']).catch((failure) => {
    log(`  fetch skipped: ${failure.message.split('\n')[0]}`);
  });

  let there;
  try {
    there = await git(cwd, ['ls-remote', '--heads', 'origin', ref]);
  } catch (failure) {
    return { ok: false, result: `Could not ask the remote about ${name}: ${failure.message}` };
  }
  const already = there.split('\n').map((each) => each.trim()).filter(Boolean)
    .find((each) => each.endsWith(`\t${ref}`));
  if (already) {
    const sha = already.split(/\s+/)[0];
    return { ok: true, result: `${sha}\n${name} is already on origin at ${sha.slice(0, 7)}.` };
  }

  const from = `origin/${base}`;
  let tip;
  try {
    tip = await git(cwd, ['rev-parse', '--verify', from]);
  } catch {
    return { ok: false, result: `${from} is not in this checkout, so there is nothing to cut ${name} from.` };
  }
  try {
    await git(cwd, ['push', 'origin', `${from}:${ref}`]);
  } catch (failure) {
    return { ok: false, result: `Could not push ${name}: ${failure.message}` };
  }
  return { ok: true, result: `${tip}\n${name} cut from ${from} at ${tip.slice(0, 7)}.` };
}

/**
 * Creates a branch on origin, cut from another — R379's `CREATE_BRANCH`.
 *
 * Order matters: the name is checked before anything is asked of the remote,
 * an existing name is refused whatever it points at, and the source is read
 * from `origin/<from>` after a fetch — what everyone else has, not this
 * checkout's idea of it. The sha is the FIRST LINE of an ok result, the way a
 * tag check reports it, because the platform does not take a machine's word.
 */
async function createBranchOnOrigin(cwd, name, from) {
  await git(cwd, ['fetch', '--prune', 'origin']).catch((failure) => {
    log(`  fetch skipped: ${failure.message.split('\n')[0]}`);
  });
  try {
    await git(cwd, ['check-ref-format', '--branch', name]);
    // `@{-1}` passes check-ref-format --branch (it expands), but is no name.
    if (/[~^@]/.test(name)) throw new Error('not a name');
  } catch {
    return { ok: false, result: `\`${name}\` is not a branch name git accepts. Nothing was created.` };
  }

  const ref = `refs/heads/${name}`;
  let there;
  try {
    there = await git(cwd, ['ls-remote', '--heads', 'origin', ref]);
  } catch (failure) {
    return { ok: false, result: `Could not ask the remote about ${name}: ${failure.message}` };
  }
  const already = there.split('\n').map((each) => each.trim()).filter(Boolean)
    .find((each) => each.endsWith(`\t${ref}`));
  if (already) {
    return {
      ok: false,
      result: `\`${name}\` is already on origin at ${already.split(/\s+/)[0].slice(0, 7)}. Nothing was created.`,
    };
  }

  // `from` is a branch NAME: `main~3` or `main@{1}` would resolve and be pushed.
  try {
    await git(cwd, ['check-ref-format', '--branch', from]);
  } catch {
    return { ok: false, result: `\`${from}\` is not a branch name git accepts. Nothing was created.` };
  }
  if (/[~^@]/.test(from)) {
    return { ok: false, result: `\`${from}\` is not a branch name. Nothing was created.` };
  }
  const source = `origin/${from}`;
  let tip;
  try {
    tip = (await git(cwd, ['rev-parse', '--verify', `${source}^{commit}`])).trim();
  } catch {
    return { ok: false, result: `${source} is not on origin, so there is nothing to create \`${name}\` from.` };
  }
  try {
    await git(cwd, ['push', 'origin', `${source}:${ref}`]);
  } catch (failure) {
    return { ok: false, result: `Could not push ${name}: ${failure.message}` };
  }
  return { ok: true, result: `${tip}\n${name} created from ${from} at ${tip.slice(0, 7)}.` };
}

/**
 * Why `gh pr merge` said no — R155, in one of five words.
 *
 * <p>**On the runner, deliberately.** `WorkspaceRequestService`'s javadoc
 * already argues that a platform parsing this text would be a platform with an
 * opinion about a git version it does not run. This machine has `gh`, so it can
 * simply ask it rather than reading its prose.
 *
 * <p>`mergeable: CONFLICTING` is the documented field and is what decides it.
 * **`UNKNOWN` is treated as unknown and not as "no conflict"**, which matters
 * more than it looks: GitHub computes mergeability lazily, so a pull request
 * nobody has looked at recently answers UNKNOWN, and reading that as "not a
 * conflict" is the one way this feature disappears silently. Unknown comes back
 * as OTHER, and the console offers the action for OTHER for the same reason it
 * offers it for a null — the cost of being wrong is one `git fetch`.
 */
async function classifyMergeFailure(cwd, url, merged, adapter) {
  // No process at all, or the host was unreachable. The CLI runner reports a
  // spawn error as code -1, which covers "gh/glab is not installed" as well.
  if (merged.code === -1 || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|could not resolve host|network is unreachable/i
      .test(`${merged.err} ${merged.out}`)) {
    return 'UNREACHABLE';
  }
  if (/\b403\b|not authorized|permission|protected branch|required status check|review required/i
      .test(`${merged.err} ${merged.out}`)) {
    return 'NOT_PERMITTED';
  }

  // Asked of the host's own CLI (R379: through the adapter). A failure to
  // answer is not an answer, so it falls through to OTHER rather than
  // inventing one.
  return (await adapter.refusal(cwd, url)) ?? 'OTHER';
}

/**
 * One last pass over the action queue, after the session has ended.
 *
 * `watchWorkingCopy` stops when the child does, and the rules queue their work
 * at exactly that moment — the run reaching FINISHED is what creates it. Without
 * this, an `auto_pr` project would queue a pull request that nothing ever came
 * back for, and the run would sit there claiming it was about to be published.
 *
 * Bounded rather than looped: these are the actions the run's own ending
 * produced, and if the platform has more to say it can say it to the next run.
 */
async function settleActions(config, run, cwd) {
  const actions = await api(
    config,
    `/api/projects/${run.projectSlug}/runs/${run.id}/actions/claim`,
    { method: 'POST' },
  ).catch((failure) => {
    log(`  could not read the closing actions: ${failure.message}`);
    return [];
  });

  // Array.isArray rather than `?? []`: this runs on the last breath of a run,
  // inside an exit handler, and a platform older than R40 — or one that
  // answered with something else entirely — must not be the thing that throws
  // out of it. "Nothing was queued" is both the common case and the safe
  // reading of anything that is not a list.
  if (!Array.isArray(actions)) {
    return;
  }
  for (const action of actions) {
    await perform(config, run, cwd, action);
  }
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
    // `close`, not `exit` — see git() above.
    child.on('close', (code) => resolvePromise(code === 0 ? text.trim() : null));
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
 * What `gh` says about a hand-taken branch's pull request — R346.
 *
 * `pr list --head`, not `pr view <branch>`: the latter stops finding the pull
 * request once the branch is deleted, and this matches on the pull request's own
 * head branch name, which does not change. Fork pull requests are dropped: a
 * fork's branch of the same name is not this branch.
 *
 * A merged pull request opened-after `openedAt` wins (latest merge first); a
 * reused branch name can bring back an older one, which the platform also
 * refuses. Otherwise the highest-numbered row speaks.
 */
async function askGitHubForBranch(cwd, branch, openedAt) {
  if (!branch) {
    return null;
  }
  const out = await new Promise((resolvePromise) => {
    const child = spawn(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '10', '--json',
        'number,url,state,mergedAt,mergeCommit,baseRefName,headRefName,isCrossRepository'],
      { cwd, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let text = '';
    child.stdout.on('data', (chunk) => (text += chunk));
    child.on('error', () => resolvePromise(null));
    child.on('close', (code) => resolvePromise(code === 0 ? text.trim() : null));
  });
  const parsed = out ? safeJson(out) : null;
  if (!Array.isArray(parsed)) {
    return null;
  }
  const own = parsed.filter((row) => row && !row.isCrossRepository && row.headRefName === branch);
  if (!own.length) {
    return null;
  }
  const since = openedAt ? Date.parse(openedAt) : Number.NEGATIVE_INFINITY;
  const merged = own
    .filter((row) => row.state === 'MERGED' && Date.parse(row.mergedAt) >= since)
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  const chosen = merged[0] ?? [...own].sort((a, b) => b.number - a.number)[0];
  if (chosen.state === 'MERGED' && !merged.length) {
    return null; // Only a merge from before the item existed: not this item's.
  }
  const state = { OPEN: 'OPEN', MERGED: 'MERGED', CLOSED: 'CLOSED' }[chosen.state];
  if (!state) {
    return null;
  }
  return {
    state,
    prUrl: chosen.url ?? null,
    mergeCommit: chosen.mergeCommit?.oid ?? null,
    mergedAt: chosen.mergedAt ?? null,
    baseRefName: chosen.baseRefName ?? null,
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
    //
    // `exit` is right here, and it is the only place it is: nothing is piped,
    // so there is no output to lose. Everything that captures output waits for
    // `close` instead — see git().
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
async function readMergeState(cwd, { branch, defaultBranch, baseBranch, head, prUrl }) {
  const viaGh = await askGitHub(cwd, branch, prUrl).catch(() => null);
  if (viaGh) {
    return viaGh;
  }

  // R260: landed means landed on the branch's BASE — the sprint's branch when
  // it has one. The gh path above already reads the pull request wherever it
  // points; this is the fallback's half of the same rule.
  const viaGit = await askGit(cwd, head, baseBranch ?? defaultBranch)
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
  // One fetch per project, not one per branch: twenty-five branches in one
  // repository are twenty-five questions about the same set of refs.
  const fetched = new Set();
  if (pending?.length) {
    await checkRunMerges(config, pending, fetched);
  }
  // R346: the hand-taken items, even when no run is pending.
  await checkWorkItemMerges(config, fetched);
}

/** The run pass of `checkMerges`: one reading per pending run branch. */
async function checkRunMerges(config, pending, fetched) {
  const readings = [];

  for (const branch of pending) {
    const project = config.projects[branch.projectSlug];
    if (!project) {
      continue; // Not ours to answer for.
    }
    // Same argument as the git survey: read a checkout nobody is working in.
    const heldNow = heldWorkspaces();
    const cwd = (await usableWorkspace(project, heldNow, new Map()))
      ?? resolve(project.path);

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

/**
 * R346: the hand-taken items. A squash or rebase merge leaves no head on the
 * default branch for the git reading to find, so ask `gh` about the pull
 * request. An older platform answers 404 and this returns in silence.
 */
async function checkWorkItemMerges(config, fetched) {
  const pending = await api(config, `/api/runners/${config.runnerId}/work-item-branches`)
    .catch(() => null);
  if (!Array.isArray(pending) || !pending.length) {
    return;
  }
  const readings = [];
  for (const item of pending) {
    const project = config.projects[item.projectSlug];
    if (!project) {
      // Not ours, but say so: an UNKNOWN only stamps the platform's rotation,
      // and silence would leave these rows first in the queue for ever.
      readings.push({ workItemId: item.workItemId, state: 'UNKNOWN' });
      continue;
    }
    const heldNow = heldWorkspaces();
    const cwd = (await usableWorkspace(project, heldNow, new Map()))
      ?? resolve(project.path);
    try {
      await access(join(cwd, '.git'));
    } catch {
      readings.push({ workItemId: item.workItemId, state: 'UNKNOWN' });
      continue;
    }
    if (!fetched.has(cwd)) {
      fetched.add(cwd);
      await git(cwd, ['fetch', '--prune', 'origin']).catch(() => null);
    }
    const reading = await askGitHubForBranch(cwd, item.branch, item.openedAt).catch(() => null);
    readings.push({
      workItemId: item.workItemId,
      state: reading?.state ?? 'UNKNOWN',
      prUrl: reading?.prUrl ?? null,
      mergeCommit: reading?.mergeCommit ?? null,
      mergedAt: reading?.mergedAt ?? null,
      baseRefName: reading?.baseRefName ?? null,
    });
  }
  if (!readings.length) {
    return;
  }
  const recorded = await api(config, `/api/runners/${config.runnerId}/work-item-merges`, {
    method: 'POST',
    body: { readings },
  }).catch((failure) => {
    log(`could not record what became of the hand-taken branches: ${failure.message}`);
    return null;
  });
  if (recorded?.merged?.length) {
    log(`${recorded.merged.length} hand-taken branch(es) have merged`);
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
    ? await findPullRequest(cwd, run.branch, { declared: run.gitHost ?? null, base: run.baseBranch ?? null }).catch(() => null)
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

/**
 * The cawdev tools a profile that must change nothing may hold.
 *
 * <p>This was a regex over the END of the name — anything not finishing in
 * `create`, `update`, `set_status`, `decline` or `add` was a read. It was right
 * about every tool that existed when it was written, and it fails in the one
 * direction that matters: a writer whose name ends in a noun is silently a read.
 * `roadmap_comment` is exactly that tool, and adding it to the defaults above
 * would have quietly handed the roadmap's discussion to ASK, AUDIT and PLAN.
 *
 * <p>So the list is the READS (`CAWDEV_READS`, beside `canChangeThings` because
 * they answer one question) and everything else is a write. A tool added above
 * and forgotten there is missing from the read-only profiles, which is a session
 * saying out loud that it cannot do something rather than one quietly doing it.
 */
const READ_ONLY_CAWDEV = CAWDEV_TOOLS.filter(
  (tool) => CAWDEV_READS.has(tool.slice('mcp__cawdev__'.length)),
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

/**
 * Where a project's brief lives — R96.
 *
 * The platform is the authority and sends it with the claim (`claimed.brief`).
 * This is the same constant for the one place no claim is in hand: the git
 * survey, which reports whether a repository already has a brief so the console
 * knows whether to offer an interview.
 */
const BRIEF = {
  path: 'docs/brief',
  index: 'docs/brief/README.md',
};

/** What an interview may write, and nothing else — R96. */
function briefWrites(run) {
  const path = run?.brief?.path || BRIEF.path;
  // Both verbs, because Claude Code writes a new file with one and changes an
  // existing one with the other, and an interview run twice does both.
  return [`Write(${path}/**)`, `Edit(${path}/**)`];
}

/**
 * What a MERGE session may write, and nothing else — R155.
 *
 * `briefWrites`' shape, narrowed per RUN rather than per profile, and that is
 * the whole idea: the daemon has already done the `git merge` by the time this
 * is called, so the list is the files git actually put conflict markers in on
 * THIS branch on THIS attempt. A session cannot edit a file git did not
 * conflict on, and "the agent resolves the conflict and nothing else" is a
 * permission rather than a sentence in a prompt.
 *
 * Both verbs for `briefWrites`' stated reason. A conflicted file always exists,
 * so `Edit` is the one that matters — `Write` is here because a resolution that
 * rewrites a file whole is a legitimate resolution and discovering it cannot
 * costs the session a turn and a refusal.
 *
 * An empty list is not a fallback to "anything": a run with nothing conflicted
 * never gets here, because the daemon finishes it without spawning.
 */
function conflictedWrites(run) {
  const files = Array.isArray(run?.conflictedFiles) ? run.conflictedFiles : [];
  return files.flatMap((path) => [`Write(${path})`, `Edit(${path})`]);
}

/**
 * `Write`/`Edit` for the version files a RELEASE session may touch — R187.
 *
 * `conflictedWrites`' shape, with the list decided by the PLATFORM rather than
 * by git: the claim carries the paths the release procedure bumps a version in,
 * and the prompt's step 4 is built from the same list, so the instruction and
 * the permission cannot name different files. Since i189 that list is the
 * project's own, declared by an owner on its settings page — never read from
 * a file in the checkout, which whoever last committed there would have set.
 *
 * An empty list is not a fallback to "anything". A platform too old to send it,
 * or a project that declares no version files, yields a session that cannot
 * bump the version and says so in its report — which is the legible failure,
 * and a far better one than a release session that could write wherever it
 * liked because the list was missing.
 */
function releaseWrites(run) {
  const files = Array.isArray(run?.releaseWrites) ? run.releaseWrites : [];
  return files.flatMap((path) => [`Write(${path})`, `Edit(${path})`]);
}

/**
 * Everything under `mcp__cawdev__` that WAITS ON A PERSON.
 *
 * `CAWDEV_READS` holds all five, correctly — asking somebody something changes
 * nothing, so they are reads. This is a second, narrower question asked of the
 * same names: which of them park the run until somebody answers.
 */
const CAWDEV_WAITS_ON_A_PERSON = [
  'mcp__cawdev__ask_user',
  'mcp__cawdev__await_answer',
  'mcp__cawdev__ask_group',
  'mcp__cawdev__await_group',
  'mcp__cawdev__await_more_rounds',
];

/**
 * The cawdev tools a merge session gets — R155, narrowed by i167.
 *
 * The read-only set, minus the ones that wait on a person — WHATEVER the
 * project's rule says. R155 handed `ask_user` to a session whose resolution
 * waited to be read, and told it to ask; the person answered "land it" and
 * nothing read the answer, because the platform had not asked the question. The
 * platform asks now, on the run, once the session has pushed and ended, and
 * recognises its own question's answer. A session that could still ask would
 * produce a second question beside that one, in an inbox, with an answer that
 * lands nothing — which is the bug wearing a different sentence.
 *
 * A subtraction rather than an addition, and that is not a detail: `ask_user`
 * and `await_answer` are already IN `READ_ONLY_CAWDEV`, so adding them would be
 * a no-op and the absence would silently never hold. Which is exactly what the
 * first draft of this did, and what `agent-merge.test.mjs` caught.
 *
 * Takes the run for the same reason `PROFILE_TOOLS.MERGE` passes it: the
 * signature is the seam the test exercises, and a rule that stops mattering
 * here is not a rule that stops being sent.
 */
function mergeCawdevTools(run) {
  return READ_ONLY_CAWDEV.filter((tool) => !CAWDEV_WAITS_ON_A_PERSON.includes(tool));
}

/**
 * The tool a session delegates with — R104, and the reason its experts were
 * never reached.
 *
 * The platform picks a run's experts by ACTION and the daemon writes them into
 * a plugin directory, both correctly. Nothing allowed the tool that calls one.
 * A session spawned with `--setting-sources ''` gets exactly the list it is
 * handed, `Agent` was in no profile's list and in no default, so every expert
 * on every project was loaded and unreachable — the symptom `run-plugin.mjs`
 * names in its own header: *a session that quietly does not delegate.*
 *
 * `Agent` is the name on **Claude Code 2.1.263**, checked against the running
 * binary rather than remembered; `Task` is what older builds called it and is
 * matched wherever this is recognised, so a machine on an older CLI is not
 * silently narrowed.
 */
const DELEGATE = 'Agent';

/**
 * The profile's tools, plus delegation when this run has somebody to delegate
 * TO.
 *
 * <p>Conditional on purpose, and it is the sentence the entry asks for: a
 * project with no experts turned on runs exactly as it did before, and a
 * project with one gets the tool that reaches it. Handing `Agent` to a session
 * with an empty plugin directory offers a capability with nothing behind it,
 * which is how a run spends a turn discovering there is nobody to ask.
 *
 * <p>Read-only stages drop it again in `toolsForStage`, because
 * `canChangeThings` knows delegation is a writer. This function does not need
 * to know that, and should not: one place decides what a stage may hold.
 */
function withDelegation(tools, expertAgents) {
  const list = Array.isArray(tools) ? tools : [];
  if (!expertAgents?.length || list.includes(DELEGATE)) {
    return list;
  }
  return [...list, DELEGATE];
}

/** The tool that invokes a skill — R105, allowed by nothing until R130. */
const INVOKE_SKILL = 'Skill';

/**
 * The same, for the skills this run was handed — R130.
 *
 * <p>Conditional on exactly the argument above: a project with no skills is
 * spawned as it always was, and a project with one gets the tool that reaches
 * it.
 *
 * <p><strong>This was the R104 bug, repeated.</strong> `skillsFor` hands skills
 * to every profile that reads code — PLAN, REVIEW, AUDIT and INTERVIEW as well
 * as CODE — and `Skill` was in no PROFILE_TOOLS list, in no default, and
 * `argsForProfile` strips `--permission-prompt-tool` from every non-CODE
 * profile, so there was not even a person to ask. A skill was written into the
 * plugin directory and could not be invoked, silently: `run-plugin.mjs`'s own
 * header names the symptom for experts, and it was true of skills too.
 *
 * <p>A skill is NOT a writer, and `canChangeThings('Skill')` stays false: it is
 * a body of instructions, and a session holding `Skill` and no `Write` still
 * cannot write. So a read-only stage keeps it, which is the point — reading and
 * planning is most of what a skill is for.
 */
function withSkills(tools, skills) {
  const list = Array.isArray(tools) ? tools : [];
  if (!skills?.length || list.includes(INVOKE_SKILL)) {
    return list;
  }
  return [...list, INVOKE_SKILL];
}

const PROFILE_TOOLS = {
  ASK: READ_ONLY_CAWDEV,
  // R104's profile, and it was MISSING from this table until R112 — so a review
  // run fell through to `?? READ_ONLY_CAWDEV` and could not read a file, let
  // alone a diff. A profile with no entry here does not fail loudly; it runs
  // with the narrowest list in the file and reports that it could not do the
  // work, which is the least legible way for this to go wrong.
  //
  // A review writes ONE thing: its findings, as comments on the card. That is
  // the profile's entire output — R117's "what it leaves behind" — and it was
  // the one tool the list did not have, while the prompt below told the session
  // to use it. "Writes nothing" was true of the code and the card's status and
  // got applied to the discussion as well, which left a reviewer that could
  // read everything and say nothing.
  //
  // Everything else stays shut. `git` is read-only on purpose — the diff is the
  // subject, and a reviewer that could commit is a reviewer that could fix what
  // it was asked to judge — and there is still no set_status here, because
  // `DONE` is the person's word (R74) and a reviewer that could move the card
  // would be giving the verdict it is explicitly told not to give.
  REVIEW: [
    ...READ_ONLY_CAWDEV,
    'mcp__cawdev__roadmap_comment',
    ...READ_FILES,
    ...GIT_READS,
  ],
  // R150. Retired: nothing new starts on this profile — the platform refuses
  // it — and it is kept here so a session interrupted before the release and
  // resumed after it is still spawnable.
  ROADMAP: ROADMAP_WRITE_CAWDEV,
  AUDIT: [...READ_ONLY_CAWDEV, 'mcp__cawdev__propose_entry', ...READ_FILES],
  // R227. Scope your idea: AUDIT's list, name for name. It reads the code
  // and the roadmap, proposes the cards it cut an idea into, and can write
  // nothing — not a file, not an entry. What differs from an audit is the
  // prompt, and the prompt is not where a permission lives. Its own key here
  // rather than an alias, because a profile with no entry falls through to
  // `?? READ_ONLY_CAWDEV` and loses `propose_entry` silently — R112's lesson.
  SCOPE: [...READ_ONLY_CAWDEV, 'mcp__cawdev__propose_entry', ...READ_FILES],
  // R124's plan phase. AUDIT's list without `propose_entry`: it reads the
  // repository and the card, and writes NOTHING — not the code, not the
  // roadmap, not even the plan.
  //
  // That last one is the part worth stating. The plan of record is written by
  // the PLATFORM when this run finishes, from the stage's own artefact, rather
  // than by the session calling a tool. R108's argument: a phase that must not
  // write should not be handed a writer to do its own bookkeeping with, because
  // then it has a writer.
  //
  // `git` is read-only for REVIEW's reason — the code as it stands is the
  // subject, and a planner that could commit is a planner that could start.
  //
  // R150 corrects the "not the roadmap" above for exactly one case, and it is
  // narrower than it sounds: a plan run started with NO CARD gets
  // `roadmap_create` and nothing else. The thing it is planning does not exist
  // yet, so writing it is the first step of planning it rather than a widening.
  // Note what is still absent — `roadmap_update`, `roadmap_set_status`,
  // `roadmap_comment`, and every tool that touches a file. The plan of record is
  // still the PLATFORM's to write, and a plan run that HAS a card gets exactly
  // the list it always had.
  //
  // A function of the run for INTERVIEW's reason: both call sites already
  // accept one. `entryNumber` is null on the claim of a cardless plan run —
  // `ClaimedRunView` wraps `presenter.of(run)` — so nothing new crosses the API
  // to say this.
  //
  // R198: a plan run on an ISSUE (a confirm) is handed exactly this list. What
  // differs is one paragraph of prompt, not a tool — the "ended without a plan"
  // note on the issue is the platform's to write, for the reason above.
  // R302. Less the reads that need the work to exist — `quality_get` — the
  // same narrowing `toolsForStage` applies to a walk's PLAN stage, by the same
  // name: a plan run spawned as one process comes through here and not there.
  PLAN: (run) => [
    ...beforeTheWorkExists(READ_ONLY_CAWDEV),
    ...READ_FILES,
    ...GIT_READS,
    ...(run?.entryNumber ? [] : [CARD_WRITE]),
  ],
  // R96. Read the whole repository, ask in rounds, write the brief, commit it.
  //
  // The narrowing is HERE and not in the prompt, which is the whole reason the
  // interview is a profile: a session that can rewrite the code and is asked
  // not to is one refusal away from rewriting it. `Bash(git *)` is on the same
  // grounds as CODE's — the prompt tells it to commit, so the permissions must
  // let it — and it is git and nothing else.
  // R155. The narrowest list in this file, and the only one computed from what
  // happened on THIS run rather than from what the profile is.
  //
  // Read everything, `git` in full — the prompt tells it to commit and push, so
  // the permissions must let it — and `Write`/`Edit` for the conflicted files
  // and NOTHING ELSE. There is no `gh`, in any form: `Bash(git *)` cannot reach
  // it, and that is what makes "it cannot land its own resolution" true rather
  // than merely asked for. Whether the resolution lands is the PLATFORM's, from
  // the project's rule, through R134's existing merge request.
  //
  // `roadmap_comment` is absent too, and deliberately: what the session chose is
  // written onto the card by the platform from the run's own summary, which is
  // R108's argument — a session that should not be doing its own bookkeeping
  // should not be handed a writer to do it with.
  //
  // And whether it may ASK a person is the project's `agent_merge_lands` rule,
  // applied by subtraction in `mergeCawdevTools`.
  MERGE: (run) => [
    ...mergeCawdevTools(run),
    ...READ_FILES,
    'Bash(git *)',
    ...conflictedWrites(run),
  ],
  // R187. Cut a release: write the changelog, ship the cards, bump the
  // version, tag, push, open the pull request. Until R187 this was a CODE run
  // with a careful prompt, which meant the project's build tools, the
  // permission prompt and `bypassPermissions` where a machine had granted it —
  // for a session asked to touch three files.
  //
  // The cawdev half is the reads plus exactly the three writers the procedure
  // uses: an entry, an entry's version, a card's status. `ask_user` stays with
  // the reads because the OWNER who pressed the button is watching and a
  // release may genuinely need to ask. Nothing that creates a card, proposes
  // one, or comments.
  //
  // The shell is `git` in full — it commits, tags and pushes — `gh pr create`
  // and `gh pr view`, and `node` for the export scripts. NOT `Bash(gh *)`: it
  // can open the release's pull request and it cannot merge it, and that is a
  // permission rather than a sentence in the prompt. A release is merged by a
  // person, with a merge commit, because a squash orphans the tag.
  //
  // And `Write`/`Edit` on the version files the platform named on the claim,
  // and nothing else. `ROADMAP.md`, `ISSUES.md` and `CHANGELOG.md` are
  // unwritable by hand as a permission, which is what "never hand-edit the
  // exports" means from here on.
  RELEASE: (run) => [
    ...READ_ONLY_CAWDEV,
    'mcp__cawdev__changelog_add',
    'mcp__cawdev__changelog_update',
    'mcp__cawdev__roadmap_set_status',
    ...READ_FILES,
    'Bash(git *)',
    'Bash(gh pr create *)',
    'Bash(gh pr view *)',
    'Bash(node *)',
    ...releaseWrites(run),
  ],
  INTERVIEW: (run) => [
    ...READ_ONLY_CAWDEV,
    'mcp__cawdev__ask_group',
    'mcp__cawdev__await_group',
    // R101. Where it stands, and the wait on the person's decision. Without
    // these the session cannot find out that it has asked its last round, and
    // the refusal it gets from ask_group reads as a failure.
    'mcp__cawdev__interview_rounds',
    'mcp__cawdev__await_more_rounds',
    ...READ_FILES,
    ...briefWrites(run),
    'Bash(git *)',
  ],
};

/**
 * Whether this run is a plan session that has to write its own card — R150.
 *
 * <p>Inferred from the claim rather than carried on it: a cardless plan run's
 * `entryNumber` is null because there is no card, and that is the same fact.
 * One reader, so `PROFILE_TOOLS.PLAN`, `toolsForStage` and R113's cross-check
 * cannot come to three different answers.
 *
 * <p>It stays true after the session writes the card, because the claim was
 * taken before it did. That is deliberate: the permission is for the whole plan
 * stage, and a session that has to re-file a card it got wrong should not find
 * the tool gone half way through.
 */
function writesItsOwnCard(run) {
  return run?.profile === 'PLAN' && !run?.entryNumber;
}

/**
 * Tell the platform a usage window is closed — R73, from either place that
 * finds out.
 *
 * <p>Two callers and one implementation, deliberately: the turn that SAYS the
 * window closed and the exit that follows one. They were one place and it was
 * the wrong one — an exit that a mid-run limit never produces.
 *
 * <p>Both calls are best-effort and say so when they fail. A refused report is
 * worth a line rather than a stopped run: the commonest refusal is a run whose
 * state has moved on underneath the daemon, and failing the run over a
 * bookkeeping call would be a worse answer than a stale label.
 */
async function reportUsageLimit(config, run, limit, lastText) {
  const window = limit.window === 'WEEKLY' ? 'weekly' : 'five-hour';
  await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/transition`, {
    method: 'POST',
    body: {
      state: 'USAGE_LIMITED',
      summary: `Usage limit reached (${window} window). ${lastText ?? ''}`.trim(),
      limitWindow: limit.window,
      limitResetsAt: limit.resetsAt ? limit.resetsAt.toISOString() : null,
    },
  }).catch((failure) => log(`  could not report the usage limit: ${failure.message}`));
  // R73's worst case, shipped: the CLI reports its windows to a person more
  // readily than to a program, so the one moment this daemon KNOWS a window is
  // closed is when a run was refused. Report that — no numbers, the reset it
  // stated — and the runners page shows the last refusal and when it opens,
  // which is infinitely more than nothing and better than a meter cawdev
  // computed for itself.
  await api(config, `/api/runners/${config.runnerId}/limits`, {
    method: 'POST',
    body: [{
      provider: 'claude',
      window: limit.window,
      used: null,
      limit: null,
      resetsAt: limit.resetsAt ? limit.resetsAt.toISOString() : null,
    }],
  }).catch((failure) => log(`  could not report the window: ${failure.message}`));
}

/**
 * Everything before `--allowedTools`, which is variadic and swallows the rest.
 *
 * <p>Shared by {@code argsForProfile} and R112's stage args so the two cannot
 * disagree about where the permission list begins — a stage built on a list
 * that still had the coding defaults on the end would be a stage with tools its
 * table never granted, and nothing would have said so.
 *
 * <p>With `listOnly`, the allow-list is the WHOLE permission — i138. Two of the
 * coding defaults let a session past its list: `--permission-mode` waves a
 * class of calls through without consulting it (`acceptEdits` writes files —
 * proved by spike against 2.1.268, a session allowed only `Read`, `Grep` and
 * `Glob` wrote a file — and `bypassPermissions` anything at all), and
 * `--permission-prompt-tool` turns everything else into a question for a person.
 * A profile's permissions are the whole point of the profile: an ASK session
 * that can have a person grant it the shell is an ASK session that can write
 * code, which is exactly what R28 decided it must not be. "Cannot" must not
 * quietly become "not yet". So both go, for every profile that is not CODE and
 * for every read-only stage of one.
 *
 * <p>`argsForProfile` always stripped them. The stage path did not, and that is
 * i138: a PLAN run walked as stages was spawned with `acceptEdits` and the
 * prompt tool its single-process twin never had, so every shell command the
 * planner reached for — and the `report` its prompt told it to finish with —
 * became a question on the inbox, on a machine whose operator had turned on
 * "allow everything". That setting is coding-only, correctly, and so did
 * nothing for the session that was asking. One function for both paths now,
 * so they cannot come apart again.
 */
function argsBefore(agentArgs, { listOnly = false } = {}) {
  const kept = [];
  for (let i = 0; i < agentArgs.length; i++) {
    if (agentArgs[i] === '--allowedTools') {
      break; // variadic: everything after it is a permission
    }
    if (listOnly && (agentArgs[i] === '--permission-mode'
        || agentArgs[i] === '--permission-prompt-tool')) {
      i += 1;
      continue;
    }
    kept.push(agentArgs[i]);
  }
  return kept;
}

/**
 * The spawn arguments for a session that does not write code.
 *
 * Everything up to `--allowedTools` is kept — the output format, the streaming
 * input, the model — and the permissions are replaced with the profile's own.
 * `--permission-mode acceptEdits` goes too: a session that cannot write files
 * has no use for permission to. And so does the permission prompt — see
 * `argsBefore` for why "cannot" must not become "not yet".
 */
function argsForProfile(agentArgs, profile, run, expertAgents = [], skills = []) {
  const allowed = PROFILE_TOOLS[profile] ?? READ_ONLY_CAWDEV;
  return [...argsBefore(agentArgs, { listOnly: true }), '--allowedTools',
    ...withSkills(
      withDelegation(typeof allowed === 'function' ? allowed(run) : allowed, expertAgents),
      skills)];
}

/**
 * What one STAGE is asked to do, and what the stages before it produced — R112.
 *
 * <p>Each stage is its own process, so nothing carries across except what is
 * written down. That is the cost of real enforcement and it is why R108's
 * briefing and R109's stored plan had to exist first: they are the memory that
 * makes a process boundary survivable.
 *
 * <p>The plan is handed on VERBATIM rather than summarised. A stage that
 * re-derived the plan from a précis would be planning again, which is the one
 * thing the gate exists to stop it doing after somebody approved the first one.
 */
/** Longer than ask_user's own ten-minute wait — see the cawdev server of spawnCodex. */
const CAWDEV_TOOL_TIMEOUT_SEC = 660;

/**
 * R368. cawdev reads a plan's `**Done when:**` list into the card's review
 * checklist, numbered in order, so a plan has to end in one that can be ticked.
 */
const DONE_WHEN_PLAN = 'End the plan with a `**Done when:**` list of `- [ ]` items, each one '
  + 'condition somebody could check on its own — cawdev turns that list into the card\'s '
  + 'review checklist, numbered in order.';

/** R368. The other half: the session that builds it says which items it built. */
const DONE_WHEN_TICK = 'When an item under the plan\'s **Done when** is built and you have '
  + 'checked it, call `done_when_tick` with its number and one line of evidence. Do not tick '
  + 'what you did not check.';

/**
 * A decision that is the person's is ASKED, and the stage goes on with the
 * answer. R19 and R24 (Codex) each met one — a plan the code had moved away
 * from, a plan whose review left the scope open — and ended the stage saying
 * so, the run FINISHED with nothing built and the question in a summary
 * nobody was asked. Claude asked; the wording let Codex stop instead.
 */
const ASK_DONT_STOP = 'If a decision is genuinely the person\'s — a scope the card leaves open, '
  + 'a plan that no longer matches the code, a trade-off with no right answer — ASK it with '
  + '`ask_user` (a round of questions if there are several), wait for the answer, and carry on '
  + 'with it. Never end this stage on an open question: a question left in your report is one '
  + 'nobody was asked.';

/**
 * A stage is ONE turn, and it ends the moment the turn does — so a command left
 * running in the background is a result lost (background-shells.mjs).
 */
const WAIT_FOR_COMMANDS = 'This stage ends when your turn ends: run every command in the '
  + 'foreground and wait for it to finish — a build or a test suite left running in the '
  + 'background is lost, and the stage is run again. The same goes for delegating: call '
  + '`Agent` with `run_in_background: false` and wait for its answer — an agent still '
  + 'working when your turn ends has its work lost, and the stage is run again.';

/**
 * @param hasPlan whether the card has a plan of record — the same test
 *   harnessPrompt uses to draw "The plan for this card" (`plan?.body`), so the
 *   instruction and the block it points at cannot disagree
 */
function stagePrompt(stage, carried, hasPlan = true) {
  const asked = {
    PLAN: 'Work out what to do and WRITE THE PLAN. Do not change anything — you have no '
      + 'tool that can, so do not spend turns discovering that. Read what you need, then say, '
      + 'concretely: which files, what change in each, and how you will know it worked. '
      + 'What you report becomes the card\'s plan, and a DIFFERENT session — another '
      + 'process, with none of your context — will be handed it and told to carry it out. '
      + 'Write it for them — with every decision in it already made. ' + DONE_WHEN_PLAN + ' '
      + ASK_DONT_STOP,
    VERIFY: 'Check the plan against what is actually there. Does every file it names exist? '
      + 'Does every interface it assumes still look like that? You cannot change anything — '
      + 'say what is wrong with the plan, or say plainly that it holds.',
    // With a plan, the plan is the task. Without one — `/new dev R21` on a
    // card nobody planned — the CARD is: the old wording pointed at a plan
    // section that was not there, and a careful session read "stop rather than
    // improvise" as "stop", ending R21 with nothing built and nothing to push.
    IMPLEMENT: (hasPlan
      ? 'Do the work in the plan — it is under "The plan for this card" above, '
        + 'written by the plan phase and agreed. Do not quietly improvise a different change: '
        + 'somebody approved that plan. If it turns out to be wrong or incomplete, ask what to '
        + 'do instead of stopping — and stop only if the answer is to stop. ' + DONE_WHEN_TICK + ' '
      : 'This card has no plan, and it does not need one: it was started straight into '
        + 'development, so the CARD\'s text is the task. Work out what it asks — read the code '
        + 'it touches first — build it, and commit it on this branch. Never stop because a plan '
        + 'is missing. ')
      + ASK_DONT_STOP + ' ' + WAIT_FOR_COMMANDS,
    // R129. Two honest ways to do this stage, and the project chose one. The
    // TESTBOOK wording says "you have no tool that could" for the PLAN
    // prompt's reason: a session that has to discover a refusal spends turns
    // on it, and then argues with it.
    TEST: stage.testMode === 'TESTBOOK'
      ? 'WRITE THE TESTBOOK — do not run anything. Write `TESTBOOK.md` at the root of the '
        + 'checkout, creating it if it is not there, and ADD A SECTION FOR THIS CARD: do not '
        + 'rewrite or delete what is already in the file. It is the project\'s test plan and '
        + 'not this card\'s, and somebody else\'s section is not yours to remove. For each '
        + 'thing worth testing, say three things: what should be tested, the exact command '
        + 'that would prove it, and what a person should see if it passed. Do not run any of '
        + 'them — you have no shell that could, so do not spend turns discovering that. Use '
        + '`git diff` to find out what the work actually changed. A test you could not run is '
        + 'a line in the testbook, not a failure of this stage.'
      : 'Run what proves the work. Report what passed and what did not, with the output. A '
        + 'failing test is a result, not a failure of this stage. The branch\'s SonarQube gate '
        + 'is one call away — `quality_get`, which reads this run\'s branch by default; a red '
        + 'gate with new vulnerabilities is a finding to report with the output, not a failure '
        + 'to hide. ' + WAIT_FOR_COMMANDS + ' Then commit the branch\'s changes — no stage '
        + 'after this one writes code, and work left uncommitted is work nothing can push. '
        + DONE_WHEN_TICK,
    MEMORY: 'Write what the NEXT session on this branch needs to know: what was done, what was '
      + 'tried and rejected and why, and anything that turned out to matter and would not be '
      + 'obvious from the diff. Be brief and concrete. This is saved as this branch\'s '
      + 'briefing and handed to whoever comes next.',
  }[stage.stage] ?? `Carry out the ${stage.stage} stage.`;

  const before = [];
  for (const [name, text] of Object.entries(carried ?? {})) {
    if (text) {
      before.push(`### What the ${name} stage produced\n\n${text}`);
    }
  }

  return `\n\n---\n\n## This is the ${stage.stage} stage\n\n${asked}`
    + (before.length ? `\n\n${before.join('\n\n')}` : '');
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
  // How that card is written — R127. The API says, in `entryRef`; the fallback
  // is for a platform that predates it. Spelled once here, so the three prompts
  // below cannot disagree about what to call the same card.
  const ref = run.entryRef ?? `R${run.entryNumber}`;

  const about = run.entryNumber
    ? `This is about **${ref} — ${run.entryTitle}**. Read it with `
      + `\`roadmap_get\` before you answer.\n`
    : '';

  // R150. Retired: nothing new starts on this profile. Kept because a session
  // that was interrupted before the release and resumed after it still has to be
  // spawnable, and a resumed run whose prompt had gone missing would be worse
  // than one on a profile nobody can pick any more.
  if (run.profile === 'ROADMAP') {
    return `You are working on a roadmap in the cawdev platform. You have the cawdev MCP
tools and nothing else: you cannot edit files, run commands, or use git, and you
should not offer to.

This session's profile has been retired — new work of this kind is a **Plan**
session that writes the card and then plans it. This one was already running, so
finish what it asked for.
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

  if (run.profile === 'MERGE') {
    const files = Array.isArray(run.conflictedFiles) ? run.conflictedFiles : [];
    const list = files.map((path) => `- \`${path}\``).join('\n');
    // Whether the resolution waits to be read. Said so the session knows what
    // happens after it pushes — and ONLY that. i167: the session used to be
    // told to `ask_user` here and wait for the answer, and the answer landed
    // nothing, because a question the platform did not ask is a question it
    // cannot recognise the answer to. The platform asks now, once the run has
    // ended and the machine has reported; the session pushes and reports.
    const waits = !run.rules?.agentMergeLands;

    return `You are resolving a **merge conflict** on branch \`${run.branch}\`, in the cawdev
platform. The default branch has been merged into it and git could not reconcile
${files.length === 1 ? 'one file' : `${files.length} files`}:

${list}

**Resolve those files and nothing else.** They are the only files you can write
to — that is a permission, not a request, so do not spend turns discovering it.
You have no \`gh\`: you cannot open, merge or close a pull request, and you are
not supposed to. Pushing the branch is the whole of your job.

**What this is.** Two versions of lines somebody has ALREADY REVIEWED. This card
is DONE: a person read the work and accepted it, and so did whoever wrote what is
on the default branch. Your job is to say what both of them meant, together.

**What this is not.** Do not improve the code. Do not take the opportunity to
refactor. Do not write the feature the conflict revealed was missing. Do not
touch a file that is not in the list above. Every one of those turns a merge
somebody can read into a change somebody has to review, which is the thing this
session exists to avoid.

**How to work.** Read both sides of each conflict and read enough around them to
know what each was for — \`git log\`, \`git diff\` and the cards are all yours.
Then remove the markers and leave the file saying what both changes meant. When
every file is done: \`git add\` them, \`git commit\`, and \`git push\`. An
ordinary push — never \`--force\`, which would detach the review comments on a
pull request somebody has already approved.

**If you cannot tell which side is right, stop.** Call \`report\` with kind
"blocked" and say exactly which file, which hunk, and what the two sides disagree
about. **That is the preferred outcome, not a failure.** A conflict a person
spends five minutes on is cheap; a resolution that compiles and is wrong reaches
the default branch and is not. Nothing is re-run here and nothing tests what you
merged, so guessing is not a risk you are entitled to take on somebody else's
behalf.
${waits ? `
**Your resolution will not land by itself.** This project's rule says a resolved
conflict waits to be read. Once you have pushed and reported, the platform puts
what you chose in front of the person who started this, in their inbox, and
their answer is what lands the branch. Do not ask them yourself — you have no
tool for it, and the report is the asking.
` : `
**Your resolution will land.** This project's rule says a resolved conflict
merges by itself once you have pushed it. Nobody will read it first. Hold
yourself to that: if you are not sure, stop and say so instead.
`}
Report what you did with \`report\` kind "done" — name every file and say what you
chose in each. That text goes on the card, and it is how anybody finds out how
this was resolved without opening your transcript.`;
  }

  if (run.profile === 'RELEASE') {
    // R187. The procedure itself is the platform's — ReleasePrompt composes it
    // with the version and the cards — so this only says what the session is
    // standing in and what it has been allowed, in the terms the permission
    // list uses, so it does not spend turns discovering either.
    const files = Array.isArray(run.releaseWrites) ? run.releaseWrites : [];
    const list = files.length
      ? files.map((path) => `\`${path}\``).join(', ')
      : 'none — this project declares no version files, so say so in your report '
        + 'rather than looking for a way round it';

    return `You are cutting a release in a working copy on branch \`${run.branch}\`, for the
cawdev platform.

Your permissions, so you do not spend turns discovering them: \`git\` in full;
\`gh pr create\` and \`gh pr view\`; \`node\`; and Write/Edit on exactly these files —
${list} — and nothing else. There is no permission prompt in this session: a
command outside those is refused and nobody is asked. You cannot merge a pull
request, run a build, or run tests.

If a decision is genuinely the person's, use \`ask_user\` and wait.

${run.openingPrompt}`;
  }

  if (run.profile === 'INTERVIEW') {
    const brief = run.brief ?? { path: BRIEF.path, index: BRIEF.index, sections: [] };
    const sections = (brief.sections ?? [])
      .map((section) => `- \`${section.path}\` — ${section.title}: ${section.about}`)
      .join('\n');
    const emphasis = run.openingPrompt
      ? `\nThey asked you to pay particular attention to:\n\n${run.openingPrompt}\n`
      : '';
    const existing = brief.indexText
      ? `\nThere is already a brief here. Read every file of it first and treat this as an
UPDATE: confirm what is still true, correct what is not, and ask only about what has
changed or was never answered. Do not re-ask what the brief already says.\n`
      : '';

    return `You are conducting a **CTO Interview** on this repository for the cawdev platform.

**Who this is for.** The document you produce is read by CODING AGENTS — including
you, next time — at the start of every session cawdev runs here. It is not a report
for a board and not marketing. Write for something that has the code in front of it,
cannot ask anybody anything, and will make expensive mistakes if it guesses.

You are on branch ${run.branch}, and you may write ${brief.path} and NOTHING else. No
code, no configuration, no other document.

**Read first, ask second.** Start with \`code_map\` and \`file_deps\` — cawdev has
already mapped this repository — then read what they point at: the build files, the
entry points, the routes, the schema, the tests, the READMEs, the git history.
Everything you can answer by reading, you must NOT ask.
${existing}
**Then interview, in rounds.** Use \`ask_group\` with the title "CTO Interview". Each
round is up to 12 questions that belong together, with an \`intro\` line saying what
the round is about. Ask what the code cannot tell you, and what an agent would get
wrong:

- what each part is RESPONSIBLE for, and which boundaries exist for a reason
- the invariants — what must never happen, and what breaks if it does
- where a new thing of each kind belongs, and which file looks right and is wrong
- what is load-bearing and looks incidental; what is dead and looks alive
- the words this code uses, and where they mean something unusual
- how work is done here: branches, tests, migrations, what is generated
- how it is built and deployed, what breaks in production, and who finds out
- the traps: the mistakes people have already made in this repository

Make every question specific and show that you have read the code —
"\`AccessGuard.require\` is called in every handler except three; is that deliberate?"
is worth ten of "how does authorisation work?". Offer \`options\` when there is a small
set of plausible answers; they can always write their own. Between rounds, read again:
a good answer opens a door you have not looked through yet.

**How many rounds you get, and who decides.** You start with THREE rounds of up to
twelve questions. That is a sitting, and it is enough for what this project is, what
it must never do, and how work is done here — so spend them on what an agent cannot
work out by reading. Call \`interview_rounds\` if you are unsure where you stand.

When you have used them, call \`await_more_rounds\` and WAIT. The person is shown two
buttons. *I have more time* gives you three more; *finish here* means stop asking and
write the brief from what has been answered — not from what you wish you had asked.
**Six rounds is the ceiling and it is not yours to raise**; asking past your allowance
is refused by the platform, and the refusal is not a failure, it is the answer.

Before your last allowed round, ask yourself what a new agent would still get wrong
here, and spend that round on it.

**Then write the brief.** ${brief.index} is the index, and it is the file every future
session is handed: open it with a short paragraph saying what this project is and what
it must never do, then list each section with a line saying what is in it. Then:

${sections}

Write in plain prose, specific to this repository, naming real files and symbols.
Say what is true rather than what would be nice; where the answer is "nobody knows",
write that in ${brief.path}/08-open-questions.md rather than inventing one. Attribute
nothing to the person you interviewed by name — the brief is about the project.

Commit the brief with git when it is written. Do not push and do not open a pull
request: this project's own rules decide what happens next.

Finally \`report\` kind "done": what you read, how many rounds you asked, what the
brief now says, and what is still unanswered.
${emphasis}`;
  }

  if (run.profile === 'AUDIT') {
    return `You are auditing this repository for the cawdev platform. You can READ the code
and the roadmap; you cannot change either. No edits, no commands, no git — and no
creating roadmap entries directly.
${about}${briefLine(run)}
What you find becomes a **proposal** with \`propose_entry\`, one per finding, each
naming its kind, and an issue with a severity:

- \`critical\` — it is broken, unsafe, or loses data
- \`medium\` — it will hurt, but not today
- \`minor\` — worth doing, nobody is bleeding

Each finding is \`kind: issue\` when something is broken, unsafe or lossy, and
\`kind: roadmap\` when the code should also do something, or do it better. A
feature request is not an issue, and an issue is not a feature: pick the kind by
what you found, not by how much you care. Only an issue takes a severity. Only a
card takes \`after\` — what it starts after — and a card must: \`after: []\` when
it depends on nothing, \`["R12"]\` for a card already on the roadmap, \`["#1"]\`
for a card you proposed earlier in this run.

A person decides which proposals become issues or roadmap cards — and may file
one the other way — so write each one as an entry would be written: a title
somebody can scan, then prose, a **Build:** list and a **Done when:** condition.
Say where in the code you saw it.

Then \`report\` kind "done" with the report itself — what you looked at, what you
found, and what you deliberately did not check. Twenty vague findings are worth
less than four you can point at.

They asked:

${run.openingPrompt}`;
  }

  if (run.profile === 'SCOPE') {
    // R227. An audit's permissions and a different question. An audit is
    // asked what is wrong; this is handed an idea and asked what cards it
    // is. The order the prompt gives — read first, cut second, file third,
    // then report the cutting — is the order the work has to happen in: a
    // session that files before it has read the code cuts by the prompt's
    // words, not the code's shape.
    return `You are scoping an idea for planning on the cawdev platform. You can READ
the code and the roadmap; you cannot change either. No edits, no commands, no git —
and no creating roadmap entries directly.
${about}${briefLine(run)}
You have been handed an idea that is too big to be one roadmap card. Your job is
not to plan it and not to build it: it is to **cut** it — to read the code and say
which cards this is, in what order, each small enough to be planned and built on
its own.

**Read first.** Start with \`roadmap_where\`, then \`roadmap_list\` to see what is
already recorded — a card that already covers part of this is a card you do not
file twice. Then read the code the idea touches, with a purpose: where does
each piece live, what depends on it, what would break. \`code_map\` is one call
and answers "where does this live"; \`file_deps\` answers "what would I break".

**Then cut.** Each card is a self-contained piece of work: it can be planned and
built on its own, and when it lands the code is in a state somebody could ship.
Aim for the fewest cards that are each small enough — four to six is usual —
and put them in **build order**. Read two or three existing entries before you
write one, and match their shape:

- a title somebody can scan in a list
- prose saying what and why, naming real files and symbols
- a **Build:** list
- a **Done when:** condition somebody could check

**Then file.** Every card is \`propose_entry\` with \`kind: roadmap\`, in build
order, all under **one \`section\`** you name for the idea — the same string on
every call, because the shared section is what makes six proposals read as one
change. A scoping session that files under six sections has not scoped anything.

**Every card says what it starts after** — \`after\`, on the call, not a line in
the body. The first card sends \`after: []\`. A later card names the cards it
depends on by the number the tool answered with: \`after: ["#1"]\`, \`after:
["#1", "#3"]\` — or \`"R12"\` for a card already on the roadmap. You can only
name what has already been proposed, which is why the order you file in is the
build order: a card that depends on one you have not filed yet is a card you
are filing too early. The platform refuses a card with no \`after\`, and a
person adds the cards in that order — #2 cannot go on the roadmap until #1 has.
This is what makes the order you worked out real: a coding session on a card
waits until every card it starts after has landed.

If, on the way, you find something **already broken** — unsafe, lossy, wrong
today — you may file it as \`kind: issue\` with a severity (critical, medium or
minor). That is the exception and not the job: one issue found while reading is
worth filing; a list of them means you audited when you were asked to cut.

You are proposing, not creating. A person accepts each card — as the card you
proposed, as an issue, or not at all — and nothing reaches the roadmap that
nobody read. Cards accepted from this session are related to each other on the
board, and each carries what it starts after, so you do not need to spell the
relationships into the bodies.

Then \`report\` kind "done" with **the cutting itself**: what the cards are, in
what order, what each depends on, and what you deliberately left out and why.
That report is what the person reads before they read a single card.

They asked:

${run.openingPrompt}`;
  }

  if (run.profile === 'PLAN') {
    // R150. Two openings, one body. Without a card the heading would render
    // `**undefined**`, and more to the point the first instruction is a
    // different one: write the thing you are about to plan.
    const noCard = !run.entryNumber;
    // R198. A plan run on an ISSUE is a confirm: the platform moves the issue
    // NEW → CONFIRMED when the plan is recorded, so the session has to be told
    // that a plan is a verdict — and that the only honest ending for "I could
    // not find it" is no plan at all. The kind comes from the API (`entryKind`),
    // not from the first letter of the ref; a platform older than R198 sends
    // neither and gets the card paragraph, which is what it did before.
    const confirming =
      !noCard && run.entryKind === 'ISSUE'
        ? `
**This is an issue, not a card, and it may not yet have been confirmed.** Your
first job is to establish that it is real: find where in the code it happens and
say so in the plan. If it is real, plan the fix — cawdev confirms the issue when
your plan is recorded. If you cannot find the fault, do not write a plan:
\`report\` kind "blocked" saying what you looked at and why you could not
reproduce it, and the issue stays New for a person to look at. Whether something
is *not* a bug is a person's call, not yours.
`
        : '';
    const opening = noCard
      ? `You are starting a new piece of work on the cawdev platform, in this project.
This is the PLAN PHASE: you work out what to do, and you write it down. You do not
build it, and you have no tool that could — so do not spend turns finding that out.
${briefLine(run)}
**There is no card yet, and writing it is your first job.** Start with
\`roadmap_where\`, then \`roadmap_list\` to see what is already recorded. Read two
or three existing entries before writing one, and match their shape: prose saying
what and why, a **Build:** list, and a **Done when:** condition somebody could
check. Then create it with \`roadmap_create\`.

\`roadmap_create\` is the ONE thing you may write. You cannot edit a file, run a
command, use git, or comment on a card, and you should not offer to.

**The card's body is the card, not the plan.** The card says what the thing is and
how anybody would know it works. The plan — the files, the changes, the order — is
what you report at the end, and cawdev stores it against the card itself.

**Then plan the card you just wrote**, exactly as if somebody had handed it to
you.
`
      : `You are planning **${ref} — ${run.entryTitle}** for the cawdev
platform. This is the PLAN PHASE: you work out what to do, and you write it down.
You do not build it, and you have no tool that could — so do not spend turns
finding that out.
${about}${briefLine(run)}${confirming}`;
    const asked = run.openingPrompt
      ? `\n\n${noCard ? 'They asked' : 'They also asked'}:\n\n${run.openingPrompt}`
      : '';
    return `${opening}
**What you produce is an artefact somebody reads.** Not notes to yourself: a plan
a different session, in a different process, with none of your context, has to be
able to carry out. Name the files. Say what changes in each. Say how anybody will
know it worked — which test, which command, what they should see.

**Read before you decide.** Start with \`code_map\` and \`file_deps\`: cawdev has
already mapped this repository, and guessing at a structure you could have read
is how a plan comes to name files that do not exist. Read the card with
\`roadmap_get\`, and read the code itself.

**If this card has been planned before, \`roadmap_get\` shows you that plan.** It
is deliberately not put in front of you here: starting from somebody else's
answer produces a version of it rather than a second opinion. But go and look
before you finish, because one case matters — a person correcting a plan writes
a NEW one, and re-planning blind to that would undo the fix they just made.

**Say what you are unsure about.** A plan that hides its doubts gets carried out
confidently and wrongly. If there is a real fork, \`ask_user\` — you are the phase
where a question is cheap.

**Do not write the plan anywhere.** Not to a file, not to the card — including a
card you created a moment ago. cawdev stores what you report as the card's plan of
record when this phase ends, and that is the only copy anybody wants: two plans in
two places is how one of them goes stale.

**End with a Done-when list.** ${DONE_WHEN_PLAN}

Then \`report\` kind "done" with the plan itself.${asked}`;
  }

  if (run.profile === 'REVIEW') {
    return `You are reviewing the work on **${ref} — ${run.entryTitle}**
on branch ${run.branch} for the cawdev platform.

**Your job.** Read the branch's work and check it against the card's Build: and
Done when: conditions. File findings as comments — what you see and why it
matters — and stop there. Do not decide the verdict. That is the person's.
The findings go on the card and the person decides Done or Not done.

**Read the code.** Start with \`code_map\` and \`file_deps\` — cawdev has already
mapped this repository. Then read the work with \`git_reads\` tools. \`quality_get\`
gives the branch's SonarQube gate and the project's open findings; a new
vulnerability belongs in your comment.

**Check against the Build: and Done when:.** Use \`roadmap_get\` to read the
card's own words, then check the code against them. Point at what is done and
what is not. If anything is wrong, say what and why. If nothing is broken but
something could be better, say so — but mark it as polish, not a blocker.

**File findings.** Use \`roadmap_comment\` to write a structured comment on the
card. Say what you looked at, what you found, and what you did not check.
Everything a reviewer reads goes here. Include code pointers so the developer
can find it.

Do not commit, do not push, do not make edits. The branch is not yours to change.

Then \`report\` kind "done".`;
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

/**
 * One user message, in the shape `--input-format stream-json` expects.
 *
 * **Never throws, and never lets the socket throw.** A session that has already
 * exited has a closed stdin, and writing to one raises EPIPE as an *unhandled*
 * error event on the socket — which does not fail the write, it kills the
 * daemon. That took every other run on the machine down with it, from a CI
 * failure that read as "an ASK session queued behind coding" and was nothing of
 * the kind.
 *
 * The agent being gone is ordinary: it is what a crashed session, a finished
 * one, and a stubbed one all look like. Its exit is handled elsewhere, so here
 * it is enough to say the prompt did not land and carry on.
 *
 * @returns whether the message reached the session.
 */
function writeUserMessage(child, text) {
  if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
    return false;
  }
  try {
    child.stdin.write(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      })}\n`,
      // Asynchronous failures arrive here rather than as an error event on the
      // socket, which is the half that was crashing.
      (failure) => {
        if (failure && failure.code !== 'EPIPE') {
          log(`  could not write to the session: ${failure.message}`);
        }
      },
    );
    return true;
  } catch (failure) {
    // Synchronous EPIPE, on a stdin closed between the check above and here.
    if (failure.code !== 'EPIPE') {
      log(`  could not write to the session: ${failure.message}`);
    }
    return false;
  }
}

/**
 * The one message a REQUIRED capability buys — R161.
 *
 * <p>Said once, plainly, WITH THE WAY OUT. The last line is what makes this a
 * nudge and not an argument: a session that has genuinely read the description
 * and found it does not apply is right, and a message that left it no way to
 * say so would be asking it to use a skill for the sake of using one — which is
 * worse than the thing this entry exists to fix.
 *
 * <p>Both invocations are spelled out because the two are reached differently
 * and the qualified name is the one thing that must be exact. R147 was five
 * bugs' worth of evidence that a name a session cannot use is a capability it
 * does not have.
 *
 * <p>i257. `stillBackgrounded` names the ones that WERE delegated to but only
 * with a backgrounded `Agent` call — so "has not used it" would be false and
 * the fix would be wrong: telling a session to call something again that it
 * already called would read as broken, not as a nudge. Those get the specific
 * reason instead, because the generic "use it now" is the wrong instruction —
 * it already did, and doing it the same way again loses the result the same
 * way.
 */
function nudgeText(stage, missing, stillBackgrounded = []) {
  const neverUsed = missing.filter((each) => !stillBackgrounded.includes(each));
  const clauses = [
    neverUsed.length
      ? `has not used ${neverUsed.map((each) => `\`${each}\``).join(', ')}`
      : null,
  ].filter(Boolean);
  const opening = clauses.length
    ? `cawdev: this project requires ${missing.map((each) => `\`${each}\``).join(', ')}, and `
      + `this ${stage.stage} stage ${clauses.join(', and ')}.`
    : `cawdev: this project requires ${missing.map((each) => `\`${each}\``).join(', ')}.`;
  const backgroundedNames = stillBackgrounded.map((each) => `\`${each}\``).join(', ');
  const backgroundedNote = stillBackgrounded.length
    ? `\n\n${backgroundedNames} ${stillBackgrounded.length > 1 ? 'were' : 'was'} delegated to `
      + 'with `Agent`, but in the background, and its result has not come back. This stage is '
      + 'one process (R112): your turn ending is indistinguishable, to the daemon, from being '
      + 'finished, so a backgrounded delegation still in flight when that happens is lost along '
      + 'with anything gated on it. Call it again with `run_in_background: false` and wait for '
      + 'it in this same turn before finishing.'
    : '';
  return `${opening}${backgroundedNote}\n\n`
    + 'Use it now — `Skill` with `skill: "<name>"`, `Agent` with `subagent_type: "<name>"`, or '
    + 'for an MCP server a call to one of its tools (`mcp__<server>__…`) — and then say what it '
    + 'changed about your answer.\n\n'
    + 'If it genuinely does not apply to this work, say so in one sentence and stop. '
    + '**You will not be asked again.**';
}

/**
 * Ends the session — the function `agentArgs`'s comment has promised since R22
 * and which, until now, did not exist.
 *
 * <p>R22 keeps a session's stdin OPEN so a person can prompt it again without a
 * second process. The cost, which that comment states, is that the CLI no
 * longer exits when its turn finishes: it is sitting there waiting for more
 * input. For a RUN that is the point — the session stays open for whatever gets
 * typed next, and the run ends when the agent reports, which the platform turns
 * into a terminal state that `reapCancelled` acts on.
 *
 * <p>For a STAGE there is nobody to type anything. A stage is one instruction
 * and one turn, the next stage is a different process, and {@link
 * walkLifecycle} advances on the child's `close`. So the walk waited on an
 * event nothing was ever going to cause, and a run sat RUNNING between PLAN and
 * VERIFY — holding its project's only checkout, with a finished plan nobody was
 * ever shown — until a person went looking.
 *
 * <p>Closing the input is the whole fix; the rest of this is distrust. A CLI
 * that ignores EOF would reproduce that deadlock exactly, so the wait is
 * bounded — SIGTERM to the process GROUP, because an agent that spawned a build
 * should not leave it behind, and then SIGKILL. Neither is a failure: {@link
 * walkLifecycle} judges a stage by whether its TURN ended, so a stage that did
 * all of its work and had to be helped out of the door still counts as done.
 *
 * <p>Deliberately NOT called for a run without a lifecycle. Doing that would
 * undo R22 for every ASK session on the machine.
 */
function endSession(child, describe, seconds) {
  if (child.cawdevEnding) {
    return;
  }
  child.cawdevEnding = true;

  if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
    try {
      child.stdin.end();
    } catch (failure) {
      // A stdin already gone is the state this wanted anyway.
      if (failure.code !== 'EPIPE') {
        log(`  could not close ${describe}'s input: ${failure.message}`);
      }
    }
  }

  const grace = Math.max(1, seconds) * 1000;
  child.cawdevExitTimers = [
    setTimeout(() => {
      log(`  ${describe} has not exited ${seconds}s after its input closed; stopping it`);
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch { /* already gone, which is what was wanted */ }
    }, grace),
    setTimeout(() => {
      log(`  ${describe} is still here; killing it`);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch { /* already gone */ }
    }, grace * 2),
  ];
  // Never hold the daemon open on these. A machine that could not exit because
  // it was waiting to kill something is this same bug one level up.
  for (const timer of child.cawdevExitTimers) {
    timer.unref?.();
  }
}

/** Stops the escalation above — the child left, which is all anybody wanted. */
function stopEndingSession(child) {
  for (const timer of child.cawdevExitTimers ?? []) {
    clearTimeout(timer);
  }
  child.cawdevExitTimers = [];
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
        // Acknowledged only if it actually landed. Marking one delivered to a
        // session that had already gone is how a prompt disappears with nobody
        // able to say whether it was seen.
        if (!writeUserMessage(child, prompt.body)) {
          log('    the session was already gone; leaving it undelivered');
          break;
        }
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
 * What the platform said about this machine on the last heartbeat — R73, R80.
 *
 * `paused` is "claim nothing new": a person's switch in the console. What is
 * running finishes. `heldWorkspaces` are checkouts a FAILED run is keeping,
 * uncommitted work and all, until somebody discards the run — they are not
 * free, whatever `running` says, and must not be reset for the next claim.
 */
const told = { paused: false, autoResume: false, heldWorkspaces: [] };

/**
 * How this daemon paints its own output — R62.
 *
 * Decided once, from the terminal it was actually started in. Piped to a file
 * or run under NO_COLOR it is a no-op, and every line still reads.
 */
const ink = painter();

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

/**
 * The last set of queued reasons this daemon told the platform — R148.
 *
 * <p>`noteQueued` above used to be the ONLY place the reason a run waits
 * existed. It goes to the platform now, the whole current set every pass, so
 * omission withdraws a reason; this is the guard that keeps an idle machine
 * from posting the same body on every poll.
 */
let lastSentReasons = '';

/**
 * The run holding a workspace, or undefined — R47.
 *
 * Read from the two places a workspace can be spoken for: a live child, and a
 * run claimed but not yet spawned. Kept as a function rather than a third map
 * because a third map is a third thing to forget to update, and the failure
 * that causes is two agents in one checkout.
 */
function heldBy(path) {
  for (const [id, child] of running) {
    if (child.cawdevWorkspace === path) return id;
  }
  for (const [id, claim] of taken) {
    if (claim.workspace === path) return id;
  }
  return undefined;
}


/** Every workspace spoken for right now. */
function heldWorkspaces() {
  const held = new Set();
  for (const child of running.values()) {
    if (child.cawdevWorkspace) held.add(child.cawdevWorkspace);
  }
  for (const claim of taken.values()) {
    if (claim.workspace) held.add(claim.workspace);
  }
  // R80. A failed run's checkout is held for as long as the run is not
  // discarded — with no child and no claim, but with somebody's half-written
  // branch in it. Resetting it for the next run is how that work is lost.
  for (const path of told.heldWorkspaces) held.add(path);
  return held;
}

/**
 * Which checkout an offered coding run gets, or why it must keep waiting —
 * R71/i258.
 *
 * In order: a NAMED checkout (`offered.workspace`) is the only answer once
 * the branch is bound to it — served or busy, nothing else is considered. A
 * PREFERRED checkout (`offered.preferredWorkspace`) is taken when free,
 * dirty or not: it is the checkout the branch last ran in, so uncommitted
 * work there is plausibly that branch's own leftovers, and routing away from
 * it risks abandoning work rather than protecting it. That is pin-shaped
 * reasoning, and it is deliberate that cleanliness plays no part in this
 * rung — do not "fix" it in passing.
 *
 * The one exception is `offered.waitForClean` — R270. Once the person has
 * said "don't touch dirty", the idea that the leftovers are probably this
 * branch's own no longer applies: the preferred checkout is taken only when
 * it reads clean, and otherwise the run falls through to the free scan below
 * exactly as if it had no preference at all.
 *
 * Below that, a checkout is free game and cleanliness finally matters: the
 * first free path that reads CLEAN wins, and only when nothing free is known
 * clean does the first free path win regardless — today's behaviour,
 * unchanged, so the existing refusal in `prepareWorkingCopy` and the
 * console's *Start anyway* flow still work exactly as they did. With
 * `waitForClean` set, that last fallback does not happen: the run keeps
 * waiting instead of taking a dirty checkout.
 *
 * Cleanliness is read fresh, right here, rather than from
 * `surveyWorkingCopies`'s heartbeat reading — see `looksClean`. `probed` is a
 * `Map` the caller creates once per poll pass, so several offers of one
 * project only ask each checkout once.
 *
 * `surveyGit` and `checkMerges` use the same `workspaces.find((path) =>
 * !held.has(path))` idiom this replaces, and must NOT be unified with this:
 * they read refs, never the tree, so which checkout they pick is a different
 * question and dirtiness does not bear on it.
 */
async function pickWorkspace(slug, project, offered, held, probed, autoMax = 0, problems = new Map()) {
  const pinned = offered.workspace ?? null;
  if (pinned) {
    if (!project.workspaces.includes(pinned)) {
      // Not one of ours. The platform pins a machine as well as a path, so
      // this means the config changed under a live branch — which is a
      // thing to say out loud rather than quietly ignore.
      return { workspace: null, why: `its branch is in ${pinned}, which this machine does not serve` };
    }
    // Before the busy check, so the reason is the folder's own sentence and not
    // prepareWorkingCopy's raw error.
    const trouble = await problemOf(problems, pinned);
    if (trouble) {
      return {
        workspace: null,
        why: workspaceProblemSaid(slug, trouble, { first: project.workspaces[0] }),
      };
    }
    if (held.has(pinned)) {
      return {
        workspace: null,
        why: `waiting for ${pinned}, which is busy — the branch has work only that checkout holds`,
      };
    }
    return { workspace: pinned, why: null };
  }

  const waitForClean = offered.waitForClean === true;
  const preferred = offered.preferredWorkspace ?? null;
  if (preferred && project.workspaces.includes(preferred) && !held.has(preferred)
      && !(await problemOf(problems, preferred))) {
    if (!waitForClean) {
      return { workspace: preferred, why: null };
    }
    if (!probed.has(preferred)) probed.set(preferred, await looksClean(preferred));
    if (probed.get(preferred) === true) return { workspace: preferred, why: null };
  }

  const broken = [];
  for (const path of project.workspaces) {
    const trouble = await problemOf(problems, path);
    if (trouble) broken.push(trouble);
  }
  const first = project.workspaces[0];
  const usable = project.workspaces.filter((path) => !broken.some((each) => each.path === path));
  if (!usable.length && broken.length) {
    // Nothing here can be used at all — said before "all busy", and without
    // trying to clone: `createAutoWorkspace` clones FROM the first workspace.
    return { workspace: null, why: workspaceProblemSaid(slug, broken[0], { first }) };
  }
  const free = usable.filter((path) => !held.has(path));
  if (!free.length) {
    // Every checkout is busy. Where the machine allows it, make one more
    // rather than wait — the second coding session on a project starting at
    // once is the whole point of `autoWorkspaces`.
    // A deleted clone must not use up the quota until `syncAutoWorkspaces` runs.
    const made = usable.filter((path) => isAutoWorkspace(first, path));
    const firstTrouble = broken.find((each) => each.path === first);
    if (firstTrouble && made.length < autoMax) {
      return { workspace: null, why: workspaceProblemSaid(slug, firstTrouble, { first }) };
    }
    if (made.length < autoMax) {
      try {
        log(`every checkout of ${slug} is busy — cloning another beside ${first}`);
        const path = await createAutoWorkspace(first, project.workspaces);
        project.workspaces.push(path);
        log(`  made ${path} (${made.length + 1} of ${autoMax} on demand)`);
        return { workspace: path, why: null };
      } catch (failure) {
        log(`  could not make another checkout of ${slug}: ${failure.message}`);
        return { workspace: null, why: `no free workspace in ${slug}, and cloning another failed` };
      }
    }
    return {
      workspace: null,
      why: autoMax
        ? `no free workspace in ${slug} (${project.workspaces.length} here, all busy, `
          + `and the ${autoMax} this machine may make are made)`
        : `no free workspace in ${slug} (${project.workspaces.length} here, all busy)`,
    };
  }
  for (const path of free) {
    if (!probed.has(path)) probed.set(path, await looksClean(path));
    if (probed.get(path) === true) return { workspace: path, why: null };
  }
  // Nothing free reads clean — including anything `looksClean` could not read
  // at all, which groups with dirty rather than clean.
  if (waitForClean) {
    // R270: the person said to wait rather than go ahead on top of somebody
    // else's work. Keep waiting instead of falling back to the old
    // first-free rule below.
    return {
      workspace: null,
      why: `waiting for a clean checkout in ${slug} — every free one has uncommitted work or `
        + 'could not be read; stash or commit in one, or wait for a running session to finish',
    };
  }
  // Fall back to the old first-free rule verbatim, so the refusal and *Start
  // anyway* flow still apply to exactly this workspace.
  log(`every free checkout in ${slug} has uncommitted work — taking ${free[0]}`);
  return { workspace: free[0], why: null };
}

function noteQueued(run, why) {
  // Once per REASON, not once per run — R70, now that there are two gates a run
  // can be held by. A run refused by the machine's cap and then, when a session
  // ends, by the project's checkouts is waiting for a different thing, and
  // keeping the first answer would leave the log and the terminal explaining a
  // wait with a limit that is no longer the one in the way. Still not chatter:
  // the reason only changes when a session starts or finishes.
  if (noted.get(run.id)?.why === why) {
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
      // Which checkout it is in — R47. On a machine serving three, the label
      // alone no longer says where the work is.
      workspace: child.cawdevWorkspace ?? null,
      // Which CLI, and which model it is on — per STAGE on a walked run,
      // since each stage is its own process with its own model (R112).
      agent: child.cawdevAgent ?? null,
      model: child.cawdevModel ?? null,
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
      workspace: claim.workspace ?? null,
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

async function startRun(config, offered, workspace, source = null) {
  const run = offered.run;
  const project = config.projects[run.projectSlug];
  // The workspace this run was given, or — for a run that takes none — the
  // first, which is where a question about the project gets read from.
  const path = workspace ?? source ?? project?.path;
  let runToken;
  let defaultBranch;
  let allowDirty = false;
  // Where the branch stood when this run took it over.
  let baseCommit;
  // The conversation this run is continuing, when it is continuing one — R69.
  let resume = null;
  let handoff = null;
  // What this project has turned on — R76. Asked for, never granted: the
  // platform decides, and the machine still has the veto at spawn.
  let mcpServers = [];
  // R104/R105: and what it turned on that is MARKDOWN rather than a command.
  // Two lists rather than one, because they are two decisions with two risks:
  // an MCP server executes on this machine, and these enter a context.
  let expertAgents = [];
  let skills = [];
  // R107–R110. What this project tells a session, what the last one left, the
  // lifecycle to walk, and what is guarded against.
  let instincts = [];
  let briefing = null;
  let plan = null;
  let lifecycle = [];
  let shield = null;
  // R155. What `git merge` did before anything was spawned, on a MERGE run.
  let merge = null;

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
    // Or whether the uncommitted work is THIS BRANCH'S OWN: the platform named
    // the checkout (R86/R87 — a carried-on run's held workspace, or the next
    // run of a pinned work item) and it is already on the run's branch. R80
    // holds a failed run's checkout precisely so its work survives, and
    // refusing that work as "yours, commit it first" turned every Carry on
    // into a second failure with nothing in the console able to break the loop.
    if (!allowDirty && offered.workspace && path && writesCodeProfile(run) && run.branch) {
      const on = await git(resolve(path), ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
      if (on.trim() === run.branch) {
        allowDirty = true;
        log(`  ${path} is on ${run.branch} already — its uncommitted work is this branch's, kept`);
      }
    }
    // And what this project has decided happens when the run ends — R40. The
    // daemon does not act on this: the platform queues the push, the pull
    // request and the merge as actions and `settleActions` performs them. It is
    // said out loud here so that whoever is watching this log finds out BEFORE
    // the surprise rather than after it — particularly the last one.
    announceRules(claimed.rules);
    // R155. `PROFILE_TOOLS.MERGE` reads `agentMergeLands` off the run to decide
    // whether the session is handed the tools that let it ask a person. A
    // session that must not stall should not have the tool that stalls it, and
    // one that must ask should not be relied on to remember to.
    run.rules = claimed.rules ?? null;
    // R260. What this run's branch is cut from, when that is not the default:
    // the branch of the sprint its card is in. Cutting, merging-in, the pull
    // request's base and the merge check read it; `defaultBranch` stays what
    // a reset, the code map and the brief read. Null on every run until a
    // sprint has a branch — and then everything below is what it was.
    run.baseBranch = claimed.baseBranch ?? null;
    // R379. The project's declared git host (GITHUB/GITLAB), or null to detect it.
    run.gitHost = claimed.gitHost ?? null;
    if (run.baseBranch) {
      log(`  cut from ${run.baseBranch} (the sprint's branch)`);
    }
    // R300. Which SonarQube project this is and where — two FACTS the
    // scanner needs on its command line, learnt with the claim because
    // reading a project is session-only. No token comes with them; the
    // scanner runs with this machine's own, from the variable the `quality`
    // block names. Stored on the run the way `baseBranch` is, so the walk
    // reads them off `run` after TEST rather than through another parameter.
    run.sonarProjectKey = claimed.sonarProjectKey ?? null;
    run.sonarUrl = claimed.sonarUrl ?? null;
    // R316. Whether the project SAYS its server refuses branches — null is
    // "not sure, try the branch scan first", today's behaviour.
    run.sonarBranches = claimed.sonarBranches ?? null;
    // R69. Whether this is the same conversation picked back up, and which one.
    // Null on an ordinary claim, which is nearly all of them.
    resume = claimed.resume ?? null;
    if (resume?.agentSessionId) {
      log(`  resuming session ${short(resume.agentSessionId)}`);
    }
    // R148. A run handed off from another checkout: its branch is on the
    // remote and its uncommitted tree is a patch. Applied after the working
    // copy is prepared, below.
    handoff = claimed.handoff ?? null;
    if (handoff) {
      log(`  carrying a hand-off: ${handoff.files ?? 0} file(s) as a patch on `
        + `${String(handoff.baseSha ?? '?').slice(0, 7)}`);
    }
    // R76. What the project turned on. Logged because a machine's operator
    // should be able to see, from the daemon's own output, that a session was
    // given a capability — the platform decides it, and this is where it lands.
    // R96. Where this project's brief lives and what it is made of. The
    // platform is the authority — a path a session is told by something that
    // might be wrong is a brief written in the wrong place — and this is the
    // one thing every profile's prompt is given about it.
    run.brief = claimed.brief ?? null;
    // R187. The version files a release session may write — its whole write
    // scope, decided by the platform. Logged for the reason the rules are: the
    // operator should see from the daemon's own output what a session was
    // allowed to touch.
    run.releaseWrites = Array.isArray(claimed.releaseWrites) ? claimed.releaseWrites : [];
    if (run.releaseWrites.length) {
      log(`  a release session may write: ${run.releaseWrites.join(', ')}`);
    }
    mcpServers = Array.isArray(claimed.mcpServers) ? claimed.mcpServers : [];
    if (mcpServers.length) {
      log(`  the project asks for: ${mcpServers.map((each) => each.key).join(', ')}`);
    }
    // R104: already narrowed to this run's PROFILE by the platform, so the
    // count logged here is what the session will actually be handed.
    expertAgents = Array.isArray(claimed.expertAgents) ? claimed.expertAgents : [];
    skills = Array.isArray(claimed.skills) ? claimed.skills : [];
    instincts = Array.isArray(claimed.instincts) ? claimed.instincts : [];
    briefing = claimed.briefing ?? null;
    // R124. The card's plan of record, when the platform says this run follows
    // one. Read here with everything else the claim carries.
    plan = claimed.plan ?? null;
    lifecycle = Array.isArray(claimed.workflow) ? claimed.workflow : [];
    shield = claimed.shield ?? null;
    if (instincts.length) {
      log(`  instincts: ${instincts.map((each) => each.key).join(', ')}`);
    }
    if (briefing) {
      log(`  resuming from a briefing left on ${run.branch}`);
    }
    if (lifecycle.length) {
      log(`  lifecycle: ${lifecycle.map((each) => each.stage).join(' → ')}`);
    }
    if (expertAgents.length || skills.length) {
      log(`  experts: ${expertAgents.map((each) => each.key).join(', ') || 'none'}`
        + ` | skills: ${skills.map((each) => each.key).join(', ') || 'none'}`);
    }
  } catch (failure) {
    // Losing the race is normal when two runners serve one project, and is not
    // this run's failure — somebody else has it.
    log(`  not ours: ${failure.message}`);
    taken.delete(run.id);
    return;
  }

  // Where the session runs: the checkout, or for a session with no branch
  // the project's reading copy (`readingCopy`).
  let cwd = path ? resolve(path) : path;
  let reader = null;
  try {
    // R377. The folder was fine when the run was offered; it may not be now.
    // Checked before anything is prepared, so the run says what is wrong with
    // the folder instead of `is not a git repository` or `spawn claude ENOENT`.
    // One check covers every walked stage, which reuse this `cwd`.
    const trouble = path ? await workspaceProblem(resolve(path)) : null;
    if (trouble && !(trouble.kind === 'not-git' && !writesCodeProfile(run))) {
      throw new Error(workspaceProblemSaid(run.projectSlug, trouble, {
        first: project?.workspaces?.[0] ?? null,
      }));
    }
    let branch = run.branch;
    if (!writesCodeProfile(run)) {
      // Nothing is prepared. It cuts no branch, and a dirty tree does not stop
      // it, because it is not going to write to one — refusing here would make
      // "what is R12 about?" unanswerable while somebody has edits open.
      log(`  a ${run.profile.toLowerCase()} session: no branch, nothing cut`);
      if (path) {
        reader = await readingCopy(resolve(path), defaultBranch);
        cwd = reader.path;
        log(`  ${reader.said}`);
      }
    } else {
      // Cleared BEFORE the checkout, and never when somebody deliberately
      // started on top of their own uncommitted work — there the untracked
      // files are the point of the run.
      if (!allowDirty) {
        await resetWorkspace(resolve(path));
      }
      const prepared = await prepareWorkingCopy(
        resolve(path), run.branch, defaultBranch, allowDirty, run.baseBranch);
      branch = prepared.branch;
      baseCommit = prepared.base;
      if (handoff) {
        // R148. The work travelled: put the checkout on the pushed branch and
        // lay the uncommitted tree on top. A patch that does not apply is not
        // a failed run — it is left beside the checkout and SAID, in the
        // briefing the session reads first, so a person or the session can
        // finish the job by hand.
        const said = await applyHandoff(resolve(path), branch, handoff);
        log(`  ${said}`);
        briefing = briefing ? `${said}\n\n${briefing}` : said;
        baseCommit = await git(resolve(path), ['rev-parse', 'HEAD']).catch(() => baseCommit);
      }
      if (run.profile === 'MERGE') {
        // R155. The daemon does the merge, BEFORE anything is spawned, and what
        // git conflicts on becomes the session's whole write scope. A clean
        // merge needs no session at all and gets none.
        merge = await prepareMerge(resolve(path), branch, run.baseBranch ?? defaultBranch);
        run.conflictedFiles = merge.conflicted;
        log(merge.clean
          ? `  ${merge.into} merged into ${branch} with no conflict — nothing to resolve`
          : `  ${merge.conflicted.length} file(s) conflicted: ${merge.conflicted.join(', ')}`);
        await api(config, `/api/runners/${config.runnerId}/runs/${run.id}/merge/prepared`, {
          method: 'POST',
          body: { clean: merge.clean, conflictedFiles: merge.conflicted, base: merge.head },
        }).catch((failure) => log(`  could not report the merge: ${failure.message}`));
      }
    }
    log(`  working copy ${cwd ?? path} is on ${branch ?? 'no branch of its own'}`);

    await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/transition`, {
      method: 'POST',
      // Where it ran, sent with the move to RUNNING because that is the one
      // moment it is known. With three checkouts of one project, a run that
      // does not say which it used makes "what is uncommitted on this run"
      // unanswerable — and a console showing one run's files against another
      // run's path is worse than one showing nothing.
      body: { state: 'RUNNING', workspace: workspace ?? null },
    });

    if (merge?.clean) {
      // R155. Nothing conflicted, so there is nothing for a session to decide
      // and none is spawned. The merge commit still has to reach the remote —
      // it is what the pull request will show and what the platform reads as
      // evidence there is a resolution to land — so it is pushed and reported
      // exactly as a resolved one is, and the run ends here.
      await finishTheMerge(config, run, resolve(path), branch, null);
      return;
    }

    const said = await walkLifecycle(config, run, runToken, cwd, baseCommit, workspace,
        resume, mcpServers, expertAgents, skills, instincts, briefing, plan, lifecycle, shield);

    if (merge) {
      // R155. The session has gone. Whether it resolved anything is a question
      // about the TREE and the REMOTE, not about how the process exited or what
      // it said — a session that reports done over a tree full of conflict
      // markers is exactly the case this must not believe.
      await finishTheMerge(config, run, resolve(path), branch, said?.text ?? null);
    }
  } catch (failure) {
    // Anything that goes wrong before or during the spawn is the run's failure,
    // and the reason belongs on the run where someone will see it.
    log(`  failed: ${failure.message}`);
    await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/transition`, {
      method: 'POST',
      body: { state: 'FAILED', summary: failure.message },
    }).catch((second) => log(`  could not record the failure: ${second.message}`));
  } finally {
    reader?.release();
    running.delete(run.id);
    taken.delete(run.id);
    // The transcript of a run that is over is on the platform, where it belongs.
    // Holding four thousand lines of it here for ever is how a daemon that runs
    // for a week ends up being restarted for no reason anybody can name.
    control?.forget(run.id);
  }
}

/**
 * Whether this run is the kind that takes a checkout, before the child exists.
 *
 * R96: an INTERVIEW does. It is prepared a working copy and cut a branch like a
 * coding run, because the brief it writes is committed and goes out through the
 * project's finish rules — what it may write in that copy is far narrower, and
 * that is decided in PROFILE_TOOLS rather than here.
 */
function writesCodeProfile(run) {
  // R155: a MERGE does too, and needs it more literally than any of them — the
  // conflict is IN a working copy and there is nowhere else to resolve one. The
  // platform draws the same line in `RunProfile.writesCode()`.
  // R187: a RELEASE commits, tags and pushes, so it holds a checkout and counts
  // against the coding cap. `writesAnythingProfile` stays false for it, which
  // is what sends it through `argsForProfile` — no permission prompt, no
  // `bypassPermissions`, none of the project's extras.
  return !run.profile || run.profile === 'CODE' || run.profile === 'INTERVIEW'
    || run.profile === 'MERGE' || run.profile === 'RELEASE';
}

/**
 * Whether this run may change the SOURCE — R96, and not the same question.
 *
 * An interview takes a checkout and writes only the brief. The platform draws
 * the line in the same place (`RunProfile.writesAnything`), and this says it
 * again on the machine for the reason the ceiling is enforced twice: a claim
 * from an older platform has never been through the check at all.
 */
function writesAnythingProfile(run) {
  return !run.profile || run.profile === 'CODE';
}

/**
 * Spawns the agent with the run's own token, and nothing else.
 *
 * The user's `cawd_` token never reaches this process. The child gets a
 * `cawdr_` token bound to one run, which expires with it — so the worst a
 * confused or misbehaving session can do is act on the run it was started for.
 */
/**
 * The daemon walks the lifecycle — R112.
 *
 * <p>R109 gave a run stages and handed them to the SESSION as an instruction. A
 * session that ignores a gated stage is a session nobody stops, and one that
 * reports PLAN while calling Edit is believed. This is the fix, and it is the
 * same fix as R28's profiles: the narrowing is in what the process is SPAWNED
 * with, not in what it is asked.
 *
 * <p>One process per stage. Nothing carries across but what is written down —
 * which is why R108's briefing and R109's stored plan had to come first.
 *
 * <p>A run with NO lifecycle spawns exactly as it always did. That is not a
 * fallback, it is the ordinary case for ASK, ROADMAP, AUDIT and SCOPE, and for
 * every project that has not configured one.
 */
/**
 * Says so about the stages that will never run — R122.
 *
 * <p>A lifecycle can end before its last stage in three ordinary ways: the
 * agent reports done inside one, a person cancels, or a gate is refused twice.
 * In all three the stages behind it stay {@code PENDING}, which is the state
 * meaning *not yet* — so the console draws a run that is over as one still
 * working, and the stage it stopped in as the stage it is stuck in.
 *
 * <p>{@code SKIPPED} is the state that says the difference, and it already
 * exists for the stages a project has switched off. Reported one at a time and
 * never fatally: this is bookkeeping after the fact, and a run that has already
 * ended must not be failed because a tidying call did not land.
 */
async function skipRest(config, run, lifecycle, from, why) {
  for (let at = from; at < lifecycle.length; at++) {
    await reportStage(config, run, lifecycle[at].stage, 'report', {
      state: 'SKIPPED',
      outcome: why,
    });
  }
}

async function walkLifecycle(config, run, runToken, cwd, baseCommit, workspace, resume,
    projectServers, expertAgents, skills, instincts, briefing, plan, lifecycle, shield) {
  const spawn = (stage, carried, usage) => spawnAgent(config, run, runToken, cwd, baseCommit,
    workspace, resume, projectServers, expertAgents, skills, instincts, briefing, plan, lifecycle,
    shield, stage, carried, usage);

  // No lifecycle, or a resume: one process, exactly as before.
  //
  // A RESUME is deliberately not staged. `--resume` continues one conversation,
  // and there is no conversation to continue when the work was five of them —
  // R69's follow-up goes to the last stage that ran, which is the one the
  // person was reading when they typed it.
  if (!lifecycle?.length || resume) {
    return spawnAgent(config, run, runToken, cwd, baseCommit, workspace, resume,
      projectServers, expertAgents, skills, instincts, briefing, plan, lifecycle, shield);
  }

  log(`  walking ${lifecycle.length} stage(s): ${lifecycle.map((s) => s.stage).join(' → ')}`);
  const carried = {};
  let last = null;

  // R305. What the RUN has been credited with so far. Each stage is its own
  // process with its own cumulative counter, so the base the next child adds
  // to must move — read once from the claim, it stayed at zero and the platform
  // ignored every stage after the first as a reading that went backwards, so a
  // five-stage run's stored total was its largest stage rather than the sum.
  const spent = { tokensIn: Number(run.tokensIn) || 0, tokensOut: Number(run.tokensOut) || 0 };
  // And what each STAGE was already credited with, for the same reason. A run
  // walked a second time in a fresh session — handed off to another machine,
  // or one that died before the CLI said its session id — re-walks the same
  // `run_stage` rows, and the claim's total already holds the first walk; a
  // stage counted from zero here would be kept as max(walk) by the platform
  // while the run kept the sum. Read once; an older platform, or a stub,
  // answers without the fields and the base is zero, which is today's number.
  const stored = await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/stages`)
    .catch(() => []);
  const creditedTo = (name) => {
    const row = Array.isArray(stored) ? stored.find((each) => each?.stage === name) : null;
    return { tokensIn: Number(row?.tokensIn) || 0, tokensOut: Number(row?.tokensOut) || 0 };
  };

  const storedRow = (name) => (Array.isArray(stored)
    ? stored.find((each) => each?.stage === name) : null);

  for (let at = 0; at < lifecycle.length; at++) {
    const stage = lifecycle[at];
    // Where a carried-on run resumes, and what its DONE stages said, is the
    // platform's (R263, `WorkflowService.resumeFrom`): the claim's lifecycle
    // starts at the first stage not DONE. What only the daemon knows is WHY
    // the stage about to run stopped last time — so that is handed to it.
    const before = storedRow(stage.stage);
    if (before?.state === 'FAILED' && before.outcome) {
      // The attempt that stopped, handed to the one about to run.
      carried[`${stage.stage} (the attempt that stopped)`] = `${before.outcome}\n\n`
        + 'This stage is being run again to finish that. Run the commands — and the agents — '
        + 'it left running again IN THE FOREGROUND — not with run_in_background — wait for '
        + 'each one to end and read its output, then finish the stage properly. Check the '
        + 'checkout first: a background agent may have left part of its work there.';
    }
    // R305. What THIS stage's processes have used, across its attempts. Outside
    // the attempt loop on purpose: `run_stage` is one row per stage and keeps
    // the larger reading, so a second attempt after a refused gate must report
    // the first attempt's total plus its own, or the row would show
    // max(attempt) and the stages would no longer sum to the run.
    const stageSpent = creditedTo(stage.stage);
    // Two attempts at most, and the second only exists because a REFUSED gate
    // should cost one cheap stage rather than a whole run. A third would be a
    // loop nobody asked for.
    for (let attempt = 0; attempt < 2; attempt++) {
      await reportStage(config, run, stage.stage, 'begin');
      log(`  ${stage.stage}${stage.model ? ` on ${stage.model}` : ''}`
        + `${attempt ? ' (again, after the gate refused it)' : ''}`);

      // Both handed BY REFERENCE and moved below once the child is over. Safe
      // only because stages run one at a time: the child reads them at each
      // `result` event, and nothing else touches them while it lives.
      last = await spawn(stage, carried, { run: spent, stage: stageSpent });

      // Credited before the exit is judged, so a stage that was killed or
      // skipped still counts what its `result` events said it used.
      if (last?.usage) {
        spent.tokensIn += last.usage.input;
        spent.tokensOut += last.usage.output;
        stageSpent.tokensIn += last.usage.input;
        stageSpent.tokensOut += last.usage.output;
      }

      // A clean exit, OR a turn that ended. The second half is the half that
      // matters now: `endSession` closes a stage's input when its turn is over
      // and forces the process down if that is ignored, so a stage that did
      // every bit of its work can still leave on a signal — and reading that as
      // a failure would fail a run for a shutdown the daemon performed itself.
      //
      // Neither half alone is enough. A CLI that exits 0 having said nothing
      // did not do the work; one killed mid-thought did not either.
      if (last?.code !== 0 && !last?.turnEnded) {
        // Before this is a failure, ask whether the RUN is still going — R122.
        //
        // `reapCancelled` stops the process group of any run that is no longer
        // live, and that includes a run the AGENT itself ended by reporting
        // done in the middle of its lifecycle. The kill being read here is then
        // the daemon's own, and reading it as a dead stage is how a FINISHED
        // run comes to be drawn as stuck: R117 reported done inside VERIFY, the
        // reaper stopped the child, and the console showed a finished run whose
        // VERIFY stage said `exited with code 143` with three stages PENDING
        // behind it for ever.
        //
        // Asked of the platform rather than remembered locally, because the run
        // can end from three places — the agent's report, a person cancelling,
        // the sweeper — and only one of them passes through this process.
        const ended = await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}`)
          .catch(() => null);
        // R73's states are LIVE ones, which is why they need their own test
        // here: `PAUSED` and `USAGE_LIMITED` hold no process, so the child
        // exiting is expected rather than a fault — and R122's guard above asks
        // whether the run is over, which these are not.
        //
        // Without this the close handler's work is undone a moment later. It
        // classifies the exit as a usage limit and transitions the run; the
        // walk then reads a non-zero code and calls `finish(FAILED)` on top,
        // and the console shows a crash where a clock ran out. That is exactly
        // what R73 exists to prevent, arriving through a door R73 predates.
        if (ended && ended.live !== false && STOPPED_STATES.has(ended.state)) {
          const why = `The run was ${String(ended.state).toLowerCase().replace('_', ' ')}`
            + ` during the ${stage.stage} stage.`;
          log(`  ${why} Not failing it: the stage did not.`);
          await reportStage(config, run, stage.stage, 'report', {
            // SKIPPED and not FAILED. Nobody claims this stage finished its
            // work, and nobody should record that it broke: it stopped because
            // the run stopped.
            state: 'SKIPPED',
            plan: stage.stage === 'PLAN' ? last?.text ?? null : null,
            outcome: `${why} ${last?.text ?? ''}`.trim(),
          });
          await skipRest(config, run, lifecycle, at + 1, why);
          return;
        }

        if (ended && ended.live === false) {
          const why = ended.state === 'FINISHED'
            ? `The run was reported finished during the ${stage.stage} stage.`
            : `The run was ${String(ended.state).toLowerCase()} during the ${stage.stage} stage.`;
          await reportStage(config, run, stage.stage, 'report', {
            // DONE when the run reached its own ending here — the stage did not
            // fail, it is where the work stopped — and SKIPPED for every other
            // way a run can be over, where nobody claims the work was finished.
            state: ended.state === 'FINISHED' ? 'DONE' : 'SKIPPED',
            plan: stage.stage === 'PLAN' ? last?.text ?? null : null,
            outcome: `${why} ${last?.text ?? ''}`.trim(),
          });
          await skipRest(config, run, lifecycle, at + 1, why);
          return;
        }

        // A stage that died is the run failing, and R80's carry-on already
        // knows what to do with a failed run — including that it KEEPS the
        // workspace, so picking it back up does not start from origin.
        const how = last?.signal
          ? `was stopped (${last.signal}) before finishing its turn`
          : `exited with code ${last?.code}`;
        await reportStage(config, run, stage.stage, 'report', {
          state: 'FAILED',
          outcome: `The ${stage.stage} stage ${how}.`,
        });
        await finish(config, run, 'FAILED',
          `The ${stage.stage} stage ${how}. ${last?.text ?? ''}`.trim());
        return;
      }

      // The turn ended, but with commands it started in the background still
      // running, or finished and never read. Not done: the result is what the
      // stage was for. FAILED keeps the checkout and the session (R80), so
      // /continue picks the run up HERE — the stages behind it stay pending.
      if (last?.unfinishedShells?.length) {
        const listed = last.unfinishedShells.map((command) => `\`${command.slice(0, 120)}\``).join(', ');
        const why = `The ${stage.stage} stage ended with ${last.unfinishedShells.length} command(s) or agent(s) `
          + `still running in the background, or finished and never read: ${listed}. `
          + 'Nothing they proved was recorded — /continue runs this stage again and waits for them.';
        log(`  ${why}`);
        await reportStage(config, run, stage.stage, 'report', { state: 'FAILED', outcome: why });
        await finish(config, run, 'FAILED', `${why}\n\n${last.text ?? ''}`.trim());
        return;
      }

      await reportStage(config, run, stage.stage, 'report', {
        state: 'DONE',
        // The PLAN's text IS the plan — the artefact R109 exists to store, and
        // the thing a person reads in the gate below.
        plan: stage.stage === 'PLAN' ? last.text : null,
        outcome: last.text,
      });

      if (stage.gate !== 'ASK') {
        break;
      }

      const decision = await awaitGate(config, run, runToken, stage, last.text);
      if (decision.allowed) {
        break;
      }
      if (decision.expired) {
        // R339. Unread is not refused: re-running the stage would spend a
        // second stage on a plan nobody has looked at yet.
        const why = `Stopped at the ${stage.stage} gate: ${decision.reason}. Nothing was `
          + 'refused — start the run again when somebody can read it.';
        await skipRest(config, run, lifecycle, at + 1, why);
        await finish(config, run, 'FINISHED', why, cwd);
        return;
      }
      if (attempt === 1) {
        const why = `Stopped at the ${stage.stage} gate: ${decision.reason ?? 'refused twice.'}`;
        // The same trail R122 came from: a run that ends here never reaches the
        // stages after it, and stages left PENDING on a run that is over read
        // as a lifecycle still going.
        await skipRest(config, run, lifecycle, at + 1, why);
        await finish(config, run, 'FINISHED', why, cwd);
        return;
      }
      // Refused once: the reason is the point of refusing, so it goes into the
      // next attempt rather than into a log nobody reads.
      carried[`${stage.stage} (refused)`] =
        `${last.text}\n\n**This was refused.** ${decision.reason ?? 'No reason was given.'}`;
    }

    carried[stage.stage] = last.text;

    // R300. The scanner, after TEST settles and before the next stage — on
    // the tree the tests just ran against, by the daemon and not the session.
    // AWAITED: the workspace is released in `perform`'s finally, and a
    // scanner still reading files when the next run's reset runs is the
    // hazard; the block's `timeoutSeconds` bounds the wait. It never throws.
    if (stage.stage === 'TEST' && run.branch && writesAnythingProfile(run)) {
      await scanQuality(config, run, cwd, run.branch);
    }

    // R108. The MEMORY stage's output IS the briefing, saved by the DAEMON
    // rather than by the session calling a tool. One less thing to trust, and
    // one less tool to hand a stage that should not be writing.
    if (stage.stage === 'MEMORY' && last.text && run.branch) {
      await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/briefing`, {
        method: 'POST',
        body: { body: last.text },
      }).catch((failure) => log(`  could not save the briefing: ${failure.message}`));
    }
  }

  // Every stage done, and nothing has ended the run — the agent's own
  // `report done` usually has by now. This catches the lifecycle finishing
  // without one, which would otherwise leave the run RUNNING for ever.
  const current = await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}`)
    .catch(() => null);
  if (current?.live) {
    await finish(config, run, 'FINISHED', last?.text ?? 'The lifecycle finished.', cwd);
  }
  await settleActions(config, run, cwd);
}

/**
 * The live states that hold no process — R73, R80.
 *
 * <p>A run in one of these is not over and not running: the clock stopped it,
 * or a person did. A stage's child exiting under them is the consequence, not
 * the cause, so {@link walkLifecycle} must not read it as a stage that died.
 */
const STOPPED_STATES = new Set(['PAUSED', 'USAGE_LIMITED']);

/** Tells the platform a stage began, or how it ended. Never fatal. */
async function reportStage(config, run, stage, what, body = {}) {
  const path = what === 'begin'
    ? `/api/projects/${run.projectSlug}/runs/${run.id}/stages/${stage}/begin`
    : `/api/projects/${run.projectSlug}/runs/${run.id}/stages/${stage}/report`;
  await api(config, path, { method: 'POST', body })
    .catch((failure) => log(`  could not report ${stage}: ${failure.message}`));
}

/**
 * Waits for a person at a gated stage — R112.
 *
 * <p>On R51's approval and NOT on a third way of waiting. That is worth the
 * sentence: reusing it brings the inbox row, the badge, the expiry and the
 * decision UI, all of which already exist and none of which anybody has to
 * maintain twice.
 *
 * <p>The summary is the stage's own output, which for a PLAN is the plan. So
 * the person deciding is reading the plan — which is what R109 said an artefact
 * was for, and would not be true of a summary this function wrote itself.
 *
 * <p><strong>Unreachable means refused</strong>, and it is the one direction
 * this can fail in: a gate that let the run through when the platform was down
 * would be a gate that opens under exactly the conditions nobody is watching.
 */
async function awaitGate(config, run, runToken, stage, text) {
  let asked;
  try {
    asked = await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/approvals`, {
      method: 'POST',
      // The RUN's token: approvals are on `agent:ask`, which a machine token
      // does not carry and should not.
      token: runToken,
      body: {
        toolName: `stage:${stage.stage}`,
        toolInput: JSON.stringify({ stage: stage.stage }),
        summary: text?.trim()
          || `The ${stage.stage} stage finished without saying anything.`,
      },
    });
  } catch (failure) {
    log(`  could not raise the ${stage.stage} gate: ${failure.message}`);
    return { allowed: false, reason: `the gate could not be raised (${failure.message})` };
  }

  log(`  waiting at the ${stage.stage} gate`);
  // R339: no deadline of its own by default. A gate is a person reading the
  // plan, the platform never expires one, and a run waiting on it is never
  // swept — a timer here turned "not read yet" into a refusal and re-ran the
  // stage, which is spend nobody asked for. An older platform that does
  // expire it still answers EXPIRED, which is handled below.
  const deadline = Date.now() + gateTimeoutSeconds() * 1000;
  while (Date.now() < deadline) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    try {
      const decision = await api(config,
        `/api/projects/${run.projectSlug}/runs/${run.id}/approvals/${asked.id}/decision`
          + `?wait=${Math.min(25, Math.max(1, remaining))}`, { token: runToken });
      // A terminal state, or keep waiting. Checked on the STATE rather than on
      // the transport — a 204 and a `{state: 'PENDING'}` both mean "not yet",
      // and depending on which one the platform chose would be depending on
      // something nobody promised.
      if (decision?.state === 'EXPIRED') {
        // A platform from before R339. Nobody said no, so this is not a
        // refusal to re-run the stage over: the run stops at the gate.
        log(`  the ${stage.stage} gate expired unread`);
        return { allowed: false, expired: true, reason: 'nobody read it in time' };
      }
      if (decision && decision.state && decision.state !== 'PENDING') {
        const allowed = decision.state === 'ALLOWED';
        log(`  the ${stage.stage} gate was ${allowed ? 'allowed' : 'refused'}`);
        return { allowed, reason: decision.reason ?? decision.note ?? null };
      }
    } catch (failure) {
      log(`  waiting on the ${stage.stage} gate failed: ${failure.message}`);
      return { allowed: false, reason: `waiting failed (${failure.message})` };
    }
  }
  return { allowed: false, expired: true, reason: 'nobody answered in time' };
}

/**
 * How long a gate waits before the daemon gives up on it: for ever, unless a
 * test says otherwise — R339. The platform decides when nobody is coming.
 */
function gateTimeoutSeconds() {
  const configured = Number(process.env.CAWDEV_GATE_TIMEOUT_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : Infinity;
}

/**
 * An agent session, spawned under the machine's memory ceiling when it has
 * one — R339. `systemd-run --scope` execs in place, so the pid, the group and
 * the pipes are the agent's own. `cawdevCommand` is what the next daemon reads
 * off the driving note to tell this session's orphan from a reused pid.
 */
function spawnScoped(config, command, args, options) {
  const line = scoped(command, args, config.sessionScope);
  const child = spawn(line.command, line.args, options);
  child.cawdevCommand = command;
  return child;
}

async function spawnAgent(config, run, runToken, cwd, baseCommit, workspace, resume,
    projectServers, expertAgents, skills, instincts, briefing, plan, lifecycle, shield,
    stage = null,
    carried = null,
    // R305. `{ run, stage }`: what the run and this stage had already used
    // before this child, as the walk counted them. Null on an unstaged run or
    // a resume, where the claim's own figure is the base and there is no stage.
    usage = null) {
  // R51: what this machine will let a STORED rule cover. The project's rules
  // are filtered through it before they go anywhere near a spawn, so the
  // platform can narrow what runs here and never widen it.
  //
  // FIRST in this function, and it has to be: the MCP server's environment is
  // written a few lines below and carries the ceiling, so a declaration further
  // down is a ReferenceError on every single spawn. That shipped, and every
  // coding run failed with "Cannot access 'ceiling' before initialization"
  // until somebody tried to start one.
  // R126. What the CONSOLE granted this machine, when this machine says it
  // accepts that. It goes into the CEILING rather than through it, which is the
  // whole difference between this and a project rule: a project rule is
  // narrowed by what the laptop already allows, and this is the laptop being
  // told — by its own operator, through a page it opted in to — to allow more.
  const granted = await machineRules(config);

  // R147. Which of the run's experts THIS process may reach — moved ahead of
  // the agy branch below (R279) so BOTH spawn paths narrow the same way: a
  // read-only stage is handed only the experts that can change nothing.
  // `readOnlyExpert` judges by the frontmatter the plugin is written from, so
  // the plugin loaded, the delegation tool allowed, and the list the session
  // is told about all agree. Everything else, and every process with no
  // lifecycle, gets them all.
  const readOnlyStage = Boolean(stage) && ['PLAN', 'VERIFY', 'MEMORY'].includes(stage.stage);
  const stageExperts = readOnlyStage ? expertAgents.filter(readOnlyExpert) : expertAgents;
  // R161. From `stageExperts` and NEVER from `expertAgents` — see the note
  // above; an expert a read-only stage cannot reach must not be required here.
  const cannotDelegate = readOnlyStage && expertAgents.length && !stageExperts.length
    ? [`The ${stage.stage} stage holds nothing that can change anything, and none of this `
      + "project's experts is read-only, so none can be reached from it. They are reached "
      + 'from IMPLEMENT and TEST.']
    : undefined;

  // Which CLI answers this run — R276's follow-on made real. A staged run
  // carries the resolved choice on its stage (`stage.agent`, from
  // `WorkflowService.forRun`); anything else carries it on the run itself
  // now (`run.agent`, from `RunService.agentFor`) — both fall back to Claude
  // Code, exactly as every run did before either existed. Antigravity's
  // shape differs enough (no --mcp-config, no --allowedTools, no --resume —
  // checked against the real CLI by hand) that it is not this function's
  // Claude-specific machinery with a different binary name; it is
  // `spawnAntigravity`, entirely.
  // Codex's own shape — a real sandbox and a per-server tool list, but no
  // allow-list for the shell — is `spawnCodex`, for the same reason.
  if ((stage?.agent ?? run.agent) === 'codex') {
    const codexCmd = config.agentCommands.find((each) => agentOfCommand(each) === 'codex') ?? 'codex';
    return spawnCodex(config, run, runToken, cwd, baseCommit, resume, projectServers,
      skills, stageExperts, readOnlyStage, instincts, briefing, plan, lifecycle, stage, carried,
      codexCmd, granted, shield, usage);
  }
  if ((stage?.agent ?? run.agent) === 'agy') {
    const agyCmd = config.agentCommands.find((each) => agentOfCommand(each) === 'agy') ?? 'agy';
    return spawnAntigravity(config, run, runToken, cwd, baseCommit, resume, projectServers,
      skills, stageExperts, cannotDelegate, instincts, briefing, plan, lifecycle, stage, carried,
      agyCmd, granted, usage);
  }

  const ceiling = [
    ...(config.grantable ?? []),
    ...(config.projects[run.projectSlug]?.grantable ?? []),
    ...granted.patterns,
  ];
  if (granted.patterns.length) {
    log(`  this machine has been granted: ${granted.patterns.join(', ')}`);
  }
  // R126's "everything", and whether it applies HERE. Coding only: nothing else
  // is spawned with a permission mode or a permission prompt at all —
  // `argsBefore` strips both, deliberately — so an ASK session cannot be handed
  // the shell by a setting made about builds, and a PLAN session cannot be
  // handed a writer by it either.
  const everything = granted.everything && writesAnythingProfile(run);
  if (everything) {
    // Said every time, and not once at boot. "Everything" is the setting people
    // turn on for an afternoon and forget, and the log of the run it applied to
    // is where somebody looks afterwards.
    log('  !! this machine allows EVERYTHING: this session will not ask before any command');
  } else if (granted.everything) {
    // i138. Said too, because the operator who turned it on and then watched a
    // plan session get refused a shell needs the log to say the two are
    // connected — that the setting was read, and is coding-only by design.
    log(`  this machine allows everything, and that is coding-only: a ${run.profile} session `
      + 'holds its own list and nothing else');
  }
  // Only a coding session can be given anything by a rule. Asked in the same
  // breath as the ceiling so the two cannot drift apart.
  const stored = writesCodeProfile(run) ? await projectRules(config, run.projectSlug) : [];
  const admitted = stored.filter((pattern) => withinCeiling(ceiling, pattern));
  const refused = stored.filter((pattern) => !withinCeiling(ceiling, pattern));

  const mcpDirectory = await mkdtemp(join(tmpdir(), 'cawdev-runner-'));
  const mcpConfigPath = join(mcpDirectory, 'mcp.json');

  // The frozen copy, never the one in the working copy — which the run itself
  // may have just checked out onto another branch. See snapshotTools.
  const serverPath = config.mcpServerPath ?? new URL('../mcp/server.mjs', import.meta.url).pathname;

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

  // R76. The skills the project turned on, each as an MCP server. AFTER the repository's own, so a checkout cannot shadow a skill
  // with a server of the same name and be spawned in its place — the same
  // ordering argument that puts cawdev's own entry last, one level down.
  //
  // `resolveSkills` also prepares whatever a skill keeps per repository, which
  // for CodeGraph is the index. It never throws and never fails a run: every
  // outcome comes back as a sentence for the transcript.
  const { attached, notes: skillNotes } =
      await resolveSkills(config, run, cwd, baseCommit, projectServers);
  for (const { skill, local } of attached) {
    mcpServers[skill.serverName] = {
      command: skill.command,
      args: skill.args,
      // The machine's environment for it, plus nothing from the platform. A
      // skill's stored settings are deliberately NOT spread in here: the row
      // says what to run and the machine says under what conditions, and a
      // settings blob that could add environment variables would be a channel
      // from a database row into a spawned process.
      env: { ...process.env, ...(local.env ?? {}) },
    };
  }

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
      // R76. Which of the servers in this config are skills — so that when the
      // first call to one stops and asks, the pattern offered is the WHOLE
      // server rather than the one tool.
      //
      // A skill is one decision: the project turned CodeGraph on, not
      // `codegraph_explore`. Being asked twenty-six times about a capability
      // somebody has already expressed as one thing is how a good permission
      // model becomes a thing people click through. A server this list does not
      // name keeps the per-tool suggestion, because nobody declared it as a
      // capability — see `suggestionFor`.
      CAWDEV_SKILL_SERVERS: JSON.stringify(
        attached.map(({ skill }) => skill.toolPrefix ?? `mcp__${skill.serverName}`)),
      // R110. The policy, and the checkout it is measured against. The CHECK is
      // the server's — it is the process Claude Code asks before a tool call,
      // and there is nowhere else the answer can be given in time.
      CAWDEV_SHIELD: JSON.stringify(shield ?? {}),
      CAWDEV_WORKSPACE: cwd,
    },
  };
  await writeFile(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2));

  // R147/R279. `readOnlyStage` and `stageExperts` are computed once, ahead of
  // the agy branch above, so both spawn paths narrow the same way.

  // R161. What this project said had to be used, by the name a transcript line
  // carries.
  //
  // From `stageExperts` and NEVER from `expertAgents`. An expert a read-only
  // stage cannot reach — dropped by `readOnlyExpert` just above — must not be
  // required HERE: requiring what the stage was deliberately not given is how
  // this would come to widen what a run may do, which is the one thing it must
  // not do. The mode is read after the narrowing, always.
  //
  // R303. An MCP server can be required too, and the entry comes from
  // `attached` — what this machine actually spawned — and NEVER from the
  // claim's list, for exactly the reason above: a server the machine refused
  // cannot be required of a session that has no such tool. And only when the
  // stage can reach it: a read-only stage is spawned with `listOnly`, which
  // strips the permission prompt, and `mcp__<server>__*` is never on its list —
  // so a PLAN stage told it MUST call `mcp__codegraph__…` would be nudged for
  // something it was deliberately not given. IMPLEMENT and TEST, and a run
  // with no lifecycle, keep the prompt and can answer the first call.
  //
  // Keyed `<kind>:<name>` on both sides — here and where `used` is filled —
  // so a server named like a skill cannot satisfy the other's requirement.
  const serversCanBeReached = !readOnlyStage;
  const mustUse = new Set([
    ...stageExperts.filter((each) => each.mode === 'REQUIRED')
      .map((each) => `EXPERT:${qualified(each.key)}`),
    ...skills.filter((each) => each.mode === 'REQUIRED')
      .map((each) => `SKILL:${qualified(each.key)}`),
    ...(serversCanBeReached ? attached : [])
      .filter(({ skill }) => skill.mode === 'REQUIRED')
      .map(({ skill }) => `MCP_SERVER:${skill.serverName}`),
  ]);
  /** The transcript's name for a requirement — what the nudge and the log say. */
  const nameOf = (entry) => entry.slice(entry.indexOf(':') + 1);

  // R104/R105. The experts and skills the project turned on, as one plugin in
  // the daemon's own directory — see writeRunPlugin for why not the checkout.
  const pluginRoot = await writeRunPlugin(mcpDirectory, stageExperts, skills);
  if (pluginRoot) {
    log(`  loading ${stageExperts.length} expert(s) and ${skills.length} skill(s)`);
  }

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
        // R126. What the console granted THIS MACHINE. Straight in rather than
        // through `withinCeiling`, because these ARE the ceiling — filtering
        // them through it would mean a grant could only ever restate something
        // the config already allowed, which is a grant that does nothing.
        //
        // Coding only, like everything else here: a machine that may run `mvn`
        // unattended has said nothing about handing it to a session that was
        // asked a question.
        ...granted.patterns,
      ];
  const agentArgs = [...config.agentArgs];

  // R126. "Allow everything on this machine", expressed in the CLI's own words
  // rather than as a pattern list that tries to name everything. `agentArgs`'s
  // own comment already points at bypassPermissions as the honest way to say
  // this — "a real decision about what an unattended agent may do in your
  // checkout, so it is yours to make" — and this is that decision made through
  // the console instead of by hand.
  //
  // Coding only — `everything` above says so. And only the stages of a coding
  // run that write: a read-only stage is spawned through `argsBefore`'s
  // `listOnly` below, which drops the mode again, because "everything" is a
  // decision about what an unattended agent may RUN in a checkout and not a
  // decision that MEMORY may write files.
  if (everything) {
    const mode = agentArgs.indexOf('--permission-mode');
    if (mode !== -1) {
      agentArgs[mode + 1] = 'bypassPermissions';
    } else {
      agentArgs.push('--permission-mode', 'bypassPermissions');
    }
  }

  // R61. Whether this session may drive the browser: the run asks, and this
  // machine answers. Both have to say yes.
  //
  // Refusing is NOT a failure. The run goes ahead without a browser and says so
  // on its own transcript — "I could not look at it" is a thing the session and
  // whoever reads it later both need to know, and failing the run instead would
  // throw away work over a capability it may not even have needed.
  const browserAllowedHere = config.projects[run.projectSlug]?.browser ?? config.browser;
  const browser = Boolean(run.browser) && Boolean(browserAllowedHere) && writesCodeProfile(run);
  if (browser) {
    agentArgs.unshift('--chrome');
  }

  // Which model answers. Passed through verbatim — the CLI validates it, and a
  // run that names none is spawned exactly as it was before R23.
  //
  // Before --allowedTools, which is variadic and would swallow it.
  // R112. The stage's model when this is a stage, else the run's. This is the
  // line that makes R109's router real: a router that resolved a model per
  // stage into a single process was a row in a database that nothing read.
  const model = stage?.model ?? run.model;
  if (model) {
    agentArgs.unshift('--model', model);
  }

  // How hard it is told to think: --effort low|medium|high|xhigh|max. Passed
  // through verbatim for the same reason as the model — the CLI validates it,
  // and a run naming none is spawned exactly as it was before.
  if (run.effort) {
    agentArgs.unshift('--effort', run.effort);
  }
  // R69. Which conversation this is. Before --allowedTools for the reason the
  // model and the effort are: that option is variadic and swallows whatever
  // follows it.
  //
  // The PERMISSIONS are untouched by this. A resumed ask is spawned through
  // exactly the same argsForProfile below as the first time, because the run's
  // profile is the same run's profile — being started a second time is not a
  // reason to be allowed to write files.
  if (resume?.agentSessionId) {
    agentArgs.unshift('--resume', resume.agentSessionId);
  }

  if (extras.length) {
    if (!agentArgs.includes('--allowedTools')) {
      agentArgs.push('--allowedTools');
    }
    agentArgs.push(...extras);
  }
  const writesCode = writesCodeProfile(run);
  // The CODING arguments, which is not the same question as whether a checkout
  // was prepared — R96. An interview has one and is still spawned with its own
  // list: it may read everything, write the brief, and commit, and that is all.
  const codesFreely = writesAnythingProfile(run);
  // R107's two halves meet here: the platform's instincts, and the repository's
  // own `.ai-config.md` read out of the checkout this run is standing in.
  const harness = harnessPrompt({
    instincts,
    briefing,
    // R147. Named to the session, by the name the CLI answers to. Before this
    // the experts reached a session only through the CLI's own listing, beside
    // its built-in agents, and nothing chose one.
    experts: stageExperts.map((each) => ({
      qualified: qualified(each.key),
      description: each.description ?? each.name ?? each.key,
      // R161: named under its own MUST heading rather than in the list.
      required: each.mode === 'REQUIRED',
    })),
    skills: skills.map((each) => ({
      qualified: qualified(each.key),
      description: each.description ?? each.name ?? each.key,
      required: each.mode === 'REQUIRED',
    })),
    // R303. Only a REQUIRED server changes the prompt, and only where the
    // stage can reach it — the same gate `mustUse` applies, so the prompt and
    // the nudge never disagree about what a stage owes.
    mcpServers: attached.map(({ skill }) => ({
      name: skill.name ?? skill.key,
      prefix: skill.toolPrefix ?? `mcp__${skill.serverName}`,
      required: serversCanBeReached && skill.mode === 'REQUIRED',
    })),
    cannotDelegate,
    // R124. Null on everything but an implementation phase whose card has been
    // planned, which the PLATFORM decides — the runner does not work out which
    // runs deserve a plan, it carries the one it was handed.
    plan,
    lifecycle,
    repoConfig: await readRepoConfig(cwd),
  });

  // R112. A stage's tools are its own, narrowed from the PROFILE's rather than
  // chosen freely — so a stage can never be handed something the profile would
  // have refused. PLAN and VERIFY end up with no write tool at all, which is
  // the whole entry.
  const profileTools = codesFreely
    ? agentArgs.slice(agentArgs.indexOf('--allowedTools') + 1)
    : (PROFILE_TOOLS[run.profile] ?? READ_ONLY_CAWDEV);
  // i138. A stage's arguments before the list are the coding defaults' only
  // when the stage may write: a non-coding profile and a read-only stage are
  // given the list and nothing that reaches past it — no `acceptEdits`, no
  // `bypassPermissions`, no permission prompt — which is what `argsForProfile`
  // has always done for the same profile spawned as one process. Without this
  // the list `toolsForStage` narrows was narrowed on paper: the mode wrote
  // files the list never named, and the prompt asked a person for the rest.
  const stageArgs = stage
    ? [...argsBefore(agentArgs, { listOnly: !codesFreely || readOnlyStage }), '--allowedTools',
      ...toolsForStage(stage.stage,
        withSkills(
          withDelegation(typeof profileTools === 'function' ? profileTools(run) : profileTools,
            stageExperts),
          skills),
        // R129. Only TEST reads it, and only when the project set it: a
        // testbook stage is spawned with nothing that can run anything.
        stage.testMode,
        // R147. A read-only stage keeps `Agent` when every expert it was
        // handed is read-only — which `stageExperts` guarantees above.
        // R150. And a PLAN stage keeps `roadmap_create` when the run has no
        // card to plan, because writing it is the first thing it has to do.
        { delegatesReadOnly: readOnlyStage && stageExperts.length > 0,
          writesItsOwnCard: writesItsOwnCard(run) })]
    : null;

  // Reaching here at all means Claude Code answers this run — the branch at
  // the top of this function sent Antigravity to spawnAntigravity instead.
  // Matched against what this machine actually lists (`config.agentCommands`)
  // by `agentOfCommand`, the rule `readUsage` uses too, so a machine whose list
  // is agy- or codex-first still gets Claude Code's own command.
  const agentCmd = config.agentCommands.find((each) => agentOfCommand(each) === 'claude')
    ?? 'claude';

  const args = [
    '--mcp-config',
    mcpConfigPath,
    // Only when there is something in it. An empty plugin loads nothing and
    // still says, in the session's own listing, that cawdev gave it something —
    // which is a lie a person would have to go and check.
    ...(pluginRoot ? ['--plugin-dir', pluginRoot] : []),
    ...(stageArgs ?? (codesFreely
      ? [...argsBefore(agentArgs), '--allowedTools',
        ...withSkills(
          withDelegation(agentArgs.slice(agentArgs.indexOf('--allowedTools') + 1), expertAgents),
          skills)]
      : argsForProfile(agentArgs, run.profile, run, expertAgents, skills))),
  ];
  log(`  spawning: ${agentCmd} ${args.join(' ')} (prompt on stdin)`);

  return new Promise((resolvePromise) => {
    const child = spawnScoped(config, agentCmd, args, {
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
    // Which CLI and which model — what advanced mode puts in a window's title.
    // The model asked for now; the one the CLI says it is on replaces it at
    // `init` (below), which is also the only answer when none was asked.
    child.cawdevAgent = 'claude';
    child.cawdevModel = model ?? null;
    // The checkout this child holds, and what the queue serialises on. Null for
    // a run that took none, which is what lets an ASK session run alongside
    // three coding ones.
    child.cawdevWorkspace = workspace ?? null;
    // Enough of the run for the socket to name it. The child is the only handle
    // the daemon keeps once a session is going, so what somebody attaching
    // needs to read has to hang off it.
    child.cawdevRun = {
      projectSlug: run.projectSlug,
      label: run.label,
      branch: run.branch,
      profile: run.profile ?? 'CODE',
    };
    // A stdin with no error listener turns EPIPE into an unhandled event, and an
    // unhandled event on a socket ends the process — the daemon, not the run.
    // The child's own exit is what says the session is over; this only stops it
    // being said by a crash.
    child.stdin?.on('error', (failure) => {
      if (failure.code !== 'EPIPE') {
        log(`  the session's input failed: ${failure.message}`);
      }
    });
    child.cawdevStartedAt = new Date().toISOString();
    // What kind it is, so the queue knows whether it holds the working copy.
    // Whether it holds the working copy, which is what the queue serialises on.
    child.cawdevWritesCode = writesCode;
    running.set(run.id, child);

    // The opening instruction, as a user message. stdin is NOT closed here:
    // the session stays open for whatever a person types next. For a stage,
    // endSession() closes it when the turn ends — see there.
    //
    // On a resume it is the FOLLOW-UP and nothing else — R69. The session is
    // being handed back its own transcript, so it already has the question, the
    // answer and the preamble that told it what it may do. Writing promptFor()
    // again would ask it the original question a second time, which is a repeat
    // wearing a resume's clothes.
    // R107–R109. The profile's prompt, then what this PROJECT adds — appended
    // and labelled, so the session can tell a standing rule from its task.
    //
    // Not on a resume: that session already has all of this in its context, and
    // sending it again is a repeat wearing a resume's clothes — R69's rule about
    // the opening prompt, applied to the thing that now travels with it.
    writeUserMessage(child, resume?.prompt
      ?? (promptFor(run) + harness + (stage ? stagePrompt(stage, carried, Boolean(plan?.body)) : '')));

    let lastText = '';
    // R305. This child's own last reading, handed back to the walk so the next
    // stage's base can move.
    let childTotals = null;
    // Whether the CLI ever said its turn was over. This, and not the exit code,
    // is what says a STAGE did its work — see the failure branch in
    // walkLifecycle, and endSession above for why the two came apart.
    let turnEnded = false;
    // R161. Every capability this child has been seen to call, by qualified
    // name. Read off the transcript lines the daemon already writes rather than
    // asked of the platform: the answer is needed at the `result` event, and a
    // question that has to cross the network cannot be answered in time.
    const used = new Set();
    // i257. A required expert's `Agent(...)` line is written the instant the
    // call is MADE (R130), not when its result comes back — so `used` alone
    // cannot tell "delegated and waited" from "delegated and moved on". This
    // holds the qualified name of every required expert whose most recent
    // `Agent`/`Task` call was NOT `run_in_background: false` — added on that
    // call, and removed the moment the same name is called again WITH it. A
    // stage is one process and gets one turn (R112); a session that ends its
    // turn with a name still in here dispatched the delegation and did not
    // wait for it, which is exactly the shape that loses it when `endSession`
    // closes stdin below.
    const backgrounded = new Set();
    // Shell commands this child started in the background and never saw end
    // — the walk will not call a stage done with any of them left (see
    // background-shells.mjs).
    const shells = new BackgroundShells();
    // The last of what the CLI said on stderr, for the exit decision below.
    // The usage-limit notice is written there, and a decision made on stdout
    // alone would call every window a crash.
    let stderrTail = '';
    // Whether a closed window has already been reported for this child. The
    // CLI emits one `result` per turn and a run may have several, so without
    // this a limited session reports the same window on every turn after it.
    let limitReported = false;
    const transcript = new Transcript(config, run);

    // R113. Nothing watched for silence, and a session that stops producing
    // output holds its workspace until a person notices.
    //
    // It SAYS SO rather than killing. A daemon that ended runs on a timer would
    // eventually end a legitimate twelve-minute test suite, and the cost of
    // being wrong in that direction is somebody's work — while the cost of
    // being wrong in this one is a line in a transcript.
    let idleTimer = null;
    let said = false;
    const quiet = () => {
      if (!config.idleSeconds) {
        return;
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (said) {
          return;
        }
        said = true;
        const minutes = Math.round(config.idleSeconds / 60);
        log(`  ${run.label}: nothing for ${minutes} minute(s)`);
        transcript.push({
          kind: 'ERROR',
          body: `cawdev: this session has said nothing for ${minutes} minutes. It may be `
            + 'thinking, running something long, or stuck — nothing has been stopped, and it '
            + 'is holding this project\'s checkout while it is here.',
        });
      }, config.idleSeconds * 1000);
      // Never hold the process open on this alone: a daemon that could not exit
      // because a watchdog was pending would be a worse bug than the one it is
      // here to catch.
      idleTimer.unref?.();
    };
    quiet();


    // R61. Asked for a browser and not given one. Said on the RUN for the same
    // reason a refused rule is: the session is about to report that it could
    // not look at the page, and the reason belongs next to that rather than in
    // a log on somebody's laptop.
    if (run.browser && !browser) {
      const line = writesCodeProfile(run)
        ? 'This run asked to drive the browser, and this machine does not allow it. '
          + 'It is running without one — set "browser": true in the runner\'s config to '
          + 'permit it. Nothing else about the run is affected.'
        : 'This run asked to drive the browser, but its profile writes no code and has '
          + 'nothing to look at, so it is running without one.';
      log(`  ${line}`);
      transcript.push({ kind: 'SYSTEM', body: line });
    }
    if (browser) {
      const line = 'Claude in Chrome is available to this session. The first call still asks '
        + 'a person — allow mcp__claude-in-chrome for the session to cover the rest.';
      log(`  ${line}`);
      transcript.push({ kind: 'SYSTEM', body: line });
    }

    // R76. What was attached, what was refused, and what happened to a skill's
    // index — on the RUN, for the reason the browser's line is: the session is
    // about to either use a capability or explain that it could not, and the
    // reason belongs beside that rather than in a log on somebody's laptop.
    // Which side refused is in the sentence, because "the project asked and
    // this machine has not allowed it" and "nobody asked" are different facts.
    for (const line of skillNotes) {
      log(`  ${line}`);
      transcript.push({ kind: 'SYSTEM', body: line });
    }

    // R130. The other three things the project turned on, on the same argument
    // as the skill notes above: a person who configured an expert, a skill or a
    // memory and cannot tell whether it was ever reached has no way to find out
    // except by reading a daemon's log on somebody else's laptop.
    for (const agent of expertAgents) {
      // R147: the QUALIFIED name, which is the one the CLI answers to — the
      // bare key was the honest-looking line that sent a person, and a
      // session, to a name that did not exist.
      //
      // And the honest answer to "why did my expert never get used?" in the
      // other common case. A read-only stage reaches only an expert that can
      // change nothing (`readOnlyExpert`); one that asks for a writer is left
      // out of the stage's plugin, and this says so where the person is
      // looking rather than in a daemon's log.
      const cannot = readOnlyStage && !stageExperts.includes(agent)
        ? ` The ${stage.stage} stage cannot reach it: it asks for tools that can change `
          + 'things, and only read-only experts are reached from here.'
        : '';
      // R161. A required one says so where the person is looking. Only when the
      // stage can actually reach it: `cannot` and this are mutually exclusive
      // by construction, because `mustUse` is built from `stageExperts`.
      const must = mustUse.has(`EXPERT:${qualified(agent.key)}`)
        ? ' This project REQUIRES it: if this stage finishes without using it, the session '
          + 'will be told.'
        : '';
      const line = `${agent.name} is available to delegate to as `
        + `Agent(${qualified(agent.key)}).${cannot}${must}`;
      log(`  ${line}`);
      transcript.push({ kind: 'SYSTEM', body: line });
    }

    for (const skill of skills) {
      const must = mustUse.has(`SKILL:${qualified(skill.key)}`)
        ? ' This project REQUIRES it: if this stage finishes without using it, the session '
          + 'will be told.'
        : '';
      const line = `${skill.name} is available to this session as `
        + `Skill(${qualified(skill.key)}).${must}`;
      log(`  ${line}`);
      transcript.push({ kind: 'SYSTEM', body: line });
    }

    // R108's briefing reached the daemon's stdout and nowhere else, so the one
    // session that was handed the last one's notes was the only party that
    // could not see it had been.
    if (briefing) {
      const line = `A briefing left on ${run.branch} was handed to this session.`;
      log(`  ${line}`);
      transcript.push({ kind: 'SYSTEM', body: line });
    }

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

    // R76. What this run had already used before this child started. Zero on an
    // ordinary run; on a resume it is what the earlier session spent, which the
    // claim carries on the run itself. R305: on a staged run the walk keeps the
    // count, because the claim's figure never moves and every stage after the
    // first would otherwise report from zero again.
    const usageBase = usage?.run ?? {
      tokensIn: Number(run.tokensIn) || 0,
      tokensOut: Number(run.tokensOut) || 0,
    };

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
        if (event) shells.observe(event);

        // i257. Read off the RAW event, before `linesOf` flattens it to a
        // string: `describeCall` (`../lib/tool-line.mjs`) never carries
        // `run_in_background` into the TOOL line it writes — deliberately not
        // extended for it, because that line is a parsing contract three
        // implementations share (`CapabilityUse.java`, `capability-tag.ts`),
        // and this is a daemon-internal question none of the three need
        // answered. So this is the one place that can still see the field.
        // Record-then-decide, ahead of the loop below that reacts to
        // `result`, so a `result` on this same line always sees this line's
        // own dispatches first.
        //
        // Only tracked for a REQUIRED expert. An optional one backgrounded is
        // the session's own call and nothing here gates on it.
        //
        // Known consequence of not extending the shared line: the platform's
        // own ledger (`RunCapabilityService.used`, called from
        // `RunService.appendOutput` on the same TOOL line and read by the run
        // panel) increments `RunCapability.uses` the instant the line is
        // written, exactly like `used` below — it has no way to learn a
        // dispatch was backgrounded, so a stage this nudge caught and that
        // then corrected itself still reads as an ordinary "required,
        // delegated to 1×" on the panel afterwards. That is this card's
        // trade-off, made on purpose: the daemon is the one place that can
        // still leave with the delegation unfinished, so it is the one place
        // that has to catch it before it does. Making the panel say so too is
        // a different card, not a reason to read it as ground truth here.
        //
        // The default-background assumption this rests on is not a guess:
        // i249 and i250 are both a `Agent(...)` call with no
        // `run_in_background` at all whose result never came back — this
        // project's own Agent tool backgrounds unless told `false`. If a
        // spawned CLI's `Agent` were ever synchronous by default, this would
        // nudge a stage that did nothing wrong — loud, not silent, and capped
        // at one wasted turn by `child.cawdevNudged` below.
        //
        // Keyed `EXPERT:<name>`, matching `mustUse`/`used`: a Set of bare
        // names would let a REQUIRED skill and a REQUIRED expert that share a
        // qualified name mark each other's requirement backgrounded.
        //
        // The last call to a name wins. A session that is awaited once and
        // backgrounded again later is reported missing on the second call —
        // "requirement met" and "something is in flight" are conflated on
        // purpose, because the second call is the one whose result this
        // stage's turn is actually at risk of losing.
        if (event?.type === 'assistant') {
          for (const part of event.message?.content ?? []) {
            if (part?.type !== 'tool_use' || (part.name !== 'Agent' && part.name !== 'Task')) {
              continue;
            }
            const who = typeof part.input?.subagent_type === 'string'
              ? part.input.subagent_type : null;
            const entry = who ? `EXPERT:${who}` : null;
            if (!entry || !mustUse.has(entry)) {
              continue;
            }
            if (part.input?.run_in_background === false) {
              backgrounded.delete(entry);
            } else {
              backgrounded.add(entry);
            }
          }
        }

        if (event?.type === 'result') {
          if (typeof event.result === 'string') {
            lastText = event.result;
          }
          // The turn is over. An errored result is still an ending, so the
          // session is closed either way — but it is not work done, and the
          // walk is told the difference rather than left to read an exit code
          // that says nothing about it.
          turnEnded = turnEnded || event.is_error !== true;

          // R73, at the moment the window is actually said.
          //
          // The close handler below asks `usageLimitOf` too, and asks it too
          // late and under a condition that does not hold: only when the child
          // EXITS, and only when it exits NON-ZERO. A session that hits its
          // limit mid-run does neither. The CLI prints "You've hit your session
          // limit · resets 4am", ends the turn with SUCCESS, and then — R22
          // holds its stdin open, correctly, so a person can prompt it — sits
          // there for ever. Observed: forty-three minutes, a run stuck RUNNING,
          // the machine's only slot held, and three queued runs behind it.
          //
          // Worse, the recovery made it invisible. Carrying the run on put it
          // back to QUEUED, and when the process was finally killed the daemon
          // recognised the window and the platform refused the report — "a run
          // that is QUEUED cannot move to USAGE_LIMITED" — so the one moment
          // this daemon KNEW a window was closed was spent on a state the run
          // had already left. Then it re-claimed and spawned a fresh session
          // straight back into the same closed window.
          //
          // Same matcher, same text, same trust as the exit path — this only
          // stops waiting for an exit that is not coming. The direction of a
          // mistake is deliberate: a false positive parks a run and lets
          // AutoResumer pick it up after a reset that has already passed, which
          // costs a delay; a false negative is what the paragraph above
          // describes.
          if (!limitReported) {
            const closed = usageLimitOf(lastText ?? '');
            if (closed) {
              limitReported = true;
              log(`  the ${closed.window === 'WEEKLY' ? 'weekly' : 'five-hour'} usage window `
                + `closed mid-run${closed.resetsAt ? `; resets ${closed.resetsAt.toISOString()}` : ''}`);
              // Not awaited: this is the stream's handler, and a reader that
              // stopped to talk to the platform would stall the transcript
              // behind the network — the same rule the shield follows below.
              reportUsageLimit(config, run, closed, lastText);
              // A stage is asked to leave just below, for its own reason. A run
              // has to be asked here: USAGE_LIMITED holds no process (R73), and
              // leaving one behind is the forty-three minutes again.
              if (!stage) {
                endSession(child, 'the usage window closed', config.sessionExitSeconds);
              }
            }
          }

          // R22's cost, paid. A stage has nobody to prompt it and one turn to
          // give, so this is where its process is asked to leave; without it
          // the walk waits on a `close` that cannot come. A run with no
          // lifecycle keeps its input open, exactly as R22 intends.
          if (stage) {
            // R161. The one moment the daemon owns: between "the turn ended"
            // and "close the input" there is room for exactly one more turn, in
            // the same session, with all of its context. A run with no
            // lifecycle never reaches here — `endSession` is deliberately not
            // called for one — so REQUIRED is prompt wording and a console row
            // on ASK, ROADMAP and AUDIT, and nothing more.
            // i257. `used` alone says "the name appeared in a TOOL line",
            // which is true the instant a required expert is DISPATCHED —
            // backgrounded or not. An entry still in `backgrounded` was
            // delegated but never waited for, so it counts as missing here
            // too. `stillBackgroundedEntries` keeps the `EXPERT:` prefix so it
            // can only ever match the Set it was built from; only its NAMES
            // (`nameOf`) are for display.
            const stillBackgroundedEntries = [...mustUse].filter((entry) => backgrounded.has(entry));
            const trulyMissingEntries = [...mustUse].filter((entry) => !used.has(entry));
            const missing = [...new Set([...trulyMissingEntries, ...stillBackgroundedEntries])]
              .map(nameOf);
            const stillBackgrounded = stillBackgroundedEntries.map(nameOf);
            // Whether the input stays open for one more turn. NOT an early
            // return out of this handler, which the obvious shape would be:
            // this is the stdout reader's `while`, and returning from it would
            // drop the rest of an already-buffered chunk along with this turn's
            // own usage report and its transcript line.
            let nudged = false;
            if (missing.length && !child.cawdevNudged) {
              // Once per process. A model that has decided cannot be looped:
              // this is a nudge, not an argument.
              child.cawdevNudged = true;
              // i257. "has not used" is not true of `stillBackgrounded` — it
              // WAS called, just not waited for — and this line is the half
              // of the nudge a person actually reads (`nudgeText` below goes
              // to the child's stdin, never to the transcript). This card
              // exists because a run once said nothing was done when work
              // really happened; a nudge that misdescribes its own trigger
              // would be the same mistake at smaller scale.
              const trulyMissingNames = trulyMissingEntries.filter((entry) => !backgrounded.has(entry))
                .map(nameOf);
              const clauses = [
                trulyMissingNames.length ? `has not used ${trulyMissingNames.join(', ')}` : null,
                stillBackgrounded.length
                  ? `delegated to ${stillBackgrounded.join(', ')} only in the background and never `
                    + 'waited for it'
                  : null,
              ].filter(Boolean);
              const line = `cawdev: this stage ${clauses.join(', and ')}, which this project `
                + 'requires. Asking it once.';
              log(`  ${line}`);
              transcript.push({ kind: 'SYSTEM', body: line });
              // The return value is load-bearing. It is false when stdin is
              // already gone — a crashed or finished session — and falling
              // through to `endSession` is what stops a dead session from never
              // being dismissed. That is R22's forty-three minutes arriving
              // through a new door.
              nudged = writeUserMessage(child, nudgeText(stage, missing, stillBackgrounded));
              if (nudged) {
                // The turn runs again and the next `result` closes the input.
                // This timer is the whole defence against the one deadlock this
                // could introduce: if that second `result` never comes, the
                // stage still leaves. Unref'd, so it cannot hold the daemon
                // open — `endSession`'s own timers are unref'd for the same
                // reason, one level down.
                setTimeout(() => endSession(child, `the ${stage.stage} stage`,
                  config.sessionExitSeconds), config.sessionExitSeconds * 2000).unref?.();
              }
            }
            if (!nudged) {
              endSession(child, `the ${stage.stage} stage`, config.sessionExitSeconds);
            }
          }
        }
        // R69. The handle this conversation can be continued with. The CLI
        // announces it on `init` and nowhere else, so it is caught here rather
        // than derived — and it is reported EVERY time, because a resumed
        // session announces itself again and the id a further resume needs is
        // the most recent one, not the first.
        if (event?.type === 'system' && event.subtype === 'init' && event.session_id) {
          reportSessionId(config, run, event.session_id);
        }
        if (event?.type === 'system' && event.subtype === 'init' && event.model) {
          child.cawdevModel = event.model;
        }
        // R76. What the session has consumed, recorded rather than only
        // printed. Caught here for the reason the session id is: the CLI says
        // it on a `result` event and nowhere else.
        //
        // The base is what the RUN had already been credited with before this
        // child existed, because these counters are cumulative per session and
        // a resumed run (R69) starts a second process counting from zero.
        // Adding this child's total to that base is the only reading that is
        // right for both a first run and a resumed one.
        if (event?.type === 'result') {
          const totals = totalsOf(event);
          if (totals) {
            childTotals = totals;
            reportUsage(config, run, {
              tokensIn: usageBase.tokensIn + totals.input,
              tokensOut: usageBase.tokensOut + totals.output,
            });
            // R305. The same reading, filed on the stage: its own base plus
            // this child, absolute for the stage across its attempts.
            if (stage && usage?.stage) {
              reportStageUsage(config, run, stage.stage, {
                tokensIn: usage.stage.tokensIn + totals.input,
                tokensOut: usage.stage.tokensOut + totals.output,
              });
            }
          }
        }
        // R113. Anything at all counts as alive.
        said = false;
        quiet();

        for (const recorded of linesOf(event, line)) {
          // R113. The half of R110 that had the best argument and no code.
          //
          // A session that greps a config, cats a `.env`, or hits a stack trace
          // with a token in it puts that in a transcript the platform stores
          // and the console renders to everybody with READER. The permission
          // handler cannot see this: it is asked about INPUTS, and this is what
          // came back.
          //
          // Replaced rather than dropped. A tool result that vanished would be
          // a session whose next turn makes no sense, and the redaction says
          // what happened — which is also the only way anybody finds out.
          if (shield?.blockSecrets !== false && recorded.kind === 'TOOL_RESULT') {
            const found = findSecret(recorded.body);
            if (found) {
              recorded.body = `[cawdev removed ${found.name} from this result] ${found.redacted}`;
              // Not awaited: this handler is the stream's, and a synchronous
              // reader that stopped to talk to the platform would stall the
              // transcript behind the network.
              api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/blocks`, {
                method: 'POST',
                body: { kind: 'SECRET', detail: `${found.name}: ${found.redacted}` },
              }).catch(() => {
                // Bookkeeping. The credential is already out of the line above,
                // which is the part that mattered.
              });
            }
          }
          // R113. What it SAID it was doing against what it DID. Noticed, never
          // blocked: R112 does the blocking by not handing over the tool, and a
          // second thing that can stop a run is a second thing that can stop it
          // wrongly.
          if (recorded.kind === 'TOOL') {
            // R161, and cheap: one regex per TOOL line, on lines that are
            // already being walked. See ../lib/tool-line.mjs.
            const reached = capabilityIn(recorded.body);
            if (reached) {
              used.add(`${reached.kind}:${reached.key}`);
            }
          }
          if (stage && recorded.kind === 'TOOL') {
            const drifted = driftedFrom(stage.stage, recorded.body, stage.testMode,
              stageExperts.map((each) => qualified(each.key)),
              { writesItsOwnCard: writesItsOwnCard(run) });
            if (drifted) {
              transcript.push({ kind: 'ERROR', body: drifted });
            }
          }
          transcript.push(recorded);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (!text) return;
      log(`  agent stderr: ${text.slice(0, 400)}`);
      stderrTail = (stderrTail + '\n' + text).slice(-2000);
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
      // Under a memory ceiling (`sessionScope`) the child is `systemd-run`, so a
      // missing `claude` arrives as its exit code and never as an ENOENT here.
      await finish(config, run, 'FAILED', spawnFailureSaid({
        failure, command: agentCmd, cwd, slug: run.projectSlug, label: 'the agent',
        first: config.projects[run.projectSlug]?.workspaces?.[0],
      }));
      await rm(mcpDirectory, { recursive: true, force: true });
      clearTimeout(idleTimer);
      // A spawn that never happened has no exit code. The run is already
      // FAILED above, so the loop is told the stage did not succeed and stops
      // — it must not read `code: undefined` as "fine".
      resolvePromise(
        stage ? { code: -1, signal: null, text: failure.message, turnEnded: false } : undefined);
    });

    // `close`, not `exit`, for the reason git() gives: the last stream-json
    // events can still be in flight when the process ends, and on `exit` the
    // flush below would drop them — losing the end of the transcript, which is
    // the part somebody reads to find out how the session finished.
    child.on('close', async (code, signal) => {
      prompts.stop();
      workingCopy.stop();
      // Both of these outlive the child otherwise. The idle watchdog did, and
      // went on posting "this session has said nothing for 20 minutes" against
      // a run that had ended twenty minutes earlier — a note on a closed
      // transcript, naming a session nobody could look at.
      stopEndingSession(child);
      clearTimeout(idleTimer);
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
        // R73. The clock said no; the work did not. A stop the CLI attributed
        // to its usage window is USAGE_LIMITED, with the window and the reset
        // it stated — not FAILED, which is the word for a crash. Recognised by
        // the Claude Code adapter only: a second CLI supplies its own, or none.
        const limit = limitReported
          ? null
          : (code === 0 ? null : usageLimitOf(`${lastText}\n${stderrTail}`));
        if (limit) {
          log(`  the ${limit.window === 'WEEKLY' ? 'weekly' : 'five-hour'} usage window closed`
            + (limit.resetsAt ? `; resets ${limit.resetsAt.toISOString()}` : ''));
          await reportUsageLimit(config, run, limit, lastText);
        } else if (limitReported) {
          // Already reported from the turn that said it, and the run is not
          // live in the sense this branch means: it is parked. Saying nothing
          // is the point — the alternative is `finish(FAILED)` below undoing
          // the parking, which is R73's whole complaint in one line.
        } else if (!stage) {
          const summary = signal
            ? `The agent was terminated (${signal}).`
            : `The agent exited with code ${code} without reporting. ${lastText}`.trim();
          await finish(config, run, code === 0 ? 'FINISHED' : 'FAILED', summary, cwd);
        }
        // R112. A STAGE ending is not the RUN ending. The loop decides that —
        // it is the only thing that knows whether there is another stage — and
        // a stage that finished the run here would end it four fifths of the
        // way through the first time PLAN succeeded.
      }

      // The run has ended, which is the moment its project's rules queue a
      // push, a pull request or a merge — R40. The working-copy watcher that
      // would normally pick those up stopped with the child, so this is the
      // pass that performs them. It has to come BEFORE the last reading, or
      // the push state and PR link the console shows would be the ones from
      // before the rules ran.
      //
      // R112: not between stages. A push after PLAN would push nothing and a
      // pull request after it would be a pull request for an empty branch.
      if (!stage) {
        await settleActions(config, run, cwd);
      }

      // R217. The person who cancelled said what to do with the uncommitted
      // work, and this is the first moment it can be done: the agent is dead,
      // and a cancelled run spawns no further stage. Only on a run that took a
      // checkout — an ASK standing in somebody's working copy has nothing of
      // its own here. The reading that follows is what turns the page's count
      // back to zero.
      if (current?.state === 'CANCELLED' && current.stashOnCancel && child.cawdevWorkspace) {
        await stashAfterCancel(config, run, cwd);
        const state = await readWorkingCopy(cwd).catch(() => null);
        if (state && writesAnythingProfile(run)) {
          await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/working-copy`, {
            method: 'POST',
            body: state,
          }).catch((failure) => log(`  could not report the working copy: ${failure.message}`));
        }
      }

      // The last reading, after the agent has stopped changing things and after
      // anything the rules did. It usually lands *after* the run is already
      // FINISHED, because the agent ends its own run by reporting — which the
      // API allows for exactly this.
      await reportCommits(config, run, cwd, baseCommit);
      // R112. A stage hands its result back so the loop can store the plan,
      // gate on it, and carry it into the next stage. A run with no lifecycle
      // resolves with nothing, exactly as it always did.
      resolvePromise(stage
        ? { code, signal, text: lastText, turnEnded, usage: childTotals,
          unfinishedShells: shells.unfinished() }
        : undefined);
    });
  });
}

// --- Antigravity ('agy') ------------------------------------------------------

// Serializes agy's global registry mutations — MCP servers AND, since R279,
// installed plugins. Claude Code's --mcp-config and --plugin-dir are each a
// file or directory this daemon writes and hands to one process; agy has no
// per-invocation equivalent for either, only two machine-wide registries
// (`agy mcp add/remove` and `agy plugin install/uninstall`, both under
// ~/.gemini) shared by every agy call on this machine. Both are
// re-registered before each spawn — the MCP token is fresh per run, and a
// different project may have turned different experts on — and ONE lock
// serializes both, because they are the same kind of hazard: two concurrent
// agy spawns racing on the same machine-wide state, v1's answer to a problem
// Claude Code's own design does not have.
let agyRegistryLock = Promise.resolve();
function withAgyRegistryLock(work) {
  const next = agyRegistryLock.then(work, work);
  agyRegistryLock = next.then(() => {}, () => {});
  return next;
}

/** One `agy` subcommand, run to completion. Not a session — just its exit and output. */
function runAgyCli(agyCmd, args) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(agyCmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', () => resolve({ code: -1, out }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/**
 * What Antigravity currently has registered, read rather than asked for:
 * `agy mcp list` has no machine-readable form, and the registry is one
 * small JSON file at a fixed, undocumented path. Read-only, and tolerant of
 * that path changing under a future CLI version — an empty list here costs
 * a stale entry left behind, never a wrong removal.
 */
async function currentAntigravityMcpNames() {
  try {
    const raw = await readFile(join(homedir(), '.gemini', 'config', 'mcp_config.json'), 'utf8');
    return Object.keys(JSON.parse(raw)?.mcpServers ?? {});
  } catch {
    return [];
  }
}

/**
 * Registers cawdev's own MCP server, this checkout's own (its `.mcp.json`),
 * and R76's registry entries this run was handed — R278, the same three
 * Claude Code's `--mcp-config` carries. R105's skills are NOT here: those
 * are not servers, see `inlinedSkillsFor`. Experts are NOT here either, but
 * for the opposite reason R278 first claimed — that card said agy "has
 * nothing shaped like `--plugin-dir`, only its own, unrelated subagent
 * system", and that was wrong, unverified when it was written. Checked by
 * hand for R279: `agy plugin install <directory>` reads the very same
 * `agents/*.md` shape, and `invoke_subagent` really does reach one — see
 * `registerAntigravityExperts`, which does for experts what this does for
 * servers, under the same lock.
 *
 * Every name but `cawdev` itself is prefixed `cawdev-server-` — on two
 * sides of the same reason: this must never touch an MCP server Dali
 * registered with agy himself for something unrelated, and a stale entry
 * an EARLIER run left behind (a different project, a different registry)
 * has to be findable by that same prefix so it can be removed before the
 * new set goes in. Confirmed by hand that this is safe to do at all: a
 * registered server inherits the daemon's own environment (`PATH`, `HOME`,
 * ...) same as any spawned child, so `--env` only has to carry what a
 * server adds on top of that — not `...process.env` the way the
 * file-based `--mcp-config` write does.
 */
function registerAntigravityMcp(agyCmd, {
  url, token, projectSlug, cwd, serverPath, repoServers, attachedServers,
}) {
  return withAgyRegistryLock(async () => {
    const wanted = new Map();
    wanted.set('cawdev', {
      command: process.execPath,
      args: [serverPath],
      env: {
        CAWDEV_URL: url, CAWDEV_TOKEN: token, CAWDEV_PROJECT: projectSlug, CAWDEV_WORKSPACE: cwd,
      },
    });
    // This checkout's own `.mcp.json`.
    for (const [name, def] of Object.entries(repoServers ?? {})) {
      wanted.set(`cawdev-server-${name}`, {
        command: def.command, args: def.args ?? [], env: def.env ?? {},
      });
    }
    // R76's registry, via `resolveSkills` — `skill` here is what that
    // function calls its own parameter, from a rename that came after it
    // was written; the shape is `RunMcpServerView`, a server, not a SKILL.md.
    for (const { skill, local } of attachedServers ?? []) {
      wanted.set(`cawdev-server-${skill.key}`, {
        command: skill.command, args: skill.args, env: local.env ?? {},
      });
    }

    const stale = (await currentAntigravityMcpNames()).filter((name) => (
      name === 'cawdev' || name.startsWith('cawdev-server-')
    ) && !wanted.has(name));
    for (const name of stale) {
      await runAgyCli(agyCmd, ['mcp', 'remove', name]);
    }

    let ok = true;
    for (const [name, def] of wanted) {
      // Removed first — agy mcp add UPDATES an existing name in place, but
      // a run's token changes every time and "updates" is exactly the kind
      // of word worth not trusting without having watched it happen.
      await runAgyCli(agyCmd, ['mcp', 'remove', name]);
      // Flags before <name> or agy silently absorbs them into the spawned
      // command's own argv instead of its env — confirmed by hand: the same
      // --env flags placed after the name landed in mcp_config.json's
      // `args`, never in an `env` object. `agy mcp add --help`'s own note
      // ("Flags must come before <name>") says this; it just doesn't reject
      // the wrong order, it mis-files it.
      const envArgs = Object.entries(def.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
      const added = await runAgyCli(agyCmd,
        ['mcp', 'add', ...envArgs, name, def.command, ...def.args]);
      if (added.code !== 0) {
        ok = false;
      }
    }
    return ok;
  });
}

/**
 * What Antigravity currently has installed, read the same way
 * `currentAntigravityMcpNames` reads its registrations: `agy plugin list`
 * has no machine-readable form either, and `import_manifest.json` is the
 * file it renders from (confirmed by hand: installing and listing a probe
 * plugin round-tripped through exactly this file). Tolerant of the same
 * failure for the same reason — an empty list here costs a stale plugin
 * left behind, never a wrong uninstall.
 */
async function currentAntigravityPluginNames() {
  try {
    const raw = await readFile(join(homedir(), '.gemini', 'config', 'import_manifest.json'), 'utf8');
    const imports = JSON.parse(raw)?.imports;
    return Array.isArray(imports) ? imports.map((each) => each.name).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Installs this run's experts as an Antigravity plugin — R279, doing for
 * `agents/*.md` what `registerAntigravityMcp` does for servers, and under
 * the SAME lock: `agy plugin install` is machine-wide state exactly like
 * `agy mcp add` is, one project's experts at a time on this machine.
 *
 * <p>Always removes whatever `ANTIGRAVITY_EXPERTS_PLUGIN` currently holds
 * first — never trusting `agy plugin install` to update a name in place,
 * the same caution `registerAntigravityMcp` already takes with `agy mcp
 * add`, unverified here and not worth finding out the hard way — then
 * installs fresh only when this run was handed experts at all. Takes
 * `stageExperts`, never raw `expertAgents`: R147's read-only-stage
 * narrowing has to hold for Antigravity exactly as it does for Claude Code,
 * and the caller is where that narrowing already happened.
 *
 * <p>Failing to install is NOT failed the way a failed MCP registration is
 * — an expert is optional delegation, not plumbing a report/ask_user call
 * depends on, so the caller logs it and carries on without one rather than
 * failing the run.
 */
function registerAntigravityExperts(agyCmd, { expertAgents }) {
  return withAgyRegistryLock(async () => {
    const stale = (await currentAntigravityPluginNames())
      .filter((name) => name === ANTIGRAVITY_EXPERTS_PLUGIN);
    for (const name of stale) {
      await runAgyCli(agyCmd, ['plugin', 'uninstall', name]);
    }
    if (!expertAgents.length) {
      return true;
    }
    const pluginDir = await mkdtemp(join(tmpdir(), 'cawdev-agy-experts-'));
    try {
      const root = await writeAntigravityExpertsPlugin(pluginDir, expertAgents);
      const installed = await runAgyCli(agyCmd, ['plugin', 'install', root]);
      return installed.code === 0;
    } finally {
      await rm(pluginDir, { recursive: true, force: true });
    }
  });
}

/**
 * The prompt's half of R279 — telling the session which experts it has and
 * how to reach one, the way `harnessPrompt`'s own experts section does for
 * Claude Code. NOT folded into `harnessPrompt` itself: that function's
 * wording ("delegate with the `Agent` tool, `subagent_type` exactly as
 * written") names a Claude Code tool, and agy's is `invoke_subagent` — the
 * same split `inlinedSkillsFor` already makes for skills, for the same
 * reason.
 *
 * <p>`experts` here must already be `stageExperts` — narrowed for a
 * read-only stage — and, when nothing was installed for this run
 * (`registerAntigravityExperts` failed, or there was nothing to install),
 * an empty list: advertising an expert the plugin step could not actually
 * install would tell the session it can reach something it cannot.
 */
function expertsBlockFor(experts, cannotDelegate) {
  const list = Array.isArray(experts) ? experts : [];
  if (!list.length) {
    return cannotDelegate?.length ? `\n\n## Experts\n\n${cannotDelegate.join(' ')}` : '';
  }
  const must = list.filter((each) => each.mode === 'REQUIRED');
  const may = list.filter((each) => each.mode !== 'REQUIRED');
  const entry = (each) => `- **${each.key}** — ${each.description ?? each.name ?? each.key}`;
  const section = (heading, rows) => rows.length
    ? `## ${heading}\n\n${rows.map(entry).join('\n')}`
    : '';
  return '\n\n' + [
    section('Experts you MUST use — delegate with `invoke_subagent`, naming it exactly as '
      + 'written below, before this stage is finished', must),
    section("Experts — delegate with `invoke_subagent` whenever one's description fits the "
      + 'step you are on', may),
  ].filter(Boolean).join('\n\n');
}

/**
 * R105's skills, whole, for a CLI with no `Skill` tool to fetch one lazily.
 *
 * <p>Claude Code sees a name and a description in its harness prompt and
 * loads the `body` — the actual SKILL.md instructions — only if the model
 * invokes it, through a plugin directory this agent has no equivalent way
 * to be handed. There is nothing to invoke here, so the body is INLINED
 * up front instead: every skill this run was handed, whether or not the
 * model ends up needing it. Larger prompt, no lazy loading — the honest
 * trade for a CLI with no mechanism to defer it.
 */
function inlinedSkillsFor(skills) {
  const list = Array.isArray(skills) ? skills : [];
  if (!list.length) {
    return '';
  }
  const must = list.filter((each) => each.mode === 'REQUIRED');
  const may = list.filter((each) => each.mode !== 'REQUIRED');
  const entry = (each) => `### ${each.name ?? each.key}\n\n${each.description ?? ''}\n\n${each.body ?? ''}`
    .trim();
  const section = (heading, rows) => rows.length
    ? `## ${heading}\n\n${rows.map(entry).join('\n\n')}`
    : '';
  return '\n\n' + [
    section('Skills you MUST use — this project requires each of these; use one before this '
      + 'stage is finished', must),
    section('Skills — use one when its description fits the work', may),
  ].filter(Boolean).join('\n\n');
}

/**
 * Antigravity's shape — one-shot per turn, not a long-lived process.
 *
 * Checked against the real CLI by hand rather than guessed at: no
 * `--mcp-config` (`flags provided but not defined`), no `--allowedTools` (no
 * per-tool allow-list exists at all), no `--resume <id>` (`--conversation
 * <id>` instead). `--mode plan` denies MCP tool calls outright — including
 * calls to cawdev's own `report`/`ask_user` — so even a read-only run needs
 * `--dangerously-skip-permissions` just to talk to the platform. There is no
 * narrower option on this CLI today.
 *
 * So: this refuses to run at all unless the machine has granted "everything"
 * — R126, the same switch Claude Code's `bypassPermissions` already stands
 * behind — and every call that does run gets `--dangerously-skip-permissions`
 * unconditionally, coding or not. No per-project tool-rule narrowing, and no
 * live mid-run prompting (R22's "keep stdin open" assumes a process that
 * stays up between turns; agy's `-p` exits after one). A STAGE is already
 * one process per R112, so stages fit this shape without changing it — a
 * follow-up typed into a RUNNING session does not reach it yet, and that gap
 * is not silently papered over: `sendPrompt` still only writes to a live
 * child's stdin, which this never opens.
 *
 * R278: this checkout's own MCP servers and R76's registry ARE reached now,
 * the way `registerAntigravityMcp` describes, and R105's skills are
 * inlined whole (`inlinedSkillsFor`) rather than reached at all — there is
 * nothing on this CLI shaped like Claude Code's `Skill` tool to fetch one
 * lazily.
 *
 * R279: expert agents ARE reached too, now — R278's claim that agy "has
 * nothing shaped like `--plugin-dir`" was wrong, and unverified when it was
 * written. `agy plugin install <directory>` reads the same `agents/*.md`
 * shape Claude Code's plugin does; `registerAntigravityExperts` installs
 * this run's `stageExperts` under it, and `invoke_subagent` is the real
 * tool a session delegates through — confirmed end-to-end by hand, a probe
 * agent installed, invoked by name, and its answer returned correctly.
 */
/** This machine, as a refusal names it: what it is called, where its config and console are. */
function thisMachine(config) {
  return {
    name: config.name,
    acceptsConsoleRules: config.acceptsRulesFromConsole === true,
    configPath: config.configPath ?? null,
    consoleUrl: config.url,
  };
}

/**
 * A refusal said on the run's own transcript, where the terminal and the run
 * page show it — the run's summary alone left a window reading "failed" and
 * nothing else, with the reason one page away.
 */
async function sayOnTheRun(config, run, text) {
  await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/output`, {
    method: 'POST',
    body: { lines: text.split('\n').filter((body) => body.trim()).map((body) => ({ kind: 'ERROR', body })) },
  }).catch((failure) => log(`  could not say it on the run: ${failure.message}`));
}

async function spawnAntigravity(config, run, runToken, cwd, baseCommit, resume, projectServers,
    skills, stageExperts, cannotDelegate, instincts, briefing, plan, lifecycle, stage, carried,
    agyCmd, granted, usage = null) {
  if (!granted.everything) {
    // Antigravity needs it even to read: no per-tool allow-list exists on it.
    const summary = needsEverything('agy', thisMachine(config), run, { readsWithout: false });
    log(`  refusing to spawn Antigravity: ${summary.split('\n')[0]}`);
    await sayOnTheRun(config, run, summary);
    await finish(config, run, 'FAILED', summary);
    return stage ? { code: -1, signal: null, text: summary, turnEnded: false } : undefined;
  }

  // Created here rather than down with the spawn — the notes below (what
  // attached, what a project asked for that this machine refused, what an
  // index build said) belong on the run the moment they are known, same as
  // Claude Code's path: a person watching should not have to wait for the
  // one-shot call to finish before finding out something never loaded.
  const transcript = new Transcript(config, run);

  // Two DIFFERENT things cawdev calls capabilities, reached two different
  // ways even for Claude Code — R278 gives Antigravity both, each the way
  // its own shape allows:
  //
  // `projectServers` (R76's registry, `claimed.mcpServers` — the parameter
  // is misleadingly named after an old rename, not this checkout's own
  // `.mcp.json`) and `repoServers` (that actual file, read fresh) are both
  // real MCP SERVERS — a command line cawdev already knows how to run.
  // `resolveSkills` (despite its name — R76 called these "skills" before
  // R105 split the word) turns the registry half into the same shape.
  // Both go through `registerAntigravityMcp`, the same way cawdev's own
  // server does.
  //
  // `skills` (R105, `claimed.skills`) is NOT a server at all — it is a
  // SKILL.md's `body`, markdown Claude Code loads lazily through its own
  // `Skill` tool when the model invokes it by name, bundled into a plugin
  // directory this agent has no equivalent way to be handed
  // (`--plugin-dir`, same gap experts have). There is nothing to invoke
  // here to fetch it later, so it is not offered as something reachable —
  // it is INLINED below, in full, up front.
  const serverPath = config.mcpServerPath ?? new URL('../mcp/server.mjs', import.meta.url).pathname;
  const repoServers = await projectMcpServers(cwd);
  const { attached: attachedServers, notes: serverNotes } =
    await resolveSkills(config, run, cwd, baseCommit, projectServers);
  if (attachedServers.length) {
    log(`  loading ${attachedServers.length} MCP server(s)`);
  }
  for (const line of serverNotes) {
    log(`  ${line}`);
    transcript.push({ kind: 'SYSTEM', body: line });
  }
  const registered = await registerAntigravityMcp(agyCmd, {
    url: config.url, token: runToken, projectSlug: run.projectSlug, cwd, serverPath,
    repoServers, attachedServers,
  });
  if (!registered) {
    const summary = 'Could not register this session\'s MCP servers with Antigravity (`agy mcp '
      + 'add` failed) — without cawdev\'s own this session cannot report, ask a question, or '
      + 'read the roadmap.';
    log(`  ${summary}`);
    await finish(config, run, 'FAILED', summary);
    return stage ? { code: -1, signal: null, text: summary, turnEnded: false } : undefined;
  }

  // R279. Unlike the MCP registration above, a failed expert install does
  // NOT fail the run — an expert is optional delegation, not the plumbing a
  // report/ask_user call depends on. `usableExperts` drops to empty so the
  // prompt below never advertises an expert that was not actually
  // installed; `stageExperts` itself already carries R147's read-only-stage
  // narrowing from the caller.
  if (stageExperts.length) {
    log(`  loading ${stageExperts.length} expert(s)`);
  }
  const expertsRegistered = await registerAntigravityExperts(agyCmd, { expertAgents: stageExperts });
  if (!expertsRegistered && stageExperts.length) {
    const note = 'Could not install this project\'s experts into Antigravity (`agy plugin '
      + 'install` failed) — continuing without delegation.';
    log(`  ${note}`);
    transcript.push({ kind: 'SYSTEM', body: note });
  }
  const usableExperts = expertsRegistered ? stageExperts : [];

  // Same assembly as Claude Code's — promptFor, harnessPrompt, stagePrompt
  // are all agent-agnostic. Both experts and skills are kept OUT of
  // harnessPrompt's own `experts`/`skills` params and handled entirely
  // below instead — its wording ("the `Agent` tool", "the `Skill` tool")
  // names tools this CLI does not have. `expertsBlockFor` and
  // `inlinedSkillsFor` are agy's own wording for the same two ideas.
  const harness = harnessPrompt({
    instincts, briefing, experts: [], skills: [], plan, lifecycle,
    repoConfig: await readRepoConfig(cwd),
  });
  const skillsBlock = inlinedSkillsFor(skills);
  const expertsBlock = expertsBlockFor(usableExperts, cannotDelegate);
  const resuming = Boolean(resume?.agentSessionId);
  const promptText = resuming
    ? resume.prompt
    : (promptFor(run) + harness + skillsBlock + expertsBlock
      + (stage ? stagePrompt(stage, carried, Boolean(plan?.body)) : ''));

  const args = ['-p', promptText, '--output-format', 'stream-json', '--dangerously-skip-permissions'];
  if (run.model) {
    args.push('--model', run.model);
  }
  if (resuming) {
    args.push('--conversation', resume.agentSessionId);
  }

  log(`  spawning: ${agyCmd} -p <prompt omitted, ${promptText.length} chars> --output-format `
    + `stream-json --dangerously-skip-permissions${resuming ? ` --conversation ${resume.agentSessionId}` : ''}`);

  // The same live view Claude Code gets — none of this existed before, and a
  // run that writes nothing here is a run the console and the CLI's attach
  // both draw as a black box until the one-shot call finally returns.
  // Confirmed by hand against the real CLI: `--output-format stream-json`
  // gives `init` (once, carries the conversation id), `step_update` (an
  // `agent_response` step's `text_delta` is an INCREMENTAL chunk to append,
  // not the text so far; a `tool` step is ACTIVE with the call and DONE with
  // `tool_info.output`), and one final `result` — the same shape
  // `--output-format json` returns whole, just arriving a piece at a time.

  return new Promise((resolvePromise) => {
    let result = null;
    // R76 / R305: what the run had already used before this process, and what
    // this process itself reported — see the same pair on the Claude Code path.
    const usageBase = usage?.run ?? {
      tokensIn: Number(run.tokensIn) || 0,
      tokensOut: Number(run.tokensOut) || 0,
    };
    let childTotals = null;
    let err = '';
    let buffer = '';
    const child = spawnScoped(config, agyCmd, args, {
      cwd,
      // Its own process group — see the same choice on the Claude Code path.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.cawdevProjectSlug = run.projectSlug;
    child.cawdevAgent = 'agy';
    child.cawdevModel = run.model ?? null;
    // The existing cancellation sweep (`reapCancelled`) reads this map by
    // run id and SIGTERMs whatever is in it — true for any child, so a
    // cancelled Antigravity run stops exactly the way a cancelled Claude
    // Code one does, with no code of its own.
    running.set(run.id, child);

    // What the console can see of the checkout, and the commits as they land —
    // the same watcher as the Claude Code path. Without it the platform never
    // hears of this run's commits, so the finish rules (R40) see a run that
    // wrote nothing and queue no push and no pull request.
    const workingCopy = watchWorkingCopy(config, run, cwd, baseCommit);

    // stream-json arrives in chunks that split mid-line, same as Claude
    // Code's — buffer until a full line rather than assuming one chunk is
    // one event.
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          // A stray non-protocol line on stdout — shown rather than dropped,
          // the same call `linesOf` makes for Claude Code's unparseable ones.
          transcript.push({ kind: 'SYSTEM', body: line.slice(0, 4000) });
          continue;
        }
        if (event.event === 'init') {
          if (event.conversation_id) {
            reportSessionId(config, run, event.conversation_id);
          }
          transcript.push({
            kind: 'SYSTEM',
            body: `session ${short(event.conversation_id)} started`
              + (run.model ? ` on ${run.model}` : ''),
          });
        } else if (event.event === 'step_update') {
          const step = event.step_update ?? {};
          if (step.step_type === 'agent_response' && step.text_delta) {
            transcript.push({ kind: 'ASSISTANT', body: step.text_delta });
          } else if (step.step_type === 'tool' && step.state === 'ACTIVE') {
            transcript.push({
              kind: 'TOOL',
              body: `${step.tool_name}(${JSON.stringify(step.tool_info?.parameters ?? {})})`,
            });
          } else if (step.step_type === 'tool' && step.state === 'DONE') {
            transcript.push({
              kind: 'TOOL_RESULT',
              body: String(step.tool_info?.output ?? '(no output)').slice(0, 4000),
            });
          } else if (step.step_type === 'subagent' && step.state === 'ACTIVE') {
            // R279. Delegation is its OWN step_type, `subagent` — confirmed
            // by hand it is not `tool`, which is why this needed its own
            // branch rather than falling into the one above by accident.
            // No `tool_info` here, only `subagent_info.subagents[]`; the
            // sub-conversation's own transcript is a local file this
            // process never reads, so the parent's own narration (an
            // ordinary `agent_response`) is what carries the answer back to
            // this transcript, same as it already did in the run that
            // proved this end to end.
            const who = (step.subagent_info?.subagents ?? [])
              .map((each) => each.type_name).filter(Boolean).join(', ') || 'a subagent';
            const prompt = step.subagent_info?.subagents?.[0]?.initial_prompt ?? '';
            transcript.push({ kind: 'TOOL', body: `invoke_subagent(${who}): ${prompt}` });
          } else if (step.step_type === 'subagent' && step.state === 'DONE') {
            const who = (step.subagent_info?.subagents ?? [])
              .map((each) => each.type_name).filter(Boolean).join(', ') || 'a subagent';
            transcript.push({ kind: 'TOOL_RESULT', body: `${who} finished` });
          }
          // user_input steps carry no text of their own — the prompt is
          // already shown as "What it was asked", from run.openingPrompt.
        } else if (event.event === 'result') {
          result = event.result;
          if (result?.usage) {
            // R305. On the same base as the Claude Code path: what the run had
            // already used before this process. Reported with no base until
            // now, so a resume or a second stage here counted from zero.
            childTotals = {
              input: Number(result.usage.input_tokens) || 0,
              output: Number(result.usage.output_tokens) || 0,
            };
            reportUsage(config, run, {
              tokensIn: usageBase.tokensIn + childTotals.input,
              tokensOut: usageBase.tokensOut + childTotals.output,
            });
            if (stage && usage?.stage) {
              reportStageUsage(config, run, stage.stage, {
                tokensIn: usage.stage.tokensIn + childTotals.input,
                tokensOut: usage.stage.tokensOut + childTotals.output,
              });
            }
          }
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        log(`  agent stderr: ${text.slice(0, 400)}`);
      }
      err += chunk;
    });

    child.on('error', async (failure) => {
      workingCopy.stop();
      running.delete(run.id);
      const summary = spawnFailureSaid({
        failure, command: agyCmd, cwd, slug: run.projectSlug, label: 'Antigravity',
        first: config.projects[run.projectSlug]?.workspaces?.[0],
      });
      await transcript.flush();
      await finish(config, run, 'FAILED', summary);
      resolvePromise(
        stage ? { code: -1, signal: null, text: summary, turnEnded: false } : undefined);
    });

    child.on('close', async (code) => {
      workingCopy.stop();
      running.delete(run.id);
      await transcript.flush();
      const text = result?.response
        || (result?.denied_actions?.length
          ? `Antigravity denied an action it needed and stopped: `
            + result.denied_actions.map((each) => each.display_name ?? each.action).join(', ')
          : null)
        || err.trim() || 'Antigravity produced no output.';
      // Whether the CLI ever gave back a parseable turn — this agent has no
      // separate "the turn ended" signal the way Claude Code's stream does;
      // getting the `result` event at all IS the turn ending, one way or
      // the other.
      const turnEnded = Boolean(result);

      // The agent normally ends the run itself with report(done|blocked),
      // through the same cawdev MCP server Claude Code calls — this only
      // catches a call that produced nothing report could act on.
      const current = await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}`)
        .catch(() => null);
      if (current?.live && !stage) {
        await finish(config, run, code === 0 && result?.status === 'SUCCESS' ? 'FINISHED' : 'FAILED',
          text, cwd);
      }
      // R112: not between stages — see the same line on the Claude Code path.
      if (!stage) {
        await settleActions(config, run, cwd);
      }
      // The last reading, as on the Claude Code path: after the agent has
      // stopped and after anything the rules did.
      await reportCommits(config, run, cwd, baseCommit);

      resolvePromise(stage
        ? { code, signal: null, text, turnEnded, usage: childTotals }
        : undefined);
    });
  });
}

/**
 * The cawdev tools a Codex process may call — the SAME list Claude Code's
 * `--allowedTools` would hold for this run and stage, without the prefix.
 *
 * <p>`enabled_tools` on cawdev's server is the one narrowing this CLI does as
 * precisely as Claude Code: a tool left out is not offered at all (checked by
 * hand). So the list is derived from `PROFILE_TOOLS` and `toolsForStage`
 * rather than chosen here — a second place deciding what a profile may do is
 * how the two agents would drift. Above all, `toolsForStage` takes `report`
 * away from every STAGE, whose "done" would end the run in the middle of the
 * walk.
 *
 * <p>Null — every tool the server has — only for a coding run with no
 * lifecycle, which can only be spawned where the machine allowed everything.
 */
function codexCawdevTools(run, stage, mayWrite) {
  const profile = PROFILE_TOOLS[run.profile];
  const profileList = profile ? (typeof profile === 'function' ? profile(run) : profile) : null;
  if (stage) {
    return cawdevToolNames(toolsForStage(stage.stage, profileList ?? CAWDEV_TOOLS, stage.testMode,
      { writesItsOwnCard: writesItsOwnCard(run) }));
  }
  if (profileList) {
    return cawdevToolNames(profileList);
  }
  return mayWrite ? null : cawdevToolNames(READ_ONLY_CAWDEV);
}

/**
 * OpenAI's Codex CLI — one `codex exec` per turn, like Antigravity, and the
 * command line, the stream and every flag's behaviour are `../lib/codex.mjs`,
 * checked against the real CLI.
 *
 * <p>What it has that Antigravity lacks is a SANDBOX the operating system
 * enforces, and that decides the permission question:
 *
 * <ul>
 * <li>A session that must change nothing — every profile but the coding
 *   ones, and PLAN, VERIFY and MEMORY of any run — is spawned with
 *   `--sandbox read-only`. Its shell can read and cannot write, and it does
 *   not need the machine to have allowed anything: "cannot" is the kernel's
 *   word here, not the prompt's. Only cawdev's server is attached, narrowed
 *   to the profile's list by `codexCawdevTools`.
 * <li>A session that writes — CODE, INTERVIEW, MERGE, RELEASE, and their
 *   IMPLEMENT and TEST — has to commit and push, which the workspace sandbox
 *   refuses (`.git` and the network are outside it). There is no allow-list
 *   for the shell on this CLI, so it runs with the sandbox bypassed, and
 *   ONLY where the machine allowed everything (R126) — Antigravity's rule.
 * </ul>
 *
 * <p>Not reached: experts (nothing on this CLI loads cawdev's `agents/*.md`,
 * so the session is told it cannot delegate rather than shown names it cannot
 * call), R51's permission prompt and R110's command shield (both live in
 * `approve`, which Codex never calls) and R22's live prompting (the process
 * ends with its turn; a follow-up is a resume). Skills are inlined whole, as
 * for Antigravity. The transcript half of R110 — secrets taken out of a tool
 * result — does apply, since it runs here and not in the CLI.
 */
async function spawnCodex(config, run, runToken, cwd, baseCommit, resume, projectServers,
    skills, stageExperts, readOnlyStage, instincts, briefing, plan, lifecycle, stage, carried,
    codexCmd, granted, shield, usage = null) {
  const failedBeforeSpawn = async (summary) => {
    log(`  ${summary.split('\n')[0]}`);
    await sayOnTheRun(config, run, summary);
    await finish(config, run, 'FAILED', summary);
    return stage ? { code: -1, signal: null, text: summary, turnEnded: false } : undefined;
  };

  const mayWrite = writesCodeProfile(run) && !readOnlyStage;
  if (mayWrite && !granted.everything) {
    // It must commit and push, which its sandbox refuses, and there is no
    // allow-list for its shell — so everything, or nothing. Read-only runs
    // and stages need nothing.
    return failedBeforeSpawn(needsEverything('codex', thisMachine(config), run));
  }
  if (mayWrite) {
    log('  !! this machine allows EVERYTHING: this Codex session runs without a sandbox');
  }

  const transcript = new Transcript(config, run);
  const serverPath = config.mcpServerPath ?? new URL('../mcp/server.mjs', import.meta.url).pathname;

  // The token reaches cawdev's server through `env_vars` — from Codex's own
  // environment, never its command line — and is blanked for the shell.
  const cawdevEnv = { CAWDEV_URL: config.url, CAWDEV_TOKEN: runToken, CAWDEV_PROJECT: run.projectSlug };
  const childEnv = { ...process.env, ...cawdevEnv };

  // By name, so a later server replaces an earlier one whole — the ordering
  // argument of the Claude Code path: the repository's own first, then R76's
  // registry, then cawdev's LAST, so nothing can shadow it and take its token.
  const servers = new Map();
  if (mayWrite) {
    for (const [name, server] of Object.entries(await projectMcpServers(cwd))) {
      if (!server?.command) {
        transcript.push({ kind: 'SYSTEM',
          body: `The project's MCP server "${name}" is not a command, and Codex is handed commands only — skipped.` });
        continue;
      }
      servers.set(name, { name, command: server.command, args: server.args, env: server.env });
    }
    const { attached, notes } = await resolveSkills(config, run, cwd, baseCommit, projectServers);
    for (const line of notes) {
      log(`  ${line}`);
      transcript.push({ kind: 'SYSTEM', body: line });
    }
    for (const { skill, local } of attached) {
      Object.assign(childEnv, local.env ?? {});
      servers.set(skill.serverName, {
        name: skill.serverName, command: skill.command, args: skill.args,
        envVars: Object.keys(local.env ?? {}),
      });
    }
  }
  servers.set('cawdev', {
    name: 'cawdev',
    command: process.execPath,
    args: [serverPath],
    envVars: Object.keys(cawdevEnv),
    enabledTools: codexCawdevTools(run, stage, mayWrite),
    // Codex cuts an MCP call off after 60 s unless told otherwise, and
    // `ask_user` waits up to ten minutes for a person: a question asked from
    // Codex died before anybody could answer it, so it did not ask — it
    // stopped. Longer than ask_user's own wait (mcp/server.mjs), so the
    // question is answered or handed back as pending, never cut off.
    toolTimeoutSec: CAWDEV_TOOL_TIMEOUT_SEC,
  });

  const cannotDelegate = stageExperts.length
    ? ["This project has experts, and Codex has no way to be handed them: nothing on this CLI "
      + "loads cawdev's expert agents. Do the work yourself; they are reached from Claude Code "
      + 'and Antigravity runs.']
    : undefined;
  if (cannotDelegate) {
    transcript.push({ kind: 'SYSTEM', body: cannotDelegate[0] });
  }

  const resuming = Boolean(resume?.agentSessionId);
  const promptText = resuming
    ? (resume.prompt ?? '')
    : (promptFor(run)
      + harnessPrompt({
        instincts, briefing, experts: [], skills: [], plan, lifecycle,
        repoConfig: await readRepoConfig(cwd),
      })
      + inlinedSkillsFor(skills)
      + expertsBlockFor([], cannotDelegate)
      + (stage ? stagePrompt(stage, carried, Boolean(plan?.body)) : ''));

  const model = stage?.model ?? run.model;
  const args = codexArgs({
    model,
    effort: run.effort,
    sandbox: mayWrite ? 'bypass' : 'read-only',
    resumeId: resuming ? resume.agentSessionId : null,
    servers: [...servers.values()],
    hideFromShell: Object.keys(cawdevEnv),
  });
  log(`  spawning: ${codexCmd} ${args.join(' ')} <prompt on stdin, ${promptText.length} chars>`);

  return new Promise((resolvePromise) => {
    // R76 / R305: what the run had already used before this process — see the
    // same pair on the Claude Code path.
    const usageBase = usage?.run ?? {
      tokensIn: Number(run.tokensIn) || 0,
      tokensOut: Number(run.tokensOut) || 0,
    };
    let childTotals = null;
    let ended = false;
    let failed = null;
    let lastError = null;
    let lastSaid = null;
    let err = '';
    let buffer = '';
    const child = spawnScoped(config, codexCmd, args, {
      cwd,
      // Its own process group — see the same choice on the Claude Code path.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    child.cawdevProjectSlug = run.projectSlug;
    child.cawdevAgent = 'codex';
    child.cawdevModel = model ?? null;
    // `reapCancelled` SIGTERMs whatever is here, whichever CLI it is.
    running.set(run.id, child);

    // What the console can see of the checkout, and the commits as they land —
    // the same watcher as the Claude Code path. Without it the platform never
    // hears of this run's commits, so the finish rules (R40) see a run that
    // wrote nothing and queue no push and no pull request.
    const workingCopy = watchWorkingCopy(config, run, cwd, baseCommit);

    child.stdin.on('error', () => {
      // A CLI that died before reading its prompt says why on stderr.
    });
    child.stdin.end(promptText);

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          transcript.push({ kind: 'SYSTEM', body: line.slice(0, 4000) });
          continue;
        }
        const read = translateCodexEvent(event);
        if (read.sessionId) {
          reportSessionId(config, run, read.sessionId);
          transcript.push({
            kind: 'SYSTEM',
            body: `session ${short(read.sessionId)} started${model ? ` on ${model}` : ''}`
              + (mayWrite ? '' : ' (read-only sandbox)'),
          });
        }
        for (const recorded of read.lines) {
          // R110's transcript half, as on the Claude Code path: a credential
          // that came back from a command is replaced before it is stored.
          if (shield?.blockSecrets !== false && recorded.kind === 'TOOL_RESULT') {
            const found = findSecret(recorded.body);
            if (found) {
              recorded.body = `[cawdev removed ${found.name} from this result] ${found.redacted}`;
              api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/blocks`, {
                method: 'POST',
                body: { kind: 'SECRET', detail: `${found.name}: ${found.redacted}` },
              }).catch(() => {});
            }
          }
          if (recorded.kind === 'ASSISTANT') {
            lastSaid = recorded.body;
          }
          transcript.push(recorded);
        }
        if (read.error) {
          lastError = read.error;
        }
        if (read.failed) {
          failed = read.failed;
        }
        if (read.ended) {
          ended = true;
          childTotals = read.usage;
          reportUsage(config, run, {
            tokensIn: usageBase.tokensIn + childTotals.input,
            tokensOut: usageBase.tokensOut + childTotals.output,
          });
          if (stage && usage?.stage) {
            reportStageUsage(config, run, stage.stage, {
              tokensIn: usage.stage.tokensIn + childTotals.input,
              tokensOut: usage.stage.tokensOut + childTotals.output,
            });
          }
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        log(`  agent stderr: ${text.slice(0, 400)}`);
      }
      err += chunk;
    });

    child.on('error', async (failure) => {
      workingCopy.stop();
      running.delete(run.id);
      const summary = spawnFailureSaid({
        failure, command: codexCmd, cwd, slug: run.projectSlug, label: 'Codex',
        first: config.projects[run.projectSlug]?.workspaces?.[0],
      });
      await transcript.flush();
      await finish(config, run, 'FAILED', summary);
      resolvePromise(stage ? { code: -1, signal: null, text: summary, turnEnded: false } : undefined);
    });

    child.on('close', async (code) => {
      workingCopy.stop();
      running.delete(run.id);
      await transcript.flush();
      const text = failed ?? lastSaid ?? lastError ?? (err.trim() || 'Codex produced no output.');
      // The agent normally ends the run itself with report(done|blocked); this
      // only catches a turn that produced nothing report could act on.
      const current = await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}`)
        .catch(() => null);
      if (current?.live && !stage) {
        await finish(config, run, code === 0 && ended && !failed ? 'FINISHED' : 'FAILED', text, cwd);
      }
      // R112: not between stages — see the same line on the Claude Code path.
      if (!stage) {
        await settleActions(config, run, cwd);
      }
      // The last reading, as on the Claude Code path: after the agent has
      // stopped and after anything the rules did.
      await reportCommits(config, run, cwd, baseCommit);

      resolvePromise(stage
        ? { code, signal: null, text, turnEnded: ended && !failed, usage: childTotals }
        : undefined);
    });
  });
}

/**
 * Tells the platform what the CLI calls this session — R69.
 *
 * Fire and forget, and deliberately: losing it costs a resume that has to be
 * asked again as a new question, and failing the run over it would cost the
 * whole session. The same trade every other reading the daemon reports makes.
 */
function reportSessionId(config, run, sessionId) {
  api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/session`, {
    method: 'POST',
    body: { agentSessionId: sessionId },
  }).catch((failure) => log(`  could not record the session id: ${failure.message}`));
}

/**
 * What the session has consumed, sent as an absolute total for the run — R76.
 *
 * Fire and forget, like the session id, and for a stronger reason: this is
 * bookkeeping for a comparison somebody may make later, and a run must never
 * fail because a number could not be filed. It arrives once per turn, and the
 * platform keeps the largest reading.
 */
function reportUsage(config, run, totals) {
  api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/usage`, {
    method: 'POST',
    body: totals,
  }).catch((failure) => log(`  could not record what the session used: ${failure.message}`));
}

/**
 * The same reading, for one STAGE — R305. Absolute for the stage across its
 * attempts, fire and forget for the reason `reportUsage` is, and the platform
 * keeps the largest reading here too.
 */
function reportStageUsage(config, run, stageName, totals) {
  api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/stages/${stageName}/usage`, {
    method: 'POST',
    body: totals,
  }).catch((failure) =>
    log(`  could not record what the ${stageName} stage used: ${failure.message}`));
}

/**
 * Ends a run on the platform.
 *
 * R345: a coding run reaches FINISHED only committed and pushed. Given the
 * checkout, a FINISHED for a profile that commits its work settles the branch
 * first — commits what the session left (unless it looks like a credential),
 * pushes without force — and becomes FAILED, with the reason in the summary
 * and the checkout held for Carry on (R80), when that cannot be done. Before
 * this, R325's run finished with a file modified and nothing pushed, and the
 * next run in that checkout refused to start on top of it.
 */
async function finish(config, run, state, summary, cwd = null) {
  if (state === 'FINISHED' && cwd && run.branch && COMMITS_ITS_WORK.has(run.profile)) {
    const settled = await settleBranch(cwd, run.branch, {
      push: pushBranch,
      label: run.entryRef ?? 'cawdev',
    }).catch((failure) => ({ ok: false, reason: `Checking the branch failed: ${failure.message}` }));
    if (!settled.ok) {
      log(`  not finished: ${settled.reason}`);
      state = 'FAILED';
      summary = `${settled.reason}\n\n${summary ?? ''}`.trim();
    } else if (settled.note) {
      log(`  ${settled.note}`);
      summary = `${summary ?? ''}\n\n${settled.note}`.trim();
    }
  }
  await api(config, `/api/projects/${run.projectSlug}/runs/${run.id}/transition`, {
    method: 'POST',
    body: { state, summary },
  }).catch((failure) => log(`  could not finish the run: ${failure.message}`));
}

// --- cancellation ------------------------------------------------------------

/**
 * What the daemon before this one was driving when it died — R339.
 *
 * Read off the note it kept (restart.mjs), and only when its writer is dead:
 * a live writer is a second daemon on this runner id. Each run the platform
 * still believes in is failed at once as DAEMON_RESTARTED, in words that name
 * the cause — where the stale sweep would have said, five minutes later, that
 * the runner "stopped driving it". A session the old daemon left running
 * unattended is stopped first: two sessions writing one checkout is worse
 * than either.
 */
async function reportWhatARestartKilled(config) {
  const path = drivingPath(config.runnerId);
  const previous = await readDriving(path);
  const behind = leftBehind(previous, process.pid, isAlive);
  for (const left of behind) {
    const run = await api(config, `/api/projects/${left.projectSlug}/runs/${left.id}`)
      .catch((failure) => {
        log(`could not read ${left.id} after the restart: ${failure.message}`);
        return null;
      });
    if (!killedByRestart(run, config.runnerId)) {
      continue;
    }
    const orphanStopped = await stopOrphan(left);
    log(`run ${left.id} was being driven when this daemon last died (pid ${previous.pid}); `
      + 'reporting it');
    await api(config, `/api/projects/${left.projectSlug}/runs/${left.id}/transition`, {
      method: 'POST',
      body: {
        state: 'FAILED',
        failureReason: 'DAEMON_RESTARTED',
        summary: restartSummary({
          name: config.name, previousPid: previous.pid, pid: process.pid, orphanStopped,
          stopped: previous.stopped ?? null,
        }),
      },
    }).catch((failure) => log(`  could not report it: ${failure.message}`));
  }
  await writeDriving(path, snapshotOf(process.pid, running))
    .catch((failure) => log(`could not write ${path}: ${failure.message}`));
}

/**
 * The old daemon's session, if it outlived it — and only if the pid still
 * runs the command it was spawned with, because after a reboot that number
 * may be somebody else's process.
 */
async function stopOrphan(left) {
  if (!left.childPid || !left.command || !isAlive(left.childPid)) {
    return false;
  }
  const command = await new Promise((resolveCommand) => {
    const ps = spawn('ps', ['-o', 'command=', '-p', String(left.childPid)],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ps.stdout.on('data', (chunk) => (out += chunk));
    ps.on('error', () => resolveCommand(''));
    ps.on('close', () => resolveCommand(out));
  });
  if (!command.includes(left.command)) {
    return false;
  }
  try {
    process.kill(-left.childPid, 'SIGTERM');
    log(`  stopped the session it left running (pid ${left.childPid})`);
    return true;
  } catch (failure) {
    log(`  could not stop the session it left running: ${failure.message}`);
    return false;
  }
}

/**
 * Keeps the note current: rewritten whenever the set of runs being driven
 * changes, checked every second. A second is the window in which a death
 * goes unreported — and the stale sweep still catches that one.
 */
function keepTheDrivingNote(config) {
  const path = drivingPath(config.runnerId);
  let written = null;
  const timer = setInterval(() => {
    const snapshot = snapshotOf(process.pid, running);
    const text = JSON.stringify(snapshot);
    if (text === written) return;
    written = text;
    writeDriving(path, snapshot).catch((failure) => {
      written = null;
      log(`could not write ${path}: ${failure.message}`);
    });
  }, 1000);
  timer.unref?.();
  return timer;
}

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
    // How many checkouts each project has here — R47 — which since R109 is the
    // ONLY cap this machine reports, and the only one it enforces. The
    // machine-wide `maxSessions` is gone: it bounded processes, a delegated
    // expert costs none, and a gate measuring the wrong thing while looking
    // like it worked is worse than no gate.
    workspaces: Object.fromEntries(
      Object.entries(config.projects).map(([slug, project]) => [slug, project.workspaces.length]),
    ),
    // Which skills this machine will let a project attach — R76. Said out loud
    // for the reason the two numbers above are: a project can turn CodeGraph on
    // and see nothing happen, and the answer is on the machine. A console that
    // can read this can say which side refused without waiting for a run to
    // say it in a transcript.
    skills: config.skills ?? [],
    agents: config.agentCommands,
    // R260. This daemon knows a claim can carry `baseBranch` — a sprint's
    // branch to cut from, open the pull request against and merge into. It
    // is the WHOLE of how the platform tells an old daemon from a new one:
    // the runner reports no version, so a run cut from a sprint's branch is
    // offered only to a machine that says this, and a machine that does not
    // is told why on the queue rather than handed a base it would ignore.
    baseBranches: true,
    // R270. This daemon knows an offer can carry `waitForClean`, and honours it
    // in `pickWorkspace` — taking the preferred checkout only when clean, and
    // refusing to fall back to a dirty one at all. The same shape as
    // `baseBranches`: an older daemon that ignored the flag would take the
    // dirty checkout and fail a run the person explicitly queued to avoid
    // that, so the platform tells it apart rather than letting one behave
    // like the other.
    waitForClean: true,
    // R379. This daemon knows `CREATE_BRANCH` (a branch put on origin, cut from
    // another branch) and can open, find and merge a GitLab merge request with
    // `glab`. An older daemon would fail the unknown kind, so the platform
    // hands the request only to a daemon that says so.
    createBranch: true,
    gitHosts: ['github', 'gitlab'],
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
  let allGood = true;
  for (const agentCommand of config.agentCommands) {
    // A Claude Code flag. Codex never calls a permission prompt — see
    // `spawnCodex` — and offering it this one would start its terminal UI.
    if (agentOfCommand(agentCommand) === 'codex') {
      continue;
    }
    const said = await new Promise((done) => {
      let text = '';
      let child;
      try {
        child = spawn(agentCommand, ['-p', '--permission-prompt-tool', 'mcp__cawdev__approve'], {
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
      // `close`, not `exit`: this reads the CLI's own help to decide whether a
      // flag exists, and a truncated read would answer "no" for a flag that is
      // there. See git() above.
      child.on('close', () => {
        clearTimeout(give_up);
        done(text);
      });
      // Nothing to say: the missing prompt is what we want it to complain about.
      child.stdin.end();
    });

    if (/unknown option.*permission-prompt-tool/i.test(said)) {
      log(
        `WARNING: ${agentCommand} does not accept --permission-prompt-tool. Sessions that ` +
          `need a command nobody allowed in advance will be denied outright rather than asking ` +
          `you. See R51 and tools/runner/README.md.`,
      );
      allGood = false;
    }
    if (said.startsWith('could not be run:')) {
      log(`WARNING: ${agentCommand} ${said}`);
      allGood = false;
    }
  }
  return allGood;
}

async function main() {
  // Read before anything can log, so the very first line already goes the
  // right way.
  quiet = attaching;

  // A SIGHUP that arrives while booting — `cawdev config` run a moment after
  // the daemon started — is held, not fatal: Node's default for an unhandled
  // SIGHUP is to exit, and the real handler is only installed once
  // `rereadConfig` exists, well after the first lines are logged. It is
  // applied as soon as that handler is in place.
  let hupWhileBooting = false;
  const holdHup = () => {
    hupWhileBooting = true;
  };
  process.on('SIGHUP', holdHup);

  const config = await readConfig();
  // The checkouts made on demand by an earlier run of this daemon, found
  // again by their name — nothing about them is in the config.
  await syncAutoWorkspaces(config.projects);
  const myVersion = await cliVersion();

  // R283. Checked before registering — a daemon too old to be safe should not
  // get as far as claiming a run. `/api/health` is unauthenticated, so this
  // works with the very token `readConfig` just resolved, before it has been
  // proven good for anything else. Anything BUT "the platform said refuse"
  // fails open: a health check that cannot be reached is not evidence the
  // version is wrong, and refusing to boot over a network hiccup would be R2's
  // failure mode pointed at the wrong target.
  try {
    const health = await api(config, '/api/health');
    if (isBelow(myVersion, health?.minimumCliVersion)) {
      throw new Error(
        `This CLI is ${myVersion}; ${config.url} requires at least `
          + `${health.minimumCliVersion}. Update it (npm i -g ./tools from an `
          + 'updated checkout, or however this machine installs cawdev) and run '
          + 'cawdev again.',
      );
    }
  } catch (failure) {
    if (failure.message.startsWith('This CLI is')) {
      throw failure;
    }
    log(`could not check the minimum CLI version (${failure.message}); continuing`);
  }

  const runner = await api(config, '/api/runners', {
    method: 'POST',
    body: {
      name: config.name,
      capabilities: capabilities(config),
      // R126. What this machine says about itself: whether it applies rules set
      // in the console, and the ceiling it declared for itself. The second is a
      // READING the console shows read-only — a ceiling the console could edit
      // would not be a ceiling.
      acceptsConsoleRules: config.acceptsRulesFromConsole === true,
      grantable: JSON.stringify(declaredCeiling(config)),
      // R283. Own version, on every registration and heartbeat — see cliVersion below.
      cliVersion: myVersion,
    },
  });
  config.runnerId = runner.id;

  // R62. The mark, and the five settings that decide what this machine will
  // do. Straight to stdout rather than through log(): it is not an event, it
  // is the state everything after it happens inside, and a timestamp on each
  // of nine lines would bury it.
  //
  // Skipped when attaching, where the UI takes the screen a moment later and
  // a banner would only flash.
  if (!quiet) {
    console.log(bannerLines(config, ink, myVersion).join('\n'));
  }

  log(`registered as "${runner.name}" (${runner.id})`);
  for (const [slug, project] of Object.entries(config.projects)) {
    // The paths still go to the log — the banner says how many, this says
    // which, and "which" is what you need when one of them is wrong.
    log(`serving ${slug}: ${project.workspaces.join(', ')}`);
    // R300. Said before the first run, so the log says the feature is on
    // — and which variable the token is read from — before a scan is missed.
    if (project.quality) {
      log(`quality: ${slug} scans with ${project.quality.command} after TEST, token from $${project.quality.tokenEnv}`);
    }
  }
  await sayWhichWorkspacesCannotBeUsed(config);
  await sayWhichServedProjectsTheTokenCannotReach(config);

  // Frozen here, before anything can be claimed. A run that checks this very
  // directory out onto another branch — which every run on cawdev does — must
  // not be able to change what the NEXT session is given as its MCP server.
  const tools = await snapshotTools().catch((failure) => {
    log(`could not snapshot the MCP server (${failure.message}); using it in place`);
    return null;
  });
  if (tools) {
    config.mcpServerPath = tools.serverPath;
    log(`MCP server frozen at ${tools.serverPath}`);
  }
  if (config.grantable.length) {
    log(`stored rules may cover: ${config.grantable.join(', ')}`);
  }

  // Before anything is claimed, so the warning is at the top of the log rather
  // than buried under a session that then fails for a reason it explains.
  await probePermissionPrompt(config);

  // R339. Whether this machine can put each session under a memory ceiling,
  // and what an earlier daemon on this runner left behind when it died —
  // both before anything is claimed: a run reported now is one the queue
  // must not hand the checkout of to somebody else first.
  const memoryMax = memoryMaxOf(config.sessionMemoryMax);
  if (config.sessionMemoryMax && !memoryMax) {
    log(`sessionMemoryMax "${config.sessionMemoryMax}" is not a size systemd reads (6G, 512M, 75%); ignored`);
  }
  const probed = await probeScope(memoryMax);
  config.sessionScope = probed.scope;
  if (probed.scope) {
    log(`each session runs under MemoryMax=${probed.scope.memoryMax} (systemd --${probed.scope.manager} scope)`);
  } else if (probed.why) {
    log(`sessionMemoryMax not applied: ${probed.why}`);
  }
  await reportWhatARestartKilled(config);
  const drivingNote = keepTheDrivingNote(config);

  // What this daemon SAYS it is, on every hello — R52's socket, R288's rule
  // that it describes the current state. One object, sent as-is by
  // `serveControl` and mutated by the SIGHUP handler below, so a terminal that
  // attaches after a toggle reads what is true now.
  const advertised = {
    id: config.runnerId,
    name: config.name,
    url: config.url,
    // R126. Whether this machine takes rules from the console — so the
    // terminal only offers `M` when pressing it would do something. A key
    // that takes an answer the platform then refuses reads as cawdev being
    // broken, which is R58's rule about `a` applied to this one.
    acceptsConsoleRules: config.acceptsRulesFromConsole === true,
    projects: Object.keys(config.projects),
    // How many checkouts each has — R62. The per-project half of R47's
    // gate, which the bar shows as `cawdev 1/2`. Added rather than
    // replacing `projects`: an older attach ignores it and still works,
    // and a newer one against an older daemon simply shows a count with
    // nothing to compare it against.
    workspaces: Object.fromEntries(
      Object.entries(config.projects).map(([slug, p]) => [slug, p.workspaces.length]),
    ),
    // R288: which agents this machine spawns, and the file it booted from,
    // so the attached terminal's config screen can show the state of each
    // toggle and write to the right file. `configPath` is null for a daemon
    // run from the environment alone, and the screen says so rather than
    // inventing a file.
    agents: [...config.agentCommands],
    configPath: config.configPath,
    // R294: the keys the file has moved on from since boot that only a restart
    // would apply — nothing, at boot, by definition — and when the file was
    // last read, so a door that just signalled can wait for a fresh answer.
    restartNeeded: [],
    configReadAt: new Date().toISOString(),
    // R81. `cawdev` starts a daemon for you when it finds none, and
    // quitting the UI leaves it running — it is driving sessions. A
    // background process you did not know you started is the cost of that
    // choice, so the goodbye has to name it precisely enough to stop, and
    // this is the only place the number is known.
    pid: process.pid,
  };

  // R283. `cawdev config agent enable/disable` and `cawdev config rules
  // on/off` write the file and, if a daemon is running on it, send SIGHUP — NOT
  // a control-socket command. `control.mjs` is deliberately read-only ("no
  // command can" change anything, so a person acting through it never gets
  // more than their own HTTPS session already grants); SIGHUP is a unix
  // convention for "re-read your config", asked of a process this operator
  // already owns, so it does not open that door. Only the settings that are
  // genuinely safe to hot-swap — `HOT_SWAPPABLE`, in lib/runner-config.mjs,
  // the ONE spelling of that list — are applied: `agentCommands`, `grantable`
  // and `acceptsRulesFromConsole` are read fresh from `config` on every use
  // (spawn, or the next heartbeat), never captured once at boot, so mutating
  // them here is enough, with no further plumbing.
  //
  // R294: and the daemon SAYS what it could not apply. Everything else in the
  // file is read once at boot, and until this a project added to the file was
  // logged as "nothing changed" — the handler diffed only the three keys it
  // could swap. `rereadConfig` compares the whole file against the one this
  // process BOOTED with (not the last one read, so an edit reverted by hand
  // clears the notice by itself) and publishes the keys only a restart would
  // apply as `restartNeeded` on the hello, with `configReadAt` so a door that
  // just signalled can tell a fresh answer from the old one. A notice, never a
  // restart — R113's rule: the daemon says so, and a person decides. Two
  // triggers, one function: the signal, and the heartbeat noticing the file's
  // mtime moved, which is what covers a hand edit with no door at all.
  let configSeenAt = null;
  const rereadConfig = async (why) => {
    const path = config.configPath ?? configPathFromArgv();
    try {
      // The mtime first, so a re-read on a signal is not followed by a second
      // one on the next beat for the same write.
      configSeenAt = (await stat(path).catch(() => null))?.mtimeMs ?? configSeenAt;
      const file = JSON.parse(await readFile(path, 'utf8'));
      // What the three keys RESOLVE to, defaults filled in as `readConfig`
      // fills them, so a key the file omits is not reported as a change.
      const resolved = {
        acceptsRulesFromConsole: file.acceptsRulesFromConsole ?? DEFAULTS.acceptsRulesFromConsole,
        grantable: file.grantable ?? DEFAULTS.grantable,
        autoWorkspaces: autoWorkspacesOf(file.autoWorkspaces),
        agentCommands: file.agentCommands
          ?? (file.agentCommand ? [file.agentCommand] : null)
          ?? DEFAULTS.agentCommands,
      };
      const applied = reloadableFor({
        agentCommands: config.agentCommands,
        grantable: config.grantable,
        acceptsRulesFromConsole: config.acceptsRulesFromConsole,
        autoWorkspaces: config.autoWorkspaces,
      }, resolved);
      // A checkout made on demand may have been dropped — the attached
      // terminal's `/drop` deletes the directory and sends this signal.
      await syncAutoWorkspaces(config.projects, heldWorkspaces());
      if (await sayWhichWorkspacesCannotBeUsed(config)) {
        log('  (the project list itself is read at start — restart the daemon after changing "workspaces")');
      }
      Object.assign(config, resolved);
      // R288: the hello describes the current state, not the booted one — an
      // attach opened after a toggle would otherwise offer to turn on what is
      // already on. The same object `serveControl` sends, mutated in place.
      advertised.acceptsConsoleRules = config.acceptsRulesFromConsole === true;
      advertised.agents = [...config.agentCommands];
      advertised.restartNeeded = config.bootedFile ? restartNeededFor(config.bootedFile, file) : [];
      advertised.configReadAt = new Date().toISOString();
      const said = [
        applied.length ? `applied: ${applied.join(', ')}` : null,
        advertised.restartNeeded.length ? `needs restart: ${advertised.restartNeeded.join(', ')}` : null,
      ].filter(Boolean);
      log(`re-read ${path} on ${why} — ${said.length ? said.join('; ') : 'nothing changed'}`);
    } catch (failure) {
      log(`${why} re-read of ${path} failed: ${failure.message}`);
    }
    // A terminal already attached got its hello before this; the daemon tells
    // it rather than waiting for the next attach. An older client ignores an
    // event type it does not know.
    control?.publish({ type: 'runner', runner: advertised });
  };
  process.off('SIGHUP', holdHup);
  process.on('SIGHUP', () => rereadConfig('SIGHUP'));
  if (hupWhileBooting) {
    void rereadConfig('SIGHUP (sent while booting)');
  }

  // The heartbeat's half of R294: the file's mtime, read once per beat, and a
  // re-read when it moved. `stat` and nothing more when it did not, which is
  // what makes this affordable every thirty seconds. Skipped for a daemon
  // booted from the environment alone — there is no file to have changed.
  configSeenAt = config.configPath ? (await stat(config.configPath).catch(() => null))?.mtimeMs ?? null : null;
  const noticeConfigEdits = async () => {
    if (!config.configPath) return;
    const seen = (await stat(config.configPath).catch(() => null))?.mtimeMs ?? null;
    if (seen === null || seen === configSeenAt) return;
    // `rereadConfig` records the mtime before it reads: a file caught
    // mid-write fails to parse, and the write that finishes it moves the
    // mtime again.
    await rereadConfig('edit');
  };

  // R52. Nothing here is load-bearing for running an agent, so a daemon that
  // cannot open a socket says so and carries on: trading the ability to run
  // work for the ability to watch it would be the wrong way round.
  try {
    control = await serveControl({
      runner: advertised,
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
  //
  // Awaitable, and awaited by `performWorkspaceRequest` since R218: a request
  // that changed a tree answers only after the platform holds the tree as it
  // now is. It never rejects — each of its two POSTs keeps its own catch.
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
    // R77. Which projects have a map already, so the tab can offer to build one
    // rather than making somebody start a session to find out.
    const skillIndexes = await surveySkillIndexes(config).catch((failure) => {
      log(`could not survey the skill indexes: ${failure.message}`);
      return null;
    });
    // R87. What every checkout HOLDS — commits included, which is the half
    // nothing reported. A daemon that has just come back from a crash is the
    // one thing that knows there are five commits and seven changed files in
    // cawdev-2, and R80 kept that silently.
    const workspacesReported = surveyWorkspaces(config)
      .then((workspaces) => api(config, `/api/runners/${config.runnerId}/workspaces`, {
        method: 'POST',
        body: { workspaces },
      }))
      .then((recorded) => {
        if (recorded?.holdingWork) {
          log(`${recorded.holdingWork} checkout(s) hold unfinished work — resume or start over`);
        }
      })
      .catch((failure) => log(`could not report the workspaces: ${failure.message}`));
    const heartbeatAnswered = api(config, `/api/runners/${config.runnerId}/heartbeat`, {
      method: 'POST',
      body: {
        name: config.name,
        running: [...running.keys()],
        capabilities: capabilities(config),
        // Stringified, as `capabilities` and R24's detail are: the platform
        // stores what this machine said, not its own reading of it.
        workingCopies: workingCopies ? JSON.stringify(workingCopies) : null,
        skillIndexes: skillIndexes ? JSON.stringify(skillIndexes) : null,
        // R126, on every beat and not only at registration: a machine that is
        // reconfigured to stop accepting console rules stops honouring them
        // without anybody having to revoke anything.
        acceptsConsoleRules: config.acceptsRulesFromConsole === true,
        grantable: JSON.stringify(declaredCeiling(config)),
        // R283. Sent on every beat, not only at registration, for
        // `acceptsConsoleRules`' own reason: a daemon reconfigured or
        // reinstalled reports what is true NOW.
        cliVersion: myVersion,
      },
    }).then((me) => {
      // R73/R80. The heartbeat's answer is what the platform decided about
      // this machine, and it changes what the queue loop does next.
      if (me && typeof me === 'object') {
        if (told.paused !== !!me.paused) {
          log(me.paused
            ? 'paused from the console: claiming nothing new, finishing what is running'
            : 'unpaused from the console');
        }
        told.paused = !!me.paused;
        told.autoResume = !!me.autoResume;
        told.heldWorkspaces = Array.isArray(me.heldWorkspaces)
          ? me.heldWorkspaces.map((each) => each.path).filter(Boolean)
          : [];
      }
    }).catch((failure) => log(`heartbeat failed: ${failure.message}`));
    await Promise.all([workspacesReported, heartbeatAnswered, noticeConfigEdits()]);
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

  // What is left of the usage windows. Once immediately, for `readGit`'s
  // reason: a console showing no meter for ten minutes after a restart has
  // told somebody this machine has no windows.
  const readTheMeter = () => {
    void readUsage(config).catch((failure) => log(`usage read failed: ${failure.message}`));
  };
  if (config.usageSeconds) {
    readTheMeter();
    const usage = setInterval(readTheMeter, config.usageSeconds * 1000);
    usage.unref?.();
  }

  // R57: looking at a checkout, parking what is in it, or keeping it.
  const takeWorkspaceRequests = watchWorkspaceRequests(config, { afterTheTreeMoved: beat });
  const workspaceRequests = setInterval(() => {
    void takeWorkspaceRequests();
  }, config.workspacePollSeconds * 1000);
  workspaceRequests.unref?.();

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (stopping) {
        // A second Ctrl-C means "now", not "again".
        process.exit(0);
      }
      log('stopping; leaving any live run to the platform’s staleness sweep');
      stopping = true;
      // R339. Said in the note before the sessions go, so the next daemon
      // tells a stop somebody asked for from a kill nobody did.
      clearInterval(drivingNote);
      await writeDriving(drivingPath(config.runnerId),
        { ...snapshotOf(process.pid, running), stopped: signal })
        .catch(() => undefined);
      clearInterval(heartbeat);
      clearInterval(gitSurvey);
      clearInterval(workspaceRequests);
      clearInterval(publishRuns);
      if (tools) {
        await rm(tools.directory, { recursive: true, force: true }).catch(() => undefined);
      }
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
    const argv = process.argv.slice(2);
    const typed = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : null;
    void attach(argv, {
      socketPath: control?.path,
      // Where the person signs in: `--url`, else what this daemon is called —
      // `cawdev.mjs`'s `signInUrl` order. `urlFrom` alone never sees the config.
      url: (typed ?? config.url).replace(/\/+$/, ''),
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

      // Checked again HERE, not only at the top. The poll blocks for up to
      // pollSeconds, and a Ctrl-C during it flips `stopping` and begins the
      // goodbye — which is bounded but not instant. A poll that returns inside
      // that window would otherwise walk on to claim a run and spawn a
      // detached agent that outlives the exiting daemon, orphaned with a live
      // claim. The gap after this point is startRun's own: it reads `stopping`
      // nowhere, and a Ctrl-C between its claim and its spawn is still open.
      //
      // Also the loop's exit an analyser can see. The header's condition IS one
      // at runtime — `stopping` is a closed-over `let` read every iteration —
      // but its only writer is the signal handler, and i247 (S2189) is what a
      // loop with no visible way out looks like from outside.
      if (stopping) {
        break;
      }

      // ONE gate — R109. There were two; `maxSessions` bounded this machine
      // and is gone, for the reason written where it used to be applied.
      //
      // A project's workspaces bound its CODING runs and nothing else: they are
      // checkouts, and only a coding run needs one.
      //
      // One run at a time per WORKSPACE — R47, and only for runs that use one.
      // The gate used to key on the project, because there was one checkout per
      // project and the two were the same thing. They are not any more: a
      // project with three workspaces takes three coding runs, and the reason a
      // fourth waits is that there is no free checkout rather than that the
      // project is somehow occupied.
      //
      // An ASK run prepares nothing and writes nothing, so it takes no
      // workspace and waits for nothing — asking "what is R12 about?" while
      // three sessions are running is exactly when you would want to.
      //
      // Computed AFTER the poll, not before. The poll blocks for up to
      // pollSeconds, so a set built before it is a snapshot of the world as it
      // was when the wait began — and a run that started during the wait was
      // invisible. Two agents went into one checkout that way.
      const held = heldWorkspaces();
      // One `git status` per checkout per pass, not per offer — i258.
      // Several offers of one project ask `looksClean` on a shared checkout
      // only once.
      const probed = new Map();
      const problems = new Map();

      let claimable = 0;
      let skipped = 0;

      for (const offered of offers) {
        const slug = offered.run.projectSlug;
        if (!config.projects[slug]) {
          continue; // Not ours to run.
        }
        // R73. Paused is "claim nothing new". Everything already running is
        // left to finish; that is the default because killing a machine's work
        // to stop it taking more is the surprising reading.
        if (told.paused) {
          noteQueued(offered.run, 'this machine is paused from the console');
          skipped += 1;
          continue;
        }
        if (taken.has(offered.run.id)) {
          continue; // Already being claimed or prepared by us.
        }
        const writes = writesCodeProfile(offered.run);

        // ONE gate now — R109 removed the machine's.
        //
        // `maxSessions` bounded agent PROCESSES on this laptop, and R70's own
        // note said why: a queue of runs is otherwise a fork bomb with better
        // manners. What it never bounded is AGENTS. A delegated expert (R104)
        // runs inside its parent's session and costs no process at all, so with
        // sub-agents the number it capped stopped being the number anybody was
        // worried about — and capping runs to bound agents would have been a
        // gate measuring the wrong thing while looking like it worked.
        //
        // The workspace gate stays, because a checkout is a real, countable,
        // contended thing. An operator who wants a ceiling has one: it is how
        // many workspaces they give a project.
        //
        // The project's gate, which counts CODING runs only — R70.
        // It is a checkout, and the checkout is the whole reason for it: an
        // ASK, a ROADMAP, an AUDIT or a SCOPE contends for no working copy, no
        // branch and no dev-stack port, so measuring it against a per-project budget
        // bounds it by a constraint it does not have.
        //
        // Which checkout this one gets. Null for a run that needs none.
        //
        // R86/R87: the platform may NAME one (`workspace`), and then it is the
        // only answer. It does so while the branch is BOUND to that checkout:
        // a later run of a branch whose unpushed commits are in that one
        // directory, or a resumed run whose uncommitted work is there — so
        // preparing it in whichever checkout happens to be free is preparing it
        // from `origin` with the work still sitting three directories away.
        // Waiting is the right behaviour and the reason is worth saying.
        //
        // R212: once the branch is entirely on the remote and nothing is
        // writing it, the platform names only a PREFERENCE
        // (`preferredWorkspace`) — the checkout the branch last ran in, where
        // the local ref already is. Taken when free, passed over when not: a
        // busy preferred checkout is not worth waiting for, because origin has
        // everything and prepareWorkingCopy brings a stale ref up to it.
        //
        // Below pinned and preferred, which checkout a free-for-the-taking
        // run gets now also weighs whether its tree is clean — R71/i258. The
        // `await` here can only make `held` more conservative while it waits:
        // claims are added by this loop alone, sequentially, and a run
        // finishing only frees a path. The one optimistic case — a heartbeat
        // adding to `told.heldWorkspaces` mid-loop — is the same window that
        // already exists between this poll and `startRun`'s own claim.
        let workspace = null;
        let source = null;
        if (writes) {
          const picked = await pickWorkspace(slug, config.projects[slug], offered, held, probed,
            config.autoWorkspaces, problems);
          if (picked.why) {
            noteQueued(offered.run, picked.why);
            skipped += 1;
            continue;
          }
          workspace = picked.workspace;
        } else {
          // Reads from a usable folder, and holds none: the source goes to
          // `startRun` on its own and never into `held` or `taken` (R70).
          const project = config.projects[slug];
          source = await usableWorkspace(project, new Set(), problems, { reading: true });
          if (!source) {
            const first = project.workspaces[0];
            const trouble = await problemOf(problems, first);
            noteQueued(offered.run, trouble
              ? workspaceProblemSaid(slug, trouble, { first })
              : `${slug} has no workspace on this machine`);
            skipped += 1;
            continue;
          }
        }
        if (workspace) {
          held.add(workspace);
        }
        taken.set(offered.run.id, {
          projectSlug: slug,
          writes,
          workspace,
          label: offered.run.label,
        });
        noted.delete(offered.run.id);
        claimable += 1;
        void startRun(config, offered, workspace, source);
      }

      // Forget runs that are no longer offered, so one that comes back around
      // is reported again rather than staying silently skipped forever.
      for (const id of [...noted.keys()]) {
        if (!offers.some((offer) => offer.run.id === id)) {
          noted.delete(id);
        }
      }

      // R148. Say it where a person can read it. Fire-and-forget: a daemon
      // that died because the platform was slow to take a nicety would be
      // worse than one that said nothing.
      const reasons = [...noted.entries()].map(([runId, note]) => ({ runId, why: note.why }));
      const reasonsBody = JSON.stringify(reasons);
      if (reasonsBody !== lastSentReasons) {
        lastSentReasons = reasonsBody;
        api(config, `/api/runners/${config.runnerId}/queued-reasons`, {
          method: 'POST',
          body: { reasons },
        }).catch((failure) => log(`could not report why the queue waits: ${failure.message}`));
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
