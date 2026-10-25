// node --test tools/runner/in-cli-config.test.mjs
//
// R288 — configuring this machine from inside the attached terminal.
//
// R283 built `cawdev config …` as a shell subcommand and the first person to
// launch the new CLI could not find it: they were attached, and nothing there
// mentioned configuration. So `c` and `/config` open the same functions through
// the terminal's own line editor and picker. What is pinned here is what the
// screen DECIDES: that a row shows the state it would change, that a chosen row
// writes the file configure.mjs would have written and signals the daemon the
// hello names, that Esc anywhere in a step changes nothing, and that the doors
// that must stay shut (an older daemon, no config file, not signed in) say so.
//
// The client is driven by handing it keys, as answering.test.mjs does.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripAnsi } from '../lib/ansi.mjs';
import { Attached, CANCELLED, configMenu, splitPrompt } from './attach.mjs';
import { TYPE_A_PATH } from './paths.mjs';

process.env.CAWDEV_HISTORY_FILE = join(mkdtempSync(join(tmpdir(), 'cawdev-history-')), 'h.json');

const ESC = '\x1b';

const CONFIG = {
  url: 'http://localhost:4200',
  token: 'cawdev_secret_value_nobody_should_see',
  name: 'laptop',
  acceptsRulesFromConsole: false,
  projects: { cawdev: '/tmp/checkouts/cawdev' },
  agentCommands: ['claude', 'agy'],
};

/** A config on disk, in a directory of its own, and a runner hello that names it. */
function configured(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cawdev-config-'));
  const path = join(dir, 'runner.config.json');
  writeFileSync(path, `${JSON.stringify({ ...CONFIG, ...over }, null, 2)}\n`);
  return { path, read: () => JSON.parse(readFileSync(path, 'utf8')) };
}

function client({ email = 'alice@cawdev.test', runner = null, replies = null, inspect = undefined } = {}) {
  const out = { write() {}, columns: 100, rows: 40, isTTY: true };
  const calls = [];
  const killed = [];
  const session = {
    url: 'http://localhost:4200',
    email,
    signedIn: Boolean(email),
    async request(path, options = {}) {
      calls.push({ path, ...options });
      return replies?.[path] ?? null;
    },
    async signOut() {},
  };
  const ui = new Attached('/tmp/none.sock', session, {
    out,
    kill: (pid, signal) => killed.push({ pid, signal }),
    ...(inspect ? { inspect } : {}),
  });
  ui.runner = runner;
  return { ui, calls, killed };
}

const hello = (configPath, over = {}) => ({
  name: 'laptop', pid: 4242, acceptsConsoleRules: false, agents: ['claude', 'agy'],
  projects: ['cawdev'], configPath, ...over,
});

async function until(is, what) {
  for (let tries = 0; tries < 400; tries++) {
    if (is()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.fail(what);
}
const overlay = (ui) => ui.overlayLines(100).map(stripAnsi).join('\n');
const said = (ui) => ui.pending.map(stripAnsi).join('\n');
const status = (ui) => stripAnsi(ui.status);

/** Press the digit of the row with this id, so a test names WHAT it picks. */
function pick(ui, id) {
  const at = ui.select.rows.findIndex((row) => row.id === id);
  assert.notEqual(at, -1, `no row ${id} in ${ui.select.rows.map((row) => row.id)}`);
  // R577: the menu grew past the nine rows a digit can reach, so the tail is
  // walked to with the arrow and confirmed with enter.
  if (at < 9) {
    ui.onKey(String(at + 1));
    return;
  }
  for (let step = 0; step < at; step += 1) ui.onKey('j');
  ui.onKey('\r');
}
const type = (ui, text) => {
  for (const key of text) ui.onKey(key);
};

// --- the rows say what they would change -------------------------------------

test('the menu names the change, and the hint carries the current state', () => {
  const menu = configMenu(CONFIG, hello('/x/runner.config.json'));
  const labels = Object.fromEntries(menu.rows.map((row) => [row.id, `${row.label} · ${row.hint}`]));
  assert.equal(menu.kind, 'config');
  assert.match(labels['add-project'], /Add a project — or create one on cawdev · serves cawdev/);
  assert.match(labels['add-workspace'], /cawdev: 1/);
  assert.match(labels['agent:claude'], /^Disable claude · spawned here now/);
  assert.match(labels['agent:agy'], /^Disable agy/);
  assert.match(labels.rules, /^Accept permission rules from the console · off now/);
  assert.match(labels.show, /runner\.config\.json/);
});

test('the planning-limit row says what the daemon was last told — R577', () => {
  const hintOf = (runner) => configMenu(CONFIG, runner).rows.find((row) => row.id === 'planning-limit');
  const none = hintOf(hello('/x/runner.config.json'));
  assert.equal(none.label, 'Limit planning runs at once');
  assert.equal(none.hint, 'no limit now');
  assert.equal(hintOf(hello('/x/runner.config.json', { maxPlanningRuns: 3 })).hint, '3 at once now');
});

test('the pause row is the change and the hint is the value now — R571', () => {
  const rowOf = (runner) => configMenu(CONFIG, runner).rows.find((row) => row.id === 'pause');
  const running = rowOf(hello('/x/runner.config.json'));
  assert.equal(running.label, 'Pause this machine — claim nothing new');
  assert.equal(running.hint, 'claiming now');
  const paused = rowOf(hello('/x/runner.config.json', { paused: true }));
  assert.equal(paused.label, 'Resume this machine — claim new runs again');
  assert.equal(paused.hint, 'paused now');
  const usage = rowOf(hello('/x/runner.config.json', { paused: true, pausedByUsage: true }));
  assert.equal(usage.label, 'Paused by cawdev for usage');
  assert.match(usage.hint, /resumes by itself/);
  assert.doesNotMatch(usage.label, /Resume this machine/);
});

test('an agent that is off is offered as "Enable", and rules that are on as "Stop"', () => {
  const menu = configMenu({ ...CONFIG, agentCommands: ['claude'], acceptsRulesFromConsole: true });
  const byId = Object.fromEntries(menu.rows.map((row) => [row.id, row.label]));
  assert.equal(byId['agent:claude'], 'Disable claude');
  assert.equal(byId['agent:agy'], 'Enable agy');
  assert.match(byId.rules, /^Stop accepting permission rules/);
});

test('a project in the file the daemon did not boot with is named "after a restart" — R294', () => {
  const file = { ...CONFIG, projects: { ...CONFIG.projects, dycrypt: '/tmp/checkouts/dycrypt' } };
  const menu = configMenu(file, hello('/x/runner.config.json', { restartNeeded: ['projects'] }));
  const row = menu.rows.find((each) => each.id === 'add-project');
  assert.equal(row.hint, 'serves cawdev · dycrypt after a restart');
  // The same file against a daemon that says nothing needs a restart: no split.
  const fresh = configMenu(file, hello('/x/runner.config.json', { projects: ['cawdev', 'dycrypt'] }));
  assert.equal(fresh.rows.find((each) => each.id === 'add-project').hint, 'serves cawdev, dycrypt');
});

test('every served project can be stopped, the ones cawdev no longer has first', () => {
  const file = { ...CONFIG, projects: { ...CONFIG.projects, ngsign: '/tmp/checkouts/ngsign' } };
  const rows = configMenu(file, hello('/x/runner.config.json'), new Set(['ngsign']))
    .rows.filter((row) => row.id.startsWith('remove:'));
  assert.deepEqual(rows.map((row) => `${row.label} · ${row.hint}`), [
    'Stop serving ngsign · not on cawdev any more',
    'Stop serving cawdev · its checkouts stay on disk',
  ]);
});

test('an agent the file names that this screen does not know still gets a row', () => {
  const menu = configMenu({ ...CONFIG, agentCommands: ['claude', 'codex'] });
  assert.ok(menu.rows.some((row) => row.id === 'agent:codex' && row.label === 'Disable codex'));
});

test('each served project gets a SonarQube row, saying whether it is scanned here now — R300', () => {
  const off = configMenu(CONFIG, hello('/x/runner.config.json'));
  const offRow = off.rows.find((row) => row.id === 'quality:cawdev');
  assert.equal(offRow.label, 'Scan cawdev with SonarQube after TEST');
  assert.equal(offRow.hint, 'not scanned here');

  const on = configMenu({ ...CONFIG, projects: { cawdev: {
    workspaces: ['/tmp/checkouts/cawdev'], quality: { command: 'sonar-scanner', tokenEnv: 'SONAR_TOKEN' },
  } } });
  const onRow = on.rows.find((row) => row.id === 'quality:cawdev');
  assert.equal(onRow.label, 'Stop scanning cawdev with SonarQube');
  assert.equal(onRow.hint, 'sonar-scanner after TEST now');
});

// --- the doors that stay shut --------------------------------------------------

test('c against a daemon that does not say where its config is says to restart it', async () => {
  const { ui } = client({ runner: { name: 'laptop', pid: 1 } });
  ui.onKey('c');
  await until(() => status(ui) !== '', 'a note');
  assert.match(status(ui), /older than this client/);
  assert.equal(ui.mode, 'keys');
});

test('c against a daemon run from the environment alone has nothing to edit', async () => {
  const { ui } = client({ runner: hello(null) });
  ui.onKey('c');
  await until(() => status(ui) !== '', 'a note');
  assert.match(status(ui), /no config file/);
});

test('c before the hello has arrived says so rather than guessing', async () => {
  const { ui } = client();
  ui.onKey('c');
  await until(() => status(ui) !== '', 'a note');
  assert.match(status(ui), /not connected/);
});

// --- the screen ------------------------------------------------------------------

test('c opens the config screen as a picker over the file the daemon booted from', async () => {
  const { path } = configured();
  const { ui } = client({ runner: hello(path) });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  assert.equal(ui.select.kind, 'config');
  const drawn = overlay(ui);
  assert.match(drawn, /this machine — laptop/);
  assert.match(drawn, /Disable claude/);
  assert.match(drawn, /Accept permission rules/);
  assert.match(drawn, /Show this machine's config/);
});

test('/config opens the same screen', async () => {
  const { path } = configured();
  const { ui } = client({ runner: hello(path) });
  type(ui, '/config');
  ui.onKey('\r');
  await until(() => ui.mode === 'select', 'the picker');
  assert.equal(ui.select.kind, 'config');
});

test('esc on the screen closes it and changes nothing', async () => {
  const { path, read } = configured();
  const { ui } = client({ runner: hello(path) });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  ui.onKey(ESC);
  await until(() => ui.configuring === null, 'the walk to end');
  assert.equal(ui.mode, 'keys');
  assert.equal(status(ui), 'nothing changed');
  assert.deepEqual(read().agentCommands, ['claude', 'agy']);
});

test('c while a step is open says so instead of opening a second walk', async () => {
  const { path } = configured();
  const { ui } = client({ runner: hello(path) });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'rules');
  await until(() => ui.mode === 'typing', 'the confirm line');
  // Esc closes the line and the step, so `c` can be pressed again afterwards.
  ui.onKey(ESC);
  await until(() => ui.configuring === null, 'the walk to end');
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker again');
  const walking = ui.configuring;
  ui.onKey(ESC);
  await until(() => ui.configuring === null, 'the walk to end');
  assert.ok(walking, 'the second press opened a walk once the first had ended');
});

// --- the toggles write the file and signal the daemon -------------------------------

test('disabling an agent writes the file, signals the pid the hello names, and updates the hello', async () => {
  const { path, read } = configured();
  const { ui, killed } = client({ runner: hello(path) });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'agent:agy');
  await until(() => ui.configuring === null, 'the walk to end');
  assert.deepEqual(read().agentCommands, ['claude']);
  assert.deepEqual(killed, [{ pid: 4242, signal: 'SIGHUP' }]);
  assert.deepEqual(ui.runner.agents, ['claude']);
  assert.match(said(ui), /This machine spawns: claude/);
  assert.match(said(ui), /Told the running daemon \(pid 4242\)/);
});

test('disabling the only agent is refused in words, and the file is untouched', async () => {
  const { path, read } = configured({ agentCommands: ['claude'] });
  const { ui, killed } = client({ runner: hello(path, { agents: ['claude'] }) });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'agent:claude');
  await until(() => ui.configuring === null, 'the walk to end');
  assert.match(said(ui), /must spawn at least one agent/);
  assert.deepEqual(read().agentCommands, ['claude']);
  assert.deepEqual(killed, []);
});

test('turning rules on asks first; enter on the empty line is yes, and the daemon is told', async () => {
  const { path, read } = configured();
  const { ui, killed } = client({ runner: hello(path) });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'rules');
  await until(() => ui.mode === 'typing', 'the confirm line');
  assert.equal(ui.input.kind, 'config');
  // R289: the warning is printed where it can wrap; the footer keeps the short part.
  assert.match(said(ui), /widen what an unattended agent may run.*Are you sure/s);
  assert.equal(stripAnsi(ui.input.label), '[Y/n] ▸');
  ui.onKey('\r');
  await until(() => ui.configuring === null, 'the walk to end');
  assert.equal(read().acceptsRulesFromConsole, true);
  assert.equal(ui.runner.acceptsConsoleRules, true);
  assert.deepEqual(killed, [{ pid: 4242, signal: 'SIGHUP' }]);
});

test('answering n to the rules question changes nothing', async () => {
  const { path, read } = configured();
  const { ui, killed } = client({ runner: hello(path) });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'rules');
  await until(() => ui.mode === 'typing', 'the confirm line');
  type(ui, 'n');
  ui.onKey('\r');
  await until(() => ui.configuring === null, 'the walk to end');
  assert.equal(read().acceptsRulesFromConsole, false);
  assert.deepEqual(killed, []);
  assert.match(said(ui), /Nothing changed/);
});

test('esc on a config line cancels the step, not just the line', async () => {
  const { path, read } = configured();
  const { ui, killed } = client({ runner: hello(path) });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'rules');
  await until(() => ui.mode === 'typing', 'the confirm line');
  ui.onKey(ESC);
  await until(() => ui.configuring === null, 'the walk to end');
  assert.equal(ui.mode, 'keys');
  assert.equal(read().acceptsRulesFromConsole, false);
  assert.deepEqual(killed, []);
});

test('turning rules off asks nothing — narrowing is never confirmed', async () => {
  const { path, read } = configured({ acceptsRulesFromConsole: true });
  const { ui } = client({ runner: hello(path, { acceptsConsoleRules: true }) });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'rules');
  await until(() => ui.configuring === null, 'the walk to end');
  assert.equal(read().acceptsRulesFromConsole, false);
  assert.equal(ui.runner.acceptsConsoleRules, false);
});

// --- show, add a project, add a workspace ------------------------------------------

test('show prints the config with the secret cut short, and says which file it is', async () => {
  const { path } = configured();
  const { ui } = client({ runner: hello(path) });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'show');
  await until(() => ui.configuring === null, 'the walk to end');
  const printed = said(ui);
  assert.match(printed, /"token": "cawdev_sec…"/);
  assert.doesNotMatch(printed, /nobody_should_see/);
  assert.ok(printed.includes(path));
});

test('adding a project needs a person signed in, because it widens the token', async () => {
  const { path } = configured();
  const { ui, calls } = client({ email: null, runner: hello(path) });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'add-project');
  await until(() => ui.configuring === null, 'the walk to end');
  assert.match(status(ui), /sign in with \/login to add a project/);
  assert.equal(calls.length, 0);
});

test('adding a workspace offers the next path beside the first, saying what is there', async () => {
  const { path, read } = configured();
  const inspections = [];
  const inspect = async (where) => { inspections.push(where); return { kind: 'missing' }; };
  const { ui, killed } = client({ email: null, runner: hello(path), inspect });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'add-workspace');
  await until(() => ui.mode === 'select' && ui.select.rows.some((row) => row.id === TYPE_A_PATH), 'the path picker');
  const drawn = overlay(ui);
  assert.match(drawn, /Where should the second checkout of cawdev live\?/);
  assert.doesNotMatch(said(ui), /Where should/, 'the question is the picker\'s title, said once');
  assert.match(drawn, /\/tmp\/checkouts\/cawdev-2.*next to cawdev.*new folder/);
  assert.match(drawn, /Type a path/);
  pick(ui, '/tmp/checkouts/cawdev-2');
  await until(() => ui.configuring === null, 'the walk to end');
  // Not signed in: nothing to clone from, and a new folder cannot be taken as is.
  assert.match(said(ui), /no git URL to clone from/);
  assert.deepEqual(read().projects.cawdev, '/tmp/checkouts/cawdev', 'nothing written');
  assert.deepEqual(killed, []);
});

test('a checkout already at the path is taken as it is, after one question when the remote cannot be checked', async () => {
  const { path, read } = configured();
  const inspect = async () => ({ kind: 'checkout', remote: 'git@github.com:4dali/cawdev.git', matches: null });
  const { ui } = client({ email: null, runner: hello(path), inspect });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'add-workspace');
  await until(() => ui.mode === 'select' && ui.select.rows.some((row) => row.id === TYPE_A_PATH), 'the path picker');
  pick(ui, '/tmp/checkouts/cawdev-2');
  await until(() => ui.mode === 'typing', 'the confirm line');
  assert.match(said(ui), /Use \/tmp\/checkouts\/cawdev-2 as a checkout of cawdev/);
  ui.onKey('\r');
  await until(() => ui.configuring === null, 'the walk to end');
  assert.deepEqual(read().projects.cawdev, { workspaces: ['/tmp/checkouts/cawdev', '/tmp/checkouts/cawdev-2'] });
  assert.match(said(ui), /Using the checkout already at/);
  // R294: the hello here carries no `configReadAt` (a daemon older than this
  // client), so the door's own reading says it — projects need a restart.
  assert.match(stripAnsi(said(ui)), /needs a restart to pick up projects — q, then cawdev/);
  assert.match(status(ui), /saved — restart to apply/);
});

test('with a current daemon, adding a workspace waits for its re-read and repeats ITS verdict', async () => {
  const { path, read } = configured();
  const inspect = async () => ({ kind: 'checkout', remote: 'git@github.com:4dali/cawdev.git', matches: null });
  const { ui, killed } = client({
    email: null, inspect,
    runner: hello(path, { configReadAt: 't0', restartNeeded: [], workspaces: { cawdev: 1 } }),
  });
  // The daemon's side, stood in for: the signal makes it re-read the file and
  // push a `runner` event, exactly as runner.mjs's `rereadConfig` does.
  ui.options.kill = (pid, signal) => {
    killed.push({ pid, signal });
    ui.onEvent({ type: 'runner', runner: { ...ui.runner, configReadAt: 't1', restartNeeded: ['projects'] } });
  };
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'add-workspace');
  await until(() => ui.mode === 'select' && ui.select.rows.some((row) => row.id === TYPE_A_PATH), 'the path picker');
  pick(ui, '/tmp/checkouts/cawdev-2');
  await until(() => ui.mode === 'typing', 'the confirm line');
  ui.onKey('\r');
  await until(() => ui.configuring === null, 'the walk to end');
  assert.deepEqual(read().projects.cawdev, { workspaces: ['/tmp/checkouts/cawdev', '/tmp/checkouts/cawdev-2'] });
  assert.deepEqual(killed, [{ pid: 4242, signal: 'SIGHUP' }]);
  assert.match(stripAnsi(said(ui)), /needs a restart to pick up projects — q, then cawdev/);
  assert.deepEqual(ui.runner.restartNeeded, ['projects'], 'what the footer now draws from');
  // And the menu, opened again, says which checkout is not served yet.
  const menu = configMenu(read(), ui.runner);
  const row = menu.rows.find((each) => each.id === 'add-workspace');
  assert.match(row.hint, /cawdev: 1, 2 after a restart/);
});

test('with a current daemon, a toggle waits for the re-read and says applied', async () => {
  const { path } = configured();
  const { ui, killed } = client({ runner: hello(path, { configReadAt: 't0', restartNeeded: [] }) });
  ui.options.kill = (pid, signal) => {
    killed.push({ pid, signal });
    ui.onEvent({ type: 'runner', runner: { ...ui.runner, configReadAt: 't1', restartNeeded: [], agents: ['claude'] } });
  };
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'agent:agy');
  await until(() => ui.configuring === null, 'the walk to end');
  assert.deepEqual(killed, [{ pid: 4242, signal: 'SIGHUP' }]);
  assert.match(stripAnsi(said(ui)), /applied, no restart needed/);
  assert.deepEqual(ui.runner.restartNeeded, []);
});

test('a daemon that does not re-read within the wait is not claimed to have', async () => {
  const { path } = configured();
  const { ui, killed } = client({ runner: hello(path, { configReadAt: 't0', restartNeeded: [] }) });
  ui.options.reloadWaitMs = 30;
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'agent:agy');
  await until(() => ui.configuring === null, 'the walk to end');
  assert.deepEqual(killed, [{ pid: 4242, signal: 'SIGHUP' }]);
  assert.match(stripAnsi(said(ui)), /did not re-read the file — restart it: q, then cawdev/);
});

test('a `runner` event from the daemon replaces the hello, so a hand edit reaches the footer', () => {
  const { path } = configured();
  const { ui } = client({ runner: hello(path, { configReadAt: 't0', restartNeeded: [] }) });
  ui.onEvent({ type: 'runner', runner: hello(path, { configReadAt: 't1', restartNeeded: ['url'] }) });
  assert.deepEqual(ui.runner.restartNeeded, ['url']);
  assert.equal(ui.runner.configReadAt, 't1');
});

test('"type a path" pre-fills the first suggestion, expands ~, and previews what is there', async () => {
  const { path, read } = configured();
  const home = mkdtempSync(join(tmpdir(), 'cawdev-home-'));
  const inspect = async (where) => (where.endsWith('/work/cawdev-b')
    ? { kind: 'checkout', remote: 'https://github.com/4dali/cawdev', matches: true }
    : { kind: 'missing' });
  const { ui } = client({ email: null, runner: hello(path), inspect });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'add-workspace');
  await until(() => ui.mode === 'select' && ui.select.rows.some((row) => row.id === TYPE_A_PATH), 'the path picker');
  pick(ui, TYPE_A_PATH);
  await until(() => ui.mode === 'typing', 'the path line');
  assert.equal(stripAnsi(ui.input.label), 'path ▸');
  assert.equal(ui.input.line.text, '/tmp/checkouts/cawdev-2', 'pre-filled, to be edited rather than retyped');
  await until(() => ui.input?.path?.preview.includes('new folder'), 'the preview of the suggestion');
  // Replace it with a home-relative path to an existing checkout.
  ui.onKey('\x15'); // ctrl+u — clear to the start
  const typedHome = join(home, 'work');
  mkdirSync(join(typedHome, 'cawdev-b'), { recursive: true });
  type(ui, `${typedHome}/cawdev-b`);
  await until(() => ui.input?.path?.preview.includes('already a checkout of cawdev'), 'the preview of the typed path');
  ui.onKey('\r');
  await until(() => ui.configuring === null, 'the walk to end');
  assert.deepEqual(read().projects.cawdev.workspaces, ['/tmp/checkouts/cawdev', `${typedHome}/cawdev-b`]);
});

test('tab completes a directory from disk, as a shell does', async () => {
  const { path } = configured();
  const root = mkdtempSync(join(tmpdir(), 'cawdev-tab-'));
  mkdirSync(join(root, 'projects', 'alpha'), { recursive: true });
  mkdirSync(join(root, 'projects', 'alps'), { recursive: true });
  mkdirSync(join(root, 'pictures'), { recursive: true });
  const { ui } = client({ email: null, runner: hello(path), inspect: async () => ({ kind: 'missing' }) });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'add-workspace');
  await until(() => ui.mode === 'select' && ui.select.rows.some((row) => row.id === TYPE_A_PATH), 'the path picker');
  pick(ui, TYPE_A_PATH);
  await until(() => ui.mode === 'typing', 'the path line');
  ui.onKey('\x15');
  type(ui, `${root}/p`);
  await until(() => ui.input?.path?.completion?.matches.length === 2, 'two matches');
  assert.deepEqual(ui.matching().rows.map(([name]) => name), ['pictures/', 'projects/']);
  ui.onKey('\t');
  // `p` is as far as pictures and projects agree, so tab cycles through them.
  assert.equal(ui.input.line.text, `${root}/pictures/`);
  ui.onKey('\x15');
  type(ui, `${root}/pr`);
  await until(() => ui.input?.path?.completion?.matches.length === 1, 'one match');
  ui.onKey('\t');
  assert.equal(ui.input.line.text, `${root}/projects/`, 'one match completes whole, with the slash');
  await until(() => ui.input?.path?.completion?.dir === `${root}/projects/`, 'listing the new folder');
  type(ui, 'al');
  await until(() => ui.input?.path?.completion?.matches.length === 2, 'alpha and alps');
  ui.onKey('\t');
  assert.equal(ui.input.line.text, `${root}/projects/alp`, 'as far as they agree');
  ui.onKey(ESC);
  await until(() => ui.configuring === null, 'the walk to end');
});

test('a path that exists and is not this project is refused in words', async () => {
  const { path, read } = configured();
  const inspect = async () => ({ kind: 'other-repo', remote: 'git@github.com:someone/else.git' });
  const { ui } = client({ email: null, runner: hello(path), inspect });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'add-workspace');
  await until(() => ui.mode === 'select' && ui.select.rows.some((row) => row.id === TYPE_A_PATH), 'the path picker');
  // The hint gives way on a narrow row (R83), so it is read off the row itself.
  assert.match(ui.select.rows[0].hint, /a checkout of git@github.com:someone\/else.git, not cawdev/);
  pick(ui, '/tmp/checkouts/cawdev-2');
  await until(() => ui.configuring === null, 'the walk to end');
  assert.match(said(ui), /is a checkout of git@github.com:someone\/else.git, not cawdev\. Nothing chan/);
  assert.equal(read().projects.cawdev, '/tmp/checkouts/cawdev');
});

test('ctrl+c during a step cancels it the way esc does', async () => {
  const { path, read } = configured();
  const { ui } = client({ runner: hello(path) });
  ui.onKey('c');
  await until(() => ui.mode === 'select', 'the picker');
  pick(ui, 'rules');
  await until(() => ui.mode === 'typing', 'the confirm line');
  ui.onKey('\x03');
  await until(() => ui.configuring === null, 'the walk to end');
  assert.equal(read().acceptsRulesFromConsole, false);
});

test('CANCELLED is a symbol, so no error message can be mistaken for it', () => {
  assert.equal(typeof CANCELLED, 'symbol');
});

test('the help and the key row both mention c', async () => {
  const { path } = configured();
  const { ui } = client({ runner: hello(path) });
  assert.match(ui.keys().map(stripAnsi).join(' '), /c config/);
  type(ui, '/help');
  ui.onKey('\r');
  await until(() => said(ui).includes('commands'), 'help');
  assert.match(said(ui), /\/config/);
  assert.match(said(ui), /c config/);
});

test('a long prompt is split: the sentence is said, the footer keeps the default', () => {
  assert.deepEqual(splitPrompt('  Is Claude Code signed in on this machine? [Y/n] '),
    { said: 'Is Claude Code signed in on this machine?', label: '[Y/n] ▸' });
  assert.deepEqual(splitPrompt('path'), { said: '', label: 'path ▸' });
  assert.deepEqual(splitPrompt('Turning this on lets anyone able to write to your cawdev widen things. Are you sure [Y/n]'),
    { said: 'Turning this on lets anyone able to write to your cawdev widen things. Are you sure', label: '[Y/n] ▸' });
});
