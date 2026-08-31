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
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { socketPathFor } from './control.mjs';

const RUNNER = 'test-daemon-boot-r52';
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

/** Answers the handful of calls a daemon makes before it has any work. */
async function fakePlatform() {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url.split('?')[0]}`);
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      if (url.startsWith('/api/runners') && request.method === 'POST' && url.endsWith('/runners')) {
        return response.end(JSON.stringify({ id: 'runner-1', name: JSON.parse(body).name }));
      }
      if (url.includes('/queue')) {
        // No work, and the daemon should sit here quietly rather than spin.
        return response.end('[]');
      }
      response.end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

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
    env: { ...process.env, CAWDEV_TOKEN: 'cawd_fake' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  daemon.stdout.on('data', (chunk) => (said += chunk));
  daemon.stderr.on('data', (chunk) => (said += chunk));

  t.after(async () => {
    daemon.kill('SIGKILL');
    platform.close();
    await rm(directory, { recursive: true, force: true });
    await rm(socketPathFor(RUNNER), { force: true });
  });

  const hello = await firstMessage(socketPathFor(RUNNER));

  assert.equal(hello.type, 'hello');
  assert.equal(hello.runner.name, RUNNER);
  assert.deepEqual(hello.runner.projects, ['board']);
  assert.equal(hello.runner.maxSessions, 4);
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
    env: { ...process.env, CAWDEV_TOKEN: 'cawd_fake' },
    stdio: 'ignore',
  });
  t.after(async () => {
    daemon.kill('SIGKILL');
    platform.close();
    await rm(directory, { recursive: true, force: true });
  });

  await firstMessage(socketPathFor(`${RUNNER}-2`));

  daemon.kill('SIGINT');
  await once(daemon, 'exit');

  // A file left behind is what makes the next attach report a machine that is
  // not there.
  await assert.rejects(() => firstMessage(socketPathFor(`${RUNNER}-2`), 1500));
});
