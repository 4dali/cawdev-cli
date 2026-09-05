// A cawdev that is not there, for testing the daemon.
//
// NOT production code and not loaded by anything that runs for real — it is
// imported by the runner's tests, which need a platform to register with and a
// queue to take work from. It lives beside them rather than inside one of them
// because two test files need the same fake, and two fakes drift.
//
// It answers only what the daemon actually calls, and records what it was told:
// the transitions are how a test knows a run started, where, and whether it
// failed.

import { createServer } from 'node:http';
import { once } from 'node:events';

/**
 * @param offers runs to hand over, each ONCE — the queue empties afterwards,
 *   so the daemon claims them and then goes quiet like a real one.
 * @param allowDirty what the claim says about starting on top of uncommitted
 *   work. R46's decision, and R57 is the half of it that had to work.
 * @param workspaceRequests handed over once, the way the real claim does.
 * @param resume what the claim says about continuing a conversation — R69.
 *   `{ agentSessionId, prompt }`, or null for an ordinary claim, which is what
 *   every claim before R69 is.
 * @param runLive whether a run reads as still going. False by default, which
 *   makes the daemon reap the child straight away; true for a test that needs
 *   the spawned session to stay up long enough to be looked at.
 * @param skills what the claim says this project has turned on — R76. What the
 *   PROJECT asked for: whether any of it is attached is the machine's answer,
 *   which is the thing under test.
 */
export async function fakePlatform({
  offers = [],
  allowDirty = false,
  workspaceRequests = [],
  resume = null,
  runLive = false,
  skills = [],
} = {}) {
  const seen = [];
  const transitions = [];
  const remaining = [...offers];
  const pending = [...workspaceRequests];
  /** What the daemon said it did, so a test can read the stash ref back. */
  const finishedRequests = [];
  /** Session ids the daemon reported off the CLI's `init` event — R69. */
  const sessionIds = [];
  /**
   * Transcript lines the daemon sent — R76.
   *
   * The run's own transcript is where a withheld capability has to be
   * explained, so a test about which side refused a skill has to read what
   * arrived HERE rather than only what the daemon printed. The two are the same
   * sentence, and only one of them a person will ever see.
   */
  const outputs = [];
  /** What the daemon said the session consumed — R76. */
  const usage = [];

  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url.split('?')[0]}`);
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });

      // R93. A machine with no config signs in before it does anything else,
      // so the fake has to be able to refuse a stored session and hand out a
      // code. Refusing is the interesting half: the catch-all below answers
      // `{}` to everything, and an `/api/auth/me` that answers 200 with no
      // email reads as somebody who is already signed in.
      if (url.endsWith('/api/auth/me')) {
        response.writeHead(401, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ message: 'not signed in' }));
      }
      if (url.endsWith('/api/auth/cli/start') && request.method === 'POST') {
        return response.end(JSON.stringify({
          code: 'ABCD-1234',
          secret: 'a-secret',
          verifyPath: '/login?cli=ABCD-1234',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }));
      }
      if (url.endsWith('/api/runners') && request.method === 'POST') {
        return response.end(JSON.stringify({ id: 'runner-1', name: JSON.parse(body).name }));
      }
      if (url.includes('/queue')) {
        // Everything still unclaimed, every time — a real queue re-offers a run
        // it has not given to anybody, and the daemon's own bookkeeping is what
        // stops it claiming the same one twice.
        return response.end(JSON.stringify(remaining.map((run) => ({ run }))));
      }
      if (url.includes('/claim/')) {
        const id = url.split('/claim/')[1];
        const at = remaining.findIndex((run) => run.id === id);
        if (at === -1) {
          // Somebody else got it. The daemon treats this as "not ours", which
          // is the normal outcome when two runners serve one project.
          response.writeHead(409, { 'content-type': 'application/json' });
          return response.end(JSON.stringify({ message: 'already claimed' }));
        }
        remaining.splice(at, 1);
        return response.end(JSON.stringify({
          runToken: 'cawdr_fake',
          defaultBranch: 'main',
          allowDirty,
          resume,
          skills,
        }));
      }
      if (url.endsWith('/session') && request.method === 'POST') {
        sessionIds.push({
          runId: url.split('/runs/')[1]?.split('/')[0],
          ...JSON.parse(body),
        });
        return response.end('{}');
      }
      if (url.endsWith('/tool-rules')) {
        // A list, because the real one answers with a list. The catch-all below
        // answers `{}`, which the daemon then reports as "could not read this
        // project's tool rules ((rules ?? []).map is not a function)" — a red
        // herring in the log of every test that spawns anything.
        return response.end('[]');
      }
      if (url.endsWith('/output') && request.method === 'POST') {
        for (const line of JSON.parse(body).lines ?? []) {
          outputs.push({ runId: url.split('/runs/')[1]?.split('/')[0], ...line });
        }
        return response.end('[]');
      }
      if (url.endsWith('/usage') && request.method === 'POST') {
        usage.push({ runId: url.split('/runs/')[1]?.split('/')[0], ...JSON.parse(body) });
        return response.end('{}');
      }
      if (url.endsWith('/actions/claim') && request.method === 'POST') {
        // A list, because the real one answers with a list. The catch-all below
        // answers `{}` to anything unrouted, and a stub that quietly hands an
        // object to a caller expecting an array tests the daemon's crash
        // handling instead of the behaviour the test came for.
        return response.end('[]');
      }
      if (url.endsWith('/workspace-requests/claim') && request.method === 'POST') {
        // Taken on read, like the real one: handed over once and then gone.
        const taken = pending.splice(0, pending.length);
        return response.end(JSON.stringify(taken));
      }
      if (url.endsWith('/finished') && url.includes('/workspace-requests/')) {
        finishedRequests.push({
          id: url.split('/workspace-requests/')[1].split('/')[0],
          ...JSON.parse(body),
        });
        return response.end('{}');
      }
      if (url.endsWith('/transition') && request.method === 'POST') {
        const transition = JSON.parse(body);
        transition.runId = url.split('/runs/')[1]?.split('/')[0];
        transitions.push(transition);
        return response.end('{}');
      }
      if (url.match(/\/runs\/[^/]+$/) && request.method === 'GET') {
        // Over by default, so the daemon does not try to finish a run somebody
        // else did — and so `reapCancelled` takes the child down promptly,
        // which is what a test wanting a quick exit relies on.
        //
        // `runLive` is for the tests that need the session to STAY UP long
        // enough to be looked at: reaping is indistinguishable from the agent
        // never having been spawned, and a test asserting on what the child did
        // has to outlive the reaper. R69's does.
        return response.end(JSON.stringify({ live: runLive, state: runLive ? 'RUNNING' : 'FINISHED' }));
      }
      response.end('{}');
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    /**
     * The environment to spawn the daemon with, and it is not `process.env`.
     *
     * **`CAWDEV_URL` and `CAWDEV_TOKEN` in the environment beat the config
     * file** — `readConfig` says so, deliberately, so a container can be
     * configured without a file. That makes a daemon spawned with the parent's
     * environment talk to whatever platform the PARENT was pointed at.
     *
     * Which is not hypothetical: cawdev is its own first project, so these
     * tests are usually run by a session that cawdev itself started — and that
     * session has `CAWDEV_URL` and a real `cawd_` token in its environment. The
     * whole suite then fails with "That token is not valid", which reads as a
     * broken daemon and is nothing of the kind.
     *
     * So the two are pinned at the fake, here, once, rather than in seven test
     * files that would each have to remember.
     */
    env(extra = {}) {
      return {
        ...process.env,
        CAWDEV_URL: url,
        CAWDEV_TOKEN: 'cawd_fake',
        // A run's own scoping, which a spawned session leaves in the
        // environment of anything it starts. Nothing under test wants it.
        CAWDEV_PROJECT: undefined,
        CAWDEV_GRANTABLE: undefined,
        ...extra,
      };
    },
    seen,
    transitions,
    finishedRequests,
    sessionIds,
    outputs,
    usage,
    /** Waits for a transcript line to arrive, or gives up — R76. */
    async untilSaidOnTheRun(pattern, timeout = 20000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (outputs.some((line) => pattern.test(line.body ?? ''))) return true;
        await new Promise((wake) => setTimeout(wake, 150));
      }
      return false;
    },
    /** Waits for a session id to be reported, or gives up — R69. */
    async untilSessionId(predicate, timeout = 20000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate(sessionIds)) return true;
        await new Promise((done) => setTimeout(done, 150));
      }
      return false;
    },
    /** Waits for something to be true of the transitions, or gives up. */
    async until(predicate, timeout = 20000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate(transitions)) return true;
        await new Promise((done) => setTimeout(done, 150));
      }
      return false;
    },
    /** The same, for a workspace request coming back. */
    async untilFinished(predicate, timeout = 20000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate(finishedRequests)) return true;
        await new Promise((done) => setTimeout(done, 150));
      }
      return false;
    },
    close: () => server.close(),
  };
}
