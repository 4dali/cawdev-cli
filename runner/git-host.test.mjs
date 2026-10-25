// node --test tools/runner/git-host.test.mjs
//
// R379's pure half: which host an origin is on, the compare link, and what
// `glab` says about a merge request.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adapterFor, compareUrl, configureBitbucket, gitlabMergeability, hostFor, iidOf, mrUrlIn, prIdOf, repoOf,
} from './git-host.mjs';

test('repoOf reads scp-style, https, and ssh:// with a port, subgroups kept', () => {
  assert.deepEqual(repoOf('git@gitlab.example.com:team/app.git'), { host: 'gitlab.example.com', path: 'team/app' });
  assert.deepEqual(repoOf('https://github.com/x/y'), { host: 'github.com', path: 'x/y' });
  assert.deepEqual(repoOf('https://github.com/x/y.git'), { host: 'github.com', path: 'x/y' });
  assert.deepEqual(repoOf('ssh://git@git.corp.example:2222/a/b.git'), { host: 'git.corp.example', path: 'a/b' });
  assert.deepEqual(repoOf('https://gitlab.com/group/sub/deep/app.git'), { host: 'gitlab.com', path: 'group/sub/deep/app' });
  assert.equal(repoOf(''), null);
  assert.equal(repoOf('/some/local/path'), null);
});

test('a declared host beats the URL, and an unknown host means GitHub', () => {
  assert.equal(hostFor({ originUrl: 'git@gitlab.example.com:t/a.git' }), 'gitlab');
  assert.equal(hostFor({ originUrl: 'https://github.com/x/y.git' }), 'github');
  assert.equal(hostFor({ originUrl: 'https://git.corp.example/x/y.git' }), 'github');
  assert.equal(hostFor({ originUrl: 'https://git.corp.example/x/y.git', declared: 'GITLAB' }), 'gitlab');
  assert.equal(hostFor({ originUrl: 'https://gitlab.com/x/y.git', declared: 'GITHUB' }), 'github');
  assert.equal(hostFor({}), 'github');
});

test('compareUrl always contains /compare/', () => {
  const repo = { host: 'gitlab.example.com', path: 'team/app' };
  assert.equal(compareUrl('github', { host: 'github.com', path: 'x/y' }, 'main', 'r1-a'), 'https://github.com/x/y/compare/r1-a');
  assert.equal(compareUrl('gitlab', repo, 'main', 'r1-a'), 'https://gitlab.example.com/team/app/-/compare/main...r1-a');
  assert.equal(compareUrl('gitlab', null, 'main', 'r1-a'), null);
});

test('the GitHub fallback link is only for github.com, as it always was', () => {
  const github = adapterFor('github');
  assert.equal(github.fallbackLink({ host: 'git.corp.example', path: 'x/y' }, null, 'b'), null);
  assert.equal(github.fallbackLink({ host: 'github.com', path: 'x/y' }, null, 'b'), 'https://github.com/x/y/compare/b');
});

test('the merge request URL is read out of glab mr create output', () => {
  const output = [
    'Creating merge request for r1-a into main in team/app',
    '',
    '!7 r1-a',
    'https://gitlab.example.com/team/app/-/merge_requests/7',
    '',
  ].join('\n');
  assert.equal(mrUrlIn(output), 'https://gitlab.example.com/team/app/-/merge_requests/7');
  assert.equal(iidOf('https://gitlab.example.com/team/app/-/merge_requests/7'), '7');
  assert.equal(mrUrlIn('nothing here'), null);
});

test('the mergeability mapping table', () => {
  assert.equal(gitlabMergeability({ has_conflicts: true }), 'CONFLICT');
  assert.equal(gitlabMergeability({ detailed_merge_status: 'conflict' }), 'CONFLICT');
  for (const waiting of ['checking', 'unchecked', 'preparing']) {
    assert.equal(gitlabMergeability({ detailed_merge_status: waiting }), 'UNKNOWN', waiting);
  }
  for (const blocked of ['not_approved', 'blocked_status', 'ci_must_pass', 'discussions_not_resolved',
    'draft_status', 'not_open', 'requested_changes']) {
    assert.equal(gitlabMergeability({ detailed_merge_status: blocked }), 'NOT_PERMITTED', blocked);
  }
  assert.equal(gitlabMergeability({ detailed_merge_status: 'mergeable' }), 'KNOWN');
  assert.equal(gitlabMergeability(null), 'KNOWN');
});

test('Bitbucket: declared, or by the origin host; the compare link contains /compare/', () => {
  assert.equal(hostFor({ declared: 'BITBUCKET', originUrl: 'https://git.corp.example/x/y.git' }), 'bitbucket');
  assert.equal(hostFor({ originUrl: 'git@bitbucket.org:team/app.git' }), 'bitbucket');
  assert.equal(hostFor({ originUrl: 'https://user@bitbucket.org/team/app.git' }), 'bitbucket');
  assert.equal(adapterFor('bitbucket').name, 'bitbucket');
  const link = compareUrl('bitbucket', { host: 'bitbucket.org', path: 'team/app' }, null, 'r9-x');
  assert.equal(link, 'https://bitbucket.org/team/app/branches/compare/r9-x%0Dmain');
  assert.ok(link.includes('/compare/'));
  assert.ok(adapterFor('bitbucket').fallbackLink({ host: 'bitbucket.org', path: 'a/b' }, 'dev', 'x').includes('/compare/'));
});

test('prIdOf reads the number at the end of a Bitbucket pull request URL', () => {
  assert.equal(prIdOf('https://bitbucket.org/team/app/pull-requests/42'), '42');
  assert.equal(prIdOf('https://bitbucket.org/team/app/branches/compare/x%0Dmain'), null);
});

test('a GitLab merge request squash-merged reports squash_commit_sha as its commit', async () => {
  const { chmod, mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'cawdev-glab-'));
  await writeFile(join(dir, 'glab'), [
    '#!/bin/sh',
    `echo '{"iid":7,"state":"merged","merged_at":"2026-01-02T00:00:00Z","merge_commit_sha":null,"squash_commit_sha":"abc123","web_url":"https://g/x/-/merge_requests/7"}'`,
    '',
  ].join('\n'));
  await chmod(join(dir, 'glab'), 0o755);
  const was = process.env.PATH;
  process.env.PATH = `${dir}:${was}`;
  try {
    const viewed = await adapterFor('gitlab').view(dir, 'https://g/x/-/merge_requests/7');
    assert.deepEqual(viewed, { state: 'MERGED', mergedAt: '2026-01-02T00:00:00Z', mergeCommit: 'abc123' });
  } finally {
    process.env.PATH = was;
  }
});

test('Bitbucket with no token answers code -1 naming the config block', async () => {
  configureBitbucket({});
  const made = await adapterFor('bitbucket').create(process.cwd(), { branch: 'b', title: 't', body: 'x' });
  assert.equal(made.code, -1);
  assert.match(made.err, /"bitbucket": \{ "email"/);
});
