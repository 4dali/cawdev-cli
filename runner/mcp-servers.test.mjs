// node --test tools/runner/mcp-servers.test.mjs
//
// R76's half that does not live in the platform: whether the MACHINE lets a
// project's skill be attached, and what it costs the second time.
//
// A skill spawns a third-party MCP server on the operator's own computer with
// read access to the checkout it is pointed at. That is the same class of
// permission as driving their logged-in Chrome, so the shape is R61's: the
// platform records what the project asked for, the machine decides whether it
// happens, and a refused run is NOT failed — it runs without the skill and says
// which side refused, on its own transcript.
//
// What is tested here:
//
//   - the machine's answer is the one that counts, in both directions, and an
//     older config that has never heard of skills keeps meaning no;
//   - the MCP config the daemon writes actually carries the skill's server, and
//     cawdev's own entry cannot be shadowed by it;
//   - the tools are NOT pre-approved — availability is not permission;
//   - two runs on one repository parse it ONCE, which is the entry's last
//     "done when" and the only part of this that is about performance.
//
// The agent is a stub that prints the MCP config it was given, so what the CLI
// would have been handed is readable from the daemon's own log.

import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

async function untilSaid(said, pattern, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(said())) return true;
    await new Promise((wake) => setTimeout(wake, 100));
  }
  return false;
}

async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-skills-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

/**
 * A stand-in for `codegraph`, which counts how often it was asked to parse.
 *
 * `init` writes an index that looks like the real one — a directory with a
 * SQLite file and a pidfile, the second of which must NOT travel between
 * workspaces — and appends a line to a counter file so a test can prove the
 * repository was parsed once rather than twice. `serve --mcp` does nothing: the
 * daemon never runs it, the CLI would.
 */
async function aFakeIndexer(home) {
  const script = join(home, 'codegraph.mjs');
  const counter = join(home, 'parses.log');
  await writeFile(script, `#!/usr/bin/env node
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('init') || args.includes('index')) {
  const dir = join(process.cwd(), '.codegraph');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'codegraph.db'), 'a graph, honestly');
  // The two things that must never be copied into another workspace: they name
  // a live process and the socket it is listening on.
  await writeFile(join(dir, 'daemon.pid'), '4242 ' + new Date().toISOString());
  await writeFile(join(dir, 'daemon.sock'), '');
  await appendFile(${JSON.stringify(counter)}, process.cwd() + '\\n');
  console.log('indexed');
}
`);
  await chmod(script, 0o755);
  return {
    command: process.execPath,
    args: [script, 'serve', '--mcp'],
    async parses() {
      return (await readFile(counter, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean);
    },
  };
}

/**
 * A stub agent that prints the MCP config it was handed, and its own argv.
 *
 * The point of a skill is a server in that file, and the daemon's log carries
 * only the path to it — which is in a temporary directory the daemon deletes
 * when the run ends. So the child reads it and prints it, which puts the whole
 * thing where a test can see it afterwards.
 *
 * Executable with its own shebang rather than `node script.mjs`, and that
 * matters: `agentArgs` in the config replaces the DEFAULTS wholesale, and the
 * defaults are where `--allowedTools` lives. A test asserting that a skill's
 * tools were not pre-approved has to be looking at the real list.
 */
async function anEchoingAgent(home) {
  const script = join(home, 'agent.mjs');
  // The config is COPIED to a file rather than printed.
  //
  // It used to be echoed on stdout and read back off the run's transcript,
  // which caps a non-JSON line at 4000 characters — and an MCP config is longer
  // than that on a CI runner, whose paths differ from a laptop's. The four
  // tests below then failed with `Unterminated string in JSON`, on main, on
  // every push, for as long as anybody had been looking. A test whose subject is
  // "what was the child handed" should not be reading it through a transport
  // that truncates.
  const configCopy = join(home, 'mcp-config.json');
  await writeFile(script, `#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
const at = process.argv.indexOf('--mcp-config');
const config = at === -1 ? '{}' : await readFile(process.argv[at + 1], 'utf8');
await writeFile(${JSON.stringify(configCopy)}, config);
console.log('MCPCONFIG written');
console.log('ARGV ' + process.argv.slice(2).join(' '));
// Stays up: the daemon reaps a child whose run has ended, and a stub that
// exited before the daemon read its stdout is indistinguishable from one that
// was never spawned.
setTimeout(() => {}, 60000);
`);
  await chmod(script, 0o755);
  return script;
}

/**
 * @param wants what the PROJECT turned on, as the claim carries it.
 * @param workspaces how many checkouts the project has here — R47. Two runs in
 *   two workspaces is how "share one index" is proved.
 */
async function daemonWith(t, { name, wants, offers, workspaces = 1 }) {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-skillcfg-'));
  const indexer = await aFakeIndexer(home);
  const agent = await anEchoingAgent(home);
  const paths = [];
  for (let i = 0; i < workspaces; i++) {
    paths.push(await aRepository());
  }

  const mcpServers = wants === undefined ? [] : [{
    key: 'codegraph',
    name: 'CodeGraph',
    serverName: 'codegraph',
    toolPrefix: 'mcp__codegraph',
    command: indexer.command,
    args: indexer.args,
    version: '1.6.0',
    settings: '{}',
    ...wants,
  }];

  const platform = await fakePlatform({
    offers: offers ?? [{
      id: 'run-mcp-servers',
      projectSlug: 'board',
      label: 'a card',
      branch: 'r76-work',
      profile: 'CODE',
    }],
    mcpServers,
    // The child has to outlive the reaper: everything here is read off what it
    // printed, and a run the platform calls FINISHED is one the daemon stops
    // before it has said anything.
    runLive: true,
  });

  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    // The defaults are left alone, so `--allowedTools` is the real one.
    agentCommand: agent,
    pollSeconds: 1,
    skillCache: join(home, 'cache'),
    skillPrepareSeconds: 60,
    projects: {
      board: { workspaces: paths },
    },
  }));

  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  daemon.stdout.on('data', (chunk) => (said += chunk));
  daemon.stderr.on('data', (chunk) => (said += chunk));

  t.after(async () => {
    daemon.kill('SIGKILL');
    platform.close();
    await rm(home, { recursive: true, force: true });
    for (const path of paths) {
      await rm(path, { recursive: true, force: true });
    }
    await rm(socketPathFor(name), { force: true });
  });

  return {
    platform,
    // Where the stub wrote its copy of the config — see `mcpConfigFrom`.
    home,
    paths,
    indexer,
    said: () => said,
    untilSaid: (pattern, timeout) => untilSaid(() => said, pattern, timeout),
  };
}

/**
 * What the child printed, read back off the RUN's transcript.
 *
 * Not off the daemon's own log, which is the obvious place and the wrong one:
 * the daemon routes an agent's stdout into the transcript it streams to the
 * platform (`linesOf` keeps a non-JSON line verbatim, up to 4000 characters)
 * and logs only its *stderr*, truncated to 400. An MCP config is longer than
 * that, so the echo has to be read where the daemon actually puts it.
 */
function saidByTheAgent(platform, tag) {
  const line = [...platform.outputs].reverse()
    .find((each) => (each.body ?? '').includes(tag + ' '));
  return line ? line.body.slice(line.body.indexOf(tag + ' ') + tag.length + 1) : null;
}

/**
 * The MCP config the child was handed, read off the copy it wrote.
 *
 * Off DISK rather than the transcript — see `anEchoingAgent`. The transcript
 * still carries `MCPCONFIG written`, which is what the tests wait on, because
 * "the child has started and read its arguments" is a thing only the stream can
 * say.
 */
async function mcpConfigFrom(where) {
  return JSON.parse(await readFile(join(where, 'mcp-config.json'), 'utf8'));
}

function argvFrom(platform) {
  return saidByTheAgent(platform, 'ARGV') ?? '';
}

test('a skill the project turned on is in the session\'s MCP config',
  async (t) => {
    const { said, untilSaid, platform, home } = await daemonWith(t, {
      name: 'test-skill-yes',
      wants: {},
    });

    assert.ok(await platform.untilSaidOnTheRun(/MCPCONFIG /), said());
    const config = await mcpConfigFrom(home);
    assert.ok(config.mcpServers.codegraph, `no codegraph server:\n${said()}`);
    // cawdev's own entry survives beside it, and is not the skill's. A skill
    // that could shadow it would intercept the run's own token.
    assert.match(config.mcpServers.cawdev.args.join(' '), /server\.mjs$/);
    assert.equal(config.mcpServers.cawdev.env.CAWDEV_TOKEN, 'cawdr_fake');
    // And the MCP server is told which of them is a skill, so the first call's
    // question offers the whole server rather than the one tool.
    assert.deepEqual(
      JSON.parse(config.mcpServers.cawdev.env.CAWDEV_SKILL_SERVERS),
      ['mcp__codegraph'],
    );

    // Said on the RUN, not only in the log: the session is about to use a
    // capability whose first call will stop, and the person watching needs to
    // know what to answer.
    assert.ok(await platform.untilSaidOnTheRun(/CodeGraph is available to this session/),
      JSON.stringify(platform.outputs, null, 2));
  });

test('availability is not pre-approval: the tools are not in --allowedTools', async (t) => {
  const { platform, said, untilSaid, home } = await daemonWith(t, {
    name: 'test-skill-not-granted',
    wants: {},
  });

  assert.ok(await platform.untilSaidOnTheRun(/ARGV /), said());
  // The whole point of R51 and R60. Attaching a server makes its tools exist;
  // it must not make them allowed, or nobody is ever asked and the machine's
  // veto is the only check left. The transcript tells the session what to
  // expect instead.
  assert.doesNotMatch(argvFrom(platform), /mcp__codegraph/);
});

test('the platform decides: a skill a project turned on is attached here', async (t) => {
  // The machine's veto is gone, deliberately. A skill's `command` is not
  // something anybody types: the `skill` table is seeded by migration and has
  // no create endpoint, so turning one on runs a command cawdev itself shipped.
  // A second allowlist on every machine was therefore guarding against a
  // project owner enabling a vetted skill — friction, not a boundary.
  const { platform, said, untilSaid, home } = await daemonWith(t, {
    name: 'test-skill-platform-decides',
    wants: {},
    // No `skills` key at all. Once, this meant "none"; now the config has no
    // opinion to have.
  });

  assert.ok(await platform.untilSaidOnTheRun(/MCPCONFIG /), said());
  assert.ok((await mcpConfigFrom(home)).mcpServers.codegraph,
    `the platform turned it on and it was not attached:\n${said()}`);
});

test('a config written before R76 needs no edit to get a skill', async (t) => {
  // The upgrade path, and the point of removing the allowlist: an operator who
  // turns CodeGraph on in the console does not then have to go and edit a JSON
  // file on the machine before anything happens.
  const { platform, said, home } = await daemonWith(t, {
    name: 'test-skill-old-config',
    wants: {},
  });

  assert.ok(await platform.untilSaidOnTheRun(/MCPCONFIG /), said());
  assert.ok((await mcpConfigFrom(home)).mcpServers.codegraph, said());
  // Still not pre-approved: the first call stops and asks (R51). Removing the
  // machine's allowlist did not remove the machine's consent — it moved it to
  // the moment the tool is actually used, which is where R51 already put it.
  assert.doesNotMatch(argvFrom(platform), /mcp__codegraph/);
});

test('a project that turned nothing on is spawned exactly as before', async (t) => {
  const { platform, said, untilSaid, home } = await daemonWith(t, {
    name: 'test-skill-unasked',
    wants: undefined,
  });

  assert.ok(await platform.untilSaidOnTheRun(/MCPCONFIG /), said());
  assert.equal((await mcpConfigFrom(home)).mcpServers.codegraph, undefined);
  // And nothing is said about it, because nothing was refused.
  assert.doesNotMatch(said(), /has not allowed it/);
});

test('the pin is checked against what was sent, and a disagreement is said out loud',
  async (t) => {
    const { platform, untilSaid, said, home } = await daemonWith(t, {
      name: 'test-skill-pin',
      // The row claims one version and the command names none — which is what a
      // migration that edited one and forgot the other looks like.
      wants: { version: '9.9.9' },
    });

    assert.ok(await platform.untilSaidOnTheRun(/MCPCONFIG /), said());
    assert.ok(await platform.untilSaidOnTheRun(/does not name that version/),
      JSON.stringify(platform.outputs, null, 2));
    // Running what was SENT, not what was claimed: the arguments are what
    // executes, and quietly substituting a version nobody sent would be worse
    // than saying so.
    assert.ok((await mcpConfigFrom(home)).mcpServers.codegraph);
  });

// --- the index, which is the integration work --------------------------------

test('two runs on one repository parse it once, in two different workspaces', async (t) => {
  const { platform, indexer, untilSaid, said, paths } = await daemonWith(t, {
    name: 'test-skill-index-shared',
    wants: {},
    workspaces: 2,
    offers: [
      {
        id: 'run-one',
        projectSlug: 'board',
        label: 'first card',
        branch: 'r76-one',
        profile: 'CODE',
      },
      {
        id: 'run-two',
        projectSlug: 'board',
        label: 'second card',
        branch: 'r76-two',
        profile: 'CODE',
      },
    ],
  });

  // Both runs get going. R47 gives them a checkout each, which is exactly the
  // case that used to mean parsing the same repository twice.
  assert.ok(await untilSaid(/reusing this repository's index/, 60000), said());
  assert.ok(await platform.untilSaidOnTheRun(/built this repository's index/),
    JSON.stringify(platform.outputs.map((line) => line.body), null, 2));

  // ONE parse, for two runs. This is the entry's last "done when", and the
  // reason the index is keyed to the repository rather than to the checkout.
  const parses = await indexer.parses();
  assert.equal(parses.length, 1, `parsed ${parses.length} times:\n${parses.join('\n')}`);

  // The second workspace has its own copy of the graph...
  //
  // Matched on the REAL path, not the one mkdtemp handed back: on macOS
  // `/var` is a symlink to `/private/var`, so the indexer's own `process.cwd()`
  // never string-equals the temp directory this test created. Comparing them
  // raw silently picks the wrong workspace — and then asserts the *building*
  // one has no pidfile, which it always does, so the test fails while the
  // behaviour it is checking is correct.
  const parsedIn = await realpath(parses[0]);
  const real = await Promise.all(paths.map((each) => realpath(each)));
  const second = parsedIn === real[0] ? paths[1] : paths[0];
  await readFile(join(second, '.codegraph', 'codegraph.db'), 'utf8');
  // ...and NOT the other one's daemon pidfile, which is the whole reason this
  // is a copy rather than a symlink: a pidfile from another root points at a
  // daemon serving another tree, and every answer it gives is about the wrong
  // files.
  await assert.rejects(() => readFile(join(second, '.codegraph', 'daemon.pid'), 'utf8'));
});

test('the index is kept out of the checkout\'s own status', async (t) => {
  const { platform, untilSaid, said, paths } = await daemonWith(t, {
    name: 'test-skill-index-excluded',
    wants: {},
  });

  assert.ok(await untilSaid(/built this repository's index/, 60000), said());

  // Otherwise the next run in this workspace is refused for a dirty tree it did
  // not make, and R47's `git clean -fd` between runs deletes the index. Local
  // to this checkout, so the project is not asked to carry a machine's
  // .gitignore line.
  const status = await run('git', ['status', '--porcelain'], { cwd: paths[0] });
  assert.doesNotMatch(status.stdout, /codegraph/, status.stdout);
});

test('an index that cannot be built is a sentence, not a failed run', async (t) => {
  const { platform, untilSaid, said, home } = await daemonWith(t, {
    name: 'test-skill-index-broken',
    // A command that is not there at all, which is what a missing binary or a
    // registry that would not serve one looks like.
    wants: { command: join(tmpdir(), 'cawdev-no-such-indexer') },
  });

  assert.ok(await platform.untilSaidOnTheRun(/MCPCONFIG /, 60000), said());
  assert.ok(await platform.untilSaidOnTheRun(/could not build this repository's index/),
    JSON.stringify(platform.outputs.map((line) => line.body), null, 2));
  assert.deepEqual(platform.transitions.filter((each) => each.state === 'FAILED'), []);
});

// --- and what it cost (R76's measurement) ------------------------------------

test('the run is told what the session used', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-usagecfg-'));
  const path = await aRepository();
  // An agent that reports one turn, in the shape the CLI's `result` event has.
  const script = join(home, 'agent.mjs');
  await writeFile(script, `#!/usr/bin/env node
console.log(JSON.stringify({
  type: 'result', subtype: 'success', result: 'done',
  modelUsage: {
    'claude-opus-5': { inputTokens: 100, cacheCreationInputTokens: 20, outputTokens: 7 },
  },
}));
setTimeout(() => {}, 60000);
`);
  await chmod(script, 0o755);
  await mkdir(join(home, 'cache'), { recursive: true });

  const platform = await fakePlatform({
    offers: [{
      id: 'run-usage',
      projectSlug: 'board',
      label: 'a card',
      branch: 'r76-usage',
      profile: 'CODE',
    }],
    runLive: true,
  });
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name: 'test-skill-usage',
    agentCommand: script,
    pollSeconds: 1,
    projects: { board: path },
  }));

  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    daemon.kill('SIGKILL');
    platform.close();
    await rm(home, { recursive: true, force: true });
    await rm(path, { recursive: true, force: true });
    await rm(socketPathFor('test-skill-usage'), { force: true });
  });

  const reported = await (async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (platform.usage.length) return platform.usage[0];
      await new Promise((wake) => setTimeout(wake, 150));
    }
    return null;
  })();

  // Input counts cache creation, which is what `usage.mjs` sums — and the
  // numbers are absolute totals for the run, because the runner is the only
  // thing that knows where one child ended and the next began.
  assert.deepEqual(reported && { tokensIn: reported.tokensIn, tokensOut: reported.tokensOut },
    { tokensIn: 120, tokensOut: 7 });
});
