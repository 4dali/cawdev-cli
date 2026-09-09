// node --test tools/runner/cawdev-command.test.mjs
//
// R81 — one word gets a working machine.
//
// The entry's first "done when": *typing `cawdev` on a machine with no daemon
// starts one and drops you into the UI.* That is the sentence tested here, end
// to end and for real — a fake platform, a config on disk, and the actual
// command, not a function pretending to be it.
//
// `CAWDEV_RUN_DIR` puts the socket somewhere the operator's own daemon is not,
// because "how many runners are on this machine" is the question this command
// now answers for you, and a test of that answer cannot share a directory with
// the answer's subject.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { daemonUrl, findConfig, isTheCommand, signInUrl } from './cawdev.mjs';

const CAWDEV = new URL('./cawdev.mjs', import.meta.url).pathname;

/** The environment a fresh machine has: no daemon anywhere this run can see. */
async function aCleanMachine() {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cmd-'));
  return {
    home,
    runDir: join(home, 'run'),
    async clean() {
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** The pid a daemon puts on its `hello` — R81, so a goodbye can name it. */
function daemonPid(socketPath) {
  return new Promise((done) => {
    const client = connect(socketPath);
    const give = (pid) => {
      try {
        client.destroy();
      } catch {
        // Going anyway.
      }
      done(pid);
    };
    client.setEncoding('utf8');
    client.on('error', () => give(null));
    client.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'hello') return give(event.runner?.pid ?? null);
        } catch {
          // Not ours to interpret.
        }
      }
      return undefined;
    });
    setTimeout(() => give(null), 2000).unref?.();
  });
}

function waitFor(text, stream, within = 25_000) {
  return new Promise((done, fail) => {
    let seen = '';
    const timer = setTimeout(
      () => fail(new Error(`never said "${text}". Said:\n${seen}`)),
      within,
    );
    stream.on('data', (chunk) => {
      seen += chunk;
      if (seen.includes(text)) {
        clearTimeout(timer);
        done(seen);
      }
    });
  });
}

test('with no daemon anywhere, `cawdev` starts one and attaches to it', async (t) => {
  const platform = await fakePlatform();
  const machine = await aCleanMachine();
  const config = join(machine.home, 'runner.config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name: 'a-fresh-machine',
    agentCommand: '/bin/echo',
    projects: { board: machine.home },
  }));

  const cawdev = spawn(process.execPath, [CAWDEV, '--config', config, '--watch-only'], {
    env: {
      ...process.env,
      HOME: machine.home,
      CAWDEV_RUN_DIR: machine.runDir,
      CAWDEV_TOKEN: 'cawd_fake',
      // The daemon reads these from the environment before the file, so a
      // developer's own shell would otherwise point the test at their cawdev.
      CAWDEV_URL: platform.url,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  cawdev.stderr.on('data', (chunk) => (stderr += chunk));

  t.after(async () => {
    cawdev.kill('SIGKILL');
    // The daemon it started is DETACHED and outlives this process on purpose —
    // that is the behaviour under test, and it is why the goodbye names a pid.
    // So the test uses the same pid to clean up: if this ever stops working,
    // the sentence somebody reads on the way out has stopped being true.
    const pid = await daemonPid(join(machine.runDir, 'a-fresh-machine.sock'));
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    platform.close();
    await machine.clean();
  });

  // The runner's NAME is the proof, and it only appears once the socket has
  // said hello — so waiting for it is waiting for the whole loop: daemon
  // spawned, socket offered, client attached.
  const said = await waitFor('a-fresh-machine', cawdev.stdout);

  assert.match(said, /No runner here yet — starting one/, 'it did not say what it was doing');
  assert.match(said, new RegExp(platform.url.replace(/[.]/g, '\\.')), 'the UI never named the platform');
  assert.match(said, /sessions \d/, 'the UI never drew its footer');
  assert.equal(stderr, '', stderr);

  const sockets = await readdir(machine.runDir);
  assert.deepEqual(sockets, ['a-fresh-machine.sock'], 'the daemon never offered a socket');

  // And it is a real one: the daemon registered with the platform, which is
  // the difference between "a process started" and "a machine is working".
  assert.ok(platform.seen.includes('POST /api/runners'), platform.seen.join(', '));
});

test('a machine with no config is set up rather than told to write one', async (t) => {
  const platform = await fakePlatform();
  const machine = await aCleanMachine();

  // No config anywhere, and no token in the environment: R93's trigger, and the
  // only case that runs the walk by itself.
  const cawdev = spawn(process.execPath, [CAWDEV, '--url', platform.url], {
    env: {
      ...process.env,
      HOME: machine.home,
      CAWDEV_RUN_DIR: machine.runDir,
      CAWDEV_TOKEN: undefined,
      CAWDEV_URL: undefined,
      CAWDEV_RUNNER_CONFIG: undefined,
      // The walk opens a browser, and a test machine should not sprout tabs.
      BROWSER: '/usr/bin/true',
    },
    cwd: machine.home,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(async () => {
    cawdev.kill('SIGKILL');
    platform.close();
    await machine.clean();
  });

  const said = await waitFor('ABCD-1234', cawdev.stdout, 15_000);

  // The old behaviour was to start a daemon that could not boot and then print
  // `readConfig`'s complaint out of a log file. This is the sentence that
  // replaced it.
  assert.match(said, /Setting up this machine/);
  assert.match(said, /Approve this sign-in at/);
  assert.doesNotMatch(said, /did not start/, 'it still tried to boot an unconfigured daemon');

  const sockets = await readdir(machine.runDir).catch(() => []);
  assert.deepEqual(sockets, [], 'a daemon was started before the machine was configured');
});

test('--no-start refuses rather than launching something nobody asked for', async (t) => {
  const machine = await aCleanMachine();
  t.after(() => machine.clean());

  const cawdev = spawn(process.execPath, [CAWDEV, '--no-start', '--watch-only'], {
    env: { ...process.env, HOME: machine.home, CAWDEV_RUN_DIR: machine.runDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  cawdev.stderr.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise((done) => cawdev.on('exit', done));

  assert.equal(code, 1);
  assert.match(stderr, /No runner is answering on this machine/);
  assert.deepEqual(await readdir(machine.runDir).catch(() => []), []);
});

test('a runner named by hand is never started for you', async (t) => {
  // Naming one is a claim that it is there. Launching a DIFFERENT daemon under
  // that name because the first was not answering is not the request.
  const machine = await aCleanMachine();
  t.after(() => machine.clean());

  const cawdev = spawn(process.execPath, [CAWDEV, '--runner', 'not-here', '--watch-only'], {
    env: { ...process.env, HOME: machine.home, CAWDEV_RUN_DIR: machine.runDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  cawdev.stderr.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise((done) => cawdev.on('exit', done));

  assert.equal(code, 1);
  assert.match(stderr, /No runner called "not-here" is answering/);
});

test('--help is the whole interface on one screen', async () => {
  const cawdev = spawn(process.execPath, [CAWDEV, '--help'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let said = '';
  cawdev.stdout.on('data', (chunk) => (said += chunk));
  await new Promise((done) => cawdev.on('exit', done));

  assert.match(said, /cawdev\s+attach to the runner here/);
  assert.match(said, /--runner/);
  assert.match(said, /L lists the runs/);
  // The one thing somebody has to be told, because it is the destructive half
  // of one key — R123 turned "the runner keeps going" into "q stops it", and
  // help that still promised the old one would be worse than saying nothing.
  assert.match(said, /q stops the machine/);
  assert.match(said, /--leave-running/);
});

// --- where a config comes from -----------------------------------------------

test('the config is looked for where somebody would expect it, in that order', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-conf-'));
  const here = await mkdtemp(join(tmpdir(), 'cawdev-cwd-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(here, { recursive: true, force: true });
  });

  // What they just typed wins, and is not checked for existence — a named file
  // that is not there should fail saying so, not fall back to another one.
  assert.equal(
    await findConfig(['--config', 'typed.json'], {}, here),
    join(here, 'typed.json'),
  );

  // Then the environment, then the directory they are standing in.
  await writeFile(join(here, 'runner.config.json'), '{}');
  assert.equal(await findConfig([], {}, here), join(here, 'runner.config.json'));

  const named = join(home, 'elsewhere.json');
  await writeFile(named, '{}');
  assert.equal(await findConfig([], { CAWDEV_RUNNER_CONFIG: named }, here), named);
});

test('no config anywhere is not an error here — the daemon decides that', async (t) => {
  // `readConfig` already refuses to start without a token or a project, naming
  // what is missing. A second copy of that judgement here would be a second
  // place for it to drift, and this one knows less.
  const empty = await mkdtemp(join(tmpdir(), 'cawdev-none-'));
  t.after(() => rm(empty, { recursive: true, force: true }));

  assert.equal(await findConfig([], { HOME: empty }, empty), null);
});

// --- installed, it has to actually run -----------------------------------------

test('the command runs when it is reached through the symlink npm installs', async (t) => {
  // The defect this pins: `npm i -g` installs a bin as a LINK, so argv[1] is
  // `…/bin/cawdev` and import.meta.url is its target. Comparing the two
  // lexically is never equal — `main()` never ran, and the installed command
  // exited 0 having printed nothing at all. Every test and every hand check
  // had typed the path, which is the one way it worked.
  const home = await mkdtemp(join(tmpdir(), 'cawdev-bin-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const link = join(home, 'cawdev');
  await symlink(CAWDEV, link);

  const said = await new Promise((done) => {
    const child = spawn(process.execPath, [link, '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('exit', () => done(out));
  });

  assert.match(said, /cawdev --url/, 'the link ran the command, not nothing at all');
});

test('the rule itself: a link and its target are the same file', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-link-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const link = join(home, 'cawdev');
  await symlink(CAWDEV, link);

  const url = new URL('./cawdev.mjs', import.meta.url).href;
  assert.equal(isTheCommand(link, url), true, 'through the link');
  assert.equal(isTheCommand(CAWDEV, url), true, 'named directly');
  assert.equal(isTheCommand(join(home, 'something-else'), url), false);
  assert.equal(isTheCommand(undefined, url), false, 'imported, not run');
});

// --- the two URLs -------------------------------------------------------------
//
// Signing in and being addressed are different questions, and conflating them
// minted a token at `:4200`, filed it under `:4200`, and left the daemon looking
// under `:8091` where the config had named it. A live credential on the tokens
// page that nothing would ever read, and a command that reported success and
// then failed one line later.

test('--url moves where you sign in, and never what this machine is called', () => {
  const file = { url: 'http://localhost:8091', name: 'laptop', projects: { board: '/code/board' } };
  const argv = ['--url', 'http://localhost:4200'];

  assert.equal(signInUrl(file, argv, {}), 'http://localhost:4200',
    'the console is where a browser can actually show a sign-in page');
  assert.equal(daemonUrl(file, {}), 'http://localhost:8091',
    '--url renamed the machine, so the token went somewhere the daemon never looks');
});

test('the daemon key follows the daemon: CAWDEV_URL, then the config, then the default', () => {
  const file = { url: 'http://localhost:8091' };

  assert.equal(daemonUrl(file, { CAWDEV_URL: 'https://elsewhere.example' }),
    'https://elsewhere.example');
  assert.equal(daemonUrl(file, {}), 'http://localhost:8091');
  // The CONSOLE's origin, not the API's — one origin is the constraint, `:8091`
  // does not exist outside development, and both the session and the token are
  // filed under this string. A config naming the API directly still wins.
  assert.equal(daemonUrl(null, {}), 'http://localhost:4200', 'the default drifted');
  assert.equal(daemonUrl({ url: 'https://cawdev.example/' }, {}), 'https://cawdev.example',
    'a trailing slash would file the token under a second name for one instance');
});

test('with no config, both questions have the same answer', () => {
  // The walk's case. Nothing has named this machine yet, so there is nothing
  // for `--url` to disagree with.
  const argv = ['--url', 'https://cawdev.example'];
  assert.equal(signInUrl(null, argv, {}), 'https://cawdev.example');
  assert.equal(daemonUrl(null, { CAWDEV_URL: 'https://cawdev.example' }), 'https://cawdev.example');
});

test('the default URL is the same string in all three places that hold one', async () => {
  // `cawdev.mjs` keeps its own copy on purpose — importing the daemon's
  // `DEFAULTS` would run a module that starts a daemon, and `urlFrom` folds in
  // `--url`, which is the one thing `daemonUrl` must not see. So the drift is
  // pinned here instead.
  const read = async (name) => readFile(new URL(`./${name}`, import.meta.url).pathname, 'utf8');

  const found = new Set();
  for (const [name, pattern] of [
    ['runner.mjs', /^ {2}url: '([^']+)',$/m],
    ['attach.mjs', /valueOf\(argv, '--url'\) \?\? process\.env\.CAWDEV_URL \?\? '([^']+)'/],
    ['cawdev.mjs', /^const DEFAULT_URL = '([^']+)';$/m],
  ]) {
    const match = (await read(name)).match(pattern);
    assert.ok(match, `${name} no longer states a default URL where this test looks`);
    found.add(match[1]);
  }

  assert.equal(found.size, 1, `three defaults, ${found.size} values: ${[...found].join(', ')}`);
});
