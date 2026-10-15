// node --test tools/runner/daemon-boot.test.mjs
//
// The daemon's first ten seconds, against a platform that is not there.
//
// This is the path nobody could exercise before: registering needs a
// `runner:operate` token, so "does the daemon still start" was a question
// answered by reading. It is also where R51 and R52 both added work — the
// permission-flag probe, and the control socket — and a mistake in either is
// silent until somebody wants it most.
//
// The platform is faked and the agent command is `echo`, so this costs nothing
// and touches no real project.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { socketPathFor } from './control.mjs';
import { fakePlatform } from './test-platform.mjs';

const RUNNER = 'test-daemon-boot-r52';
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

/**
 * Reads the first message a client is sent, or gives up.
 *
 * Retries the connect, because a daemon that is still starting has no socket
 * yet and ENOENT here would only be measuring how fast this machine is.
 */
async function firstMessage(path, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      return await new Promise((done, fail) => {
        const socket = connect(path);
        const clock = setTimeout(() => {
          socket.destroy();
          fail(new Error('connected, but nothing arrived'));
        }, 2000);
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
          buffer += chunk;
          const newline = buffer.indexOf('\n');
          if (newline !== -1) {
            clearTimeout(clock);
            socket.destroy();
            done(JSON.parse(buffer.slice(0, newline)));
          }
        });
        socket.on('error', (failure) => {
          clearTimeout(clock);
          fail(failure);
        });
      });
    } catch (failure) {
      last = failure;
      await new Promise((done) => setTimeout(done, 150));
    }
  }
  throw last ?? new Error('nothing arrived on the socket');
}

test('the daemon registers, offers a socket, and says what it is', async (t) => {
  const platform = await fakePlatform();
  const directory = await mkdtemp(join(tmpdir(), 'cawdev-boot-'));
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name: RUNNER,
    // `echo` stands in for the agent CLI. The permission-flag probe runs
    // against it and must not warn: echo accepts anything, which is exactly
    // the "flag is fine" case.
    agentCommand: '/bin/echo',
    grantable: ['Bash(mvn *)'],
    projects: { board: directory },
  }));

  await rm(socketPathFor(RUNNER), { force: true });

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
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(socketPathFor(RUNNER), { force: true });
  });

  const hello = await firstMessage(socketPathFor(RUNNER));

  assert.equal(hello.type, 'hello');
  assert.equal(hello.runner.name, RUNNER);
  assert.deepEqual(hello.runner.projects, ['board']);
  // R109: `maxSessions` is gone from what a machine reports. The
  // workspace counts are what it declares about concurrency now.
  assert.equal(hello.runner.maxSessions, undefined);
  // Nothing claimed yet, and saying so is not the same as saying nothing.
  assert.deepEqual(hello.runs, []);

  assert.match(said, /registered as/);
  assert.match(said, /stored rules may cover: Bash\(mvn \*\)/);
  // The probe passed quietly. A warning here would mean the CLI it was pointed
  // at does not take --permission-prompt-tool, which is R51's whole mechanism.
  assert.doesNotMatch(said, /does not accept --permission-prompt-tool/);

  assert.ok(platform.seen.includes('POST /api/runners'), platform.seen.join(', '));
  assert.ok(platform.seen.some((call) => call.includes('heartbeat')), platform.seen.join(', '));
});

test('the daemon reports its own version, and refuses to boot below the platform\'s minimum — R283', async (t) => {
  const platform = await fakePlatform({ health: { version: '9.9.9', minimumCliVersion: '999.0.0' } });
  const directory = await mkdtemp(join(tmpdir(), 'cawdev-boot-'));
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name: `${RUNNER}-min`,
    agentCommand: '/bin/echo',
    projects: { board: directory },
  }));

  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  daemon.stdout.on('data', (chunk) => (said += chunk));
  daemon.stderr.on('data', (chunk) => (said += chunk));

  const [code] = await once(daemon, 'exit');

  t.after(async () => {
    platform.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(socketPathFor(`${RUNNER}-min`), { force: true });
  });

  assert.notEqual(code, 0, 'a CLI below the declared minimum must not start driving runs');
  assert.match(said, /requires at least 999\.0\.0/);
  // Never registered — a refused boot must not have already claimed anything.
  assert.ok(!platform.seen.includes('POST /api/runners'), platform.seen.join(', '));
});

test('the version is sent on registration when nothing refuses it', async (t) => {
  const platform = await fakePlatform({ health: { version: '0.9.0' } });
  const directory = await mkdtemp(join(tmpdir(), 'cawdev-boot-'));
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name: `${RUNNER}-ver`,
    agentCommand: '/bin/echo',
    projects: { board: directory },
  }));

  await rm(socketPathFor(`${RUNNER}-ver`), { force: true });
  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    daemon.kill('SIGKILL');
    platform.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(socketPathFor(`${RUNNER}-ver`), { force: true });
  });

  await firstMessage(socketPathFor(`${RUNNER}-ver`));
  assert.match(platform.registrations[0].cliVersion, /^\d+\.\d+\.\d+/);
});

test('SIGHUP re-reads acceptsRulesFromConsole and agentCommands without a restart — R283', async (t) => {
  const platform = await fakePlatform();
  const directory = await mkdtemp(join(tmpdir(), 'cawdev-boot-'));
  const config = join(directory, 'config.json');
  const written = {
    url: platform.url,
    name: `${RUNNER}-hup`,
    agentCommand: '/bin/echo',
    projects: { board: directory },
    acceptsRulesFromConsole: false,
    // Fast enough that a test does not wait out a real 30s interval.
    heartbeatSeconds: 1,
  };
  await writeFile(config, JSON.stringify(written));

  await rm(socketPathFor(`${RUNNER}-hup`), { force: true });
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
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(socketPathFor(`${RUNNER}-hup`), { force: true });
  });

  await firstMessage(socketPathFor(`${RUNNER}-hup`));
  assert.equal(platform.heartbeats.at(-1)?.acceptsConsoleRules, false);

  // The operator edits the file this daemon booted from, the way
  // `cawdev config rules on` does, and signals it — no restart.
  await writeFile(config, JSON.stringify({
    ...written, acceptsRulesFromConsole: true, agentCommands: ['claude', 'agy'],
  }));
  daemon.kill('SIGHUP');

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && platform.heartbeats.at(-1)?.acceptsConsoleRules !== true) {
    await new Promise((done) => setTimeout(done, 150));
  }

  assert.equal(platform.heartbeats.at(-1)?.acceptsConsoleRules, true);
  assert.match(said, /re-read .* on SIGHUP — applied: agentCommands, acceptsRulesFromConsole/);
  assert.doesNotMatch(said, /needs restart/, 'both keys are hot-swappable');

  // R294: the hello says so too, and nothing needs a restart.
  const hello = await firstMessage(socketPathFor(`${RUNNER}-hup`));
  assert.deepEqual(hello.runner.restartNeeded, []);
  assert.ok(hello.runner.configReadAt, 'when the file was last read, for a door that signalled');
});

test('a project added to the file is "needs restart" on the hello, off the mtime with no signal — R294', async (t) => {
  const platform = await fakePlatform();
  const directory = await mkdtemp(join(tmpdir(), 'cawdev-boot-'));
  const config = join(directory, 'config.json');
  const written = {
    url: platform.url,
    name: `${RUNNER}-stale`,
    agentCommand: '/bin/echo',
    projects: { board: directory },
    heartbeatSeconds: 1,
  };
  await writeFile(config, JSON.stringify(written));

  await rm(socketPathFor(`${RUNNER}-stale`), { force: true });
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
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(socketPathFor(`${RUNNER}-stale`), { force: true });
  });

  const booted = await firstMessage(socketPathFor(`${RUNNER}-stale`));
  assert.deepEqual(booted.runner.restartNeeded, []);

  // A client that stays attached, to see the daemon push its re-read hello.
  const pushed = [];
  const watcher = connect(socketPathFor(`${RUNNER}-stale`));
  watcher.setEncoding('utf8');
  let buffer = '';
  watcher.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      pushed.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
  });
  t.after(() => watcher.destroy());

  // Somebody edits the file by hand: a second project, and the agent list —
  // one the daemon can take, one it cannot. Nobody signals it.
  await new Promise((done) => setTimeout(done, 1100)); // mtime resolution on some filesystems is a second
  await writeFile(config, JSON.stringify({
    ...written, projects: { ...written.projects, other: directory }, agentCommands: ['/bin/echo', 'claude'],
  }));

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !pushed.some((event) => event.type === 'runner')) {
    await new Promise((done) => setTimeout(done, 150));
  }
  const event = pushed.find((each) => each.type === 'runner');
  assert.ok(event, 'the daemon told the attached client');
  assert.deepEqual(event.runner.restartNeeded, ['projects']);
  assert.deepEqual(event.runner.agents, ['/bin/echo', 'claude'], 'the hot-swappable half was applied');
  assert.notEqual(event.runner.configReadAt, booted.runner.configReadAt);
  assert.match(said, /re-read .* on edit — applied: agentCommands; needs restart: projects/);

  // A fresh attach reads the same thing off its hello.
  const again = await firstMessage(socketPathFor(`${RUNNER}-stale`));
  assert.deepEqual(again.runner.restartNeeded, ['projects']);

  // Reverted by hand: compared against what was BOOTED, so the notice clears.
  await new Promise((done) => setTimeout(done, 1100));
  await writeFile(config, JSON.stringify(written));
  const cleared = Date.now() + 8000;
  while (Date.now() < cleared && (await firstMessage(socketPathFor(`${RUNNER}-stale`))).runner.restartNeeded.length) {
    await new Promise((done) => setTimeout(done, 150));
  }
  assert.deepEqual((await firstMessage(socketPathFor(`${RUNNER}-stale`))).runner.restartNeeded, []);
});

test('--attach starts the machine and shows it, in one terminal', async (t) => {
  const platform = await fakePlatform();
  const directory = await mkdtemp(join(tmpdir(), 'cawdev-boot-'));
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name: `${RUNNER}-3`,
    agentCommand: '/bin/echo',
    projects: { board: directory },
  }));

  const both = spawn(process.execPath, [DAEMON, '--config', config, '--attach', '--watch-only'], {
    env: platform.env(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let drawn = '';
  both.stdout.on('data', (chunk) => (drawn += chunk));

  t.after(async () => {
    both.kill('SIGKILL');
    platform.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(socketPathFor(`${RUNNER}-3`), { force: true });
  });

  await new Promise((done) => setTimeout(done, 2500));
  const plain = drawn.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

  // R81: the footer is what proves the UI drew. The rail of runs it used to
  // look for is gone — it cost width on every line of every transcript to
  // answer a question asked a few times an hour, and `L` answers it now.
  assert.match(plain, /sessions \d/, 'the UI never drew its footer');
  assert.match(plain, new RegExp(`${RUNNER}-3`), 'the UI did not name the runner it started');
  // The daemon's log must NOT be on the terminal: it would land in the middle
  // of a transcript, and `g` prints it instead when it is wanted.
  assert.doesNotMatch(plain, /registered as/, "the daemon's log leaked onto the UI's terminal");
  // Legible through a pipe — R81's last "done when". Nothing is pinned here
  // because there is nothing to pin to and no keyboard to offer keys for, so
  // what has to survive is the fixed half: which cawdev, what it serves, and
  // how full it is. The key list is not in this list on purpose.
  assert.match(plain, new RegExp(platform.url.replace(/[.]/g, '\\.')), 'which cawdev');
  assert.match(plain, /board 0\/1/, 'what it serves, and how full');
  // And the whole point of R81: the alternate screen is never entered, because
  // entering it is what took the terminal's scroll, wheel, search and copy
  // away. If this ever matches again, the transcript has stopped being the
  // terminal's own scrollback.
  assert.doesNotMatch(drawn, /\x1b\[\?1049h/, 'the client took the alternate screen');
});

test('a claimed run actually spawns', async (t) => {
  // The gap that let R51 ship a spawn that could not run. Nothing exercised
  // spawnAgent, so `ceiling` being read above its own declaration — a
  // ReferenceError on every single coding run — passed every test there was.
  //
  // An ASK profile, because it prepares no working copy and so needs no git
  // remote, and it reaches spawnAgent by exactly the same path.
  const platform = await fakePlatform({
    offers: [{
      id: 'run-ask-1',
      projectSlug: 'board',
      label: 'what is R12 about?',
      branch: null,
      profile: 'ASK',
    }],
  });
  const directory = await mkdtemp(join(tmpdir(), 'cawdev-boot-'));
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name: `${RUNNER}-4`,
    agentCommand: '/bin/echo',
    grantable: ['Bash(mvn *)'],
    projects: { board: directory },
    pollSeconds: 1,
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
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(socketPathFor(`${RUNNER}-4`), { force: true });
  });

  await platform.until((transitions) => transitions.length > 0);
  // And then for the line itself. RUNNING is posted before `spawnAgent` logs
  // the spawn, so asserting straight after the transition is a race that a
  // fast machine always wins and CI does not.
  for (let waited = 0; waited < 200 && !/spawning: \/bin\/echo/.test(said); waited++) {
    await new Promise((wake) => setTimeout(wake, 100));
  }

  const failed = platform.transitions.find((each) => each.state === 'FAILED');
  assert.equal(
    failed,
    undefined,
    `the run failed instead of spawning: ${failed?.summary ?? ''}\n${said}`,
  );
  assert.ok(
    platform.transitions.some((each) => each.state === 'RUNNING'),
    `the run never started: ${said}`,
  );
  assert.match(said, /spawning: \/bin\/echo/);

  // And the session was given THIS daemon's MCP server, not whatever happens
  // to be in the checkout.
  //
  // cawdev is its own first project, so a run working on it checks the
  // daemon's own directory out onto another branch — and a session was handed
  // a server from `main` with no `approve` tool while holding a
  // --permission-prompt-tool flag naming it. It died on its first tool call.
  const frozen = /MCP server frozen at (\S+)/.exec(said);
  assert.ok(frozen, `the MCP server was not frozen at startup: ${said}`);
  assert.ok(
    frozen[1].startsWith(tmpdir()) || frozen[1].startsWith('/private'),
    `frozen outside a temp directory, so a branch switch can still reach it: ${frozen[1]}`,
  );
  assert.match(
    await readFile(frozen[1], 'utf8'),
    /name: 'approve'/,
    'the frozen copy is not the version this daemon was started with',
  );
});

test('a daemon that stops takes its socket with it', async (t) => {
  const platform = await fakePlatform();
  const directory = await mkdtemp(join(tmpdir(), 'cawdev-boot-'));
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name: `${RUNNER}-2`,
    agentCommand: '/bin/echo',
    projects: { board: directory },
  }));

  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env(),
    stdio: 'ignore',
  });
  t.after(async () => {
    daemon.kill('SIGKILL');
    platform.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await firstMessage(socketPathFor(`${RUNNER}-2`));

  daemon.kill('SIGINT');
  await once(daemon, 'exit');

  // A file left behind is what makes the next attach report a machine that is
  // not there.
  await assert.rejects(() => firstMessage(socketPathFor(`${RUNNER}-2`), 1500));
});

test('a poll that returns after Ctrl-C claims nothing', async (t) => {
  // i247. The queue's long poll blocks for up to pollSeconds, and a Ctrl-C
  // during it flips `stopping` and begins the goodbye — bounded, not instant.
  // A poll that returned inside that window walked on to claim the run it
  // carried and handed an agent to a process that was about to exit.
  //
  // The fake platform answers the queue at once, so this one is hand-rolled:
  // it HOLDS the poll, and answers it with an offer only once the goodbye has
  // arrived — which is exactly the order a real platform can produce.
  const seen = [];
  let releasePoll = null;
  const polled = new Promise((done) => {
    releasePoll = done;
  });
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    seen.push(`${request.method} ${url.split('?')[0]}`);
    response.setHeader('content-type', 'application/json');
    if (url.endsWith('/api/runners') && request.method === 'POST') {
      return response.end(JSON.stringify({ id: 'runner-1', name: `${RUNNER}-3` }));
    }
    if (url.includes('/queue')) {
      // Held. Released by the goodbye below.
      releasePoll(response);
      return undefined;
    }
    if (url.endsWith('/goodbye')) {
      void polled.then((poll) => {
        poll.end(JSON.stringify([{
          run: { id: 'run-1', projectSlug: 'board', label: 'R1', branch: null, profile: 'ASK' },
          workspace: null,
          preferredWorkspace: null,
        }]));
        // Long enough for a claim to reach here if the daemon still makes one;
        // well inside the daemon's own two-second bound on the goodbye.
        setTimeout(() => response.end(JSON.stringify({})), 500);
      });
      return undefined;
    }
    request.resume();
    return response.end(JSON.stringify({}));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;

  const directory = await mkdtemp(join(tmpdir(), 'cawdev-boot-'));
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({
    url,
    name: `${RUNNER}-3`,
    agentCommand: '/bin/echo',
    projects: { board: directory },
  }));

  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: { ...process.env, CAWDEV_URL: url, CAWDEV_TOKEN: 'cawd_fake', CAWDEV_PROJECT: undefined, CAWDEV_GRANTABLE: undefined },
    stdio: 'ignore',
  });
  t.after(async () => {
    daemon.kill('SIGKILL');
    server.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await firstMessage(socketPathFor(`${RUNNER}-3`));
  await polled;

  daemon.kill('SIGINT');
  await once(daemon, 'exit');

  assert.ok(seen.some((line) => line.endsWith('/goodbye')), `never said goodbye: ${seen}`);
  assert.ok(
    !seen.some((line) => line.includes('/claim/')),
    `claimed a run after being told to stop: ${seen}`,
  );
});

test('R339: a daemon booting after one that died reports the runs it was driving, at once and by cause', async (t) => {
  const platform = await fakePlatform({ runLive: true });
  const directory = await mkdtemp(join(tmpdir(), 'cawdev-boot-'));
  const name = `${RUNNER}-restart`;
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: '/bin/echo',
    projects: { board: directory },
  }));
  // What the daemon before it left: one run, its writer a pid that is gone.
  const notes = join(directory, 'driving');
  const dead = spawn(process.execPath, ['-e', '']);
  await once(dead, 'exit');
  await mkdir(notes, { recursive: true });
  await writeFile(join(notes, 'runner-1.json'), JSON.stringify({
    pid: dead.pid,
    runs: [{ id: 'run-killed', projectSlug: 'board', childPid: null, command: null }],
  }));

  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: { ...platform.env(), CAWDEV_DRIVING_DIR: notes },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  daemon.stdout.on('data', (chunk) => (said += chunk));
  daemon.stderr.on('data', (chunk) => (said += chunk));
  t.after(async () => {
    daemon.kill('SIGKILL');
    platform.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(socketPathFor(name), { force: true });
  });

  await firstMessage(socketPathFor(name));
  const reported = platform.transitions.find((each) => each.runId === 'run-killed');
  assert.ok(reported, `no transition for the run it left behind:\n${said}`);
  assert.equal(reported.state, 'FAILED');
  assert.equal(reported.failureReason, 'DAEMON_RESTARTED');
  assert.match(reported.summary, new RegExp(`daemon on ${name} restarted`));
  assert.match(reported.summary, new RegExp(`pid ${dead.pid}`));

  // And the note is this daemon's now, with nothing in it.
  const note = JSON.parse(await readFile(join(notes, 'runner-1.json'), 'utf8'));
  assert.equal(note.pid, daemon.pid);
  assert.deepEqual(note.runs, []);
});
