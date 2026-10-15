// `cawdev config` — R283, and the granular half of R93's setup walk.
//
// `--setup` answers every question a machine has at once: which projects,
// which checkouts, which agents. That is right for a fresh laptop and wrong
// for the ordinary case afterwards — "this machine should also serve one more
// project" does not need to re-ask about the other three. So this file is the
// same questions, one at a time, on a config that already exists.
//
// **Every change here writes the FILE and nothing else.** A daemon already
// running keeps the config it booted with — `cawdev --setup` already says so,
// and this repeats it rather than inventing a second story. The one exception
// is `reloadIfRunning`: the keys in lib/runner-config.mjs's `HOT_SWAPPABLE`
// are read fresh off the live `config` object on every use in runner.mjs (a
// spawn, or the next heartbeat), so a SIGHUP that re-reads the file is enough
// to apply them without a restart — see runner.mjs's own handler for why that
// is a signal and not a command sent over R52's read-only socket. R294: every
// change goes through it, and what it prints is the DAEMON's verdict read off
// the hello — applied, or these keys need a restart — never this file's guess
// about which keys the daemon can take.
//
// R288: the same functions have a SECOND door — the attached terminal's `c`
// key — and that is why every question here comes in through a parameter.
// `ask.line` and `pick` are the two shapes a question takes (a line, or one
// row of a Select); the shell subcommand hands in readline and `askOne`, the
// UI hands in its own raw-mode line editor and its own picker, and the
// function between them cannot tell which. One implementation of each change,
// so the two doors cannot disagree about what a change does.
//
// Zero dependencies, like everything in tools/.

import { connect as connectTo } from 'node:net';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { painter } from '../lib/ansi.mjs';
import { agentLabel } from '../lib/agents.mjs';
import { probeSocket, socketPathFor } from './control.mjs';
import {
  askOne, cloneAside, cloneInto, confirm, defaultRunnerName,
  findAgents, mintRunnerToken, servable, writeRunnerConfig,
} from './bootstrap.mjs';
import {
  TYPE_A_PATH, absolute, describe, inspectPath, suggestProjectPaths, suggestWorkspacePaths, usable,
} from './paths.mjs';
import { Select } from './select.mjs';
import { storedSession } from './sign-in.mjs';
import { loadTokenRecord, saveToken } from './token-store.mjs';

/**
 * The config as an object, or null if it will not parse.
 *
 * Null rather than a throw: an unreadable config is the daemon's complaint to
 * make — it names the file and the parse error — and swallowing it here to
 * offer a setup walk would replace a precise message with a wrong guess about
 * what somebody wants. Here rather than in cawdev.mjs since R288, because the
 * attached UI reads the file too and cawdev.mjs imports attach.mjs.
 */
export async function readConfigFile(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Every slug a config file already serves, whatever shape each entry is. */
export function slugsOf(file) {
  return Object.keys(file.projects ?? {});
}

/** The agents a config file says this machine spawns — runner.mjs's own reading. */
export function agentsOf(file) {
  return file.agentCommands ?? (file.agentCommand ? [file.agentCommand] : ['claude']);
}

/** The checkout path(s) one project entry names, whatever shape it is. */
export function pathsOf(entry) {
  if (typeof entry === 'string') return [entry];
  if (Array.isArray(entry?.workspaces)) return entry.workspaces;
  if (entry?.path) return [entry.path];
  return [];
}

/**
 * Turn one project entry into the `{workspaces: [...]}` shape — R47's third
 * form — adding a path without disturbing whatever else the entry already
 * carried (`allowedTools`, `browser`, …).
 */
function withWorkspace(entry, path) {
  if (entry == null) {
    return { workspaces: [path] };
  }
  if (typeof entry === 'string') {
    return { workspaces: [entry, path] };
  }
  if (Array.isArray(entry.workspaces)) {
    return { ...entry, workspaces: [...entry.workspaces, path] };
  }
  if (entry.path) {
    const { path: only, ...rest } = entry;
    return { ...rest, workspaces: [only, path] };
  }
  return { ...entry, workspaces: [path] };
}

/**
 * This token's public id, so its grants can be WIDENED in place — R173's own
 * mechanism, `PUT /api/tokens/{id}/grants` — instead of minting a second token
 * and leaving the first live on the Tokens page for somebody to notice.
 *
 * Three places to look, in the order a machine would actually have it: the
 * config file itself (`tokenId`, set by `--setup` since R283), the token
 * store (same field, for a top-up token minted by `mintForThisMachine`), and,
 * failing both — every token minted before this card — a lookup by the label
 * `mintRunnerToken` always uses. Null when none of the three finds it, which
 * is not an error: the caller falls back to minting a fresh one.
 */
export async function resolveTokenId(session, file, url) {
  if (file.tokenId) return file.tokenId;
  const stored = await loadTokenRecord(url);
  if (stored?.id) return stored.id;
  const label = `${file.name ?? defaultRunnerName()} (runner)`;
  const tokens = await session.request('/api/tokens');
  return (Array.isArray(tokens) ? tokens : [])
    .find((each) => each.label === label && !each.revoked)?.id ?? null;
}

/**
 * Where should a checkout go — R289, and the step that used to be an empty
 * line asking for an absolute path.
 *
 * The suggestions come first, each with what is THERE right now (`describe`
 * over `inspectPath`), and the last row is a line to type on. This is the
 * plain form the shell subcommand uses; attach.mjs supplies its own through
 * the same `askPath` parameter, with the line pre-filled and tab-completed.
 * Both return an absolute path with `~` expanded, and the caller inspects it
 * AGAIN before acting — the preview is a courtesy, the check is the rule.
 */
export async function plainAskPath({ ask, say, pick = askOne, question, suggestions, slug, gitUrl, inspect = inspectPath }) {
  const rows = [];
  for (const each of suggestions) {
    const seen = await inspect(each.path, { gitUrl });
    rows.push({ id: each.path, label: each.path, hint: `${each.why} · ${describe(seen, slug)}` });
  }
  rows.push({ id: TYPE_A_PATH, label: 'Type a path', hint: '~ works' });
  const picked = await pick(ask, say, new Select({ title: question, rows }));
  if (picked.row.id !== TYPE_A_PATH) {
    return picked.row.id;
  }
  const typed = String(await ask.line(`  path [${suggestions[0]?.path ?? ''}] `)).trim();
  return absolute(typed || suggestions[0]?.path || '');
}

/**
 * The path a checkout goes in, checked, and cloned into if there is nothing
 * there — the half of the two add-commands that is the same. A checkout of this
 * repository already at the path is taken as it is; anything else that exists
 * is refused in words rather than cloned over or beside.
 */
async function settleCheckout({ path, slug, gitUrl, ask, say, ink, clone, inspect }) {
  const seen = await inspect(path, { gitUrl });
  if (!usable(seen)) {
    throw new Error(`${path} is ${describe(seen, slug)}. Nothing changed.`);
  }
  if (seen.kind === 'checkout') {
    if (seen.matches === null && !await confirm(ask, `Use ${path} as a checkout of ${slug}`)) {
      throw new Error('Nothing changed.');
    }
    say(`  ${ink.success('✓')} ${ink.muted('Using the checkout already at')} ${ink.text(path)}`);
    return;
  }
  if (!gitUrl) {
    throw new Error(`${path} is ${describe(seen, slug)}, and there is no git URL to clone from — `
      + 'sign in first, or point at a checkout you have already made.');
  }
  if (!await confirm(ask, `Clone ${gitUrl} into ${path}`)) {
    throw new Error('Nothing changed.');
  }
  say(`  ${ink.muted('Cloning')} ${ink.accent(gitUrl)} ${ink.muted('into')} ${ink.text(path)}`);
  await mkdir(dirname(path), { recursive: true });
  await cloneAside(ask, clone, gitUrl, path);
}

/** The row of Add a project that makes a new project rather than picking one. */
export const CREATE_A_PROJECT = 'create:new';

/**
 * Add one project this session can serve to an already-configured machine —
 * or CREATE one on cawdev and serve it, from the same list.
 *
 * Clones it, then widens the existing token's grants to cover it — via
 * {@link resolveTokenId}, or by minting a fresh token when that comes back
 * empty (an older machine's first run through this command, which is also
 * what teaches it the id for next time).
 *
 * The list is ALWAYS shown, one project or six: going straight to "where
 * should cawdev live?" when one was left answered a question nobody had been
 * asked, about a project the screen never named. Its last row is "Create a
 * new project on cawdev", see {@link askForANewProject}.
 */
export async function addProject({
  configPath, file, url, session: given = null,
  ask, say, ink = painter(3),
  pick = askOne,
  askPath = plainAskPath,
  inspect = inspectPath,
  clone = cloneInto,
  write = writeRunnerConfig,
} = {}) {
  const session = given ?? (await storedSession(url));
  if (!session.signedIn) {
    throw new Error('Not signed in on this machine. Run `cawdev --setup` first.');
  }

  const already = new Set(slugsOf(file));
  const projects = servable(await session.request('/api/projects'))
    .filter((project) => !already.has(project.slug));

  const picked = await pick(ask, say, new Select({
    title: projects.length
      ? 'Which project should this machine also serve?'
      : 'Every project you can serve is already here — create a new one?',
    rows: [
      ...projects.map((candidate) => ({
        id: candidate.slug, label: candidate.name, hint: candidate.slug,
      })),
      { id: CREATE_A_PROJECT, label: 'Create a new project on cawdev', hint: `on ${url} — a name and its git repository` },
    ],
  }));

  let project;
  let path;
  if (picked.row.id === CREATE_A_PROJECT) {
    ({ project, path } = await askForANewProject({
      file, url, session, ask, say, ink, pick, askPath, inspect, clone,
    }));
  } else {
    project = projects.find((candidate) => candidate.slug === picked.row.id);
    path = await askPath({
      ask, say, pick, inspect,
      question: `Where should ${project.slug} live on this machine?`,
      suggestions: suggestProjectPaths(file, project.slug),
      slug: project.slug,
      gitUrl: project.gitUrl ?? null,
    });
    await settleCheckout({ path, slug: project.slug, gitUrl: project.gitUrl ?? null, ask, say, ink, clone, inspect });
  }

  const grants = {};
  for (const slug of [...already, project.slug]) {
    grants[slug] = ['runner:operate'];
  }
  const tokenId = await resolveTokenId(session, file, url);
  const next = { ...file, projects: { ...file.projects, [project.slug]: path } };
  if (tokenId) {
    await session.request(`/api/tokens/${tokenId}/grants`, { method: 'PUT', body: { grants } });
    next.tokenId = tokenId;
    say(`  ${ink.success('✓')} ${ink.muted('Widened this machine\'s token to also cover')} ${ink.text(project.slug)}`);
  } else {
    const minted = await mintRunnerToken(session, Object.keys(grants), file.name ?? defaultRunnerName());
    next.token = minted.secret;
    next.tokenId = minted.id;
    say(`  ${ink.warn('!')} ${ink.muted('Could not find the existing token to widen — minted a new one.')}`);
    say(`  ${ink.muted('Revoke the old one on the Tokens page if you like; nothing here needs it any more.')}`);
  }

  await write(configPath, next);
  say(`  ${ink.success('✓')} ${ink.muted('Now serving')} ${ink.text(project.slug)} ${ink.muted('at')} ${ink.accent(path)}`);
  if (project.created) {
    // The rest of the console's setup walk — rules, members, the brief — is
    // decisions about the project, not about this machine, and lives there.
    say(`  ${ink.muted('The rest of its setup (rules, members, the CTO Interview):')} ${ink.accent(`${url}/projects/${project.slug}/setup`)}`);
  }
  return next;
}

/**
 * "Create a new project on cawdev": a name, the repository, the checkout —
 * and only then the project, so a clone that fails leaves nothing on the
 * platform. The slug is the SERVER's (R290, `<username>-<name>`); it is shown
 * before anything is made and the answer to the POST is what is used.
 *
 * An empty git URL is allowed when the path is already a checkout: its
 * `origin` is the repository, which is the commonest case — somebody with the
 * code on their disk who wants cawdev to know about it.
 */
async function askForANewProject({ file, url, session, ask, say, ink, pick, askPath, inspect, clone }) {
  const name = String(await ask.line('  Name of the new project ')).trim();
  if (!name) {
    throw new Error('A project needs a name. Nothing changed.');
  }
  const suggested = await session.request(`/api/projects/slug-suggestion?name=${encodeURIComponent(name)}`)
    .then((answer) => answer?.slug)
    .catch(() => null);
  const slug = suggested || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  say(`  ${ink.muted('It will be')} ${ink.text(slug)} ${ink.muted('on')} ${ink.accent(url)}`);

  const typedUrl = String(await ask.line(
    '  Its git repository URL — blank if the checkout is already on this machine ',
  )).trim();
  const path = await askPath({
    ask, say, pick, inspect,
    question: `Where should ${slug} live on this machine?`,
    suggestions: suggestProjectPaths(file, slug),
    slug,
    gitUrl: typedUrl || null,
  });

  let gitUrl = typedUrl || null;
  if (!gitUrl) {
    const seen = await inspect(path, { gitUrl: null });
    if (seen.kind !== 'checkout' || !seen.remote) {
      throw new Error(`${path} is ${describe(seen, slug)} — with no git URL, the path must be a checkout `
        + 'with an origin. Nothing changed.');
    }
    gitUrl = seen.remote;
    say(`  ${ink.muted('Its repository, from that checkout\'s origin:')} ${ink.accent(gitUrl)}`);
  }
  await settleCheckout({ path, slug, gitUrl, ask, say, ink, clone, inspect });

  if (!await confirm(ask, `Create ${name} on ${url}`)) {
    throw new Error(`Nothing created on cawdev; the checkout at ${path} stays.`);
  }
  let created;
  try {
    created = await session.request('/api/projects', { method: 'POST', body: { name, gitUrl } });
  } catch (failure) {
    throw new Error(`cawdev refused to create ${name}: ${failure.message}. The checkout at ${path} stays.`);
  }
  say(`  ${ink.success('✓')} ${ink.muted('Created')} ${ink.text(created.name ?? name)} ${ink.muted('as')} ${ink.text(created.slug)}`);
  return { project: { ...created, created: true }, path };
}

/** Add another checkout for a project this machine already serves — R47. */
export async function addWorkspace({
  configPath, file,
  ask, say, ink = painter(3),
  pick = askOne,
  askPath = plainAskPath,
  inspect = inspectPath,
  clone = cloneInto,
  write = writeRunnerConfig,
  session: given = null,
  url,
} = {}) {
  const slugs = slugsOf(file);
  if (!slugs.length) {
    throw new Error('This machine serves no projects yet — add one first.');
  }

  const slug = slugs.length === 1 ? slugs[0]
    : (await pick(ask, say, new Select({
      title: 'Add a workspace to which project?',
      rows: slugs.map((each) => ({ id: each, label: each })),
    }))).row.id;

  // The git URL first, because the suggestions are described against it —
  // "already a checkout of cawdev" is only sayable when the remote is known.
  let gitUrl = null;
  const session = given ?? (await storedSession(url));
  if (session.signedIn) {
    const projects = await session.request('/api/projects');
    gitUrl = (Array.isArray(projects) ? projects : []).find((p) => p.slug === slug)?.gitUrl ?? null;
  }

  const existing = pathsOf(file.projects[slug]).map((each) => absolute(each));
  const path = await askPath({
    ask, say, pick, inspect,
    question: `Where should the second checkout of ${slug} live?`,
    suggestions: suggestWorkspacePaths(file, slug),
    slug,
    gitUrl,
  });
  if (existing.includes(path)) {
    throw new Error(`${path} is already a workspace of ${slug}.`);
  }
  await settleCheckout({ path, slug, gitUrl, ask, say, ink, clone, inspect });

  const next = { ...file, projects: { ...file.projects, [slug]: withWorkspace(file.projects[slug], path) } };
  await write(configPath, next);
  const count = pathsOf(next.projects[slug]).length;
  say(`  ${ink.success('✓')} ${ink.muted(`${slug} now has ${count} checkout${count === 1 ? '' : 's'}, `
    + `so ${count} coding run${count === 1 ? '' : 's'} at once`)}`);
  return next;
}

/** Turn one agent this machine spawns on or off. */
export async function setAgentEnabled({
  file, configPath, enabled, command,
  ask, say, ink = painter(3),
  write = writeRunnerConfig,
  agent = findAgents,
} = {}) {
  const current = agentsOf(file);
  let next;
  if (enabled) {
    if (current.includes(command)) {
      say(`  ${ink.muted(command)} ${ink.muted('is already enabled on this machine.')}`);
      return file;
    }
    const [found] = await agent([command]);
    if (!found) {
      throw new Error(`${command} is not on this machine's PATH. Install it before enabling it here.`);
    }
    const label = agentLabel(command);
    if (!await confirm(ask, `Is ${label} signed in on this machine?`)) {
      throw new Error(`Sign in first — run \`${command}\` once in a terminal and follow it.`);
    }
    next = { ...file, agentCommands: [...current, command] };
  } else {
    if (!current.includes(command)) {
      say(`  ${ink.muted(command)} ${ink.muted('was already not enabled here.')}`);
      return file;
    }
    const remaining = current.filter((each) => each !== command);
    if (!remaining.length) {
      throw new Error('This machine must spawn at least one agent — enable another before disabling this one.');
    }
    next = { ...file, agentCommands: remaining };
  }
  await write(configPath, next);
  say(`  ${ink.success('✓')} ${ink.muted('This machine spawns:')} ${ink.text(next.agentCommands.join(', '))}`);
  return next;
}

/**
 * Stop serving a project: its entry leaves the config, and nothing else moves.
 * The checkouts stay on disk — they are somebody's working copies, and
 * deleting a directory is not a config change — and the machine's token keeps
 * its grant, which reaches nothing once the project is gone and reaches it
 * again if it is added back. `projects` is read at boot, so the daemon serves
 * it until a restart; the reload after this says so.
 *
 * The case it exists for: a project deleted in the console is still in this
 * file, so the terminal kept offering it and the daemon kept polling for it.
 */
export async function removeProject({
  file, configPath, slug,
  ask, say, ink = painter(3),
  write = writeRunnerConfig,
} = {}) {
  const projects = file.projects ?? {};
  if (!slug || !(slug in projects)) {
    throw new Error(`This machine does not serve ${slug || 'that project'}. `
      + `It serves: ${Object.keys(projects).join(', ') || 'nothing yet'}.`);
  }
  const paths = pathsOf(projects[slug]);
  const kept = paths.length ? ` Its checkout${paths.length === 1 ? '' : 's'} stay${paths.length === 1 ? 's' : ''} on disk: ${paths.join(', ')}.` : '';
  if (!await confirm(ask, `Stop serving ${slug} on this machine?${kept}`)) {
    throw new Error('Nothing changed.');
  }
  const { [slug]: _removed, ...rest } = projects;
  const next = { ...file, projects: rest };
  await write(configPath, next);
  say(`  ${ink.success('✓')} ${ink.muted(`This machine no longer serves ${slug}.`)}`
    + (paths.length ? ` ${ink.muted(`Delete ${paths.length === 1 ? 'its checkout' : 'its checkouts'} yourself if you no longer want ${paths.length === 1 ? 'it' : 'them'}.`)}` : ''));
  return next;
}

/** Turn `acceptsRulesFromConsole` on or off — R126. */
export async function setAcceptsRulesFromConsole({
  file, configPath, enabled,
  ask, say, ink = painter(3),
  write = writeRunnerConfig,
} = {}) {
  if (enabled && !await confirm(ask,
    'Turning this on lets anyone able to write to your cawdev widen what an unattended '
      + 'agent may run in your checkouts. Are you sure')) {
    throw new Error('Nothing changed.');
  }
  const next = { ...file, acceptsRulesFromConsole: enabled };
  await write(configPath, next);
  say(`  ${ink.success('✓')} ${ink.muted('acceptsRulesFromConsole is now')} ${ink.text(String(enabled))}`);
  return next;
}

/**
 * Turn a project's SonarQube scan on or off — R300.
 *
 * On writes a `quality` block into the project's entry (`{ command, tokenEnv }`,
 * the two things the daemon needs; `runner.mjs`'s `qualityBlockOf` fills in
 * the rest), asking for each with its default offered — Enter keeps it. Off
 * deletes the block and leaves every other key of the entry as it was. A bare
 * path entry is promoted to `{workspaces}` on the way, R47's third form, the
 * way `addWorkspace` promotes one.
 *
 * Nothing here checks the scanner is installed: unlike an agent, the scanner
 * can be missing on a machine that will be told so per run — the daemon
 * reports "not installed" as an error reading, which is the page saying it
 * — and a check here would refuse a config somebody is about to complete.
 * The token is NOT asked for: it is an environment variable this machine
 * exports, never a value in a file people commit.
 *
 * A third question — R316 — is what this machine does when the project's
 * server refuses branches (Community Edition): `skip` reports an error
 * reading, `main` re-scans as the project's main analysis, `project` scans
 * the branch as its own scratch SonarQube project instead. Defaults to
 * whatever is already in the block, `skip` on a fresh one.
 */
export async function setQuality({
  file, configPath, slug, enabled,
  command, tokenEnv, whenBranchesRefused,
  ask, say, ink = painter(3),
  write = writeRunnerConfig,
} = {}) {
  const projects = file.projects ?? {};
  if (!slug || !(slug in projects)) {
    throw new Error(`This machine does not serve ${slug || 'that project'}. `
      + `It serves: ${Object.keys(projects).join(', ') || 'nothing yet'}.`);
  }
  const entry = typeof projects[slug] === 'string'
    ? { workspaces: [projects[slug]] }
    : { ...projects[slug] };

  let next;
  if (enabled) {
    const chosenCommand = command
      ?? (String(await ask.line('  Scanner command [sonar-scanner]: ')).trim() || 'sonar-scanner');
    const chosenTokenEnv = tokenEnv
      ?? (String(await ask.line('  Environment variable holding the scanner token [SONAR_TOKEN]: ')).trim()
        || 'SONAR_TOKEN');
    const existingWhen = entry.quality?.whenBranchesRefused ?? 'skip';
    const chosenWhen = whenBranchesRefused
      ?? (String(await ask.line(`  When the server refuses branches — skip, main or project [${existingWhen}]: `))
        .trim().toLowerCase() || existingWhen);
    if (!['skip', 'main', 'project'].includes(chosenWhen)) {
      throw new Error(`"whenBranchesRefused" is "skip", "main" or "project" — not "${chosenWhen}".`);
    }
    entry.quality = {
      ...(entry.quality ?? {}), command: chosenCommand, tokenEnv: chosenTokenEnv, whenBranchesRefused: chosenWhen,
    };
    next = { ...file, projects: { ...projects, [slug]: entry } };
    await write(configPath, next);
    say(`  ${ink.success('✓')} ${ink.muted(`${slug} scans its branches with`)} ${ink.text(chosenCommand)}`
      + ` ${ink.muted('after TEST, token from')} ${ink.text('$' + chosenTokenEnv)}`);
    say(`  ${ink.muted(`Export ${chosenTokenEnv} where the daemon runs. It is never written to this file.`)}`);
  } else {
    if (!entry.quality) {
      say(`  ${ink.muted(`${slug} was already not scanned here.`)}`);
      return file;
    }
    delete entry.quality;
    next = { ...file, projects: { ...projects, [slug]: entry } };
    await write(configPath, next);
    say(`  ${ink.success('✓')} ${ink.muted(`${slug} is no longer scanned on this machine.`)}`);
  }
  return next;
}

/**
 * The hello of a daemon running on this exact config, or null.
 *
 * The socket is keyed by NAME (R52), not by config path, so a machine
 * renamed between `--setup` and now would miss its own daemon — an edge case
 * left alone deliberately: naming this wrong points the reload at nobody's
 * process rather than somebody else's.
 *
 * R294: the whole `runner` object and not only its pid, because the hello is
 * where the daemon says what it could not apply (`restartNeeded`) and when it
 * last read the file (`configReadAt`) — the two fields `reloadIfRunning`
 * phrases its answer from.
 */
async function liveHello(name) {
  const path = socketPathFor(name);
  if (!(await probeSocket(path))) return null;
  return new Promise((done) => {
    const client = connectTo(path);
    let buffer = '';
    const finish = (runner) => {
      clearTimeout(timer);
      try { client.destroy(); } catch { /* already gone */ }
      done(runner);
    };
    const timer = setTimeout(() => finish(null), 1000);
    client.setEncoding('utf8');
    client.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        finish(JSON.parse(buffer.slice(0, newline))?.runner ?? null);
      } catch {
        finish(null);
      }
    });
    client.on('error', () => finish(null));
  });
}

/** How to restart, said from the shell: attach, quit, start again. */
export const RESTART_FROM_SHELL = 'cawdev, then q, then cawdev again';
/** The same, said from inside the attached terminal. */
export const RESTART_FROM_ATTACH = 'q, then cawdev';

/**
 * SIGHUP a daemon already running on this config, and say what came of it.
 *
 * Never a socket command — see this file's header and runner.mjs's handler for
 * why. R294: the daemon applies what it can (`HOT_SWAPPABLE`) and advertises
 * the rest as `restartNeeded`, so this WAITS for the re-read — `configReadAt`
 * moving past the one the hello carried before the signal — and repeats the
 * daemon's own verdict rather than guessing at it. Three sentences, and each
 * is a fact the daemon stated: applied and nothing else changed; applied, and
 * these keys need a restart; signalled, and nothing came back.
 *
 * @param hello reads the daemon's current hello — the socket by default; the
 *   attached terminal hands in its own copy, which the daemon pushes to it
 * @param restartHint how to restart from where the person is standing
 * @param fallback what THIS door believes needs a restart — `restartNeededFor`
 *   over the file before and after its own write — used only for a daemon
 *   too old to say (no `configReadAt` on its hello). The daemon's answer wins
 *   whenever there is one, because the daemon knows what it booted with and
 *   the door only knows what it just changed
 * @returns what happened, for a caller that wants to draw it:
 *   `{ running, applied, restartNeeded }`
 */
export async function reloadIfRunning(name, say, ink = painter(3), {
  hello = liveHello,
  kill = process.kill,
  restartHint = RESTART_FROM_SHELL,
  fallback = [],
  waitMs = 3000,
  tick = (ms) => new Promise((done) => setTimeout(done, ms)),
} = {}) {
  const before = await hello(name);
  if (!before?.pid) return { running: false, applied: false, restartNeeded: [] };
  try {
    kill(before.pid, 'SIGHUP');
  } catch (failure) {
    say(`  ${ink.warn('!')} ${ink.muted(`Could not signal the running daemon (${failure.message}) — restart it to pick this up: ${restartHint}.`)}`);
    return { running: true, applied: false, restartNeeded: [] };
  }

  // An older daemon carries no `configReadAt` and cannot be waited for; the
  // most this can say about it is what R283 said.
  let after = null;
  if (before.configReadAt !== undefined) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const now = await hello(name);
      if (now?.configReadAt && now.configReadAt !== before.configReadAt) {
        after = now;
        break;
      }
      await tick(100);
    }
  }

  if (!after && before.configReadAt !== undefined) {
    say(`  ${ink.warn('!')} ${ink.muted(`Signalled the daemon (pid ${before.pid}) but it did not re-read the file — restart it: ${restartHint}.`)}`);
    return { running: true, applied: false, restartNeeded: [] };
  }

  const restartNeeded = after
    ? (Array.isArray(after.restartNeeded) ? after.restartNeeded : [])
    : fallback;
  if (restartNeeded.length) {
    say(`  ${ink.warn('!')} ${ink.muted('Saved. The running daemon (pid')} ${ink.text(String(before.pid))}${ink.muted(') needs a restart to pick up')} ${ink.text(restartNeeded.join(', '))} ${ink.muted(`— ${restartHint}.`)}`);
  } else {
    say(`  ${ink.success('✓')} ${ink.muted(`Told the running daemon (pid ${before.pid}) to re-read this — applied, no restart needed.`)}`);
  }
  return { running: true, applied: true, restartNeeded };
}
