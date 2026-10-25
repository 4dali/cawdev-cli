// node --test tools/runner/push-guard.test.mjs
//
// R565: what a coding agent may run. The function is a table; the hook is
// exercised through a real child process, because exit code 2 on stderr is the
// contract with Claude Code.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { judge } from './push-guard.mjs';

const B = 'r9-the-card';
const ctx = { branch: B, defaultBranch: 'main', head: B };

const allowed = [
  ['git push', ctx],
  ['git push -u origin HEAD', ctx],
  ['git push --set-upstream origin r9-the-card', ctx],
  [`git push origin HEAD:${B}`, ctx],
  [`git push origin ${B}:${B}`, ctx],
  [`git push origin refs/heads/${B}`, ctx],
  ['git status && git log --oneline | head', ctx],
  ['git push origin v1.2.0', { ...ctx, allowTags: true, isTag: (n) => n === 'v1.2.0' }],
  ['git push origin refs/tags/v1.2.0', { ...ctx, allowTags: true }],
  ['git push --tags', { ...ctx, allowTags: true }],
];

const refused = [
  ['git push origin main', ctx],
  ['git push origin HEAD:other', ctx],
  ['git push --force', ctx],
  ['git push -f origin r9-the-card', ctx],
  ['git push --force-with-lease', ctx],
  [`git push origin +${B}`, ctx],
  [`git push origin :${B}`, ctx],
  [`git push --delete origin ${B}`, ctx],
  ['git push --mirror', ctx],
  ['git push --all', ctx],
  ['git push --prune origin', ctx],
  ['git push --tags', ctx],
  ['git push --follow-tags', ctx],
  ['git push origin v1.2.0', ctx],
  ['git push origin v1.2.0', { ...ctx, allowTags: true, isTag: () => false }],
  ['git push', { ...ctx, head: 'other' }],
  ['git push origin HEAD', { ...ctx, head: 'other' }],
  ['git push', { ...ctx, branch: 'main' }],
  ['git push origin main', { ...ctx, branch: 'main' }],
  ['git push', { ...ctx, branch: '' }],
  ['gh pr create', ctx],
  ['/opt/homebrew/bin/glab mr merge 3', ctx],
  ['cd x && gh pr merge', ctx],
  ['GH_TOKEN=x gh pr view', ctx],
  ['sudo env FOO=1 gh pr list', ctx],
  ['echo $(gh auth token)', ctx],
  ['echo `glab auth status`', ctx],
  ["git -c alias.x='!gh' x", ctx],
  ['git config alias.x "!gh"', ctx],
  ['git -c core.hooksPath=/dev/null commit -m x', ctx],
  ['ls; git push origin other-branch', ctx],
  ['git push origin HEAD:other || true', ctx],
];

for (const [command, c] of allowed) {
  test(`allowed: ${command}`, () => assert.equal(judge(command, c), null));
}
for (const [command, c] of refused) {
  test(`refused: ${command} (${c.allowTags ? 'tags ok, ' : ''}head ${c.head}, branch ${c.branch})`, () => {
    assert.equal(typeof judge(command, c), 'string');
  });
}

test('a quoted "gh" argument is not a host CLI', () => {
  assert.equal(judge("git commit -m 'gh pr create is not allowed'", ctx), null);
  assert.equal(judge('echo "a; gh pr create"', ctx), null);
});

test('the host CLI reason names cawdev', () => {
  assert.match(judge('gh pr create', ctx), /done from cawdev/);
});

function hook(input, env = {}) {
  return spawnSync(process.execPath, [new URL('./push-guard.mjs', import.meta.url).pathname], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CAWDEV_PUSH_BRANCH: B, CAWDEV_DEFAULT_BRANCH: 'main', CAWDEV_PUSH_TAGS: '', ...env },
  });
}

test('the hook exits 2 with the reason on stderr for a refused command', () => {
  const done = hook({ tool_name: 'Bash', tool_input: { command: 'gh --version' }, cwd: process.cwd() });
  assert.equal(done.status, 2);
  assert.match(done.stderr, /done from cawdev/);
});

test('the hook refuses a push to another branch', () => {
  const done = hook({ tool_name: 'Bash', tool_input: { command: 'git push origin HEAD:other' }, cwd: process.cwd() });
  assert.equal(done.status, 2);
  assert.match(done.stderr, /refused/);
});

test('the hook exits 0 for a tool that is not Bash, and for an allowed command', () => {
  assert.equal(hook({ tool_name: 'Read', tool_input: { file_path: '/x' } }).status, 0);
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: process.cwd() }).status, 0);
});

test('review hardening: --repo, redirections, bash -c, env flags, URL remotes, groups', () => {
  assert.equal(judge(`git push origin ${B} 2>&1`, ctx), null);
  assert.equal(judge(`git push origin ${B} > /tmp/log 2>&1`, ctx), null);
  assert.equal(typeof judge('git push --repo origin main', ctx), 'string');
  assert.equal(typeof judge('git push --repo=origin main', ctx), 'string');
  assert.equal(typeof judge('bash -c "git push origin main"', ctx), 'string');
  assert.equal(typeof judge("sh -c 'gh pr create'", ctx), 'string');
  assert.equal(typeof judge('env -u FOO gh pr list', ctx), 'string');
  assert.equal(typeof judge('sudo -u root gh pr list', ctx), 'string');
  assert.equal(typeof judge('(gh pr create)', ctx), 'string');
  assert.equal(typeof judge('{ gh pr create; }', ctx), 'string');
  assert.equal(typeof judge(`git push https://example.com/x.git ${B}`, ctx), 'string');
  assert.equal(typeof judge('git -c core.sshCommand=x push', ctx), 'string');
  assert.equal(judge('bash -c "git status"', ctx), null);
});
