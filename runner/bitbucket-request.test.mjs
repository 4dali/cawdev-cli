// node --test tools/runner/bitbucket-request.test.mjs
//
// R565's Bitbucket half of the daemon: on a repository whose origin is
// bitbucket.org, OPEN_PR and MERGE go to Bitbucket's REST API with a token this
// machine holds — against the real daemon, with a local http server standing in
// for api.bitbucket.org (`bitbucket.apiUrl`). This proves the REQUESTS against
// a fake; it does not prove them against a real Bitbucket, which is a walk of
// its own.

import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';
import { adapterFor, configureBitbucket } from './git-host.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;
const PR = 'https://bitbucket.org/team/app/pull-requests/7';
const API = '/repositories/team/app';

async function aBitbucketRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-bb-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await run('git', ['remote', 'add', 'origin', 'git@bitbucket.org:team/app.git'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

/**
 * A stand-in api.bitbucket.org. `script` answers `METHOD path` with
 * `[status, body, headers]`; every request is recorded with its auth header.
 */
async function fakeBitbucket(t, script) {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const path = decodeURIComponent(request.url);
      calls.push({ method: request.method, path, body: body ? JSON.parse(body) : null, auth: request.headers.authorization });
      const key = Object.keys(script).find((each) => `${request.method} ${path}`.startsWith(each));
      const [status, json, headers = {}] = key ? script[key](calls) : [404, { error: { message: 'no such route' } }];
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(json));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

async function daemonWith(t, { path, name, workspaceRequests, api, token = 'sekrit', email = 'me@example.com' }) {
  const platform = await fakePlatform({ workspaceRequests });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: '/bin/echo',
    pollSeconds: 1,
    workspacePollSeconds: 1,
    projects: { board: path },
    bitbucket: { email, tokenEnv: 'BB_TEST_TOKEN', apiUrl: api },
  }));
  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env({ ...(token ? { BB_TEST_TOKEN: token } : {}), CAWDEV_MERGEABILITY_WAIT_MS: '10' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  daemon.stdout.on('data', (chunk) => (said += chunk));
  daemon.stderr.on('data', (chunk) => (said += chunk));
  t.after(async () => {
    daemon.kill('SIGKILL');
    platform.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(socketPathFor(name), { force: true });
    await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { platform, said: () => said };
}

const openRequest = (path) => ({
  id: 'wr-open', path, kind: 'OPEN_PR', message: 'r9-child', baseBranch: 'r9-parent',
  defaultBranch: 'main', title: 'R9 — child',
});
const mergeRequest = (path, extra = {}) => ({ id: 'wr-merge', path, kind: 'MERGE', message: 'r9-child', ...extra });

test('an OPEN_PR POSTs the pull request and reports its html URL first', async (t) => {
  const path = await aBitbucketRepository();
  let created = false;
  const bb = await fakeBitbucket(t, {
    [`GET ${API}/pullrequests?q=`]: () => [200, { values: created ? [{ links: { html: { href: PR } } }] : [] }],
    [`POST ${API}/pullrequests`]: () => {
      created = true;
      return [201, { id: 7, links: { html: { href: PR } } }];
    },
  });
  const { platform, said } = await daemonWith(t, {
    path, name: 'test-bb-open', api: bb.url, workspaceRequests: [openRequest(path)],
  });
  assert.ok(await platform.untilFinished((finished) => finished.length === 1), `never answered:\n${said()}`);
  const [done] = platform.finishedRequests;
  assert.equal(done.ok, true, done.result);
  assert.equal(done.result.split('\n')[0], PR);
  const post = bb.calls.find((each) => each.method === 'POST');
  assert.equal(post.body.title, 'R9 — child');
  assert.deepEqual(post.body.source, { branch: { name: 'r9-child' } });
  assert.deepEqual(post.body.destination, { branch: { name: 'r9-parent' } });
  assert.equal(post.body.close_source_branch, true);
  assert.equal(post.auth, `Basic ${Buffer.from('me@example.com:sekrit').toString('base64')}`);
});

for (const [label, extra, strategy] of [
  ['squash', {}, 'squash'],
  ['a merge commit', { mergeMethod: 'MERGE_COMMIT' }, 'merge_commit'],
]) {
  test(`a MERGE with a 200 sends merge_strategy ${strategy} (${label})`, async (t) => {
    const path = await aBitbucketRepository();
    const bb = await fakeBitbucket(t, {
      [`GET ${API}/pullrequests?q=`]: () => [200, { values: [{ links: { html: { href: PR } } }] }],
      [`POST ${API}/pullrequests/7/merge`]: () => [200, { id: 7, state: 'MERGED' }],
    });
    const { platform, said } = await daemonWith(t, {
      path, name: `test-bb-merge-${strategy}`, api: bb.url, workspaceRequests: [mergeRequest(path, extra)],
    });
    assert.ok(await platform.untilFinished((finished) => finished.length === 1), `never answered:\n${said()}`);
    const [done] = platform.finishedRequests;
    assert.equal(done.ok, true, done.result);
    assert.equal(done.result.split('\n')[0], PR);
    assert.deepEqual(bb.calls.find((each) => each.path.endsWith('/merge')).body,
      { merge_strategy: strategy, close_source_branch: true });
  });
}

test('a 202 merge is followed through the task in Location until it says SUCCESS', async (t) => {
  const path = await aBitbucketRepository();
  let polls = 0;
  let origin = '';
  const bb = await fakeBitbucket(t, {
    [`GET ${API}/pullrequests?q=`]: () => [200, { values: [{ links: { html: { href: PR } } }] }],
    [`POST ${API}/pullrequests/7/merge`]: () => [202, {}, { location: `${origin}/tasks/9` }],
    'GET /tasks/9': () => [200, { task_status: ++polls < 2 ? 'PENDING' : 'SUCCESS' }],
  });
  origin = bb.url; // the Location header carries the server's own origin
  const { platform, said } = await daemonWith(t, {
    path, name: 'test-bb-merge-202', api: bb.url, workspaceRequests: [mergeRequest(path)],
  });
  assert.ok(await platform.untilFinished((finished) => finished.length === 1), `never answered:\n${said()}`);
  const [done] = platform.finishedRequests;
  assert.equal(done.ok, true, done.result);
  assert.equal(polls, 2);
});

test('a refused merge over a conflicting diffstat is classified CONFLICT', async (t) => {
  const path = await aBitbucketRepository();
  const bb = await fakeBitbucket(t, {
    [`GET ${API}/pullrequests?q=`]: () => [200, { values: [{ links: { html: { href: PR } } }] }],
    [`POST ${API}/pullrequests/7/merge`]: () => [555, { error: { message: 'Merge conflicts' } }],
    [`GET ${API}/pullrequests/7/diffstat`]: () => [200, { values: [{ status: 'merge conflict' }] }],
  });
  const { platform, said } = await daemonWith(t, {
    path, name: 'test-bb-conflict', api: bb.url, workspaceRequests: [mergeRequest(path)],
  });
  assert.ok(await platform.untilFinished((finished) => finished.length === 1), `never answered:\n${said()}`);
  const [done] = platform.finishedRequests;
  assert.equal(done.ok, false);
  assert.equal(done.failure, 'CONFLICT');
});

test('with no token the result names the config block', async (t) => {
  const path = await aBitbucketRepository();
  const bb = await fakeBitbucket(t, {});
  const { platform, said } = await daemonWith(t, {
    path, name: 'test-bb-no-token', api: bb.url, token: null, workspaceRequests: [openRequest(path)],
  });
  assert.ok(await platform.untilFinished((finished) => finished.length === 1), `never answered:\n${said()}`);
  const [done] = platform.finishedRequests;
  assert.equal(done.ok, false);
  assert.match(done.result, /"bitbucket": \{ "email"/);
  assert.match(done.result, /BITBUCKET_TOKEN/);
  assert.deepEqual(bb.calls, [], 'nothing may be sent without a token');
});

test('listByHead maps DECLINED to CLOSED and keeps the fork flag for the caller to drop', async (t) => {
  const row = (id, state, fork = false) => ({
    id, state, updated_on: '2026-01-02T00:00:00Z', links: { html: { href: `${PR}/${id}` } },
    source: { branch: { name: 'b' }, repository: { full_name: fork ? 'fork/app' : 'team/app' } },
    destination: { branch: { name: 'main' }, repository: { full_name: 'team/app' } },
    merge_commit: state === 'MERGED' ? { hash: 'deadbeef' } : null,
  });
  const bb = await fakeBitbucket(t, {
    [`GET ${API}/pullrequests?q=`]: () => [200, { values: [row(1, 'DECLINED'), row(2, 'MERGED'), row(3, 'OPEN', true)] }],
  });
  const path = await aBitbucketRepository();
  t.after(() => rm(path, { recursive: true, force: true }));
  configureBitbucket({ token: 't', apiUrl: bb.url });
  const rows = await adapterFor('bitbucket').listByHead(path, 'b');
  assert.deepEqual(rows.map((each) => [each.number, each.state, each.isCrossRepository]),
    [[1, 'CLOSED', false], [2, 'MERGED', false], [3, 'OPEN', true]]);
  assert.equal(rows[1].mergeCommit, 'deadbeef');
  assert.equal(rows[1].mergedAt, '2026-01-02T00:00:00Z');
  assert.equal(rows[0].mergedAt, null);
  configureBitbucket({});
});
