// R605 — the screenshots a SHOW stage took, on this machine: where a copy is
// kept, how it is opened, and how a person's comments become a decision.
//
// Zero dependencies, and pure wherever it can be. The one thing here that
// touches the disk is `localCopy`, and it is the ONLY writer of the cache:
// the daemon never writes under `~/.cawdev/shots`, because a session could
// plant `<runId>` there as a symlink and the daemon would then write files
// with names the session chose wherever the link points. The terminal
// writes names it derives itself — the checksum and an extension taken from
// the platform's content type — and refuses a link at any level.

import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripAnsi } from '../lib/ansi.mjs';

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg' };

/** Where copies are kept. */
export function shotsDir(env = process.env) {
  return env.CAWDEV_SHOTS_DIR ?? join(homedir(), '.cawdev', 'shots');
}

/** A picture the OS viewer may be handed. HTML is not: it opens on the platform. */
export function isImage(view) {
  return Object.hasOwn(EXTENSIONS, view?.contentType ?? '');
}

/**
 * Where a copy of this screenshot lives, or null for HTML. The name is the
 * checksum and the extension comes from the content type — never from `name`,
 * which a session chose.
 */
export function cachedPath(dir, view) {
  if (!isImage(view) || !/^[0-9a-f]{64}$/i.test(view.sha256 ?? '')) return null;
  // Both are path parts: nothing but a plain id and a whole number may become one.
  if (!/^[A-Za-z0-9_-]+$/.test(String(view.runId ?? '')) || !Number.isInteger(view.round) || view.round < 0) return null;
  return join(dir, String(view.runId ?? ''), String(view.round), `${view.sha256.toLowerCase()}.${EXTENSIONS[view.contentType]}`);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function requireNotALink(path) {
  const found = await lstat(path).catch(() => null);
  if (found?.isSymbolicLink()) {
    throw new Error(`${path} is a link; remove it`);
  }
  return found;
}

/**
 * A local copy of an image, downloaded the first time and never again while the
 * bytes on disk still match their checksum.
 *
 * @param view the attachment as the platform lists it, with `runId` added
 * @param fetchBytes called only when no good copy exists
 */
export async function localCopy(view, { dir, fetchBytes }) {
  const path = cachedPath(dir, view);
  if (path === null) throw new Error(`${printable(view.name)} is not an image to keep — it opens on cawdev`);
  const wanted = view.sha256.toLowerCase();
  const parts = [String(view.runId ?? ''), String(view.round)];

  await mkdir(dir, { recursive: true, mode: 0o700 });
  let level = dir;
  await requireNotALink(level);
  for (const part of parts) {
    level = join(level, part);
    await requireNotALink(level);
    await mkdir(level, { mode: 0o700 }).catch((failure) => {
      if (failure.code !== 'EEXIST') throw failure;
    });
    await requireNotALink(level);
  }

  const there = await lstat(path).catch(() => null);
  if (there) {
    if (!there.isFile()) throw new Error(`${path} is not a regular file; remove it`);
    if (sha256(await readFile(path)) === wanted) return { path, downloaded: false };
  }

  const bytes = await fetchBytes();
  if (sha256(bytes) !== wanted) {
    throw new Error(`the platform's copy of ${printable(view.name)} does not match its own checksum`);
  }
  // 'wx' is O_EXCL: it fails on anything already at the name — a link planted
  // there included — instead of writing through it. The name is unguessable.
  const partial = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(partial, bytes, { mode: 0o600, flag: 'wx' });
    await rename(partial, path);
  } catch (failure) {
    await rm(partial, { force: true });
    throw failure;
  }
  return { path, downloaded: true };
}

/**
 * How to hand files to the OS viewer: a list of [command, args] to spawn, each
 * with an argument array and no shell. macOS gets one `open` with every path, so
 * Preview pages through them in one window.
 */
export function openerFor(platform) {
  if (platform === 'darwin') return (paths) => (paths.length ? [['open', paths]] : []);
  if (platform === 'win32') return (paths) => paths.map((path) => ['explorer', [path]]);
  return (paths) => paths.map((path) => ['xdg-open', [path]]);
}

/**
 * A name or a caption comes from the session: nothing in it may move the cursor,
 * start a line of its own, or reorder what follows it. `lines` keeps newlines,
 * for a text that is several lines on purpose.
 */
export function printable(text, { lines = false } = {}) {
  const plain = stripAnsi(String(text ?? ''))
    .replace(/[\u2028\u2029]/g, lines ? '\n' : ' ')
    .replace(lines ? /[\t]/g : /[\t\n\r]/g, ' ')
    .replace(lines ? /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g : /[\x00-\x1f\x7f-\x9f]/g, '');
  // Bidirectional controls: a name that reads one way and means another.
  return plain.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

/**
 * A person's comments → the decision's `reason` and `notes`.
 *
 * A line starting `#2` is a note on the second screenshot of the round (numbered
 * from 1, in list order); anything else is the round's note. Several lines for
 * one screenshot are joined, because the platform takes one note per shot.
 *
 * @returns {{reason: string, notes: Record<string,string>, error: string|null}}
 */
export function parseComments(text, shots) {
  const reasons = [];
  const perShot = new Map();
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const mine = /^#(\d+)\s*[:—-]?\s*(.*)$/.exec(line);
    if (!mine) {
      reasons.push(line);
      continue;
    }
    const at = Number(mine[1]);
    if (at < 1 || at > shots.length) {
      return { reason: '', notes: {}, error: `there is no screenshot ${at} — this round has ${shots.length}` };
    }
    if (!mine[2]) {
      return { reason: '', notes: {}, error: `write the note after #${at}` };
    }
    perShot.set(at, [...(perShot.get(at) ?? []), mine[2]]);
  }
  const notes = {};
  for (const [at, lines] of perShot) notes[shots[at - 1].id] = lines.join('\n');
  if (reasons.length === 0 && perShot.size === 0) {
    return { reason: '', notes: {}, error: 'write a note on the round or on a screenshot (#2 …)' };
  }
  return { reason: reasons.join('\n'), notes, error: null };
}

/**
 * `{round, ids}` from a `stage:SHOW` approval's `toolInput`, else null. What a
 * gate NAMES is the session's claim until the platform's sealed list agrees.
 */
export function showGate(approval) {
  if (approval?.toolName !== 'stage:SHOW') return null;
  try {
    const input = typeof approval.toolInput === 'string'
      ? JSON.parse(approval.toolInput || '{}')
      : approval.toolInput ?? {};
    const ids = Array.isArray(input.attachments) ? input.attachments.map(String) : [];
    return { round: Number(input.round ?? 0), ids };
  } catch {
    return null;
  }
}

/** The numbered lines of a round, for the scrollback or a window. */
export function roundListing(shots, ink = { muted: (text) => text }) {
  return shots.map((shot, at) => {
    const caption = shot.caption ? ` — ${printable(shot.caption)}` : '';
    const html = isImage(shot) ? '' : ink.muted(' (html — opens on cawdev)');
    return `  ${at + 1}  ${printable(shot.name)}${caption}${html}`;
  });
}

// --- thumbnails ---------------------------------------------------------------

/** Which inline-image escape this terminal speaks, or null: no other gets any. */
export function thumbnailProtocol(env = process.env) {
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm') return 'iterm';
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty') return 'kitty';
  return null;
}

/** The bytes of an image as that terminal's inline-image escape, `cols` wide. */
export function thumbnailEscape(bytes, protocol, { cols = 24 } = {}) {
  const base64 = Buffer.from(bytes).toString('base64');
  if (protocol === 'iterm') {
    return `\x1b]1337;File=inline=1;width=${cols};preserveAspectRatio=1:${base64}\x07`;
  }
  if (protocol === 'kitty') {
    let out = '';
    for (let at = 0; at < base64.length; at += 4096) {
      const chunk = base64.slice(at, at + 4096);
      const more = at + 4096 < base64.length ? 1 : 0;
      const head = at === 0 ? `a=T,f=100,c=${cols},m=${more}` : `m=${more}`;
      out += `\x1b_G${head};${chunk}\x1b\\`;
    }
    return out;
  }
  return '';
}
