// node --test tools/runner/agent-merge.test.mjs
//
// R155's half of the daemon, against the real daemon.
//
// The claim this card rests on is a claim about a SPAWN: a merge session can
// write the files git conflicted on and nothing else, and it has no `gh` in any
// form so it cannot land what it resolved. That is not something a unit test of
// a tool list can show — the list is built from what `git merge` did a moment
// earlier, in a real checkout, and the enforcement is the `--allowedTools` the
// daemon prints on its `spawning:` line. So this drives the daemon against
// `fakePlatform` with a real git repository underneath it and reads that line,
// the way `testbook-stage.test.mjs` pins its own.
//
// The `gh`-absence test is written first on purpose. It is the one that proves
// the claim, and the way to know it bites is to delete `conflictedWrites` from
// `PROFILE_TOOLS.MERGE` and watch exactly it go red.
//
// The second half is `mergePullRequest`'s classification, which is what decides
// whether the console ever OFFERS this action. `gh` is faked on `PATH`, because
// the arguments and the JSON it is asked for are the substance: a version that
// stopped asking `--json mergeable` would report every conflict as OTHER and the
// feature would quietly stop being offered.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fakePlatform } from './test-platform.mjs';
import { socketPathFor } from './control.mjs';

const run = promisify(execFile);
const DAEMON = new URL('./runner.mjs', import.meta.url).pathname;
const PR = 'https://github.com/x/y/pull/7';

const CONFLICTED = 'shared.txt';
const UNTOUCHED = 'other.txt';

const MERGE_RUN = {
  id: 'run-merge', projectSlug: 'board', label: 'the card',
  branch: 'r155-work', profile: 'MERGE',
};

/**
 * A checkout whose branch and default branch really do conflict.
 *
 * Built rather than mocked, because the whole mechanism under test is that the
 * DAEMON performs the merge and reads the conflicted set out of git. A fake
 * `git diff --diff-filter=U` would be a test of the test.
 *
 * `other.txt` changes on the branch too, and does NOT conflict. It is what
 * makes the write-scope assertion mean something: a session that could write
 * every file the branch touched would pass an assertion that only looked for
 * the conflicted one.
 */
async function aRepositoryThatConflicts() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-agent-merge-'));
  const git = (args) => run('git', args, { cwd: path });

  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@cawdev.test']);
  await git(['config', 'user.name', 'Test']);
  await writeFile(join(path, CONFLICTED), 'one\n');
  await writeFile(join(path, UNTOUCHED), 'untouched\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'first']);

  // The branch, with its own version of the shared line.
  await git(['checkout', '-q', '-b', MERGE_RUN.branch]);
  await writeFile(join(path, CONFLICTED), 'the branch says this\n');
  await writeFile(join(path, UNTOUCHED), 'changed on the branch, and never in conflict\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'on the branch']);

  // And main moves underneath it, on the same line.
  await git(['checkout', '-q', 'main']);
  await writeFile(join(path, CONFLICTED), 'main says this instead\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'on main']);
  await git(['checkout', '-q', MERGE_RUN.branch]);

  // `origin/main` without a remote at all: a local ref by that name is what
  // `prepareMerge` falls back to, and a test that needed a real remote would be
  // testing the network.
  await git(['branch', '-f', 'origin/main', 'main']);
  return path;
}

/** The same, where the branch and main touch nothing in common. */
async function aRepositoryThatMergesCleanly() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-agent-merge-clean-'));
  const git = (args) => run('git', args, { cwd: path });

  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@cawdev.test']);
  await git(['config', 'user.name', 'Test']);
  await writeFile(join(path, 'README.md'), '# a project\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'first']);

  await git(['checkout', '-q', '-b', MERGE_RUN.branch]);
  await writeFile(join(path, 'branch-only.txt'), 'only on the branch\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'on the branch']);

  await git(['checkout', '-q', 'main']);
  await writeFile(join(path, 'main-only.txt'), 'only on main\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'on main']);
  await git(['checkout', '-q', MERGE_RUN.branch]);
  await git(['branch', '-f', 'origin/main', 'main']);
  return path;
}

/**
 * A checkout that has never held the branch, while origin already does — with
 * history this checkout's own `main` has since moved past. This is the shape
 * a project's OTHER checkout (R47) leaves behind: it did the real work and
 * its push landed on the remote; this one only ever fetched refs.
 */
async function aRepositoryWhoseBranchIsOnlyOnOrigin() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-agent-merge-elsewhere-'));
  const git = (args) => run('git', args, { cwd: path });

  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@cawdev.test']);
  await git(['config', 'user.name', 'Test']);
  await writeFile(join(path, 'README.md'), '# a project\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'first']);

  // The branch, built the way another checkout would have: off this point of
  // main, with its own commit. Faked as `origin/<branch>` and then removed
  // here — this checkout has never had it locally.
  await git(['checkout', '-q', '-b', MERGE_RUN.branch]);
  await writeFile(join(path, 'branch-work.txt'), "the branch's own work\n");
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'on the branch']);
  await git(['branch', '-f', `origin/${MERGE_RUN.branch}`, MERGE_RUN.branch]);
  await git(['checkout', '-q', 'main']);
  await git(['branch', '-D', MERGE_RUN.branch]);

  // And main moves on without it, the way another PR landing in the meantime
  // would — which is exactly what makes a fresh cut of `main` unable to
  // fast-forward to what is already on `origin/<branch>`.
  await writeFile(join(path, 'main-later.txt'), 'landed on main after the branch was cut\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'later, on main']);
  await git(['branch', '-f', 'origin/main', 'main']);
  return path;
}

async function daemonWith(t, { path, name, rules = null, offers = [MERGE_RUN],
    workspaceRequests = [], env = {} }) {
  // The session has to stay up long enough for its spawn line to be read: a
  // reaped child is indistinguishable from one that was never spawned.
  const platform = await fakePlatform({ offers, rules, workspaceRequests, runLive: true });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-agent-merge-cfg-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    // Exits 0 and says nothing a stream parser can use, which is all these
    // tests need: the subject is the line the daemon prints BEFORE it spawns.
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
    await rm(home, { recursive: true, force: true });
    await rm(path, { recursive: true, force: true });
    await rm(socketPathFor(name), { force: true });
  });

  return { platform, said: () => said };
}

async function until(said, pattern, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(said())) return true;
    await new Promise((done) => setTimeout(done, 150));
  }
  return false;
}

/** The `--allowedTools` half of the daemon's own `spawning:` line. */
function spawnedTools(said) {
  const line = said.split('\n').find((each) => each.includes('spawning:'));
  assert.ok(line, `the daemon never said what it spawned:\n${said}`);
  const after = line.slice(line.indexOf('--allowedTools') + '--allowedTools'.length)
    .replace(/\(prompt on stdin\)\s*$/, '').trim();
  // A tool string CONTAINS spaces — `Bash(git diff *)` is one tool and not
  // three, so splitting on whitespace reads a passing list as a failing one.
  return after.match(/\S+\([^)]*\)|\S+/g) ?? [];
}

// --- the spawn: what a merge session may write, and what it cannot reach ------

test('a conflicting merge spawns a session that can write the conflicted file and NOTHING else',
    async (t) => {
      const path = await aRepositoryThatConflicts();
      const { platform, said } = await daemonWith(t, { path, name: 'agent-merge-scope' });

      assert.ok(await until(said, /spawning:/), said());
      const tools = spawnedTools(said());

      // **No `gh`, in any form.** This is the assertion the whole card rests
      // on: the session cannot land what it resolved, and that is a permission
      // rather than a sentence in a prompt. `Bash(git *)` cannot reach `gh`,
      // and nothing else here can run anything at all.
      for (const tool of tools) {
        assert.ok(!/gh\b/.test(tool),
          `a merge session was spawned with something that can reach gh: ${tool}`);
      }

      // The conflicted file, both verbs. Both because Claude Code changes an
      // existing file with one and rewrites it whole with the other, and a
      // resolution may legitimately do either.
      assert.ok(tools.includes(`Edit(${CONFLICTED})`),
        `a merge session could not edit the file it was started to resolve:\n${tools.join(' ')}`);
      assert.ok(tools.includes(`Write(${CONFLICTED})`),
        `a merge session could not rewrite the conflicted file:\n${tools.join(' ')}`);

      // And no other path, which is the half that makes the first half mean
      // something. `other.txt` changed on this branch and did not conflict.
      const writes = tools.filter((each) => /^(Edit|Write)\(/.test(each)).sort();
      assert.deepEqual(writes, [`Edit(${CONFLICTED})`, `Write(${CONFLICTED})`],
        `a merge session was spawned able to write something git did not conflict on:\n${
          writes.join(' ')}`);

      // The only shell is git, and it is git in full — the prompt tells the
      // session to commit and push, so the permissions must let it.
      assert.deepEqual(tools.filter((each) => each.startsWith('Bash')), ['Bash(git *)'],
        `a merge session was spawned with a shell beyond git:\n${tools.join(' ')}`);

      // What it found is reported before anything is spawned, so the card can
      // name the files without anybody opening a transcript.
      const prepared = platform.mergeReports.find((each) => each.kind === 'prepared');
      assert.ok(prepared, `the daemon never said what git merged:\n${said()}`);
      assert.equal(prepared.clean, false);
      assert.deepEqual(prepared.conflictedFiles, [CONFLICTED]);
    });

test('a sprint branch\u2019s merge session — a MANUAL run with no card — is handed the same list, and no gh',
    async (t) => {
      // R261. The sprint's branch is a work item with no card, so its R155
      // session is a MANUAL-kind run with the MERGE profile. The daemon keys
      // the tool list on the profile, so it is R155's list unchanged — and
      // in particular still no `gh`: a sprint branch that has lived beside
      // main for weeks is exactly the conflicting branch this exists for, and
      // the landing is still the platform's MERGE request, never the session's.
      const path = await aRepositoryThatConflicts();
      const sprintRun = {
        id: 'run-sprint-merge', projectSlug: 'board', kind: 'MANUAL',
        label: 'S1 Notifications \u2014 the sprint branch',
        openingPrompt: 'S1 Notifications \u2014 the sprint branch',
        branch: MERGE_RUN.branch, profile: 'MERGE',
      };
      const { platform, said } = await daemonWith(t, {
        path, name: 'agent-merge-sprint', offers: [sprintRun],
      });

      assert.ok(await until(said, /spawning:/), said());
      const tools = spawnedTools(said());
      for (const tool of tools) {
        assert.ok(!/gh\b/.test(tool),
          `a sprint merge session was spawned with something that can reach gh: ${tool}`);
      }
      const writes = tools.filter((each) => /^(Edit|Write)\(/.test(each)).sort();
      assert.deepEqual(writes, [`Edit(${CONFLICTED})`, `Write(${CONFLICTED})`]);
      assert.deepEqual(tools.filter((each) => each.startsWith('Bash')), ['Bash(git *)']);

      const prepared = platform.mergeReports.find((each) => each.kind === 'prepared');
      assert.ok(prepared, `the daemon never said what git merged:\n${said()}`);
      assert.deepEqual(prepared.conflictedFiles, [CONFLICTED]);
    });

test('a merge that comes out clean spawns nothing at all', async (t) => {
  const path = await aRepositoryThatMergesCleanly();
  const { platform, said } = await daemonWith(t, { path, name: 'agent-merge-clean' });

  const came = await until(said, /merged into r155-work with no conflict/);
  assert.ok(came, `the daemon never reported a clean merge:\n${said()}`);

  const prepared = platform.mergeReports.find((each) => each.kind === 'prepared');
  assert.ok(prepared, `the daemon never said what git merged:\n${said()}`);
  assert.equal(prepared.clean, true);
  assert.deepEqual(prepared.conflictedFiles, []);

  // The property that makes an agent merge offered on a failure which was not
  // really a conflict cost one `git fetch` rather than a model. Given a moment
  // to be wrong in, deliberately: the assertion is about something NOT
  // happening, so it has to outlast the window in which it could.
  await new Promise((done) => setTimeout(done, 1500));
  assert.ok(!/spawning:/.test(said()),
    `a clean merge spawned a session anyway:\n${said()}`);

  // It still pushes the merge commit and still says so: that commit is what the
  // pull request shows, and what the platform reads as evidence there is a
  // resolution to land.
  const resolved = platform.mergeReports.find((each) => each.kind === 'resolved');
  assert.ok(resolved, `a clean merge never reported what it left:\n${said()}`);
  assert.ok(resolved.mergeCommit, 'a clean merge reported no commit');
});

test('a checkout that has never held the branch starts it from origin, not a fresh cut of main',
    async (t) => {
      // The bug this pins: `prepareWorkingCopy` saw no LOCAL branch and cut a
      // fresh one from `main`, losing whatever the branch already carried on
      // the remote. Reported as a clean merge — main's own commit does not
      // conflict with nothing — so no session was ever spawned to notice, and
      // the branch's own work silently never reached the remote at all.
      const path = await aRepositoryWhoseBranchIsOnlyOnOrigin();
      const { said } = await daemonWith(t, { path, name: 'agent-merge-elsewhere' });

      const came = await until(said, /merged into r155-work with no conflict/);
      assert.ok(came, `the daemon never finished the merge:\n${said()}`);

      assert.ok(/was not here — checked out from origin\/r155-work/.test(said()),
        `the checkout was not started from origin/r155-work:\n${said()}`);

      const carried = await readFile(join(path, 'branch-work.txt'), 'utf8').catch(() => null);
      assert.ok(carried, "the checkout lost the branch's own work — it was cut fresh from " +
        `main instead of starting from what origin already had:\n${said()}`);
    });

test('a merge session is never handed the tools that ask a person, whatever the rule says',
  async (t) => {
    // i167. R155 handed `ask_user` to a session whose resolution waited to be
    // read, and told it to ask. The person answered "land it" and nothing read
    // the answer: the platform had not asked the question, so it could not
    // recognise the reply. The platform asks now, on the run, once the session
    // has pushed and ended — so a session that could still ask would put a
    // SECOND question in the inbox whose answer lands nothing.
    for (const agentMergeLands of [false, true]) {
      const path = await aRepositoryThatConflicts();
      const { said } = await daemonWith(t, {
        path, name: `agent-merge-${agentMergeLands ? 'lands' : 'waits'}`,
        rules: { agentMergeLands },
      });

      assert.ok(await until(said, /spawning:/), said());
      const tools = spawnedTools(said());
      assert.ok(!tools.includes('mcp__cawdev__ask_user'),
        `a merge session (lands=${agentMergeLands}) was given ask_user:\n${tools.join(' ')}`);
      assert.ok(!tools.includes('mcp__cawdev__await_answer'),
        `a merge session (lands=${agentMergeLands}) was given await_answer:\n${tools.join(' ')}`);
      // Still a reader of the platform: the cards and the task are its context.
      assert.ok(tools.includes('mcp__cawdev__roadmap_get'),
        `a merge session lost its read-only cawdev tools:\n${tools.join(' ')}`);
    }
  });

// --- the classification: why a merge failed ----------------------------------

/**
 * A `gh` that logs its argv and answers as told.
 *
 * `merge.txt` decides what `pr merge` does and `view.txt` what
 * `pr view --json` says, so one fake covers every case here.
 */
async function fakeGh(t, { mergeFails, viewJson }) {
  const dir = await mkdtemp(join(tmpdir(), 'cawdev-agent-merge-bin-'));
  const log = join(dir, 'calls.txt');
  await writeFile(join(dir, 'gh'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${log}`,
    'case "$*" in',
    // The lookup that finds the pull request, as R134 does it.
    `  "pr view ${MERGE_RUN.branch} --json url"*) printf '%s\\n' "${PR}"; exit 0 ;;`,
    // R155's question: what does the host say about mergeability.
    `  *"--json mergeable,mergeStateStatus") printf '%s\\n' '${viewJson ?? '{}'}'; exit 0 ;;`,
    `  "pr merge"*) ${mergeFails ? "printf 'merge conflict\\n' >&2; exit 1" : 'exit 0'} ;;`,
    'esac',
    'exit 1',
    '',
  ].join('\n'));
  await chmod(join(dir, 'gh'), 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    dir,
    async calls() {
      return (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    },
  };
}

async function aPlainRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-agent-merge-plain-'));
  const git = (args) => run('git', args, { cwd: path });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@cawdev.test']);
  await git(['config', 'user.name', 'Test']);
  await git(['remote', 'add', 'origin', 'https://github.com/x/y.git']);
  await writeFile(join(path, 'README.md'), '# a project\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'first']);
  return path;
}

test('a conflicting pull request is classified CONFLICT, in gh’s own words', async (t) => {
  const path = await aPlainRepository();
  const gh = await fakeGh(t, {
    mergeFails: true,
    viewJson: '{"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}',
  });
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'agent-merge-classify-conflict',
    offers: [],
    workspaceRequests: [
      { id: 'wr-merge', path, kind: 'MERGE', message: MERGE_RUN.branch },
    ],
    env: { PATH: `${gh.dir}:${process.env.PATH}` },
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never answered the merge:\n${said()}`);

  const [done] = platform.finishedRequests;
  assert.equal(done.ok, false);
  // The word the console branches on — the only failure an agent can fix.
  assert.equal(done.failure, 'CONFLICT');
  // And `gh`'s own words are UNCHANGED beside it. The classification is a word
  // added, never a replacement for the sentence a person reads.
  assert.match(done.result, /merge conflict/);

  // Asked rather than inferred from the prose. `mergeable` is the documented
  // field, and a version of this that read the text instead would be the
  // platform's mistake made on the machine.
  assert.ok((await gh.calls()).some((each) => each.includes('--json mergeable')),
    `the daemon never asked gh whether it was a conflict:\n${(await gh.calls()).join('\n')}`);
});

test('a branch with no pull request is classified NO_PULL_REQUEST and gh merge is never run',
    async (t) => {
      const path = await aPlainRepository();
      // `pr view --json url` falls through to `exit 1`, which is how a branch
      // with no pull request answers.
      const gh = await fakeGh(t, { mergeFails: false, viewJson: '{}' });
      await writeFile(join(gh.dir, 'gh'), [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${join(gh.dir, 'calls.txt')}`,
        'exit 1',
        '',
      ].join('\n'));
      await chmod(join(gh.dir, 'gh'), 0o755);

      const { platform, said } = await daemonWith(t, {
        path,
        name: 'agent-merge-classify-no-pr',
        offers: [],
        workspaceRequests: [
          { id: 'wr-merge', path, kind: 'MERGE', message: MERGE_RUN.branch },
        ],
        env: { PATH: `${gh.dir}:${process.env.PATH}` },
      });

      const came = await platform.untilFinished((finished) => finished.length === 1);
      assert.ok(came, `the runner never answered the merge:\n${said()}`);

      const [done] = platform.finishedRequests;
      assert.equal(done.ok, false);
      assert.equal(done.failure, 'NO_PULL_REQUEST');
      assert.match(done.result, /no pull request/);
      // Nothing was merged, so nothing was asked to merge.
      assert.ok(!(await gh.calls()).some((each) => each.startsWith('pr merge')),
        'gh pr merge was run for a branch with no pull request');
    });

test('a pull request the host has not judged yet is OTHER, never "no conflict"', async (t) => {
  const path = await aPlainRepository();
  // GitHub computes mergeability lazily. UNKNOWN is unknown — reading it as
  // "not a conflict" is the one way this feature disappears silently, so it
  // comes back as OTHER, which the console still offers the action on.
  const gh = await fakeGh(t, {
    mergeFails: true,
    viewJson: '{"mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN"}',
  });
  const { platform, said } = await daemonWith(t, {
    path,
    name: 'agent-merge-classify-unknown',
    offers: [],
    workspaceRequests: [
      { id: 'wr-merge', path, kind: 'MERGE', message: MERGE_RUN.branch },
    ],
    env: { PATH: `${gh.dir}:${process.env.PATH}` },
  });

  const came = await platform.untilFinished((finished) => finished.length === 1);
  assert.ok(came, `the runner never answered the merge:\n${said()}`);

  const [done] = platform.finishedRequests;
  assert.equal(done.failure, 'OTHER');
});
