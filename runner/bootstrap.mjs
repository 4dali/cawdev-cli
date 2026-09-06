// Setting a machine up — R93, and what it removes is the copy-and-paste.
//
// Before this, a new laptop needed three things before `cawdev` would start a
// daemon: a URL, a `runner:operate` token minted by hand in the console, and a
// `projects` map naming checkouts that were not there yet. Two of those are
// secrets or paths a person had to carry between a browser and a terminal, and
// the third could not be written until the repositories had been cloned.
//
// **R81 already signed you in through the browser, and that is the credential
// this file spends.** A `runner:operate` token is user-grantable, so the CLI
// can mint its own — against your CURRENT membership, by the same
// grant-what-you-hold rule as the console's own picker. Nothing about R52
// changes: the token is still the machine's, still scoped to named projects,
// still revocable on its own, and still written to a different file from the
// person's session. What stops is a human being the transport for it.
//
// **Cloning is your git, not cawdev's.** The platform holds no git credentials
// and this does not give it any: `git clone` runs in the FOREGROUND, on the
// machine somebody is sitting at, under whatever ssh agent or credential helper
// that machine already has. cawdev supplies the URL it was told at project
// creation and nothing else.
//
// The one thing this cannot do for you is Claude Code's own sign-in, so it
// asks. A runner whose `claude` is not logged in boots perfectly and then fails
// every run, which is a worse way to find out than a question.
//
// Zero dependencies, like everything in tools/.

import { spawn } from 'node:child_process';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { painter } from '../lib/ansi.mjs';
import { Select, pickFromLine, pickManyFromLine, plainLines } from './select.mjs';
import { signInThroughBrowser, storedSession } from './sign-in.mjs';
import { saveToken, tokenFile } from './token-store.mjs';

/** Where a machine set up this way keeps its config — `findConfig`'s last candidate. */
export function runnerConfigPath() {
  return join(homedir(), '.cawdev', 'runner.config.json');
}

/** Where checkouts go unless somebody says otherwise. */
export function defaultCheckoutRoot() {
  return join(homedir(), 'cawdev');
}

/**
 * The projects this machine could be pointed at.
 *
 * <p>Two filters and both are the server's rule rather than a guess at it: an
 * archived project is not somewhere work happens, and `runner:operate` needs
 * WRITER to mint — so a project you can only read is one the mint would refuse.
 * Offering it and failing afterwards would teach somebody that setup is flaky.
 *
 * Pure, so the rule can be read without a platform.
 */
export function servable(projects) {
  return (projects ?? [])
    .filter((project) => !project.archived)
    .filter((project) => project.yourRole === 'WRITER' || project.yourRole === 'OWNER');
}

/**
 * The config a daemon boots from, as an object.
 *
 * Deliberately the SMALLEST file that works — a url, a token, a name, and one
 * path per project. Everything else `readConfig` has a default for, and a
 * generated file that writes out every default is one nobody dares edit
 * afterwards because they cannot tell what they chose from what they were
 * given.
 *
 * Pure: entries in, the file's contents out.
 */
export function configFor({ url, token, name, entries }) {
  const projects = {};
  for (const entry of entries) {
    projects[entry.slug] = entry.path;
  }
  return { url, token, name, projects };
}

/** What this machine calls itself, unless told. Short: it is a row in a list. */
export function defaultRunnerName() {
  try {
    return hostname().replace(/\.local$/, '');
  } catch {
    return 'this machine';
  }
}

/**
 * Where a project's checkout goes.
 *
 * Its own function because it is the one piece of path arithmetic here, and a
 * slug that arrived with a slash in it would otherwise write outside the root.
 * Slugs cannot contain one — `Slug` sees to that — so this is belt and braces
 * against a platform that changes its mind later.
 */
export function checkoutFor(root, slug) {
  const safe = String(slug)
    .replace(/[^a-z0-9._-]/gi, '-')
    // A name that is only dots is `.` or `..`, and `join` walks up for the
    // second one — so the sanitised form of a hostile slug would land OUTSIDE
    // the root the person named. Everything else is already inside it, because
    // the separator is the character the line above removes.
    .replace(/^\.+$/, '-');
  return join(resolve(root), safe);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the config, readable by nobody else.
 *
 * 0600 for the same reason `session.json` is: a token that grants a machine the
 * right to run agents in your repositories is not a world-readable file, and a
 * multi-user box is exactly where a runner ends up.
 */
export async function writeRunnerConfig(path, config) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // Explicit, because `mode` on writeFile is ignored for a file that already
  // exists — re-running setup over a config from an older version would leave
  // whatever mode that one had.
  await chmod(path, 0o600);
}

/**
 * Mint the machine's own `runner:operate` token.
 *
 * The label says which machine, because the tokens page is where somebody goes
 * to retire one and "cawdev runner" three times over is not a list you can act
 * on.
 */
export async function mintRunnerToken(session, slugs, name) {
  const grants = {};
  for (const slug of slugs) {
    grants[slug] = ['runner:operate'];
  }
  // `/api/tokens`, which is what the spec has always called it. This said
  // `/api/agent-tokens` — the name on the console's PAGE rather than the one on
  // the endpoint — so R93's walk had never once minted a token against a real
  // platform. Every test passed because the fake session next door was written
  // from the same wrong guess, which is the failure `openapi.test.mjs` now
  // makes impossible: paths are checked against `openapi.yaml`, not against a
  // second copy of the assumption.
  const minted = await session.request('/api/tokens', {
    method: 'POST',
    body: { label: `${name} (runner)`, grants },
  });
  if (!minted?.secret) {
    throw new Error('The platform minted a token but did not return it.');
  }
  return minted.secret;
}

/**
 * `git clone`, in the foreground, with its output on the terminal.
 *
 * Inherited stdio rather than captured: a clone asks for a passphrase, prints a
 * progress bar, and may want a host key confirmed. Swallowing all three to
 * print a tidy spinner is how this hangs with no explanation on the one machine
 * whose ssh agent was not running.
 */
export function cloneInto(gitUrl, path) {
  return new Promise((done, fail) => {
    const child = spawn('git', ['clone', gitUrl, path], { stdio: 'inherit' });
    child.on('error', (failure) => fail(new Error(`Could not run git: ${failure.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        done();
      } else {
        fail(new Error(`git clone exited ${code}.`));
      }
    });
  });
}

/** Whether `claude` is on the PATH at all — a cheaper question than "is it signed in". */
export function findAgent(command = 'claude') {
  return new Promise((done) => {
    const child = spawn(process.platform === 'win32' ? 'where' : 'which', [command], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 && out.trim() ? out.trim().split('\n')[0] : null));
  });
}

/**
 * Asking, on a terminal that has not been taken over yet.
 *
 * `readline` and not R81's `input.mjs`: this runs BEFORE the full-screen client
 * exists, in an ordinary cooked-mode terminal, and the line editor next door is
 * built for a raw-mode screen with a footer. Two different situations that only
 * look like the same one.
 */
export function asker(input = process.stdin, output = process.stdout) {
  const rl = createInterface({ input, output });
  return {
    line: (prompt) => rl.question(prompt),
    close: () => rl.close(),
  };
}

/**
 * One choice, drawn the way a terminal that cannot be drawn on gets one.
 *
 * R83's rule is that everything offering a choice is `select.mjs`, and this is
 * that widget's plain form: the same rows, the same numbering, the same
 * parsing. What differs is only where the keys come from.
 */
export async function askOne(ask, say, select) {
  for (;;) {
    for (const line of plainLines(select)) {
      say(line);
    }
    const picked = pickFromLine(select, await ask.line('  > '));
    if (picked?.done === 'chosen') {
      return picked;
    }
    say('  Not one of those.');
  }
}

/** The same, for a question whose answer is several rows. */
export async function askMany(ask, say, select) {
  for (;;) {
    for (const line of plainLines(select, { many: true })) {
      say(line);
    }
    const typed = await ask.line('  > ');
    // Enter is "all of them", which is what somebody pointing a machine at
    // their projects usually means — and the line above says so, so it is an
    // offer rather than a default nobody was told about.
    if (!String(typed).trim()) {
      return select.rows;
    }
    const picked = pickManyFromLine(select, typed);
    if (picked?.length) {
      return picked;
    }
    say('  Not one of those.');
  }
}

/** A yes/no where enter means yes, because every one of them here is a confirmation. */
export async function confirm(ask, question) {
  const typed = String(await ask.line(`  ${question} [Y/n] `)).trim().toLowerCase();
  return typed === '' || typed === 'y' || typed === 'yes';
}

/**
 * The walk.
 *
 * Ordered so that **nothing is created until everything is known**: sign in,
 * choose, resolve every checkout, and only then mint a token and write a file.
 * A setup abandoned halfway leaves no token on the tokens page and no config
 * pointing at half a machine — which is what makes running it again the whole
 * recovery procedure.
 *
 * Every side effect is injected, so the walk itself can be tested without a
 * network, a git host, or a home directory.
 */
export async function setUpThisMachine({
  url,
  ask,
  say,
  ink = painter(3),
  clone = cloneInto,
  write = writeRunnerConfig,
  configPath = runnerConfigPath(),
  signIn = signInThroughBrowser,
  session: given = null,
  agent = findAgent,
} = {}) {
  const session = given ?? (await storedSession(url));

  say('');
  say(`  ${ink.bold('Setting up this machine')} ${ink.muted(`for ${url}`)}`);

  if (!session.signedIn) {
    say('');
    say(`  ${ink.muted('Signing in — a browser is about to open.')}`);
    const result = await signIn(session, ({ url: verify, code }) => {
      say('');
      say(`  ${ink.muted('Approve this sign-in at')} ${ink.accent(verify)}`);
      say(`  ${ink.muted('The code is')} ${ink.bold(code)}`);
      say('');
      say(`  ${ink.muted('Waiting…')}`);
    });
    if (!result.signedIn) {
      throw new Error(result.refused
        ? 'That sign-in was refused.'
        : 'That sign-in expired. Run cawdev again to get a new code.');
    }
  }
  say(`  ${ink.success('✓')} ${ink.muted('Signed in as')} ${ink.text(session.email)}`);

  const projects = servable(await session.request('/api/projects'));
  if (!projects.length) {
    throw new Error(
      'You are not a writer on any project, so this machine has nothing to run.\n'
        + `  Create one at ${url}, or ask an owner to add you.`,
    );
  }

  const chosen = projects.length === 1
    ? projects
    : (await askMany(ask, say, new Select({
      title: 'Which projects should this machine run agents for?',
      rows: projects.map((project) => ({
        id: project.slug,
        label: project.name,
        hint: project.slug,
      })),
    }))).map((row) => projects.find((project) => project.slug === row.id));

  if (projects.length === 1) {
    say('');
    say(`  ${ink.muted('One project to serve:')} ${ink.text(projects[0].name)}`);
  }

  // Where the checkouts go. Asked once rather than per project: a machine that
  // serves four repositories keeps them together, and four questions to learn
  // one answer is a form pretending to be a conversation.
  const suggested = defaultCheckoutRoot();
  const typedRoot = String(await ask.line(`  Where should the checkouts live? [${suggested}] `)).trim();
  const root = typedRoot || suggested;

  const entries = [];
  for (const project of chosen) {
    const path = checkoutFor(root, project.slug);
    if (await exists(path)) {
      say(`  ${ink.success('✓')} ${ink.text(project.slug)} ${ink.muted(`is already at ${path}`)}`);
      entries.push({ slug: project.slug, path });
      continue;
    }
    if (!project.gitUrl) {
      // Not fatal and not skipped silently: the project is real, cawdev simply
      // was not told where its repository is, and the person in front of us
      // knows.
      say('');
      say(`  ${ink.warn('!')} ${ink.text(project.slug)} ${ink.muted('has no git URL on the platform.')}`);
      const typed = String(await ask.line('  Path to an existing checkout (enter to skip): ')).trim();
      if (!typed) {
        say(`  ${ink.muted(`Skipping ${project.slug}.`)}`);
        continue;
      }
      entries.push({ slug: project.slug, path: resolve(typed) });
      continue;
    }
    say('');
    say(`  ${ink.muted('Cloning')} ${ink.accent(project.gitUrl)} ${ink.muted('into')} ${ink.text(path)}`);
    await mkdir(dirname(path), { recursive: true });
    await clone(project.gitUrl, path);
    entries.push({ slug: project.slug, path });
  }

  if (!entries.length) {
    throw new Error('No project ended up with a checkout, so there is nothing to configure.');
  }

  // R93's one question this cannot answer for itself. Asked BEFORE the token is
  // minted, so somebody who has to go and log in elsewhere has not left a
  // credential behind them.
  const where = await agent();
  say('');
  if (where) {
    say(`  ${ink.muted('This machine spawns')} ${ink.text('claude')} ${ink.muted(`(${where}) for every run.`)}`);
  } else {
    say(`  ${ink.warn('!')} ${ink.muted('No')} ${ink.text('claude')} ${ink.muted('on this PATH. Install Claude Code before a run can start.')}`);
  }
  say(`  ${ink.muted('It cannot sign in for you: a runner whose Claude Code is logged out')}`);
  say(`  ${ink.muted('boots fine and then fails every run.')}`);
  if (!await confirm(ask, 'Is Claude Code signed in on this machine?')) {
    throw new Error(
      'Sign in first — run `claude` once in a terminal and follow it — then run cawdev again.\n'
        + '  Nothing has been created, so there is nothing to undo.',
    );
  }

  const name = defaultRunnerName();
  const token = await mintRunnerToken(session, entries.map((entry) => entry.slug), name);
  const config = configFor({ url, token, name, entries });
  await write(configPath, config);

  say('');
  say(`  ${ink.success('✓')} ${ink.muted('Minted a')} ${ink.text('runner:operate')} `
    + `${ink.muted(`token for ${entries.length} project${entries.length === 1 ? '' : 's'}`)}`);
  say(`  ${ink.success('✓')} ${ink.muted('Wrote')} ${ink.accent(configPath)}`);
  say('');

  return { configPath, config, entries };
}

/**
 * The credential, and only the credential — for a machine already configured.
 *
 * `setUpThisMachine` above answers "what does this machine serve?", which is
 * four questions and a clone. A machine whose config already answers all of
 * them and is missing only a token has nothing to be asked: the projects are
 * named, the checkouts are there, and the one thing absent is the thing R93
 * says a person should never have to carry.
 *
 * So this is the walk with everything it can already know taken out. Sign in
 * through the browser, mint `runner:operate` on **the slugs the config already
 * serves** — never a wider set, because a top-up that quietly granted more
 * would be a privilege escalation performed by a convenience — and store it
 * beside the session rather than in the config, for the reason `token-store`
 * opens with.
 *
 * Claude Code's own sign-in is not asked about here. That question belongs to
 * setting a machine up, and this machine has been set up; asking it again on
 * every token renewal would make the answer noise.
 *
 * Every side effect is injected, so this can be tested without a network or a
 * home directory.
 */
export async function mintForThisMachine({
  url,
  config,
  configPath = null,
  say,
  ink = painter(3),
  signIn = signInThroughBrowser,
  store = saveToken,
  session: given = null,
} = {}) {
  const slugs = Object.keys(config?.projects ?? {});
  if (!slugs.length) {
    throw new Error(
      `${configPath ?? 'That config'} serves no projects, so there is no token to mint.\n`
        + '  Add a "projects" map, or run cawdev --setup to be walked through it.',
    );
  }

  const session = given ?? (await storedSession(url));

  say('');
  say(`  ${ink.bold('This machine has a config but no token')}`);
  if (configPath) {
    say(`  ${ink.muted('Config:')} ${ink.accent(configPath)}`);
  }
  say(`  ${ink.muted('Minting one for')} ${ink.text(slugs.join(', '))}${ink.muted(' — nothing to copy.')}`);

  if (!session.signedIn) {
    say('');
    say(`  ${ink.muted('Signing in — a browser is about to open.')}`);
    const result = await signIn(session, ({ url: verify, code }) => {
      say('');
      say(`  ${ink.muted('Approve this sign-in at')} ${ink.accent(verify)}`);
      say(`  ${ink.muted('The code is')} ${ink.bold(code)}`);
      say('');
      say(`  ${ink.muted('Waiting…')}`);
    });
    if (!result.signedIn) {
      throw new Error(result.refused
        ? 'That sign-in was refused.'
        : 'That sign-in expired. Run cawdev again to get a new code.');
    }
  }
  say(`  ${ink.success('✓')} ${ink.muted('Signed in as')} ${ink.text(session.email)}`);

  const name = config.name ?? defaultRunnerName();
  const token = await mintRunnerToken(session, slugs, name);
  await store(url, token, { name });

  say(`  ${ink.success('✓')} ${ink.muted('Minted a')} ${ink.text('runner:operate')} `
    + `${ink.muted(`token for ${slugs.length} project${slugs.length === 1 ? '' : 's'}`)}`);
  say(`  ${ink.success('✓')} ${ink.muted('Stored it in')} ${ink.accent(tokenFile())} `
    + `${ink.muted('— not in the config, which is a file people commit')}`);
  say('');

  return { token, slugs, name };
}
