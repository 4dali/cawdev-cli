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
    projects: file.projects ?? {},
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
  const path = config.projects[run.projectSlug];
  let runToken;
  let defaultBranch;

  try {
    log(`claiming ${run.projectSlug} R${run.entryNumber} on ${run.branch}`);
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
  await writeFile(
    mcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          cawdev: {
            command: process.execPath,
            args: [serverPath],
            env: {
              CAWDEV_URL: config.url,
              CAWDEV_TOKEN: runToken,
              CAWDEV_PROJECT: run.projectSlug,
            },
          },
        },
      },
      null,
      2,
    ),
  );

  // The prompt goes on stdin, NOT as an argument.
  //
  // `--mcp-config <configs...>` is variadic, so a prompt after it is swallowed
  // as a second config file — which fails with "ENAMETOOLONG: name too long"
  // and names neither the flag nor the prompt. Stdin also sidesteps
  // argument-length limits, and prompts are not short.
  // --mcp-config goes FIRST: both it and --allowedTools are variadic, and a
  // variadic option swallows whatever follows it.
  const args = ['--mcp-config', mcpConfigPath, ...config.agentArgs];
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

    child.stdin.write(promptFor(run));
    child.stdin.end();

    let lastText = '';
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        const event = safeJson(line.trim());
        if (event?.type === 'result' && typeof event.result === 'string') {
          lastText = event.result;
        }
      }
    });
    child.stderr.on('data', (chunk) => log(`  agent stderr: ${String(chunk).trim().slice(0, 400)}`));

    child.on('error', async (failure) => {
      await finish(config, run, 'FAILED', `Could not spawn the agent: ${failure.message}`);
      await rm(mcpDirectory, { recursive: true, force: true });
      resolvePromise();
    });

    child.on('exit', async (code, signal) => {
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
  log(`serving: ${Object.entries(config.projects).map(([s, p]) => `${s} -> ${p}`).join(', ')}`);

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
          log(`${slug} already has a run here; leaving R${offered.entryNumber} queued`);
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
