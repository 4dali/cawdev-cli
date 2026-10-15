// node --test tools/runner/gitlab-request.test.mjs
//
// R379's GitLab half of the daemon: on a repository whose origin is a GitLab
// host, OPEN_PR and MERGE go through `glab`, not `gh`. Against the real daemon
// with `glab` (and a `gh` that records any call) faked on PATH — the argv is
// the substance. This proves the ARGV against a fake; it does not prove it
// against a real GitLab, which is a walk of its own.

import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;
const MR = 'https://gitlab.example.com/team/app/-/merge_requests/7';

async function aGitLabRepository(origin = 'git@gitlab.example.com:team/app.git') {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-gitlab-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await run('git', ['remote', 'add', 'origin', origin], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

/**
 * A `glab` and a `gh` on PATH, each logging its argv. `glab mr create` makes the
 * merge request exist (so `mr list` then finds it); `mr view` answers the scripted
 * `detailed_merge_status`.
 */
async function fakeCli(t, { status = 'mergeable', hasGlab = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cawdev-bin-'));
  const glabLog = join(dir, 'glab.txt');
  const ghLog = join(dir, 'gh.txt');
  if (hasGlab) {
    await writeFile(join(dir, 'glab'), [
      '#!/bin/sh',
      `printf '%s' "$*" | tr '\\n' ' ' >> ${glabLog}; printf '\\n' >> ${glabLog}`,
      'case "$1 $2" in',
      `  "mr create") touch ${glabLog}.created; printf 'Creating merge request\\n%s\\n' "${MR}"; exit 0 ;;`,
      `  "mr list") if [ -f ${glabLog}.created ] || [ -f ${glabLog}.exists ]; then printf '[{"iid":7,"web_url":"%s"}]\\n' "${MR}"; else printf '[]\\n'; fi; exit 0 ;;`,
      `  "mr view") printf '{"iid":7,"has_conflicts":false,"detailed_merge_status":"${status}"}\\n'; exit 0 ;;`,
      `  "mr merge") if [ "$3" = "--help" ]; then exit 0; fi; ${status === 'conflict' ? 'echo "merge request has conflicts" >&2; exit 1' : 'exit 0'} ;;`,
      'esac',
      'exit 1',
      '',
    ].join('\n'));
    await chmod(join(dir, 'glab'), 0o755);
  }
  await writeFile(join(dir, 'gh'), ['#!/bin/sh', `printf '%s\\n' "$*" >> ${ghLog}`, 'exit 1', ''].join('\n'));
  await chmod(join(dir, 'gh'), 0o755);
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const calls = async (file) => (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return {
    dir,
    exists: () => writeFile(`${glabLog}.exists`, ''),
    glab: () => calls(glabLog),
    gh: () => calls(ghLog),
  };
}

async function pathWithoutGlab(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cawdev-noglab-'));
  const git = (await run('sh', ['-c', 'command -v git'])).stdout.trim();
  await symlink(git, join(dir, 'git'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

async function daemonWith(t, { path, name, workspaceRequests, env = {} }) {
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
  }));
  const daemon = spawn(process.execPath, [DAEMON, '--config', config], {
    env: platform.env(env),
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

test('an OPEN_PR on a GitLab origin runs glab mr create against the stacked base and reports the URL', async (t) => {
  const path = await aGitLabRepository();
  const cli = await fakeCli(t);
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-gitlab-open',
    workspaceRequests: [{
      id: 'wr-open', path, kind: 'OPEN_PR', message: 'r9-child', baseBranch: 'r9-parent',
      defaultBranch: 'main', title: 'R9 — child',
    }],
    env: { PATH: `${cli.dir}:${process.env.PATH}` },
  });

  assert.ok(await platform.untilFinished((finished) => finished.length === 1), `never answered:\n${said()}`);
  const [done] = platform.finishedRequests;
  assert.equal(done.ok, true, done.result);
  assert.equal(done.result.split('\n')[0], MR);

  const created = (await cli.glab()).find((each) => each.startsWith('mr create'));
  assert.ok(created, (await cli.glab()).join('\n'));
  assert.match(created, /--source-branch r9-child /);
  assert.match(created, /--target-branch r9-parent /);
  assert.match(created, /--title R9 — child /);
  assert.match(created, /--yes/);
  assert.deepEqual(await cli.gh(), [], 'gh must not be touched on a GitLab origin');
});

test('a MERGE asks mr view, then runs mr merge <iid> --yes --remove-source-branch --squash', async (t) => {
  const path = await aGitLabRepository();
  const cli = await fakeCli(t);
  await cli.exists();
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-gitlab-merge',
    workspaceRequests: [{ id: 'wr-merge', path, kind: 'MERGE', message: 'r9-child' }],
    env: { PATH: `${cli.dir}:${process.env.PATH}` },
  });

  assert.ok(await platform.untilFinished((finished) => finished.length === 1), `never answered:\n${said()}`);
  const [done] = platform.finishedRequests;
  assert.equal(done.ok, true, done.result);
  assert.equal(done.result.split('\n')[0], MR);

  const calls = await cli.glab();
  assert.ok(calls.some((each) => each.startsWith('mr view 7 --output json')), calls.join('\n'));
  assert.ok(calls.includes('mr merge 7 --yes --remove-source-branch --squash'), calls.join('\n'));
  assert.deepEqual(await cli.gh(), []);
});

test('a merge glab refuses over a conflict classifies as CONFLICT', async (t) => {
  const path = await aGitLabRepository();
  const cli = await fakeCli(t, { status: 'conflict' });
  await cli.exists();
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-gitlab-conflict',
    workspaceRequests: [{ id: 'wr-merge', path, kind: 'MERGE', message: 'r9-child' }],
    env: { PATH: `${cli.dir}:${process.env.PATH}` },
  });

  assert.ok(await platform.untilFinished((finished) => finished.length === 1), `never answered:\n${said()}`);
  const [done] = platform.finishedRequests;
  assert.equal(done.ok, false);
  assert.equal(done.failure, 'CONFLICT');
});

test('with no glab installed a merge is UNREACHABLE and says glab is not installed', async (t) => {
  const path = await aGitLabRepository();
  const cli = await fakeCli(t, { hasGlab: false });
  const bare = await pathWithoutGlab(t);
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-gitlab-no-glab',
    workspaceRequests: [
      { id: 'wr-open', path, kind: 'OPEN_PR', message: 'r9-child', defaultBranch: 'main' },
    ],
    env: { PATH: bare },
  });

  assert.ok(await platform.untilFinished((finished) => finished.length === 1), `never answered:\n${said()}`);
  const [done] = platform.finishedRequests;
  assert.equal(done.ok, false);
  assert.match(done.result, /glab is not installed on this machine, so it cannot talk to the git host\./);
  assert.deepEqual(await cli.gh(), []);
});

test('a declared GITLAB host beats a URL that does not say so', async (t) => {
  const path = await aGitLabRepository('git@git.corp.example:team/app.git');
  const cli = await fakeCli(t);
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-gitlab-declared',
    workspaceRequests: [{
      id: 'wr-open', path, kind: 'OPEN_PR', message: 'r9-child', defaultBranch: 'main', gitHost: 'GITLAB',
    }],
    env: { PATH: `${cli.dir}:${process.env.PATH}` },
  });

  assert.ok(await platform.untilFinished((finished) => finished.length === 1), `never answered:\n${said()}`);
  assert.equal(platform.finishedRequests[0].ok, true, platform.finishedRequests[0].result);
  assert.ok((await cli.glab()).some((each) => each.startsWith('mr create')));
  assert.deepEqual(await cli.gh(), []);
});

test('with no glab installed a MERGE is UNREACHABLE and says so, not "no merge request"', async (t) => {
  const path = await aGitLabRepository();
  const bare = await pathWithoutGlab(t);
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'test-gitlab-merge-no-glab',
    workspaceRequests: [{ id: 'wr-merge', path, kind: 'MERGE', message: 'r9-child' }],
    env: { PATH: bare },
  });

  assert.ok(await platform.untilFinished((finished) => finished.length === 1), `never answered:\n${said()}`);
  const [done] = platform.finishedRequests;
  assert.equal(done.ok, false);
  assert.equal(done.failure, 'UNREACHABLE');
  assert.match(done.result, /glab is not installed on this machine/);
});
