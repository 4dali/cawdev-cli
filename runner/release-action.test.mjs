// node --test tools/runner/release-action.test.mjs
//
// R187's half that lives on the machine: what a RELEASE session is allowed to
// do, read off the daemon's own `spawning:` line the way `interview.test.mjs`
// and `agent-merge.test.mjs` read theirs.
//
// The card's claim is a claim about a SPAWN. Until R187 "Release using AI
// Agents" started a CODE run, which meant the project's build tools, the
// permission prompt and `bypassPermissions` where a machine granted it — for a
// session asked to touch three files. So the assertions come in two halves:
// what a release session HAS (the version files, git, `gh pr create`, `node`,
// the three cawdev writers the procedure uses), and what it has NOT — and the
// second half is the one that proves the profile exists. Delete
// `PROFILE_TOOLS.RELEASE` and the session falls through to the read-only list;
// make it a CODE run again and `Bash(mvn *)` appears.
//
// The project config below permits `Bash(mvn *)`. That is the control: a
// coding run on this project WOULD be spawned with it, and a release must not.

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

const VERSION_FILES = ['backend/pom.xml', 'openapi.yaml', 'tools/package.json'];
const OPENING = 'You are cutting release **v9.9.9** of **board**. The procedure follows.';

const RELEASE_RUN = {
  id: 'run-release',
  projectSlug: 'board',
  label: 'Release v9.9.9',
  branch: 'release-v9.9.9',
  profile: 'RELEASE',
  kind: 'MANUAL',
  openingPrompt: OPENING,
};

async function untilSaid(said, pattern, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(said())) return true;
    await new Promise((wake) => setTimeout(wake, 100));
  }
  return false;
}

async function aRepository() {
  const path = await mkdtemp(join(tmpdir(), 'cawdev-release-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: path });
  await run('git', ['config', 'user.email', 'test@cawdev.test'], { cwd: path });
  await run('git', ['config', 'user.name', 'Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# a project\n');
  await run('git', ['add', '.'], { cwd: path });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: path });
  return path;
}

/**
 * An agent that writes what it was given on stdin, and lingers.
 *
 * `/bin/echo` would do for the spawn line, but the prompt goes on stdin and
 * echo never reads it. Held open so the reaper does not take it down before
 * the record is written — and so its working copy is not torn down under the
 * watcher, which `/bin/echo` races.
 */
async function aRecorder(directory, record) {
  const path = join(directory, 'recorder.mjs');
  await writeFile(path, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let stdin = '';
process.stdin.on('data', (chunk) => {
  stdin += chunk;
  writeFileSync(${JSON.stringify(record)}, stdin);
});
setTimeout(() => process.exit(0), 60000);
`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

/**
 * The prompt's text. Stdin carries a stream-json `user` message, one per
 * line; the text is inside it.
 */
async function untilWritten(path, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (text.trim()) {
      return text.split('\n').filter(Boolean).map((line) => {
        try {
          const message = JSON.parse(line);
          return (message.message?.content ?? []).map((part) => part.text ?? '').join('');
        } catch {
          return line;
        }
      }).join('\n');
    }
    await new Promise((wake) => setTimeout(wake, 100));
  }
  return '';
}

async function daemonWith(t, { name, releaseWrites = VERSION_FILES, offers = [RELEASE_RUN] }) {
  const path = await aRepository();
  const platform = await fakePlatform({ offers, releaseWrites, runLive: true });
  const home = await mkdtemp(join(tmpdir(), 'cawdev-release-cfg-'));
  const record = join(home, 'prompt.txt');
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({
    url: platform.url,
    name,
    agentCommand: await aRecorder(home, record),
    pollSeconds: 1,
    workspacePollSeconds: 1,
    // The control. A coding run here is spawned with `Bash(mvn *)`; a release
    // must not be, whatever the project says it permits.
    projects: { board: { path, allowedTools: ['Bash(mvn *)'] } },
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
    await rm(home, { recursive: true, force: true });
    await rm(path, { recursive: true, force: true });
    await rm(socketPathFor(name), { force: true });
  });

  assert.ok(await untilSaid(() => said, /spawning:/), `never spawned:\n${said}`);
  return {
    platform,
    path,
    record,
    said: () => said,
    untilSaid: (pattern) => untilSaid(() => said, pattern),
    spawnLine: () => said.split('\n').find((each) => each.includes('spawning:')) ?? '',
  };
}

/** The `--allowedTools` half of the spawn line, one tool per entry. */
function toolsOn(line) {
  const after = line.slice(line.indexOf('--allowedTools') + '--allowedTools'.length)
    .replace(/\(prompt on stdin\)\s*$/, '').trim();
  return after.match(/\S+\([^)]*\)|\S+/g) ?? [];
}

test('a release is prepared a working copy on the release branch, like a coding run',
    async (t) => {
      const { said, untilSaid } = await daemonWith(t, { name: 'test-release-branch' });
      // It commits, tags and pushes, so it needs the branch cut and the copy
      // prepared — that is `writesCodeProfile`, and it is why a release counts
      // against the coding cap.
      assert.ok(await untilSaid(/working copy .* is on release-v9\.9\.9/), said());
      assert.doesNotMatch(said(), /nothing prepared/);
      // And the daemon says what the platform let it write, where the
      // operator can see it.
      assert.match(said(), /a release session may write: backend\/pom\.xml, openapi\.yaml, tools\/package\.json/);
    });

test('it may write the version files, run git, gh pr create and node, and NOTHING else',
    async (t) => {
      const { spawnLine } = await daemonWith(t, { name: 'test-release-tools' });
      const line = spawnLine();
      const tools = toolsOn(line);

      // What it has. Both verbs on each version file, for the reason
      // `conflictedWrites` gives: an existing file is changed with one and
      // rewritten whole with the other.
      for (const file of VERSION_FILES) {
        assert.ok(tools.includes(`Write(${file})`), `no Write(${file}) in:\n${line}`);
        assert.ok(tools.includes(`Edit(${file})`), `no Edit(${file}) in:\n${line}`);
      }
      assert.ok(tools.includes('Bash(git *)'), line);
      assert.ok(tools.includes('Bash(gh pr create *)'), line);
      assert.ok(tools.includes('Bash(gh pr view *)'), line);
      assert.ok(tools.includes('Bash(node *)'), line);
      // The three cawdev writers the procedure uses — an entry, an entry's
      // version, a card's status — and the reads, `ask_user` among them: the
      // OWNER who pressed the button is watching.
      assert.ok(tools.includes('mcp__cawdev__changelog_add'), line);
      assert.ok(tools.includes('mcp__cawdev__changelog_update'), line);
      assert.ok(tools.includes('mcp__cawdev__roadmap_set_status'), line);
      assert.ok(tools.includes('mcp__cawdev__ask_user'), line);
      assert.ok(tools.includes('Read'), line);

      // What it has NOT — the half that proves the profile exists.
      //
      // No permission prompt and no permission mode: `argsForProfile` strips
      // both from every profile that is not CODE, and RELEASE is not CODE.
      // "Cannot" must not quietly become "not yet".
      assert.doesNotMatch(line, /--permission-prompt-tool/);
      assert.doesNotMatch(line, /--permission-mode/);
      assert.doesNotMatch(line, /bypassPermissions/);
      // Not the project's extras. `Bash(mvn *)` is permitted to a coding run
      // on this project and a release is not a coding run.
      assert.ok(!tools.includes('Bash(mvn *)'),
        `a release session was spawned with the project's build tools:\n${line}`);
      // `gh pr create`, not `gh`. It opens the pull request and cannot merge
      // it; a release is merged by a person, with a merge commit.
      assert.ok(!tools.includes('Bash(gh *)'), line);
      assert.doesNotMatch(line, /gh pr merge/);
      // No bare writer, and no writer on an export: `ROADMAP.md`,
      // `ISSUES.md` and `CHANGELOG.md` are unwritable by hand as a permission.
      assert.ok(!tools.includes('Write'), `a bare Write in:\n${line}`);
      assert.ok(!tools.includes('Edit'), `a bare Edit in:\n${line}`);
      const writes = tools.filter((each) => /^(Write|Edit)\(/.test(each)).sort();
      assert.deepEqual(writes,
        VERSION_FILES.flatMap((file) => [`Edit(${file})`, `Write(${file})`]).sort(),
        `a release session may write something that is not a version file:\n${writes.join(' ')}`);
      // And nothing that files a card or proposes one.
      assert.doesNotMatch(line, /mcp__cawdev__roadmap_create/);
      assert.doesNotMatch(line, /mcp__cawdev__propose_entry/);
    });

test('the prompt says what it may do, then hands over the platform\'s procedure', async (t) => {
  const { record } = await daemonWith(t, { name: 'test-release-prompt' });
  const prompt = await untilWritten(record);
  assert.ok(prompt, 'the agent was never given a prompt on stdin');

  // The preamble is the daemon's — where it stands and what it is allowed, in
  // the terms the permission list uses, so it spends no turns finding out.
  assert.match(prompt, /^You are cutting a release in a working copy on branch `release-v9\.9\.9`/);
  assert.match(prompt, /`backend\/pom\.xml`, `openapi\.yaml`, `tools\/package\.json`/);
  assert.match(prompt, /There is no permission prompt in this session/);
  assert.match(prompt, /cannot merge a pull\s+request, run a build, or run tests/);
  // The procedure is the platform's, composed with the version and the cards,
  // and it arrives whole.
  assert.ok(prompt.includes(OPENING), `the opening prompt was not handed over:\n${prompt}`);
});

test('a project that declares no version files yields a session with no writer at all',
    async (t) => {
      // An empty list is not a fallback to "anything". A platform older than
      // R187 sends nothing here, and since i189 so does a project whose owner
      // has declared no version files; the honest outcome either way is a
      // session that cannot bump the version and says so — not one that could
      // write wherever it liked because the list was missing.
      const { spawnLine, record } = await daemonWith(t, {
        name: 'test-release-no-list',
        releaseWrites: null,
      });
      const tools = toolsOn(spawnLine());
      assert.deepEqual(tools.filter((each) => /^(Write|Edit)/.test(each)), []);
      assert.ok(tools.includes('Bash(git *)'));
      const prompt = await untilWritten(record);
      assert.match(prompt, /declares no version files, so say so in your report/);
    });
