// Where a checkout goes, and what is there already — R289.
//
// R288 put the config screen inside the terminal and the first use of it found
// the path step unusable: an empty line, an absolute path to retype, no
// completion, `~` silently wrong, and a clone into whatever was typed. This file
// is the part of the fix that can be READ without a terminal: what to suggest,
// how to complete, and what a path IS right now — the same answers whether they
// are drawn as a picker in attach.mjs or printed as a numbered list by the shell
// subcommand.
//
// Pure where it can be (`expandHome`, `completePath`, `sameRepository`,
// `describe`) and injectable where it cannot (`inspectPath` reads the disk and
// asks git), because a path check that can only be tested against the real
// filesystem is one that gets tested once.
//
// Zero dependencies, like everything in tools/.

import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** The row a picker ends with: not one of the suggestions, a line to type on. */
export const TYPE_A_PATH = 'type-a-path';

/**
 * `~` and `~/…` as the shell reads them.
 *
 * `path.resolve` does not know about `~`: it treated `~/code/x` as a relative
 * path and produced `<cwd>/~/code/x`, which is the bug that started this card.
 * Only the leading tilde, and only the current user's — `~bob` is a shell
 * feature nobody types into a config screen, and guessing at it is how a path
 * lands in somebody else's home.
 */
export function expandHome(path, home = homedir()) {
  const text = String(path ?? '').trim();
  if (text === '~') return home;
  if (text.startsWith('~/')) return join(home, text.slice(2));
  return text;
}

/** Absolute, with `~` expanded first — the one spelling every path here ends in. */
export function absolute(path, home = homedir()) {
  return resolve(expandHome(path, home));
}

/**
 * The checkout paths a config file names, whatever shape each entry is.
 * Mirrors configure.mjs's `pathsOf` on purpose rather than importing it —
 * that module imports this one.
 */
function pathsIn(file) {
  return Object.values(file?.projects ?? {}).flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (Array.isArray(entry?.workspaces)) return entry.workspaces;
    if (entry?.path) return [entry.path];
    return [];
  });
}

/**
 * Where a NEW project's checkout would plausibly go on this machine.
 *
 * Beside the checkouts it already serves first — somebody with everything
 * under `~/Documents/Dev/agents-workspace/test/` wants the next one there too,
 * not under a default they never chose — then the default root. Deduplicated
 * and in that order, so the first row is the best guess and enter takes it.
 */
export function suggestProjectPaths(file, slug, { home = homedir() } = {}) {
  const seen = new Set();
  const out = [];
  const add = (path, why) => {
    const full = absolute(path, home);
    if (seen.has(full)) return;
    seen.add(full);
    out.push({ path: full, why });
  };
  for (const existing of pathsIn(file)) {
    add(join(dirname(absolute(existing, home)), slug), `beside ${basename(existing)}`);
  }
  add(join(home, 'cawdev', slug), 'the default');
  return out;
}

/**
 * Where ANOTHER checkout of a project this machine already serves would go —
 * R47's second workspace. `<first>-2`, then `-3`, skipping the numbers the
 * config already uses; then the default root's version of the same.
 */
export function suggestWorkspacePaths(file, slug, { home = homedir() } = {}) {
  const entry = file?.projects?.[slug];
  const existing = pathsIn({ projects: { [slug]: entry } }).map((path) => absolute(path, home));
  const taken = new Set(existing);
  const out = [];
  const seen = new Set();
  const add = (path, why) => {
    if (seen.has(path) || taken.has(path)) return;
    seen.add(path);
    out.push({ path, why });
  };
  const base = existing[0] ?? join(home, 'cawdev', slug);
  for (let n = 2; n < 100 && out.length < 1; n++) {
    add(`${base}-${n}`, `next to ${basename(base)}`);
  }
  add(`${join(home, 'cawdev', slug)}-${existing.length + 1}`, 'under the default root');
  return out;
}

/**
 * Tab, on a path — pure over the names in the directory being typed in.
 *
 * `text` is what is on the line; `entries` are the DIRECTORY names in the
 * folder that text points into (its own folder if it ends in `/`, its parent
 * otherwise). Returns the directories that match what has been typed so far,
 * as full paths, and what the line should become: one match completes whole
 * with a trailing `/`, several complete as far as they agree, none leave the
 * line alone. What every shell does, so nobody has to be taught it.
 */
export function completePath(text, entries, home = homedir()) {
  const raw = String(text ?? '');
  const expanded = expandHome(raw, home);
  const endsWithSlash = expanded.endsWith('/');
  const dir = endsWithSlash ? expanded : dirname(expanded);
  const prefix = endsWithSlash ? '' : basename(expanded);
  const matches = (entries ?? [])
    .filter((name) => name.startsWith(prefix) && (prefix.startsWith('.') || !name.startsWith('.')))
    .sort()
    .map((name) => join(dir, name));
  if (!matches.length) {
    return { dir, matches, completed: raw };
  }
  if (matches.length === 1) {
    return { dir, matches, completed: `${matches[0]}/` };
  }
  const names = matches.map((path) => basename(path));
  let common = names[0];
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < common.length && common[i] === name[i]) i += 1;
    common = common.slice(0, i);
  }
  const completed = common.length > prefix.length ? join(dir, common) : expanded;
  return { dir, matches, completed };
}

/** The directory names in `dir`, or none when it cannot be read. */
export async function listDirectories(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Two remotes naming the same repository — `git@github.com:o/r.git` and
 * `https://github.com/o/r` are one repository, and a checkout cloned over ssh
 * must not be refused because the platform stored the https form.
 */
export function sameRepository(a, b) {
  const key = (url) => String(url ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^:/]+):(?!\/\/)/, '$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  return Boolean(a && b) && key(a) === key(b);
}

/** `git -C path remote get-url origin`, or null when there is none. */
export function originOf(path) {
  return new Promise((done) => {
    let out = '';
    const child = spawn('git', ['-C', path, 'remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 ? out.trim() || null : null));
  });
}

/**
 * What a path IS, right now — the preview under the line and the check before
 * anything is cloned, one function so they cannot disagree.
 *
 *   missing     nothing there; a clone would create it
 *   empty       a directory with nothing in it; a clone would fill it
 *   checkout    a git checkout whose origin is this project's repository
 *   other-repo  a git checkout of something else
 *   not-empty   a directory holding things that are not this project
 *   file        not a directory at all
 *
 * `gitUrl` may be null (nobody signed in to ask the platform); then any
 * checkout is `checkout` with `matches: null`, and the caller says so.
 */
export async function inspectPath(path, { gitUrl = null } = {}, {
  statOf = stat, list = readdir, remoteOf = originOf,
} = {}) {
  let info;
  try {
    info = await statOf(path);
  } catch {
    return { kind: 'missing' };
  }
  if (!info.isDirectory()) {
    return { kind: 'file' };
  }
  let names;
  try {
    names = await list(path);
  } catch (failure) {
    return { kind: 'unreadable', error: failure.message };
  }
  if (!names.length) {
    return { kind: 'empty' };
  }
  if (names.includes('.git')) {
    const remote = await remoteOf(path);
    if (!gitUrl) {
      return { kind: 'checkout', remote, matches: null };
    }
    return sameRepository(remote, gitUrl)
      ? { kind: 'checkout', remote, matches: true }
      : { kind: 'other-repo', remote };
  }
  return { kind: 'not-empty' };
}

/** One line for a person, about an inspection — the preview and the refusal. */
export function describe(inspection, slug = 'this project') {
  switch (inspection?.kind) {
    case 'missing': return 'new folder — will clone here';
    case 'empty': return 'empty folder — will clone here';
    case 'checkout':
      return inspection.matches === null
        ? `a checkout (${inspection.remote ?? 'no origin'}) — cannot check it is ${slug} without signing in`
        : `already a checkout of ${slug} — used as it is`;
    case 'other-repo': return `a checkout of ${inspection.remote ?? 'something else'}, not ${slug}`;
    case 'not-empty': return 'exists and is not empty';
    case 'file': return 'a file, not a folder';
    case 'unreadable': return `cannot be read (${inspection.error})`;
    default: return '';
  }
}

/** Whether a path in this state may be used — cloned into, or taken as is. */
export function usable(inspection) {
  return ['missing', 'empty', 'checkout'].includes(inspection?.kind);
}
