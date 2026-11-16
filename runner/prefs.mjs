/**
 * What this terminal remembers about how you like to work — beside history.mjs
 * and in its shape: one file under ~/.cawdev, keyed by the platform's URL, 0600.
 *
 * The agent `/new` asks for when a command names none
 * (`/agent codex`). Kept here and not on the platform, because it is a choice
 * about THIS terminal — the project's default and your account's live in the
 * console, and this sits in front of them without changing either.
 *
 * @author Claude Opus 5.5 (Claude Code)
 * @author Moez Ben MBarka
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function prefsFile() {
  return process.env.CAWDEV_PREFS_FILE ?? join(homedir(), '.cawdev', 'terminal.json');
}

function key(url) {
  return String(url).replace(/\/+$/, '');
}

async function readAll() {
  try {
    const parsed = JSON.parse(await readFile(prefsFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** This platform's preferences, `{}` when there are none or the file is unreadable. */
export async function loadPrefs(url) {
  const mine = (await readAll())[key(url)];
  return mine && typeof mine === 'object' ? mine : {};
}

/** One write at a time: two saves that both read before either wrote would lose one of them. */
let writing = Promise.resolve();

/** Merges `changes` into this platform's preferences; a null value removes the key. */
export function savePrefs(url, changes) {
  const mine = writing.then(() => write(url, changes));
  writing = mine.catch(() => undefined);
  return mine;
}

async function write(url, changes) {
  const all = await readAll();
  const mine = { ...(all[key(url)] ?? {}) };
  for (const [name, value] of Object.entries(changes)) {
    if (value === null || value === undefined) delete mine[name];
    else mine[name] = value;
  }
  all[key(url)] = mine;
  await mkdir(dirname(prefsFile()), { recursive: true, mode: 0o700 });
  // Written beside and renamed over: a read that lands mid-write would find
  // an empty file, and every preference would read as unset.
  const beside = `${prefsFile()}.${process.pid}.tmp`;
  await writeFile(beside, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await chmod(beside, 0o600).catch(() => undefined);
  await rename(beside, prefsFile());
}
