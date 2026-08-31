// node --test tools/runner/control.test.mjs
//
// The socket protocol, on a real socket. What matters here is what somebody
// sees when they attach to a machine that has been working for an hour: the
// snapshot has to arrive first, and the backlog has to be there — a blank pane
// until the agent next speaks is the failure this whole thing exists to avoid.

import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { serveControl, socketPathFor } from './control.mjs';

/** A client that hands back messages one at a time, in order. */
function talk(path) {
  const socket = connect(path);
  socket.setEncoding('utf8');
  const queue = [];
  const waiting = [];
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const next = waiting.shift();
      if (next) next(message);
      else queue.push(message);
    }
  });
  return {
    socket,
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise((done) => waiting.push(done)),
    send: (message) => socket.write(`${JSON.stringify(message)}\n`),
    close: () => socket.destroy(),
  };
}

const RUNNER = { id: 'r-1', name: 'test-runner-r52', url: 'http://localhost:8091', projects: ['board'], maxSessions: 4 };

async function serving(runs = []) {
  await rm(socketPathFor(RUNNER.name), { force: true });
  return serveControl({ runner: RUNNER, snapshot: () => runs });
}

test('attaching says what this machine is doing, before anything else', async () => {
  const runs = [
    { id: 'run-1', state: 'running', projectSlug: 'board', label: 'R51' },
    { id: 'run-2', state: 'queued', projectSlug: 'board', label: 'R52', why: 'board already has a run here' },
  ];
  const control = await serving(runs);
  const client = talk(control.path);
  try {
    const hello = await client.next();
    assert.equal(hello.type, 'hello');
    assert.equal(hello.runner.name, RUNNER.name);
    assert.equal(hello.runs.length, 2);
    // The reason a run is queued exists nowhere but here, and is the whole
    // argument for a local socket.
    assert.equal(hello.runs[1].why, 'board already has a run here');
  } finally {
    client.close();
    await control.close();
  }
});

test('a session that started an hour ago still has a backlog', async () => {
  const control = await serving();
  const client = talk(control.path);
  try {
    await client.next(); // hello

    // Published before this client asked for it — which is the case that
    // matters: somebody attaches to work already in progress.
    control.publish({ type: 'output', runId: 'run-1', line: { kind: 'ASSISTANT', body: 'first' } });
    control.publish({ type: 'output', runId: 'run-1', line: { kind: 'ASSISTANT', body: 'second' } });
    await client.next();
    await client.next();

    client.send({ type: 'backlog', runId: 'run-1' });
    const backlog = await client.next();
    assert.equal(backlog.type, 'backlog');
    assert.deepEqual(backlog.lines.map((line) => line.body), ['first', 'second']);
  } finally {
    client.close();
    await control.close();
  }
});

test('the backlog is bounded, and keeps the newest', async () => {
  const control = await serving();
  const client = talk(control.path);
  try {
    await client.next();
    for (let i = 0; i < 4200; i++) {
      control.publish({ type: 'output', runId: 'run-1', line: { kind: 'ASSISTANT', body: `line ${i}` } });
    }
    // Drain the broadcasts before asking.
    for (let i = 0; i < 4200; i++) await client.next();

    client.send({ type: 'backlog', runId: 'run-1' });
    const backlog = await client.next();
    assert.equal(backlog.lines.length, 4000);
    assert.equal(backlog.lines.at(-1).body, 'line 4199');
  } finally {
    client.close();
    await control.close();
  }
});

test('a finished run stops costing memory', async () => {
  const control = await serving();
  const client = talk(control.path);
  try {
    await client.next();
    control.publish({ type: 'output', runId: 'run-1', line: { kind: 'ASSISTANT', body: 'hello' } });
    await client.next();

    control.forget('run-1');
    client.send({ type: 'backlog', runId: 'run-1' });
    assert.deepEqual((await client.next()).lines, []);
  } finally {
    client.close();
    await control.close();
  }
});

test('the socket is a read-only view: an unknown command changes nothing', async () => {
  const control = await serving([{ id: 'run-1', state: 'running', label: 'R51' }]);
  const client = talk(control.path);
  try {
    await client.next();
    // Nothing here can cancel, prompt or approve — those refuse a token, so a
    // socket that could do them would be a way around a guard built on purpose.
    client.send({ type: 'cancel', runId: 'run-1' });
    client.send({ type: 'ping' });
    assert.equal((await client.next()).type, 'pong', 'the unknown command was ignored, not obeyed');
  } finally {
    client.close();
    await control.close();
  }
});

test('closing takes the socket file with it', async () => {
  const control = await serving();
  await control.close();
  // A file left behind is what makes the next attach report a machine that is
  // not there.
  await assert.rejects(() => new Promise((done, fail) => {
    const socket = connect(control.path);
    socket.on('connect', () => {
      socket.destroy();
      done();
    });
    socket.on('error', fail);
  }));
});
