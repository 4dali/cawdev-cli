// node --test tools/runner/quality-scan.test.mjs
//
// R300, against the real daemon: after a coding run's TEST stage the DAEMON
// runs the scanner and tells the platform what SonarQube made of the branch.
//
// What is pinned: the reading reaches the platform with the branch's name on
// it and MEMORY begins only after it has; the scanner is handed the key and
// the branch on its argv and the token in its ENVIRONMENT and nowhere else; a
// machine with no scanner reports an error reading and the run is otherwise
// unaffected; a project with no key, and a machine with no block, scan
// nothing; and a server that refuses branches is skipped by default and
// re-analysed as main only when the operator opted in.
//
// The scanner is a stub script and SonarQube is a second tiny HTTP server:
// the subject is what the daemon does around the scan, not the scan.

import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;

async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-quality-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

const CODING = {
  id: 'run-quality', projectSlug: 'board', label: 'the card',
  branch: 'r1-work', profile: 'CODE',
};

const TEST_THEN_MEMORY = [
  { stage: 'TEST', gate: 'AUTO' },
  { stage: 'MEMORY', gate: 'AUTO' },
];

/**
 * lifecycle.test.mjs's agent: says its turn is over and stays until stdin
 * closes. `writesFile` — R316 — makes it also write an untracked `src/app.js`
 * into its cwd (the workspace) first, so `changedLines` has something to see.
 * Gated on `--mcp-config`, which only a real stage spawn passes — the daemon's
 * boot-time `probePermissionPrompt` runs this same command with no `cwd` set,
 * and an ungated write would land in the daemon's own working directory.
 */
async function anAgentThatLingers(home, { writesFile = false } = {}) {
  const path = join(home, 'lingering-agent.mjs');
  await writeFile(path, `#!/usr/bin/env node
${writesFile ? `import { mkdirSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--mcp-config')) {
  mkdirSync('src', { recursive: true });
  writeFileSync('src/app.js', 'one\\ntwo\\nthree\\n');
}
` : ''}process.stdout.write(JSON.stringify(
  { type: 'system', subtype: 'init', session_id: 'lingering' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', result: 'the stage is done' }) + '\\n');
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`, { mode: 0o755 });
  return path;
}

/**
 * A scanner that does what the real one does in the two ways that matter:
 * it writes `report-task.txt` into the working directory it is given, and
 * it refuses `sonar.branch.name` the way Community Edition does when told
 * to. Every invocation is appended to a log — argv and whether the token was
 * in its environment — so a test can read what it was handed.
 */
async function aStubScanner(home, { refusesBranches = false } = {}) {
  const path = join(home, 'sonar-scanner.mjs');
  await writeFile(path, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const value = (name) => args.find((a) => a.startsWith('-D' + name + '='))?.slice(name.length + 3);
appendFileSync(process.env.STUB_SCANNER_LOG, JSON.stringify({
  args,
  tokenInEnv: process.env.SONAR_TOKEN ?? null,
  cwd: process.cwd(),
}) + '\\n');
if (${refusesBranches} && value('sonar.branch.name')) {
  process.stderr.write('ERROR: To use the property "sonar.branch.name" and analyze branches, Developer Edition or above is required. See https://www.sonarsource.com/plans-and-pricing/ for more information.\\n');
  process.exit(1);
}
writeFileSync(join(value('sonar.working.directory'), 'report-task.txt'), [
  'projectKey=' + value('sonar.projectKey'),
  'serverUrl=' + value('sonar.host.url'),
  'dashboardUrl=' + value('sonar.host.url') + '/dashboard?id=' + value('sonar.projectKey')
    + (value('sonar.branch.name') ? '&branch=' + value('sonar.branch.name') : ''),
  'ceTaskId=task-1',
  'ceTaskUrl=' + value('sonar.host.url') + '/api/ce/task?id=task-1',
].join('\\n') + '\\n');
`, { mode: 0o755 });
  return path;
}

/** The three answers the daemon asks a SonarQube server for, and what each was asked with. */
async function aSonarQube() {
  const asked = [];
  const server = createServer((request, response) => {
    asked.push({ url: request.url, authorization: request.headers.authorization ?? null });
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/api/ce/task')) {
      return response.end(JSON.stringify({ task: { status: 'SUCCESS', analysisId: 'analysis-1' } }));
    }
    if (request.url.startsWith('/api/qualitygates/project_status')) {
      return response.end(JSON.stringify({ projectStatus: { status: 'OK' } }));
    }
    if (request.url.startsWith('/api/measures/component')) {
      return response.end(JSON.stringify({ component: { measures: [
        { metric: 'new_bugs', period: { value: '0' } },
        { metric: 'new_vulnerabilities', period: { value: '2' } },
        { metric: 'new_security_hotspots', periods: [{ value: '1' }] },
        { metric: 'new_code_smells', period: { value: '4' } },
        { metric: 'new_coverage', period: { value: '71.5' } },
      ] } }));
    }
    // R316: the scratch-project scan's findings — one BUG and one hotspot on
    // `src/app.js` (which the agent below writes, untracked), one CODE_SMELL
    // on `README.md` (which nothing touches). Answered for whatever project
    // key was asked, since a scratch key carries a hash the test does not
    // predict.
    if (request.url.startsWith('/api/issues/search')) {
      const key = new URL(request.url, 'http://x').searchParams.get('componentKeys');
      return response.end(JSON.stringify({
        total: 2, p: 1, ps: 500,
        issues: [
          { key: 'i1', type: 'BUG', component: `${key}:src/app.js`, line: 2 },
          { key: 'i2', type: 'CODE_SMELL', component: `${key}:README.md`, line: 1 },
        ],
      }));
    }
    if (request.url.startsWith('/api/hotspots/search')) {
      const key = new URL(request.url, 'http://x').searchParams.get('projectKey');
      return response.end(JSON.stringify({
        paging: { pageIndex: 1, pageSize: 500, total: 1 },
        hotspots: [{ key: 'h1', component: `${key}:src/app.js`, line: 1 }],
      }));
    }
    response.statusCode = 404;
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    asked,
    close: () => server.close(),
  };
}

async function daemonWith(t, { name, quality, sonarProjectKey = 'board-key', sonarUrl = null,
    sonarBranches = null, token = 'sqp_the_machines_token', refusesBranches = false, agentWrites = false,
    versionFiles = [], workspaceFiles = {} }) {
  const workspace = await aRepository();
  // R587: files committed in the checkout (a package.json, say), and the
  // claim's list of which of them declare the project's version.
  for (const [file, text] of Object.entries(workspaceFiles)) {
    await mkdir(dirname(join(workspace, file)), { recursive: true });
    await writeFile(join(workspace, file), text);
  }
  if (Object.keys(workspaceFiles).length > 0) {
    await run('git', ['add', '.'], { cwd: workspace });
    await run('git', ['commit', '-q', '-m', 'version files'], { cwd: workspace });
  }
  const sonar = await aSonarQube();
  const platform = await fakePlatform({
    offers: [CODING],
    workflow: TEST_THEN_MEMORY,
    runLive: true,
    sonarProjectKey,
    sonarUrl: sonarUrl ?? sonar.url,
    sonarBranches,
    versionFiles,
  });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-quality-cfg-'));
  const scanner = await aStubScanner(home, { refusesBranches });
  const scannerLog = join(home, 'scanner.log');
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: await anAgentThatLingers(home, { writesFile: agentWrites }),
    pollSeconds: 1,
    projects: {
      board: {
        workspaces: [workspace],
        ...(quality === null ? {} : { quality: { command: scanner, ...quality } }),
      },
    },
  }));

  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env({
      STUB_SCANNER_LOG: scannerLog,
      ...(token === null ? { SONAR_TOKEN: undefined } : { SONAR_TOKEN: token }),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  daemon.stdout.on('data', (chunk) => (said += chunk));
  daemon.stderr.on('data', (chunk) => (said += chunk));

  t.after(async () => {
    daemon.kill('SIGKILL');
    platform.close();
    sonar.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(socketPathFor(name), { force: true });
  });

  return {
    platform,
    sonar,
    scanner,
    said: () => said,
    async invocations() {
      const text = await readFile(scannerLog, 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

async function untilStageBegan(platform, stage, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (platform.stageCalls.some((each) => each.stage === stage && each.what === 'begin')) {
      return true;
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  return false;
}

test('after TEST the reading reaches the platform, and MEMORY begins only afterwards', async (t) => {
  const { platform, sonar, said, invocations } = await daemonWith(t, {
    name: 'test-quality-reading',
    quality: {},
  });

  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  assert.equal(platform.qualityReports.length, 1, said());
  const [reading] = platform.qualityReports;
  assert.equal(reading.slug, 'board');
  assert.equal(reading.branch, 'r1-work');
  assert.equal(reading.runId, 'run-quality');
  assert.equal(reading.gate, 'OK');
  assert.equal(reading.analysedAs, 'BRANCH');
  assert.equal(reading.newBugs, 0);
  assert.equal(reading.newVulnerabilities, 2);
  // `periods[0].value` — the older server shape — is read too.
  assert.equal(reading.newSecurityHotspots, 1);
  assert.equal(reading.newCodeSmells, 4);
  assert.equal(reading.newCoverage, 71.5);
  assert.match(reading.dashboardUrl, /dashboard\?id=board-key&branch=r1-work$/);
  assert.match(reading.headSha, /^[0-9a-f]{40}$/);
  assert.equal(reading.error, undefined);

  // Awaited: the scan is over before the next stage is begun.
  const order = platform.seen;
  const reported = order.findIndex((each) => each.endsWith('/quality/board'));
  const memoryBegan = order.findIndex((each) => each.endsWith('/stages/MEMORY/begin'));
  assert.ok(reported !== -1 && reported < memoryBegan, order.join('\n'));

  // What the scanner was handed: the key and the branch on argv, the token
  // in the environment and NOT on argv — `ps` shows argv.
  const [invocation] = await invocations();
  assert.ok(invocation.args.includes('-Dsonar.projectKey=board-key'), invocation.args.join(' '));
  assert.ok(invocation.args.includes('-Dsonar.branch.name=r1-work'), invocation.args.join(' '));
  assert.ok(invocation.args.includes(`-Dsonar.host.url=${sonar.url}`), invocation.args.join(' '));
  assert.equal(invocation.tokenInEnv, 'sqp_the_machines_token');
  assert.ok(!invocation.args.some((arg) => arg.includes('sqp_the_machines_token')),
    'the token was on the scanner\'s argv');
  assert.ok(!invocation.args.some((arg) => arg.includes('sonar.login') || arg.includes('sonar.token')),
    'the token was on the scanner\'s argv');
  // The scanner's working directory is outside the checkout: `.scannerwork/`
  // inside it would be dirt the next reset cleans and the watcher reports.
  const workDir = invocation.args.find((arg) => arg.startsWith('-Dsonar.working.directory='));
  assert.ok(workDir && !workDir.includes(invocation.cwd), workDir);

  // And the server was asked with the machine's token, for the branch.
  assert.ok(sonar.asked.every((each) => each.authorization === 'Bearer sqp_the_machines_token'));
  assert.ok(sonar.asked.some((each) => each.url.includes('/api/measures/component')
    && each.url.includes('branch=r1-work')), sonar.asked.map((each) => each.url).join('\n'));

  assert.match(said(), /quality: r1-work gate OK · 7 new problems/);
});

test('a machine with no scanner reports an error reading, and the run goes on to MEMORY', async (t) => {
  const { platform, said } = await daemonWith(t, {
    name: 'test-quality-missing',
    quality: { command: '/nonexistent/sonar-scanner' },
  });

  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  assert.equal(platform.qualityReports.length, 1, said());
  const [reading] = platform.qualityReports;
  assert.equal(reading.branch, 'r1-work');
  assert.match(reading.error, /sonar-scanner is not installed on this machine/);
  assert.equal(reading.gate, undefined);
  assert.match(said(), /quality: could not scan r1-work: .*not installed/);

  // A failed scan never fails a run.
  assert.ok(await platform.until((all) => all.some((each) => each.state === 'FINISHED')), said());
  assert.ok(!platform.transitions.some((each) => each.state === 'FAILED'), said());
});

test('the scanner token unset on the machine is an error reading naming the variable', async (t) => {
  const { platform, said, invocations } = await daemonWith(t, {
    name: 'test-quality-no-token',
    quality: { tokenEnv: 'MY_SONAR_TOKEN' },
    token: null,
  });

  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  assert.equal(platform.qualityReports.length, 1, said());
  assert.match(platform.qualityReports[0].error, /export MY_SONAR_TOKEN on this machine/);
  assert.deepEqual(await invocations(), [], 'the scanner ran without a token');
});

test('a project with no SonarQube key is not scanned, and the scanner never runs', async (t) => {
  const { platform, said, invocations } = await daemonWith(t, {
    name: 'test-quality-no-key',
    quality: {},
    sonarProjectKey: null,
  });

  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  assert.deepEqual(platform.qualityReports, []);
  assert.deepEqual(await invocations(), []);
  assert.match(said(), /quality: board has no SonarQube key — not scanned/);
});

test('a machine with no quality block scans nothing and says nothing', async (t) => {
  const { platform, said, invocations } = await daemonWith(t, {
    name: 'test-quality-no-block',
    quality: null,
  });

  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  assert.deepEqual(platform.qualityReports, []);
  assert.deepEqual(await invocations(), []);
  assert.doesNotMatch(said(), /quality:/);
});

test('a server that refuses branches is skipped by default, and the reading says how to opt in', async (t) => {
  const { platform, said, invocations } = await daemonWith(t, {
    name: 'test-quality-community-skip',
    quality: {},
    refusesBranches: true,
  });

  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  assert.equal(platform.qualityReports.length, 1, said());
  const [reading] = platform.qualityReports;
  assert.match(reading.error, /does not analyse branches \(Community Edition\)/);
  assert.match(reading.error, /"whenBranchesRefused": "main"/);
  // Once, with the branch — and NOT again without it.
  const ran = await invocations();
  assert.equal(ran.length, 1, JSON.stringify(ran));
  assert.ok(ran[0].args.includes('-Dsonar.branch.name=r1-work'));
});

test('with "whenBranchesRefused": "main" the branch is analysed as the main analysis, and the reading says so', async (t) => {
  const { platform, said, invocations } = await daemonWith(t, {
    name: 'test-quality-community-main',
    quality: { whenBranchesRefused: 'main' },
    refusesBranches: true,
  });

  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  assert.equal(platform.qualityReports.length, 1, said());
  const [reading] = platform.qualityReports;
  assert.equal(reading.error, undefined, JSON.stringify(reading));
  assert.equal(reading.gate, 'OK');
  assert.equal(reading.analysedAs, 'MAIN');
  assert.match(reading.warning, /analysed as the project's main analysis/);
  assert.doesNotMatch(reading.dashboardUrl, /branch=/);

  const ran = await invocations();
  assert.equal(ran.length, 2, JSON.stringify(ran));
  assert.ok(ran[0].args.includes('-Dsonar.branch.name=r1-work'));
  assert.ok(!ran[1].args.some((arg) => arg.startsWith('-Dsonar.branch.name=')), ran[1].args.join(' '));
  assert.match(said(), /quality: r1-work gate OK · 7 new problems · This server does not analyse branches/);
});

test('R316: sonarBranches REFUSED + "project" analyses the branch as its own scratch SonarQube project', async (t) => {
  const { platform, said, invocations } = await daemonWith(t, {
    name: 'test-quality-refused-project',
    quality: { whenBranchesRefused: 'project' },
    sonarBranches: 'REFUSED',
    agentWrites: true,
  });

  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  assert.equal(platform.qualityReports.length, 1, said());
  const [reading] = platform.qualityReports;
  assert.equal(reading.error, undefined, JSON.stringify(reading));
  assert.equal(reading.gate, 'NONE');
  assert.equal(reading.analysedAs, 'PROJECT');
  // `src/app.js` is untracked (the agent wrote it, never committed) — its BUG
  // and hotspot count; `README.md`'s CODE_SMELL is on an unchanged file and
  // is dropped.
  assert.equal(reading.newBugs, 1);
  assert.equal(reading.newCodeSmells, 0);
  assert.equal(reading.newSecurityHotspots, 1);
  assert.match(reading.dashboardUrl, /board-key:branch:r1-work-[0-9a-f]{6}/);

  const ran = await invocations();
  assert.equal(ran.length, 1, JSON.stringify(ran));
  const projectKey = ran[0].args.find((arg) => arg.startsWith('-Dsonar.projectKey='))
    ?.slice('-Dsonar.projectKey='.length);
  assert.match(projectKey, /^board-key:branch:r1-work-[0-9a-f]{6}$/);
  assert.ok(!ran[0].args.some((arg) => arg.startsWith('-Dsonar.branch.name=')), ran[0].args.join(' '));
});

test('R316: REFUSED with the default block ("skip") scans nothing, and the error names "project"', async (t) => {
  const { platform, said, invocations } = await daemonWith(t, {
    name: 'test-quality-refused-skip',
    quality: {},
    sonarBranches: 'REFUSED',
  });

  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  assert.equal(platform.qualityReports.length, 1, said());
  const [reading] = platform.qualityReports;
  assert.match(reading.error, /does not analyse branches \(Community Edition, set on the project\)/);
  assert.match(reading.error, /"whenBranchesRefused": "project"/);
  assert.deepEqual(await invocations(), [], 'a known refusal never runs the doomed branch scan');
});

test('R316: REFUSED + "main" goes straight to the main analysis, with no branch attempt first', async (t) => {
  const { platform, said, invocations } = await daemonWith(t, {
    name: 'test-quality-refused-main',
    quality: { whenBranchesRefused: 'main' },
    sonarBranches: 'REFUSED',
  });

  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  assert.equal(platform.qualityReports.length, 1, said());
  const [reading] = platform.qualityReports;
  assert.equal(reading.error, undefined, JSON.stringify(reading));
  assert.equal(reading.analysedAs, 'MAIN');

  const ran = await invocations();
  assert.equal(ran.length, 1, JSON.stringify(ran));
  assert.ok(!ran[0].args.some((arg) => arg.startsWith('-Dsonar.branch.name=')), ran[0].args.join(' '));
});

test('R316: SUPPORTED scans the branch, as today', async (t) => {
  const { platform, said, invocations } = await daemonWith(t, {
    name: 'test-quality-supported',
    quality: {},
    sonarBranches: 'SUPPORTED',
  });

  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  assert.equal(platform.qualityReports.length, 1, said());
  const [reading] = platform.qualityReports;
  assert.equal(reading.analysedAs, 'BRANCH');

  const ran = await invocations();
  assert.equal(ran.length, 1, JSON.stringify(ran));
  assert.ok(ran[0].args.includes('-Dsonar.branch.name=r1-work'));
});

test('R316: sonarBranches not known: the branch is tried first, and "project" is only the fallback', async (t) => {
  const { platform, said, invocations } = await daemonWith(t, {
    name: 'test-quality-unknown-project',
    quality: { whenBranchesRefused: 'project' },
    refusesBranches: true,
  });

  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  assert.equal(platform.qualityReports.length, 1, said());
  const [reading] = platform.qualityReports;
  assert.equal(reading.analysedAs, 'PROJECT');

  const ran = await invocations();
  assert.equal(ran.length, 2, JSON.stringify(ran));
  assert.ok(ran[0].args.includes('-Dsonar.branch.name=r1-work'));
  assert.ok(!ran[1].args.some((arg) => arg.startsWith('-Dsonar.branch.name=')), ran[1].args.join(' '));
});

test('R316: REFUSED is ignored when the machine scans a different server — the branch is tried first', async (t) => {
  const { platform, said, invocations } = await daemonWith(t, {
    name: 'test-quality-refused-other-server',
    quality: { url: 'http://127.0.0.1:1' },
    sonarBranches: 'REFUSED',
  });

  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  const ran = await invocations();
  assert.equal(ran.length, 1, JSON.stringify(ran));
  assert.ok(ran[0].args.includes('-Dsonar.branch.name=r1-work'), ran[0].args.join(' '));
});

test('a quality block with an unknown whenBranchesRefused refuses to boot, naming the values', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-quality-bad-'));
  const platform = await fakePlatform();
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name: 'test-quality-bad-config',
    projects: { board: { path: home, quality: { whenBranchesRefused: 'sometimes' } } },
  }));
  t.after(async () => {
    platform.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  daemon.stdout.on('data', (chunk) => (said += chunk));
  daemon.stderr.on('data', (chunk) => (said += chunk));
  const [code] = await once(daemon, 'exit');
  assert.notEqual(code, 0, said);
  assert.match(said, /quality\.whenBranchesRefused must be "skip", "main" or "project", not "sometimes"/);
});

// --- R587: the scan carries the project's version ------------------------------

const versionArg = (invocation) => invocation.args.find((arg) => arg.startsWith('-Dsonar.projectVersion='));

test('R587: a declared version file that parses puts sonar.projectVersion on the branch scan', async (t) => {
  const { platform, said, invocations } = await daemonWith(t, {
    name: 'test-quality-version',
    quality: {},
    versionFiles: ['missing/pom.xml', 'package.json'],
    workspaceFiles: { 'package.json': '{"name":"x","version":"1.2.3"}' },
  });
  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  const [invocation] = await invocations();
  assert.equal(versionArg(invocation), '-Dsonar.projectVersion=1.2.3', invocation.args.join(' '));
  assert.match(said(), /quality: version 1\.2\.3 \(package\.json\)/);
});

test('R587: no declared version files means no version on argv, and the log says so', async (t) => {
  const { platform, said, invocations } = await daemonWith(t, { name: 'test-quality-no-version', quality: {} });
  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  const [invocation] = await invocations();
  assert.equal(versionArg(invocation), undefined, invocation.args.join(' '));
  assert.match(said(), /quality: no version file declared: scanned without a version/);
});

test('R587: the main analysis (whenBranchesRefused main) carries it on the retry', async (t) => {
  const { platform, said, invocations } = await daemonWith(t, {
    name: 'test-quality-version-main',
    quality: { whenBranchesRefused: 'main' },
    refusesBranches: true,
    versionFiles: ['package.json'],
    workspaceFiles: { 'package.json': '{"version":"1.2.3"}' },
  });
  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  const ran = await invocations();
  assert.equal(ran.length, 2, JSON.stringify(ran));
  assert.equal(versionArg(ran[1]), '-Dsonar.projectVersion=1.2.3');
});

test('R587: a scratch project scan carries it too', async (t) => {
  const { platform, said, invocations } = await daemonWith(t, {
    name: 'test-quality-version-scratch',
    quality: { whenBranchesRefused: 'project' },
    sonarBranches: 'REFUSED',
    versionFiles: ['package.json'],
    workspaceFiles: { 'package.json': '{"version":"1.2.3"}' },
  });
  assert.ok(await untilStageBegan(platform, 'MEMORY'), said());
  const [invocation] = await invocations();
  assert.equal(versionArg(invocation), '-Dsonar.projectVersion=1.2.3');
});
