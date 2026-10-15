// node --test tools/runner/configure.test.mjs
//
// R283 — the granular half of R93's setup walk: one change to a config that
// already exists, rather than the whole thing re-asked.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stripAnsi } from '../lib/ansi.mjs';
import {
  CREATE_A_PROJECT, addProject, addWorkspace, reloadIfRunning, removeProject, resolveTokenId, setAcceptsRulesFromConsole,
  setQuality, setAgentEnabled,
} from './configure.mjs';

const quiet = () => {};
/** R289: nothing on disk is read for these — every path is "new folder". */
const nothingThere = async () => ({ kind: 'missing' });

function scriptedAsker(answers) {
  let at = 0;
  return {
    line(prompt) {
      if (at >= answers.length) {
        throw new Error(`asked one question too many: ${prompt}`);
      }
      return Promise.resolve(answers[at++]);
    },
    close() {},
  };
}

function fakeSession({ projects = [], tokens = [], grantsSeen = [], mints = [], created = [], order = [] } = {}) {
  return {
    signedIn: true,
    email: 'you@example.com',
    grantsSeen,
    mints,
    async request(path, options = {}) {
      if (path === '/api/projects' && options.method === 'POST') {
        created.push(options.body);
        order.push('create');
        return { slug: `you-${options.body.name.toLowerCase()}`, name: options.body.name, gitUrl: options.body.gitUrl };
      }
      if (path.startsWith('/api/projects/slug-suggestion?name=')) {
        return { slug: `you-${decodeURIComponent(path.split('=')[1]).toLowerCase()}` };
      }
      if (path === '/api/projects') return projects;
      if (path === '/api/tokens' && (options.method ?? 'GET') === 'GET') return tokens;
      if (path === '/api/tokens' && options.method === 'POST') {
        mints.push(options.body);
        return { secret: 'cawd_minted_fresh', token: { id: 'tok-new' } };
      }
      const grantsMatch = /^\/api\/tokens\/([^/]+)\/grants$/.exec(path);
      if (grantsMatch && options.method === 'PUT') {
        grantsSeen.push({ id: grantsMatch[1], grants: options.body.grants });
        return { id: grantsMatch[1] };
      }
      throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
    },
  };
}

/** `mkdir(dirname(path), ...)` runs for real even with `clone` faked, so
 * every test that clones needs a real, writable directory underneath it. */
async function aTempHome() {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-configure-'));
  return { home, clean: () => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

function capturingWrite() {
  const calls = [];
  return { write: async (path, config) => calls.push({ path, config }), calls };
}

const A_PROJECT = {
  slug: 'board', name: 'Board', gitUrl: 'git@example.com:you/board.git',
  yourRole: 'WRITER', archived: false,
};
const B_PROJECT = { ...A_PROJECT, slug: 'other', name: 'Other', gitUrl: 'git@example.com:you/other.git' };

// --- resolveTokenId --------------------------------------------------------

test('the token id in the config file wins, with no network call at all', async () => {
  const session = fakeSession();
  const id = await resolveTokenId(session, { tokenId: 'tok-file' }, 'https://cawdev.example');
  assert.equal(id, 'tok-file');
});

test('falling back to a lookup by label, for a token minted before R283', async () => {
  const session = fakeSession({
    tokens: [{ id: 'tok-old', label: 'laptop (runner)', revoked: false }],
  });
  const id = await resolveTokenId(session, { name: 'laptop' }, 'https://cawdev.example');
  assert.equal(id, 'tok-old');
});

test('a revoked token with the right label is not offered', async () => {
  const session = fakeSession({
    tokens: [{ id: 'tok-old', label: 'laptop (runner)', revoked: true }],
  });
  assert.equal(await resolveTokenId(session, { name: 'laptop' }, 'https://cawdev.example'), null);
});

// --- addProject -------------------------------------------------------------

test('adding a project widens the existing token in place — no new secret', async (t) => {
  const machine = await aTempHome();
  t.after(machine.clean);
  const session = fakeSession({ projects: [A_PROJECT, B_PROJECT] });
  const { write, calls } = capturingWrite();
  const cloned = [];

  const result = await addProject({
    configPath: join(machine.home, 'board', 'runner.config.json'),
    file: {
      url: 'https://cawdev.example', name: 'laptop', tokenId: 'tok-abc',
      projects: { board: join(machine.home, 'board') },
    },
    url: 'https://cawdev.example',
    session,
    // The project is picked from the list even when it is the only one; then
    // R289's first suggestion is beside the checkout already served, and a
    // clone is confirmed once (enter is yes).
    ask: scriptedAsker(['1', '1', '']),
    inspect: nothingThere,
    say: quiet,
    clone: (gitUrl, path) => { cloned.push([gitUrl, path]); return Promise.resolve(); },
    write,
  });

  assert.deepEqual(cloned, [[B_PROJECT.gitUrl, join(machine.home, 'other')]]);
  assert.deepEqual(session.grantsSeen, [
    { id: 'tok-abc', grants: { board: ['runner:operate'], other: ['runner:operate'] } },
  ]);
  assert.equal(session.mints.length, 0, 'no fresh token was minted');
  assert.equal(result.projects.other, join(machine.home, 'other'));
  assert.equal(result.token, undefined, 'the secret is untouched — only the grants moved');
  assert.equal(calls.length, 1);
});

test('adding a project mints a fresh token when the old one cannot be found', async (t) => {
  const machine = await aTempHome();
  t.after(machine.clean);
  const session = fakeSession({ projects: [A_PROJECT] });
  const { write } = capturingWrite();

  const result = await addProject({
    configPath: join(machine.home, 'runner.config.json'),
    file: { url: 'https://cawdev.example', name: 'laptop', projects: {} },
    url: 'https://cawdev.example',
    session,
    // The one suggestion is the default root, which this test must not create
    // for real — so the project (row 1), "type a path" (row 2), then the path,
    // then yes to the clone.
    ask: scriptedAsker(['1', '2', join(machine.home, 'x'), '']),
    inspect: nothingThere,
    say: quiet,
    clone: () => Promise.resolve(),
    write,
  });

  assert.equal(session.mints.length, 1);
  assert.equal(result.token, 'cawd_minted_fresh');
  assert.equal(result.tokenId, 'tok-new');
});

test('the one project left is NAMED in a list, beside "Create a new project"', async () => {
  const session = fakeSession({ projects: [A_PROJECT] });
  const shown = [];
  await assert.rejects(addProject({
    configPath: '/code/runner.config.json',
    file: { projects: {} },
    url: 'https://cawdev.example',
    session,
    ask: scriptedAsker([]),
    say: quiet,
    pick: (_ask, _say, select) => { shown.push(select); throw new Error('stop here'); },
  }), /stop here/);
  assert.deepEqual(shown[0].rows.map((row) => row.label), ['Board', 'Create a new project on cawdev']);
});

test('nothing left to add still offers to create one', async () => {
  const session = fakeSession({ projects: [A_PROJECT] });
  const shown = [];
  await assert.rejects(addProject({
    configPath: '/code/board/runner.config.json',
    file: { projects: { board: '/code/board' } },
    url: 'https://cawdev.example',
    session,
    ask: scriptedAsker([]),
    say: quiet,
    pick: (_ask, _say, select) => { shown.push(select); throw new Error('stop here'); },
  }), /stop here/);
  assert.match(shown[0].title, /already here — create a new one\?/);
  assert.deepEqual(shown[0].rows.map((row) => row.id), [CREATE_A_PROJECT]);
});

test('creating a project: name, repository, checkout — and only then the POST', async (t) => {
  const machine = await aTempHome();
  t.after(machine.clean);
  const created = [];
  const order = [];
  const session = fakeSession({ projects: [], created, order });
  const { write } = capturingWrite();
  const said = [];

  const result = await addProject({
    configPath: join(machine.home, 'runner.config.json'),
    file: { url: 'https://cawdev.example', name: 'laptop', tokenId: 'tok-abc', projects: {} },
    url: 'https://cawdev.example',
    session,
    // Create (row 1, the only one), the name, the git URL, type a path (row
    // 2), the path, yes to the clone, yes to the creation.
    ask: scriptedAsker(['1', 'Billing', 'git@example.com:you/billing.git', '2', join(machine.home, 'billing'), '', '']),
    inspect: nothingThere,
    say: (line) => said.push(stripAnsi(line)),
    clone: (gitUrl, path) => { order.push(`clone ${gitUrl} ${path}`); return Promise.resolve(); },
    write,
  });

  assert.deepEqual(created, [{ name: 'Billing', gitUrl: 'git@example.com:you/billing.git' }]);
  assert.match(order[0], /^clone /, 'cloned before anything was created on cawdev');
  assert.equal(order[1], 'create');
  assert.equal(result.projects['you-billing'], join(machine.home, 'billing'));
  assert.deepEqual(session.grantsSeen, [{ id: 'tok-abc', grants: { 'you-billing': ['runner:operate'] } }]);
  assert.ok(said.some((line) => /It will be you-billing on https:\/\/cawdev\.example/.test(line)));
  assert.ok(said.some((line) => /cawdev\.example\/projects\/you-billing\/setup/.test(line)));
});

test('creating with no git URL takes the origin of the checkout already there', async () => {
  const created = [];
  const session = fakeSession({ projects: [], created });
  const result = await addProject({
    configPath: '/code/runner.config.json',
    file: { tokenId: 'tok-abc', projects: {} },
    url: 'https://cawdev.example',
    session,
    ask: scriptedAsker(['1', 'Billing', '', '2', '/code/billing', '', '']),
    inspect: async () => ({ kind: 'checkout', remote: 'git@example.com:you/billing.git', matches: null }),
    say: quiet,
    write: async () => {},
  });
  assert.deepEqual(created, [{ name: 'Billing', gitUrl: 'git@example.com:you/billing.git' }]);
  assert.equal(result.projects['you-billing'], '/code/billing');
});

test('declining the creation leaves cawdev untouched and says the checkout stays', async () => {
  const created = [];
  const session = fakeSession({ projects: [], created });
  await assert.rejects(addProject({
    configPath: '/code/runner.config.json',
    file: { projects: {} },
    url: 'https://cawdev.example',
    session,
    ask: scriptedAsker(['1', 'Billing', '', '2', '/code/billing', '', 'n']),
    inspect: async () => ({ kind: 'checkout', remote: 'git@example.com:you/billing.git', matches: null }),
    say: quiet,
  }), /Nothing created on cawdev; the checkout at \/code\/billing stays/);
  assert.deepEqual(created, []);
});

// --- addWorkspace ------------------------------------------------------------

test('a bare path becomes {workspaces} with the new one appended', async (t) => {
  const machine = await aTempHome();
  t.after(machine.clean);
  const board = join(machine.home, 'board');
  const board2 = join(machine.home, 'board-2');
  const { write, calls } = capturingWrite();
  const cloned = [];

  const result = await addWorkspace({
    configPath: join(machine.home, 'runner.config.json'),
    file: { projects: { board } },
    session: fakeSession({ projects: [A_PROJECT] }),
    url: 'https://cawdev.example',
    ask: scriptedAsker(['1', '']),
    inspect: nothingThere,
    say: quiet,
    clone: (gitUrl, path) => { cloned.push([gitUrl, path]); return Promise.resolve(); },
    write,
  });

  assert.deepEqual(result.projects.board, { workspaces: [board, board2] });
  assert.deepEqual(cloned, [[A_PROJECT.gitUrl, board2]]);
  assert.equal(calls.length, 1);
});

test('an existing {workspaces} entry just grows by one, taking the first suggestion', async () => {
  const { write } = capturingWrite();
  const result = await addWorkspace({
    configPath: '/code/x/runner.config.json',
    file: { projects: { board: { workspaces: ['/a', '/b'] } } },
    session: fakeSession({ projects: [A_PROJECT] }),
    url: 'https://cawdev.example',
    // Only one project, so nothing is asked WHICH — but the checkout path is
    // always asked: row 1 is `/a-2` — the first number FREE beside the first
    // checkout, not one more than the count — and the clone is confirmed once.
    ask: scriptedAsker(['1', '']),
    inspect: nothingThere,
    say: quiet,
    clone: () => Promise.resolve(),
    write,
  });
  assert.deepEqual(result.projects.board.workspaces, ['/a', '/b', '/a-2']);
});

test('a duplicate path is refused', async () => {
  await assert.rejects(
    addWorkspace({
      configPath: '/code/x/runner.config.json',
      file: { projects: { board: '/code/board' } },
      session: fakeSession({ projects: [A_PROJECT] }),
      url: 'https://cawdev.example',
      // Suggestions are board-2 and the default root's; the third row types.
      ask: scriptedAsker(['3', '/code/board']),
      inspect: nothingThere,
      say: quiet,
    }),
    /already a workspace/,
  );
});

// --- agent toggle -------------------------------------------------------------

test('enabling an agent checks the PATH and asks for a sign-in confirmation', async () => {
  const { write } = capturingWrite();
  const result = await setAgentEnabled({
    file: { agentCommands: ['claude'] },
    configPath: '/code/x/runner.config.json',
    enabled: true,
    command: 'agy',
    ask: scriptedAsker(['y']),
    say: quiet,
    write,
    agent: async () => [{ command: 'agy', where: '/usr/local/bin/agy' }],
  });
  assert.deepEqual(result.agentCommands, ['claude', 'agy']);
});

test('enabling an agent not on PATH is refused', async () => {
  await assert.rejects(
    setAgentEnabled({
      file: { agentCommands: ['claude'] },
      configPath: '/code/x/runner.config.json',
      enabled: true,
      command: 'agy',
      ask: scriptedAsker([]),
      say: quiet,
      agent: async () => [],
    }),
    /not on this machine's PATH/,
  );
});

test('disabling the last agent is refused', async () => {
  await assert.rejects(
    setAgentEnabled({
      file: { agentCommands: ['claude'] },
      configPath: '/code/x/runner.config.json',
      enabled: false,
      command: 'claude',
      ask: scriptedAsker([]),
      say: quiet,
    }),
    /at least one agent/,
  );
});

test('disabling one of two just removes it', async () => {
  const { write } = capturingWrite();
  const result = await setAgentEnabled({
    file: { agentCommands: ['claude', 'agy'] },
    configPath: '/code/x/runner.config.json',
    enabled: false,
    command: 'agy',
    ask: scriptedAsker([]),
    say: quiet,
    write,
  });
  assert.deepEqual(result.agentCommands, ['claude']);
});

// --- removing a project -------------------------------------------------------

test('stopping serving a project drops its entry, names its checkouts and leaves them', async () => {
  const { write, calls } = capturingWrite();
  const said = [];
  const result = await removeProject({
    file: { name: 'laptop', projects: { cawdev: '/code/cawdev', ngsign: { workspaces: ['/code/ngsign', '/code/ngsign-2'] } } },
    configPath: '/code/x/runner.config.json',
    slug: 'ngsign',
    ask: scriptedAsker(['y']),
    say: (line) => said.push(stripAnsi(line)),
    write,
  });
  assert.deepEqual(result.projects, { cawdev: '/code/cawdev' });
  assert.equal(result.name, 'laptop', 'every other key as it was');
  assert.equal(calls.length, 1);
  assert.match(said.join('\n'), /no longer serves ngsign/);
});

test('declining, or naming a project not served, changes nothing', async () => {
  const { write, calls } = capturingWrite();
  const file = { projects: { ngsign: '/code/ngsign' } };
  await assert.rejects(removeProject({
    file, configPath: '/x', slug: 'ngsign', ask: scriptedAsker(['n']), say: quiet, write,
  }), /Nothing changed/);
  await assert.rejects(removeProject({
    file, configPath: '/x', slug: 'saasng', ask: scriptedAsker([]), say: quiet, write,
  }), /does not serve saasng/);
  assert.equal(calls.length, 0);
});

// --- acceptsRulesFromConsole ---------------------------------------------------

test('turning it on asks for confirmation, spelling out the risk', async () => {
  const { write, calls } = capturingWrite();
  const result = await setAcceptsRulesFromConsole({
    file: { acceptsRulesFromConsole: false },
    configPath: '/code/x/runner.config.json',
    enabled: true,
    ask: scriptedAsker(['y']),
    say: quiet,
    write,
  });
  assert.equal(result.acceptsRulesFromConsole, true);
  assert.equal(calls.length, 1);
});

test('declining the confirmation changes nothing', async () => {
  const { write, calls } = capturingWrite();
  await assert.rejects(
    setAcceptsRulesFromConsole({
      file: { acceptsRulesFromConsole: false },
      configPath: '/code/x/runner.config.json',
      enabled: true,
      ask: scriptedAsker(['n']),
      say: quiet,
      write,
    }),
  );
  assert.equal(calls.length, 0);
});

test('turning it off asks nothing — narrowing is always allowed', async () => {
  const { write } = capturingWrite();
  const result = await setAcceptsRulesFromConsole({
    file: { acceptsRulesFromConsole: true },
    configPath: '/code/x/runner.config.json',
    enabled: false,
    ask: scriptedAsker([]),
    say: quiet,
    write,
  });
  assert.equal(result.acceptsRulesFromConsole, false);
});

// --- quality — R300 -------------------------------------------------------------

test('turning a scan on writes the block with the defaults offered, and touches nothing else', async () => {
  const { write, calls } = capturingWrite();
  const result = await setQuality({
    file: { name: 'laptop', projects: { cawdev: { workspaces: ['/code/cawdev'], browser: false } } },
    configPath: '/code/x/runner.config.json',
    slug: 'cawdev',
    enabled: true,
    ask: scriptedAsker(['', '', '']), // Enter three times: the defaults
    say: quiet,
    write,
  });
  assert.deepEqual(result.projects.cawdev, {
    workspaces: ['/code/cawdev'],
    browser: false,
    quality: { command: 'sonar-scanner', tokenEnv: 'SONAR_TOKEN', whenBranchesRefused: 'skip' },
  });
  assert.equal(calls.length, 1);
  // The token itself is never asked for and never written.
  assert.doesNotMatch(JSON.stringify(result), /sqp_|token":/);
});

test('a typed command and variable are what is written', async () => {
  const { write } = capturingWrite();
  const result = await setQuality({
    file: { projects: { cawdev: '/code/cawdev' } },
    configPath: '/code/x/runner.config.json',
    slug: 'cawdev',
    enabled: true,
    ask: scriptedAsker(['/opt/sonar/bin/sonar-scanner', 'MY_SONAR_TOKEN', '']),
    say: quiet,
    write,
  });
  // A bare path is promoted to {workspaces} on the way, R47's third form.
  assert.deepEqual(result.projects.cawdev, {
    workspaces: ['/code/cawdev'],
    quality: { command: '/opt/sonar/bin/sonar-scanner', tokenEnv: 'MY_SONAR_TOKEN', whenBranchesRefused: 'skip' },
  });
});

test('R316: answering "project" to the third question writes it', async () => {
  const { write } = capturingWrite();
  const result = await setQuality({
    file: { projects: { cawdev: '/code/cawdev' } },
    configPath: '/code/x/runner.config.json',
    slug: 'cawdev',
    enabled: true,
    ask: scriptedAsker(['', '', 'project']),
    say: quiet,
    write,
  });
  assert.equal(result.projects.cawdev.quality.whenBranchesRefused, 'project');
});

test('R316: an unknown whenBranchesRefused is refused, naming the three values', async () => {
  const { write } = capturingWrite();
  await assert.rejects(
    setQuality({
      file: { projects: { cawdev: '/code/cawdev' } },
      configPath: '/code/x/runner.config.json',
      slug: 'cawdev',
      enabled: true,
      ask: scriptedAsker(['', '', 'sometimes']),
      say: quiet,
      write,
    }),
    /"whenBranchesRefused" is "skip", "main" or "project" — not "sometimes"/,
  );
});

test('R316: a "whenBranchesRefused" argument skips the third question entirely', async () => {
  const { write } = capturingWrite();
  const result = await setQuality({
    file: { projects: { cawdev: { workspaces: ['/code/cawdev'],
      quality: { command: 'sonar-scanner', tokenEnv: 'SONAR_TOKEN', whenBranchesRefused: 'main' } } } },
    configPath: '/code/x/runner.config.json',
    slug: 'cawdev',
    enabled: true,
    command: 'sonar-scanner',
    tokenEnv: 'SONAR_TOKEN',
    whenBranchesRefused: 'project',
    ask: scriptedAsker([]),
    say: quiet,
    write,
  });
  assert.equal(result.projects.cawdev.quality.whenBranchesRefused, 'project');
});

test('turning it off removes the block and keeps the rest of the entry', async () => {
  const { write, calls } = capturingWrite();
  const result = await setQuality({
    file: { projects: { cawdev: {
      workspaces: ['/code/cawdev'], grantable: ['Bash(mvn *)'],
      quality: { command: 'sonar-scanner', tokenEnv: 'SONAR_TOKEN', whenBranchesRefused: 'main' },
    } } },
    configPath: '/code/x/runner.config.json',
    slug: 'cawdev',
    enabled: false,
    ask: scriptedAsker([]),
    say: quiet,
    write,
  });
  assert.deepEqual(result.projects.cawdev, { workspaces: ['/code/cawdev'], grantable: ['Bash(mvn *)'] });
  assert.equal(calls.length, 1);
});

test('turning off a scan that was not on writes nothing', async () => {
  const { write, calls } = capturingWrite();
  const file = { projects: { cawdev: '/code/cawdev' } };
  const result = await setQuality({
    file, configPath: '/code/x/runner.config.json', slug: 'cawdev', enabled: false,
    ask: scriptedAsker([]), say: quiet, write,
  });
  assert.equal(result, file);
  assert.equal(calls.length, 0);
});

test('a project this machine does not serve is refused, naming the ones it does', async () => {
  const { write, calls } = capturingWrite();
  await assert.rejects(
    setQuality({
      file: { projects: { cawdev: '/code/cawdev' } },
      configPath: '/code/x/runner.config.json', slug: 'other', enabled: true,
      ask: scriptedAsker([]), say: quiet, write,
    }),
    /does not serve other.*It serves: cawdev/,
  );
  assert.equal(calls.length, 0);
});

// --- reloadIfRunning -----------------------------------------------------------
//
// R294: what is printed is the DAEMON's verdict, read off its hello after the
// signal — never this door's guess about which keys the daemon can take.

/** A daemon's hello that re-reads its file on the signal, the way runner.mjs does. */
function daemon({ pid = 4242, restartNeeded = [], legacy = false } = {}) {
  const killed = [];
  let runner = legacy ? { pid } : { pid, configReadAt: '2026-09-20T10:00:00.000Z', restartNeeded: [] };
  return {
    killed,
    hello: async () => runner,
    kill: (to, signal) => {
      killed.push([to, signal]);
      if (!legacy) runner = { pid, configReadAt: '2026-09-20T10:00:01.000Z', restartNeeded };
    },
    tick: async () => {},
  };
}

test('no daemon running on this name means nothing to signal', async () => {
  const said = [];
  const reloaded = await reloadIfRunning('nobody-here', (line) => said.push(line), undefined, {
    hello: async () => null,
  });
  assert.deepEqual(reloaded, { running: false, applied: false, restartNeeded: [] });
  assert.deepEqual(said, []);
});

test('a live daemon is sent SIGHUP, and its own "applied" is repeated', async () => {
  const said = [];
  const live = daemon();
  const reloaded = await reloadIfRunning('laptop', (line) => said.push(line), undefined, live);
  assert.deepEqual(reloaded, { running: true, applied: true, restartNeeded: [] });
  assert.deepEqual(live.killed, [[4242, 'SIGHUP']]);
  assert.match(said.join('\n'), /pid 4242.*applied, no restart needed/);
});

test('a daemon that says "projects" needs a restart is repeated in those words, with how to restart', async () => {
  const said = [];
  const live = daemon({ restartNeeded: ['projects'] });
  const reloaded = await reloadIfRunning('laptop', (line) => said.push(line), undefined, {
    ...live, restartHint: 'q, then cawdev',
  });
  assert.deepEqual(reloaded, { running: true, applied: true, restartNeeded: ['projects'] });
  const text = stripAnsi(said.join('\n'));
  assert.match(text, /needs a restart to pick up projects — q, then cawdev/);
  assert.doesNotMatch(text, /no restart needed/);
});

test('a daemon that never re-reads the file is not claimed to have', async () => {
  const said = [];
  const live = daemon();
  live.kill = (to, signal) => live.killed.push([to, signal]); // signalled, nothing happens
  const reloaded = await reloadIfRunning('laptop', (line) => said.push(line), undefined, { ...live, waitMs: 50 });
  assert.deepEqual(reloaded, { running: true, applied: false, restartNeeded: [] });
  assert.match(stripAnsi(said.join('\n')), /did not re-read the file — restart it/);
});

test('a daemon too old to answer gets the door\'s own reading, and only then', async () => {
  const said = [];
  const live = daemon({ legacy: true });
  const reloaded = await reloadIfRunning('laptop', (line) => said.push(line), undefined, {
    ...live, fallback: ['projects'],
  });
  assert.deepEqual(reloaded, { running: true, applied: true, restartNeeded: ['projects'] });
  assert.match(stripAnsi(said.join('\n')), /needs a restart to pick up projects/);

  // The same old daemon, after a toggle it can take: the fallback is empty.
  const toggled = [];
  await reloadIfRunning('laptop', (line) => toggled.push(line), undefined, { ...daemon({ legacy: true }), fallback: [] });
  assert.match(stripAnsi(toggled.join('\n')), /applied, no restart needed/);
});

test('a daemon that answers is believed over the door\'s fallback', async () => {
  const said = [];
  const live = daemon({ restartNeeded: [] });
  const reloaded = await reloadIfRunning('laptop', (line) => said.push(line), undefined, {
    ...live, fallback: ['projects'],
  });
  assert.deepEqual(reloaded.restartNeeded, []);
});

test('a signal that cannot be sent says so and names the way out', async () => {
  const said = [];
  const reloaded = await reloadIfRunning('laptop', (line) => said.push(line), undefined, {
    hello: async () => ({ pid: 4242, configReadAt: 'x' }),
    kill: () => { throw new Error('EPERM'); },
  });
  assert.deepEqual(reloaded, { running: true, applied: false, restartNeeded: [] });
  assert.match(stripAnsi(said.join('\n')), /Could not signal.*EPERM.*restart it to pick this up: cawdev, then q, then cawdev again/);
});
