// node --test tools/runner/bootstrap.test.mjs
//
// R93 — a machine sets itself up, and the three things that must be true of it.
//
// **Nothing is created until everything is known.** The walk asks, resolves
// every checkout, and only then mints a token and writes a file — so a setup
// abandoned in the middle leaves no credential on the tokens page and no config
// pointing at half a machine. That is what makes "run it again" the whole
// recovery procedure, and it is the first thing tested here.
//
// **The file is 0600.** It holds a token that lets a machine run agents in your
// repositories, and a runner is exactly the kind of box with other people on
// it.
//
// **The choice is `select.mjs`'s.** R83's rule is one widget, and a second
// parser for "1, 3" living in the setup walk is the drift that rule exists to
// prevent.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkoutFor,
  configFor,
  mintRunnerToken,
  servable,
  setUpThisMachine,
  writeRunnerConfig,
} from './bootstrap.mjs';
import { Select, pickManyFromLine } from './select.mjs';

/** A session that answers the two calls the walk makes, and records them. */
function fakeSession({ projects = [], email = 'you@example.com' } = {}) {
  const seen = [];
  return {
    signedIn: true,
    email,
    seen,
    async request(path, options = {}) {
      seen.push(`${options.method ?? 'GET'} ${path}`);
      if (path === '/api/projects') {
        return projects;
      }
      if (path === '/api/agent-tokens') {
        seen.push(JSON.stringify(options.body.grants));
        return { secret: 'cawd_minted', token: { id: 'abc' } };
      }
      throw new Error(`unexpected ${path}`);
    },
  };
}

/** Answers, in order. An exhausted script is a walk asking more than it should. */
function scriptedAsker(answers) {
  const asked = [];
  let at = 0;
  return {
    asked,
    line(prompt) {
      asked.push(prompt);
      if (at >= answers.length) {
        throw new Error(`asked one question too many: ${prompt}`);
      }
      return Promise.resolve(answers[at++]);
    },
    close() {},
  };
}

const quiet = () => {};

async function aTempHome() {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-setup-'));
  return { home, clean: () => rm(home, { recursive: true, force: true }) };
}

const A_PROJECT = {
  slug: 'board',
  name: 'Board',
  gitUrl: 'git@example.com:you/board.git',
  yourRole: 'WRITER',
  archived: false,
};

test('only projects the mint would accept are offered', () => {
  const offered = servable([
    A_PROJECT,
    { ...A_PROJECT, slug: 'reading', yourRole: 'READER' },
    { ...A_PROJECT, slug: 'retired', archived: true },
    { ...A_PROJECT, slug: 'yours', yourRole: 'OWNER' },
  ]);

  assert.deepEqual(offered.map((project) => project.slug), ['board', 'yours'],
    'a project you can only read would have been offered and then refused');
});

test('the config written is the smallest one that boots', () => {
  const config = configFor({
    url: 'https://cawdev.example',
    token: 'cawd_x',
    name: 'laptop',
    entries: [{ slug: 'board', path: '/home/you/cawdev/board' }],
  });

  assert.deepEqual(config, {
    url: 'https://cawdev.example',
    token: 'cawd_x',
    name: 'laptop',
    projects: { board: '/home/you/cawdev/board' },
  }, 'a generated file that writes out every default is one nobody dares edit');
});

test('a slug can never write outside the checkout root', () => {
  assert.equal(checkoutFor('/home/you/cawdev', 'board'), '/home/you/cawdev/board');
  // The separator is gone, so what is left cannot traverse…
  assert.equal(checkoutFor('/home/you/cawdev', '../../etc'), '/home/you/cawdev/..-..-etc');
  // …except for the one name that traverses without one, which `join` walks up.
  assert.equal(checkoutFor('/home/you/cawdev', '..'), '/home/you/cawdev/-');
  assert.equal(checkoutFor('/home/you/cawdev', '.'), '/home/you/cawdev/-');
});

test('the config holding the machine token is readable by nobody else', async (t) => {
  const machine = await aTempHome();
  t.after(machine.clean);
  const path = join(machine.home, 'runner.config.json');

  // Twice, because `mode` on writeFile is ignored for a file that already
  // exists — the second write is where this used to go wrong.
  await writeFile(path, '{}', { mode: 0o644 });
  await writeRunnerConfig(path, { token: 'cawd_x' });

  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { token: 'cawd_x' });
});

test('the token minted is runner:operate on the chosen projects and nothing else', async () => {
  const session = fakeSession();
  const secret = await mintRunnerToken(session, ['board', 'other'], 'laptop');

  assert.equal(secret, 'cawd_minted');
  assert.ok(session.seen.includes('{"board":["runner:operate"],"other":["runner:operate"]}'),
    session.seen.join(' | '));
});

test('one project is served without asking which', async (t) => {
  const machine = await aTempHome();
  t.after(machine.clean);
  const cloned = [];

  const result = await setUpThisMachine({
    url: 'https://cawdev.example',
    session: fakeSession({ projects: [A_PROJECT] }),
    // The root, then the Claude Code confirmation. No project question: there
    // is only one answer and asking for it is a form pretending to be a
    // conversation.
    ask: scriptedAsker([machine.home, 'y']),
    say: quiet,
    clone: (gitUrl, path) => {
      cloned.push([gitUrl, path]);
      return Promise.resolve();
    },
    agent: () => Promise.resolve('/usr/local/bin/claude'),
    configPath: join(machine.home, 'runner.config.json'),
  });

  assert.deepEqual(cloned, [[A_PROJECT.gitUrl, join(machine.home, 'board')]]);
  assert.deepEqual(result.config.projects, { board: join(machine.home, 'board') });
  assert.equal(result.config.token, 'cawd_minted');
});

test('several projects are chosen by number, and only those are cloned', async (t) => {
  const machine = await aTempHome();
  t.after(machine.clean);
  const cloned = [];
  const session = fakeSession({
    projects: [A_PROJECT, { ...A_PROJECT, slug: 'second' }, { ...A_PROJECT, slug: 'third' }],
  });

  const result = await setUpThisMachine({
    url: 'https://cawdev.example',
    session,
    ask: scriptedAsker(['1 3', machine.home, 'y']),
    say: quiet,
    clone: (gitUrl, path) => {
      cloned.push(path);
      return Promise.resolve();
    },
    agent: () => Promise.resolve('/usr/local/bin/claude'),
    configPath: join(machine.home, 'runner.config.json'),
  });

  assert.deepEqual(Object.keys(result.config.projects), ['board', 'third']);
  assert.equal(cloned.length, 2);
  assert.ok(session.seen.includes('{"board":["runner:operate"],"third":["runner:operate"]}'),
    'the token was minted for a project this machine does not serve');
});

test('saying Claude Code is not signed in creates nothing at all', async (t) => {
  const machine = await aTempHome();
  t.after(machine.clean);
  const session = fakeSession({ projects: [A_PROJECT] });
  let written = false;

  await assert.rejects(
    setUpThisMachine({
      url: 'https://cawdev.example',
      session,
      ask: scriptedAsker([machine.home, 'n']),
      say: quiet,
      clone: () => Promise.resolve(),
      write: () => {
        written = true;
        return Promise.resolve();
      },
      agent: () => Promise.resolve(null),
      configPath: join(machine.home, 'runner.config.json'),
    }),
    /Sign in first/,
  );

  assert.equal(written, false, 'a config was written for a machine that cannot run anything');
  assert.ok(!session.seen.some((call) => call.startsWith('POST /api/agent-tokens')),
    'a token was left on the tokens page by a setup that did not finish');
});

test('a project with no git URL is asked about rather than skipped or guessed', async (t) => {
  const machine = await aTempHome();
  t.after(machine.clean);

  const result = await setUpThisMachine({
    url: 'https://cawdev.example',
    session: fakeSession({ projects: [{ ...A_PROJECT, gitUrl: null }] }),
    ask: scriptedAsker([machine.home, '/somewhere/board', 'y']),
    say: quiet,
    clone: () => assert.fail('nothing to clone from'),
    agent: () => Promise.resolve('/usr/local/bin/claude'),
    configPath: join(machine.home, 'runner.config.json'),
  });

  assert.deepEqual(result.config.projects, { board: '/somewhere/board' });
});

test('a checkout already there is used rather than cloned over', async (t) => {
  const machine = await aTempHome();
  t.after(machine.clean);
  await writeFile(join(machine.home, 'board'), 'not really a checkout, but it exists');

  const result = await setUpThisMachine({
    url: 'https://cawdev.example',
    session: fakeSession({ projects: [A_PROJECT] }),
    ask: scriptedAsker([machine.home, 'y']),
    say: quiet,
    clone: () => assert.fail('it cloned over a directory that was already there'),
    agent: () => Promise.resolve('/usr/local/bin/claude'),
    configPath: join(machine.home, 'runner.config.json'),
  });

  assert.deepEqual(result.config.projects, { board: join(machine.home, 'board') });
});

test('a line naming a row that is not there settles nothing', () => {
  const select = new Select({ rows: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });

  assert.deepEqual(pickManyFromLine(select, '1, 2').map((row) => row.id), ['a', 'b']);
  assert.deepEqual(pickManyFromLine(select, '2 2').map((row) => row.id), ['b'], 'a repeat is one row');
  // The whole line, not the part that worked: somebody who typed three numbers
  // meant three, and two of them is a wrong answer wearing a right one's clothes.
  assert.deepEqual(pickManyFromLine(select, '1 9'), []);
  assert.deepEqual(pickManyFromLine(select, 'all'), []);
  assert.deepEqual(pickManyFromLine(select, ''), []);
});
