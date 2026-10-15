// node --test tools/mcp/quality-get.test.mjs
//
// R302: what `quality_get` asks the platform, and what the session reads back.
//
// Pinned through the real server over stdio, like propose-entry.test.mjs. Two
// things matter and nothing else on the JS side checks either: the PATH — the
// MCP server lives in tools/mcp/ and calls `api()`, which openapi.test.mjs does
// not scan, so a fake that answered any URL would let a typo through — and the
// BRANCH, which inside a run must be the run's own without the session naming
// it. Then the sentences: "not on SonarQube", "no machine has scanned", and a
// finding line with its link and the card it became.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

const SERVER = new URL('./server.mjs', import.meta.url).pathname;
const READING_PATH = '/api/projects/board/quality/reading';

const A_READING = {
  project: {
    fetchedAt: '2026-09-20T10:05:00Z', fetchedBy: 'cawdev', stale: false, error: null,
    analysedAt: '2026-09-20T10:00:00Z', gate: 'OK', bugs: 3, vulnerabilities: 0,
    securityHotspots: 2, codeSmells: 41, coverage: 71.2, duplicatedLinesDensity: 1.5,
    reliabilityRating: 'A', securityRating: 'A', securityReviewRating: 'B',
    maintainabilityRating: 'A', dashboardUrl: 'https://sonar.example/dashboard?id=board',
  },
  branch: {
    branch: 'r302-x', scanned: true,
    reading: {
      gate: 'ERROR', analysedAs: 'BRANCH', newBugs: 0, newVulnerabilities: 2,
      newSecurityHotspots: 0, newCodeSmells: 5, newCoverage: 40, newProblems: 7,
      dashboardUrl: 'https://sonar.example/dashboard?id=board&branch=r302-x', warning: null,
      error: null, seenBy: 'laptop', seenAt: '2026-09-20T11:00:00Z', headSha: 'abc1234def',
    },
  },
  findings: [
    {
      key: 'AZQvul1', type: 'VULNERABILITY', severity: 'BLOCKER', suggestedSeverity: 'CRITICAL',
      rule: 'java:S2078', message: 'Make sure this LDAP query is safe.',
      path: 'src/main/java/dev/caw/Foo.java', line: 41,
      url: 'https://sonar.example/project/issues?id=board&open=AZQvul1',
      firstSeenAt: '2026-09-19T10:00:00Z', seenAt: '2026-09-20T10:05:00Z', resolvedAt: null,
      became: { number: 212, ref: 'i212', kind: 'ISSUE' },
    },
    {
      key: 'AZQhot1', type: 'HOTSPOT', severity: 'HIGH', suggestedSeverity: 'CRITICAL',
      rule: 'java:S5443', message: 'Publicly writable directory.', path: null, line: null,
      url: 'https://sonar.example/security_hotspots?id=board&hotspots=AZQhot1',
      firstSeenAt: '2026-09-19T10:00:00Z', seenAt: '2026-09-20T10:05:00Z', resolvedAt: null,
      became: null,
    },
  ],
};

/**
 * A platform that answers whoami — with or without a run — the run's branch,
 * and the reading. Records every request to the reading path, and answers 404
 * to any path it does not know, so a wrong path fails the test rather than
 * passing it.
 */
async function fakePlatform({ inRun = true, reading = A_READING, status = 200 } = {}) {
  const asked = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    const json = (code, body) => {
      response.writeHead(code, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.startsWith('/api/agent/whoami')) {
      return json(200, { ...(inRun ? { runId: 'run-1' } : {}), projects: [{ slug: 'board' }] });
    }
    if (url === '/api/projects/board/runs/run-1') {
      return json(200, { id: 'run-1', branch: 'r302-x', entryRef: 'R302' });
    }
    if (url.startsWith(READING_PATH)) {
      asked.push(url);
      if (status === 204) {
        response.writeHead(204);
        return response.end();
      }
      return json(status, reading);
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    return response.end(JSON.stringify({ status: 404, message: `the fake does not serve ${url}` }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, asked, close: () => server.close() };
}

async function callTool(url, args) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      CAWDEV_URL: url,
      CAWDEV_TOKEN: 'cawdr_test',
      CAWDEV_PROJECT: 'board',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'quality_get', arguments: args },
    })}\n`,
  );
  child.stdin.end();
  await once(child, 'exit');

  const replies = out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const call = replies.find((reply) => reply.id === 2);
  assert.ok(call, `no reply to tools/call in: ${out}`);
  return call.result.content[0].text;
}

test('inside a run with no branch named, the request carries the run\'s own branch', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  const text = await callTool(platform.url, {});

  assert.deepEqual(platform.asked, [`${READING_PATH}?branch=r302-x`]);
  assert.match(text, /^Default branch: gate OK · 3 bugs · 0 vulnerabilities · 2 hotspots · 41 smells · coverage 71\.2%/m);
  assert.match(text, /^Branch r302-x: gate ERROR · new: 0 bugs · 2 vulnerabilities · 0 hotspots · 5 smells · new coverage 40% · at abc1234 · https:\/\/sonar\.example\/dashboard\?id=board&branch=r302-x$/m);
});

test('a branch named by the caller wins over the run\'s', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  await callTool(platform.url, { branch: 'main' });

  assert.deepEqual(platform.asked, [`${READING_PATH}?branch=main`]);
});

test('a plain token with no run and no branch sends no query, and says so', async (t) => {
  const platform = await fakePlatform({
    inRun: false, reading: { ...A_READING, branch: null },
  });
  t.after(() => platform.close());

  const text = await callTool(platform.url, {});

  assert.deepEqual(platform.asked, [READING_PATH]);
  assert.match(text, /No branch was read: outside a run, name one/);
});

test('a 204 is "not on SonarQube", and the session is told to carry on', async (t) => {
  const platform = await fakePlatform({ status: 204 });
  t.after(() => platform.close());

  const text = await callTool(platform.url, {});

  assert.match(text, /^board is not on SonarQube — no server, token or project key set on it\. Work as you would have anyway\./);
});

test('a branch nobody scanned says so, in words, beside the default branch and the findings', async (t) => {
  const platform = await fakePlatform({
    reading: { ...A_READING, branch: { branch: 'r302-x', scanned: false, reading: null } },
  });
  t.after(() => platform.close());

  const text = await callTool(platform.url, {});

  assert.match(text, /^Branch r302-x: no machine has scanned it yet\./m);
  assert.match(text, /^Default branch: gate OK/m);
  assert.match(text, /^Open findings \(2, worst first\):/m);
});

test('a finding line carries its link and the card it became; one that was not filed does not', async (t) => {
  const platform = await fakePlatform();
  t.after(() => platform.close());

  const text = await callTool(platform.url, {});

  assert.match(text, /^ {2}VULNERABILITY BLOCKER java:S2078 src\/main\/java\/dev\/caw\/Foo\.java:41 — Make sure this LDAP query is safe\. — https:\/\/sonar\.example\/project\/issues\?id=board&open=AZQvul1 \(filed as i212\)$/m);
  assert.match(text, /^ {2}HOTSPOT HIGH java:S5443 — Publicly writable directory\. — https:\/\/sonar\.example\/security_hotspots\?id=board&hotspots=AZQhot1$/m);
  // And the last line says whose findings these are, so a session does not
  // look for the branch's two new vulnerabilities among the default branch's.
  assert.match(text, /These findings are the default branch's/);
});

test('a failed read is the headline, and the gate it kept is dated, not current', async (t) => {
  // Seen on a throwaway stack: the timer's 401 landed between two calls, and
  // the row kept its numbers. The verdict a session skims for must not be
  // `gate OK` when the sentence after it says the read failed.
  const failed = {
    ...A_READING.project,
    error: 'SonarQube refused the token (401). Replace it under this project\'s Settings → SonarQube.',
  };
  const platform = await fakePlatform({ reading: { ...A_READING, project: failed } });
  t.after(() => platform.close());

  const text = await callTool(platform.url, {});

  assert.match(text, /^Default branch: the last read failed: SonarQube refused the token \(401\)/m);
  assert.match(text, /before that: gate OK · 3 bugs/);
  assert.doesNotMatch(text, /^Default branch: gate/m);
});

test('R316: a branch analysed as its own scratch SonarQube project says so, with no gate claimed', async (t) => {
  const platform = await fakePlatform({
    reading: {
      ...A_READING,
      branch: {
        branch: 'r302-x', scanned: true,
        reading: {
          ...A_READING.branch.reading, gate: 'NONE', analysedAs: 'PROJECT',
          warning: 'This server does not analyse branches; the branch was analysed as its own SonarQube '
            + 'project, counting problems on the lines it changed. No gate was computed.',
        },
      },
    },
  });
  t.after(() => platform.close());

  const text = await callTool(platform.url, {});

  assert.match(text, /^Branch r302-x: gate NONE · .*analysed as its own SonarQube project; new = on lines this branch changed; no gate/m);
  assert.match(text, /^ {2}This server does not analyse branches/m);
});

test('connected but never read is said as that, not as a clean bill', async (t) => {
  const platform = await fakePlatform({ reading: { ...A_READING, project: null } });
  t.after(() => platform.close());

  const text = await callTool(platform.url, {});

  assert.match(text, /^Default branch: connected to SonarQube, but nothing has read it yet/m);
});
