// node --test tools/runner/finish-gate.test.mjs
//
// R345, end to end through the daemon: a coding session that leaves its work
// uncommitted does not finish a run that strands the next one. R325's run
// ended FINISHED with a file modified and nothing pushed; here the daemon
// commits and pushes what was left, or — when what was left looks like a
// credential — reports FAILED and holds the checkout.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { socketPathFor } from './control.mjs';
import { fakePlatform } from './test-platform.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;
const BRANCH = 'r345-the-work';
const GONE = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

/** A clone of a bare remote whose main has one commit. */
async function aCheckout(root) {
  const origin = join(root, 'origin.git');
  const path = join(root, 'work');
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await run('git', ['clone', '-q', origin, path]);
  const git = (...args) => run('git', args, { cwd: path });
  await git('config', 'user.email', 'test@cawdev.test');
  await git('config', 'user.name', 'Test');
  await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(path, 'README.md'), 'hello\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'first');
  await git('push', '-q', 'origin', 'main');
  return { origin, path };
}

/**
 * An agent that writes one file where it was started, commits nothing, and
 * leaves. Only as a session (`--mcp-config`): the daemon also runs the command
 * from its own directory to probe `--permission-prompt-tool` and to read
 * `/usage`, and those must write nothing.
 */
async function anAgentThatLeaves(home, contents) {
  const script = join(home, 'agent.mjs');
  await writeFile(script, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--mcp-config')) writeFileSync('left-behind.txt', ${JSON.stringify(contents)});
console.log('wrote a file and stopped');
`);
  await chmod(script, 0o755);
  return script;
}

async function daemonWith(t, { name, contents }) {
  const root = await mkdtemp(join(tmpdir(), 'cawdev-r345-'));
  const { origin, path } = await aCheckout(root);
  const platform = await fakePlatform({
    offers: [{ id: `run-${name}`, projectSlug: 'board', label: 'R345 work', branch: BRANCH, profile: 'CODE',
      entryRef: 'R345' }],
    runLive: true,
  });
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: await anAgentThatLeaves(root, contents),
    pollSeconds: 1,
    workspacePollSeconds: 1,
    projects: { board: path },
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
    await rm(socketPathFor(name), { force: true });
    await rm(root, GONE);
  });
  return { platform, origin, path, said: () => said };
}

const ended = (transitions) => transitions.find((each) => ['FINISHED', 'FAILED'].includes(each.state));

test('work left uncommitted is committed and pushed before the run is FINISHED', async (t) => {
  const { platform, origin, path, said } = await daemonWith(t, { name: 'test-r345-commit', contents: 'the work\n' });

  assert.ok(await platform.until((all) => Boolean(ended(all)), 30000),
    `the run never ended:\n${said()}`);
  const end = ended(platform.transitions);
  assert.equal(end.state, 'FINISHED', `${end.summary}\n${said()}`);
  assert.match(end.summary, /left 1 file\(s\) uncommitted \(`left-behind.txt`\); the daemon committed them and pushed r345-the-work/);

  const { stdout: subject } = await run('git', ['log', '-1', '--format=%s', BRANCH], { cwd: origin });
  assert.match(subject, /^R345: what the session left uncommitted/);
  const { stdout: status } = await run('git', ['status', '--porcelain'], { cwd: path });
  assert.equal(status, '', 'the next run finds a clean checkout');
});

test('a leftover that looks like a credential is not committed: FAILED, and the checkout holds it', async (t) => {
  const { platform, origin, path, said } = await daemonWith(t, {
    name: 'test-r345-secret', contents: 'aws = AKIAIOSFODNN7EXAMPLE\n',
  });

  assert.ok(await platform.until((all) => Boolean(ended(all)), 30000),
    `the run never ended:\n${said()}`);
  const end = ended(platform.transitions);
  assert.equal(end.state, 'FAILED', `${end.summary}\n${said()}`);
  assert.match(end.summary, /looks like .*did not commit it/);
  assert.doesNotMatch(end.summary, /AKIAIOSFODNN7EXAMPLE/, 'the summary never carries the secret');

  const { stdout: status } = await run('git', ['status', '--porcelain'], { cwd: path });
  assert.match(status, /left-behind.txt/);
  await assert.rejects(run('git', ['rev-parse', '--verify', BRANCH], { cwd: origin }),
    'nothing reached the remote');
});
