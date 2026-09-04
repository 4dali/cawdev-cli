// The daemon's own view of itself, offered on a local socket — R52.
//
// Not an API. The platform already has one, and everything a browser needs
// goes there. What lives ONLY here is the machine's own knowledge:
//
//   - what it is driving right now, before any of it reaches the database;
//   - what it has claimed but not yet spawned;
//   - what it is leaving queued, AND WHY — "cawdev already has a run here",
//     "at 4 sessions". That reason exists nowhere else. The console can show
//     you four runs and no explanation for the fifth.
//   - the daemon's own log, and the agent's stderr.
//
// READ ONLY, deliberately. Nothing here changes anything, and no command can.
// Prompting, cancelling and deciding a permission request all refuse a token
// (R51), so a socket that could do them would either need the daemon's own
// credential — making the daemon a way around a guard that exists on purpose —
// or a person's, which does not belong in a daemon. The client signs in itself
// and acts over HTTPS like any other person.
//
// The consequence is worth stating plainly: **permission to read this socket is
// permission to read this machine's transcripts.** That is why it lives in a
// 0700 directory under the operator's home, and why it discloses only this
// machine's own work.

import { connect as connectTo, createServer } from 'node:net';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where a daemon puts its socket. 0700: the transcripts are in here.
 *
 * `CAWDEV_RUN_DIR` overrides it, and exists because R81 made "how many daemons
 * are on this machine" a question the `cawdev` command ANSWERS rather than one
 * a person answers for it — so a test of that answer has to be able to stand
 * somewhere the operator's own daemon is not.
 */
export function socketDirectory() {
  return process.env.CAWDEV_RUN_DIR ?? join(homedir(), '.cawdev', 'run');
}

/**
 * One socket per runner NAME, not per process.
 *
 * A name is what the operator chose and what the console shows, so
 * `attach --runner macbook-laptop` means the machine they are looking at. Two
 * daemons under one name would be a configuration mistake either way, and this
 * makes it a visible one: the second finds the first's socket alive.
 */
export function socketPathFor(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '-');
  return join(socketDirectory(), `${safe}.sock`);
}

/** Every daemon socket on this machine, live or left behind. */
export async function listSockets() {
  try {
    const names = await readdir(socketDirectory());
    return names
      .filter((name) => name.endsWith('.sock'))
      .map((name) => ({ name: name.slice(0, -'.sock'.length), path: join(socketDirectory(), name) }));
  } catch {
    return [];
  }
}

/**
 * Whether anything is actually listening on a socket — R81.
 *
 * A killed daemon leaves its file behind, and a stale socket is
 * indistinguishable from a live one until you try it. That did not matter while
 * attaching was something you did after starting a daemon by hand; it matters
 * now that `cawdev` decides whether to START one from what it finds here, and
 * a leftover file would make it attach to nothing for ever instead.
 */
export function probeSocket(path, timeoutMs = 750) {
  return new Promise((done) => {
    const client = connectTo(path);
    const settle = (alive) => {
      clearTimeout(timer);
      try {
        client.destroy();
      } catch {
        // Already gone.
      }
      done(alive);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    client.on('connect', () => settle(true));
    client.on('error', () => settle(false));
  });
}

/** Every socket on this machine that something is answering on. */
export async function liveSockets() {
  const found = await listSockets();
  const alive = [];
  for (const socket of found) {
    if (await probeSocket(socket.path)) {
      alive.push(socket);
    }
  }
  return alive;
}

/**
 * How many lines of each session's transcript are kept for somebody who
 * attaches later.
 *
 * Attaching to a run that started an hour ago and seeing a blank pane until the
 * agent next speaks is the whole reason this exists. Reading the history back
 * from the platform would work and would defeat the point of a local socket —
 * it has to be readable when the platform is not.
 */
const KEPT_LINES = 4000;

/**
 * Serves the socket, and returns the handle the daemon publishes through.
 *
 * `snapshot()` is called rather than passed, because the answer changes every
 * few seconds and a value captured at startup would be a lie by the first run.
 */
export async function serveControl({ runner, snapshot }) {
  await mkdir(socketDirectory(), { recursive: true, mode: 0o700 });

  const path = socketPathFor(runner.name);
  // A killed daemon leaves its socket behind, and a stale file is
  // indistinguishable from a live one until you try it. Connecting first would
  // be more correct and much slower to write; unlinking is what every daemon
  // that has ever done this does, and the failure it risks — stealing a live
  // daemon's socket — is already a misconfiguration (two daemons, one name).
  await unlink(path).catch(() => undefined);

  const clients = new Set();
  /** runId -> the last KEPT_LINES of its transcript. */
  const history = new Map();

  const write = (client, message) => {
    try {
      client.write(`${JSON.stringify(message)}\n`);
    } catch {
      // A client that has gone away is not this daemon's problem.
    }
  };

  const server = createServer((client) => {
    client.setEncoding('utf8');
    clients.add(client);
    client.on('error', () => clients.delete(client));
    client.on('close', () => clients.delete(client));

    write(client, { type: 'hello', runner, runs: snapshot() });

    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // Not ours to interpret.
        }
        // The only two things a client may ask for, and neither changes
        // anything: the backlog of one run, and proof we are still here.
        if (message.type === 'backlog') {
          write(client, {
            type: 'backlog',
            runId: message.runId,
            lines: history.get(message.runId) ?? [],
          });
        } else if (message.type === 'ping') {
          write(client, { type: 'pong' });
        }
      }
    });
  });

  server.on('error', () => {
    // A daemon that cannot offer a socket is still a daemon. Nothing here is
    // load-bearing for running an agent, and refusing to start over it would
    // trade the whole feature for one of its conveniences.
  });

  await new Promise((done) => server.listen(path, done));

  return {
    path,

    /** Broadcast, and keep what is worth keeping for whoever attaches next. */
    publish(event) {
      if (event.type === 'output' && event.runId) {
        const kept = history.get(event.runId) ?? [];
        kept.push(event.line);
        if (kept.length > KEPT_LINES) {
          kept.splice(0, kept.length - KEPT_LINES);
        }
        history.set(event.runId, kept);
      }
      for (const client of clients) {
        write(client, event);
      }
    },

    /** A run that is over stops costing memory. */
    forget(runId) {
      history.delete(runId);
    },

    async close() {
      for (const client of clients) {
        client.destroy();
      }
      clients.clear();
      await new Promise((done) => server.close(done));
      // Leaving this behind is what makes the NEXT attach report a daemon that
      // is not there.
      await unlink(path).catch(() => undefined);
    },
  };
}
