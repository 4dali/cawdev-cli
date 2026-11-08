// node --test tools/runner/workspace-request-vs-run.test.mjs
//
// i285: a Stash, Commit, Reset or Hand off is judged against the runs that hold
// the checkout when the daemon PERFORMS it, not when it was asked — and a CODE
// run whose branch was wiped under it ends FAILED, not FINISHED.
//
// The agent is a script (`/bin/echo` races the working-copy watcher) that
// writes work.txt into its checkout and lingers.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { socketPathFor } from './control.mjs';
import { fakePlatform } from './test-platform.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;
const BRANCH = 'r1-work';

async function until(check, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((wake) => setTimeout(wake, 100));
  }
  return false;
}

async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-wrvr-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

const git = async (cwd, ...args) => (await run('git', args, { cwd })).stdout.trim();

async function daemonWith(t, { name, offers = [], script }) {
  const workspace = await aRepository();
  const home = await mkdtemp(join(tmpdir(), 'cawdev-wrvr-cfg-'));
  const agent = join(home, 'agent.mjs');
  await writeFile(agent, `#!/usr/bin/env node\n${script}\n`);
  await chmod(agent, 0o755);
  const platform = await fakePlatform({ offers, runLive: true });
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: agent,
    pollSeconds: 1,
    projects: { board: { workspaces: [workspace] } },
  }));
  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  daemon.stdout.on('data', (chunk) => (said += chunk));
  daemon.stderr.on('data', (chunk) => (said += chunk));
  t.after(async () => {
    daemon.kill('SIGKILL');
    platform.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(socketPathFor(name), { force: true });
  });
  return { platform, workspace, said: () => said };
}

const LINGERING = `
import { writeFileSync } from 'node:fs';
// The daemon also runs the agent command for probes, from wherever it was
// started: only write inside a test checkout.
if (process.cwd().includes('cawdev-wrvr-')) writeFileSync('work.txt', 'the run work\\n');
setTimeout(() => process.exit(0), 60000);
`;

const OFFER = { id: 'run-code', projectSlug: 'board', label: 'the card', branch: BRANCH,
  profile: 'CODE' };

async function refusedWhileRunHolds(t, kind) {
  const { platform, workspace, said } = await daemonWith(t, {
    name: `test-wrvr-${kind.toLowerCase()}`,
    offers: [OFFER],
    script: LINGERING,
  });
  assert.ok(await until(() => readFile(join(workspace, 'work.txt'), 'utf8').then(() => true, () => false)),
    said());
  assert.ok(await platform.until((all) => all.some((each) => each.state === 'RUNNING')), said());
  platform.askOfWorkspace({ id: `wr-${kind}`, path: workspace, kind, defaultBranch: 'main' });
  assert.ok(await platform.untilFinished((all) => all.length === 1), said());
  const [answer] = platform.finishedRequests;
  assert.equal(answer.ok, false);
  assert.match(answer.result, /A run started in this checkout after you asked/);
  assert.match(answer.result, /nothing was changed/);
  assert.match(said(), new RegExp(`refusing ${kind}`));
  assert.equal(await readFile(join(workspace, 'work.txt'), 'utf8'), 'the run work\n');
  assert.equal(await git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD'), BRANCH);
  assert.ok(await git(workspace, 'branch', '--list', BRANCH));
  assert.equal(await git(workspace, 'stash', 'list'), '');
}

test('a Reset asked before a run claimed the checkout is refused when it comes to be done, and the run\'s work is intact',
  (t) => refusedWhileRunHolds(t, 'RESET'));

test('a Stash on a checkout a live run holds is refused, and the run\'s work is intact',
  (t) => refusedWhileRunHolds(t, 'STASH'));

test('a Reset on a checkout no run holds is still done', async (t) => {
  const { platform, workspace, said } = await daemonWith(t, {
    name: 'test-wrvr-unheld',
    script: LINGERING,
  });
  await writeFile(join(workspace, 'stray.txt'), 'left behind\n');
  platform.askOfWorkspace({ id: 'wr-free', path: workspace, kind: 'RESET', defaultBranch: 'main' });
  assert.ok(await platform.untilFinished((all) => all.length === 1), said());
  const [answer] = platform.finishedRequests;
  assert.equal(answer.ok, true, answer.result);
  assert.equal(await git(workspace, 'status', '--porcelain'), '');
});

test('a run whose branch is deleted mid-run ends FAILED, not FINISHED', async (t) => {
  const { platform, said } = await daemonWith(t, {
    name: 'test-wrvr-deleted',
    offers: [OFFER],
    script: `
import { execFileSync } from 'node:child_process';
execFileSync('git', ['checkout', '-q', 'main']);
execFileSync('git', ['branch', '-D', ${JSON.stringify(BRANCH)}]);
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\\n');
process.exit(0);
`,
  });
  assert.ok(await platform.until((all) => all.some((each) => each.state === 'FAILED')), said());
  const failed = platform.transitions.find((each) => each.state === 'FAILED');
  assert.match(JSON.stringify(failed), /no longer exists in this checkout/);
  assert.equal(platform.transitions.some((each) => each.state === 'FINISHED'), false);
});
