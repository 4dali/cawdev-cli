// node --test tools/runner/spawn-guard.test.mjs
//
// R565, against the real daemon: what a coding session is spawned with (the
// push guard, `gh` disallowed, the Bitbucket token gone from its environment)
// and what the audit says after a session that pushed outside its branch.
// The agent is a throwaway script: it records its argv and environment, and
// optionally commits and pushes.

import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;
const BRANCH = 'r9-guarded';

async function aRepositoryWithARemote() {
  const root = await mkdtemp(join(tmpdir(), 'cawdev-guard-'));
  const remote = join(root, 'remote.git');
  const path = join(root, 'work');
  await run('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await run('git', ['init', '-q', '-b', 'main', path]);
  const git = (...args) => run('git', args, { cwd: path });
  await git('config', 'user.email', 'test@cawdev.test');
  await git('config', 'user.name', 'Test');
  await git('remote', 'add', 'origin', remote);
  await writeFile(join(path, 'README.md'), '# a project\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'first');
  await git('push', '-q', '-u', 'origin', 'main');
  return { root, path, remote };
}

/** Records argv + env, then runs `then` (shell) in the working copy. */
async function anAgent(home, record, then = '') {
  const script = join(home, 'agent.mjs');
  await writeFile(script, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
// The daemon first probes the CLI with \`-p --permission-prompt-tool\`; that is not the session.
if (process.argv.includes('--allowedTools')) {
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
  ${then ? `execSync(${JSON.stringify(then)}, { stdio: 'ignore' });` : ''}
}
setTimeout(() => process.exit(0), 500);
`);
  await chmod(script, 0o755);
  return script;
}

async function daemonWith(t, { name, then = '' }) {
  const { root, path } = await aRepositoryWithARemote();
  const platform = await fakePlatform({
    offers: [{ id: `run-${name}`, projectSlug: 'board', label: 'R9 guarded', branch: BRANCH, profile: 'CODE' }],
    runLive: true,
  });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-cfg-'));
  const record = join(home, 'record.json');
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: await anAgent(home, record, then),
    pollSeconds: 1,
    workspacePollSeconds: 1,
    projects: { board: path },
    bitbucket: { tokenEnv: 'BB_TEST_TOKEN' },
  }));
  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env({ BB_TEST_TOKEN: 'sekrit-bb', GH_TOKEN: 'keep-gh' }),
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
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const recorded = async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const text = await readFile(record, 'utf8').catch(() => '');
      if (text) return JSON.parse(text);
      await new Promise((wake) => setTimeout(wake, 100));
    }
    assert.fail(`the agent never ran:\n${said}`);
  };
  return { platform, said: () => said, recorded };
}

test('a coding session carries the guard before --allowedTools, the branch in its env, and no Bitbucket token', async (t) => {
  const { recorded } = await daemonWith(t, { name: 'test-guard-spawn' });
  const { argv, env } = await recorded();

  const settings = argv.indexOf('--settings');
  const disallowed = argv.indexOf('--disallowedTools');
  const allowed = argv.indexOf('--allowedTools');
  assert.ok(settings >= 0 && disallowed > settings && allowed > disallowed, argv.join(' '));
  assert.match(argv[settings + 1], /push-guard\.mjs/);
  assert.equal(JSON.parse(argv[settings + 1]).hooks.PreToolUse[0].matcher, 'Bash');
  assert.deepEqual(argv.slice(disallowed + 1, allowed), ['Bash(gh *)', 'Bash(glab *)']);
  assert.ok(argv.slice(allowed).includes('Bash(git *)'));

  assert.equal(env.CAWDEV_PUSH_BRANCH, BRANCH);
  assert.equal(env.CAWDEV_DEFAULT_BRANCH, 'main');
  assert.equal(env.CAWDEV_PUSH_TAGS, '');
  assert.equal(env.BB_TEST_TOKEN, undefined, 'the Bitbucket token reached the agent');
  assert.equal(env.GH_TOKEN, 'keep-gh', 'GH_TOKEN stays: git push may authenticate through it');
});

test('a session that pushes a branch of its own is flagged on the run', async (t) => {
  const { platform, said } = await daemonWith(t, {
    name: 'test-guard-audit-flag',
    then: 'git commit --allow-empty -qm work && git push -q origin HEAD:side',
  });
  assert.ok(await platform.untilSaidOnTheRun(/pushed `refs\/heads\/side`, which is outside its branch `r9-guarded`/),
    `never flagged:\n${said()}`);
  assert.match(said(), /!! this session pushed refs\/heads\/side/);
});

test('a session that pushes only its own branch is not flagged', async (t) => {
  const { platform, said, recorded } = await daemonWith(t, {
    name: 'test-guard-audit-clean',
    then: `git commit --allow-empty -qm work && git push -q origin HEAD:${BRANCH}`,
  });
  await recorded();
  assert.ok(await platform.until((transitions) => transitions.some((each) => /FINISHED|FAILED|CANCELLED/.test(each.state ?? ''))
    || /finished|exited/i.test(said()), 15000));
  await new Promise((wake) => setTimeout(wake, 2000));
  assert.doesNotMatch(said(), /!! this session pushed/);
  assert.ok(!platform.outputs.some((line) => /outside its branch/.test(line.body ?? '')));
});
