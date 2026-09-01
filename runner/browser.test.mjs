// node --test tools/runner/browser.test.mjs
//
// R61's half that does not live in the platform: whether the machine allows a
// run to reach the browser.
//
// `--chrome` connects the session to the extension in the operator's OWN
// Chrome — their logged-in sessions, their cookies, their mail. So the platform
// records what was asked for and the machine decides whether it happens, which
// is R51's asymmetry pointed at a browser. What is tested here is that the
// machine's answer is the one that counts, in both directions, and that a
// refusal reaches the person rather than being a silent no.
//
// The agent is `/bin/echo`, so the argv it was spawned with is the whole of
// what we need to see: `--chrome` present or absent.

import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-browser-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

/**
 * @param wants what the RUN asked for — the platform's half.
 * @param allows what the MACHINE permits — the config's half. `undefined`
 *   leaves it out entirely, which is what every config written before R61
 *   looks like and must keep meaning "no".
 */
async function daemonWith(t, { name, wants, allows, perProject }) {
  const path = await aRepository();
  const platform = await fakePlatform({
    offers: [{
      id: 'run-browser',
      projectSlug: 'board',
      label: 'a card',
      branch: 'r61-work',
      profile: 'CODE',
      browser: wants,
    }],
  });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    // `echo` prints its arguments, so the transcript IS the argv.
    agentCommand: '/bin/echo',
    pollSeconds: 1,
    ...(allows === undefined ? {} : { browser: allows }),
    projects: {
      board: perProject === undefined
        ? path
        : { path, browser: perProject },
    },
  }));

  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: { ...process.env, CAWDEV_TOKEN: 'cawd_fake' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  daemon.stdout.on('data', (chunk) => (said += chunk));
  daemon.stderr.on('data', (chunk) => (said += chunk));

  t.after(async () => {
    daemon.kill('SIGKILL');
    platform.close();
    await rm(home, { recursive: true, force: true });
    await rm(path, { recursive: true, force: true });
    await rm(socketPathFor(name), { force: true });
  });

  await platform.until((transitions) => transitions.some((each) => each.state === 'RUNNING'));
  return { platform, said: () => said };
}

/** The daemon logs the whole spawn line, which is where --chrome shows up. */
function spawnedWithChrome(said) {
  const line = said.split('\n').find((each) => each.includes('spawning:'));
  assert.ok(line, `nothing was spawned:\n${said}`);
  return line.includes('--chrome');
}

test('the run asks and the machine allows: the session gets a browser', async (t) => {
  const { said } = await daemonWith(t, { name: 'test-browser-yes', wants: true, allows: true });
  assert.equal(spawnedWithChrome(said()), true, said());
  // And it is said out loud, so whoever is watching knows what the session can
  // reach — and that the first call will still ask.
  assert.match(said(), /Claude in Chrome is available/);
});

test('the run asks and the machine does not: it runs anyway, and says why', async (t) => {
  const { platform, said } = await daemonWith(t, {
    name: 'test-browser-no',
    wants: true,
    allows: false,
  });

  assert.equal(spawnedWithChrome(said()), false, said());
  // NOT failed. A capability withheld and a broken run are different things,
  // and failing here would throw away work over something the session may not
  // even have needed.
  assert.deepEqual(platform.transitions.filter((each) => each.state === 'FAILED'), []);
  assert.match(said(), /does not allow it/);
});

test('a config that never heard of R61 means no, and keeps meaning it', async (t) => {
  // The upgrade path. Every runner config written before this entry omits the
  // key, and must not start handing sessions a browser because the daemon was
  // updated.
  const { said } = await daemonWith(t, {
    name: 'test-browser-absent',
    wants: true,
    allows: undefined,
  });
  assert.equal(spawnedWithChrome(said()), false, said());
});

test('a machine that allows it can still refuse one project', async (t) => {
  const { said } = await daemonWith(t, {
    name: 'test-browser-project-no',
    wants: true,
    allows: true,
    perProject: false,
  });
  assert.equal(spawnedWithChrome(said()), false, said());
});

test('a run that did not ask gets none, however willing the machine is', async (t) => {
  const { said } = await daemonWith(t, {
    name: 'test-browser-unasked',
    wants: false,
    allows: true,
  });
  assert.equal(spawnedWithChrome(said()), false, said());
  // And nothing is said about it, because nothing was refused.
  assert.doesNotMatch(said(), /does not allow it/);
});
