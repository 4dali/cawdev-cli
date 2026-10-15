// node --test tools/mcp/report-done.test.mjs
//
// R345: `report done` on a coding run is refused while the checkout has
// uncommitted files or unpushed commits, and says which — the session that
// made them is the one that can say what they are. Through the real server
// over stdio, like quality-get.test.mjs; the checkout is a real repository.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const SERVER = new URL('./server.mjs', import.meta.url).pathname;
const BRANCH = 'r345-x';
const run = promisify(execFile);

/** A checkout on BRANCH whose every commit is on its remote. */
async function aCheckout(t) {
  const root = await mkdtemp(join(tmpdir(), 'cawdev-report-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const path = join(root, 'work');
  await run('git', ['init', '-q', '--bare', '-b', 'main', join(root, 'origin.git')]);
  await run('git', ['clone', '-q', join(root, 'origin.git'), path]);
  const git = (...args) => run('git', args, { cwd: path });
  await git('config', 'user.email', 'test@cawdev.test');
  await git('config', 'user.name', 'Test');
  await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(path, 'README.md'), 'hello\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'first');
  await git('push', '-q', 'origin', 'main');
  await git('switch', '-q', '-c', BRANCH);
  return path;
}

async function fakePlatform({ profile = 'CODE' } = {}) {
  const posted = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const url = request.url ?? '';
    const json = (code, value) => {
      response.writeHead(code, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.startsWith('/api/agent/whoami')) {
      return json(200, { runId: 'run-1', projects: [{ slug: 'board' }] });
    }
    if (url === '/api/projects/board/runs/run-1') {
      return json(200, { id: 'run-1', profile, branch: BRANCH, state: 'RUNNING', live: true });
    }
    if (url === '/api/projects/board/runs/run-1/messages' && request.method === 'POST') {
      const message = JSON.parse(body);
      posted.push(message);
      return json(200, { id: 'm-1', ...message });
    }
    return json(404, { status: 404, message: `the fake does not serve ${url}` });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, posted, close: () => server.close() };
}

async function report(url, workspace, args) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CAWDEV_URL: url, CAWDEV_TOKEN: 'cawdr_test', CAWDEV_PROJECT: 'board',
      CAWDEV_WORKSPACE: workspace },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'report', arguments: args },
  })}\n`);
  child.stdin.end();
  await once(child, 'exit');
  const call = out.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((r) => r.id === 2);
  assert.ok(call, `no reply to tools/call in: ${out}`);
  return call.result.content[0].text;
}

test('done with uncommitted files is refused, names them, and posts nothing', async (t) => {
  const path = await aCheckout(t);
  await writeFile(join(path, 'issues-board.html'), '<p>changed</p>\n');
  const platform = await fakePlatform();
  t.after(() => platform.close());

  const said = await report(platform.url, path, { kind: 'done', body: 'All done.' });

  assert.match(said, /^Not finished yet — the run is still open/);
  assert.match(said, /1 uncommitted file\(s\): `issues-board.html`/);
  assert.match(said, /`git push`, then report done again/);
  assert.deepEqual(platform.posted, [], 'the run was not ended');
});

test('done with a commit the remote has not seen is refused too', async (t) => {
  const path = await aCheckout(t);
  await writeFile(join(path, 'a.txt'), 'a\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'the work'], { cwd: path });
  const platform = await fakePlatform();
  t.after(() => platform.close());

  const said = await report(platform.url, path, { kind: 'done', body: 'All done.' });

  assert.match(said, /1 commit\(s\) on `r345-x` that origin has not seen/);
  assert.deepEqual(platform.posted, []);
});

test('done on a committed, pushed branch ends the run as before', async (t) => {
  const path = await aCheckout(t);
  await writeFile(join(path, 'a.txt'), 'a\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'the work'], { cwd: path });
  await run('git', ['push', '-q', '-u', 'origin', BRANCH], { cwd: path });
  const platform = await fakePlatform();
  t.after(() => platform.close());

  const said = await report(platform.url, path, { kind: 'done', body: 'All done.' });

  assert.match(said, /^Reported DONE\. The run is FINISHED/);
  assert.deepEqual(platform.posted.map((m) => m.kind), ['DONE']);
});

test('progress, blocked, and a run that writes no code are never held', async (t) => {
  const path = await aCheckout(t);
  await writeFile(join(path, 'scratch.txt'), 'x\n');
  const platform = await fakePlatform();
  t.after(() => platform.close());
  await report(platform.url, path, { kind: 'progress', body: 'Halfway.' });
  await report(platform.url, path, { kind: 'blocked', body: 'Cannot push: no access.' });
  assert.deepEqual(platform.posted.map((m) => m.kind), ['PROGRESS', 'BLOCKED']);

  const asking = await fakePlatform({ profile: 'ASK' });
  t.after(() => asking.close());
  await report(asking.url, path, { kind: 'done', body: 'Answered.' });
  assert.deepEqual(asking.posted.map((m) => m.kind), ['DONE']);
});
