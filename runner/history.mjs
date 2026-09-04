// What you last sent, kept per machine — R83.
//
// `~/.cawdev/history.json`, beside the stored session and keyed the same way: by
// URL, because one machine can point at more than one cawdev and a prompt
// written for one of them is not history for the other.
//
// **It survives quitting.** Up-arrow that only remembers this launch is a
// feature people learn not to reach for; the whole value of it is the prompt you
// wrote yesterday and want to send again today.
//
// What is in here is what you typed, and it is worth being plain about that: a
// prompt, an answer to a question, a slash command. Not a permission decision
// and not a refusal reason — those are records the platform keeps about a
// session, and a local convenience file is not the second place to hold them.
// A paste is remembered as its `[pasted, 342 lines]` placeholder and never as
// its contents (see input.mjs) — this file must not become a copy of everything
// anybody has ever pasted into a terminal.
//
// Zero dependencies, like everything in tools/.

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** How much is kept. Long enough to be worth walking, short enough to read. */
const KEPT = 200;

export function historyFile() {
  return process.env.CAWDEV_HISTORY_FILE ?? join(homedir(), '.cawdev', 'history.json');
}

function key(url) {
  return String(url).replace(/\/+$/, '');
}

async function readAll() {
  try {
    const parsed = JSON.parse(await readFile(historyFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // No file, unreadable, or half-written. The answer to all three is the same
    // and it is not an error: you have no history yet.
    return {};
  }
}

/** What was sent to one instance, oldest first. */
export async function loadHistory(url) {
  const lines = (await readAll())[key(url)];
  return Array.isArray(lines) ? lines.filter((line) => typeof line === 'string') : [];
}

/**
 * Remember one more line.
 *
 * Read-modify-write per line rather than a flush at exit, because a terminal is
 * quit by closing the window at least as often as by pressing `q`, and history
 * that only survives a polite exit is history that is not there when you want
 * it. The file is a few kilobytes and a line is sent a few times a minute.
 *
 * 0600 like the session file, and forced after writing for the same reason:
 * `writeFile`'s mode is masked by the umask. What people type into an agent is
 * not as sensitive as a session cookie, but it is nobody else's either.
 */
export async function pushHistory(url, line) {
  const text = String(line ?? '').trim();
  if (!text) {
    return;
  }
  const all = await readAll();
  const kept = Array.isArray(all[key(url)]) ? all[key(url)] : [];
  if (kept[kept.length - 1] !== text) {
    kept.push(text);
  }
  all[key(url)] = kept.slice(-KEPT);
  await mkdir(dirname(historyFile()), { recursive: true, mode: 0o700 });
  await writeFile(historyFile(), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await chmod(historyFile(), 0o600).catch(() => undefined);
}

/** Forget it — what `/logout` does, since it is the same person leaving. */
export async function clearHistory(url) {
  const all = await readAll();
  if (!(key(url) in all)) {
    return;
  }
  delete all[key(url)];
  await mkdir(dirname(historyFile()), { recursive: true, mode: 0o700 });
  await writeFile(historyFile(), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await chmod(historyFile(), 0o600).catch(() => undefined);
}
