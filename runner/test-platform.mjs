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
 */
export async function fakePlatform({ offers = [], allowDirty = false, workspaceRequests = [] } = {}) {
  const seen = [];
  const transitions = [];
  const remaining = [...offers];
  const pending = [...workspaceRequests];
  /** What the daemon said it did, so a test can read the stash ref back. */
  const finishedRequests = [];

  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url.split('?')[0]}`);
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });

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
        }));
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
        // Over, so the daemon does not try to finish a run somebody else did.
        return response.end(JSON.stringify({ live: false }));
      }
      response.end('{}');
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    transitions,
    finishedRequests,
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
