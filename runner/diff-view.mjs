// A branch's diff, in the terminal — `/review` (attach.mjs).
//
// The diff comes from local git, never from the platform: this terminal runs
// on a machine with a checkout of the project, `git fetch` moves refs and
// touches no file, and `git diff base...branch` reads objects only, so it is
// safe even in a checkout somebody is working in. No endpoint carries a diff,
// and it is the same for GitHub, GitLab and Bitbucket.
//
// Two halves. `branchDiff` is the plumbing (git, a bounded buffer). `parseDiff`
// and `layoutDiff` are pure: text in, files out; files in, rows out — the rows
// already wrapped to the width, so the reader's row numbers are the file
// headers' and `n`/`p` can jump to them.
//
// Zero dependencies, like everything in tools/.

import { spawn } from 'node:child_process';
import { wrap } from '../lib/ansi.mjs';

/** The most diff text read; past it the diff is cut and says so. */
export const MAX_DIFF_BYTES = 8 * 1024 * 1024;

/** A file this long opens folded: a review reads it on purpose, not by scrolling past it. */
export const FOLD_OVER_LINES = 400;

/** Generated files nobody reviews line by line. */
const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|[^/]*\.lock|go\.sum)$/;

/**
 * Text from a diff, made safe to draw: a file's bytes can hold escape
 * sequences, and a diff printed raw could move the cursor, retitle the window
 * or worse. Tabs become spaces so the width is what is drawn.
 */
export function printableDiffLine(text) {
  return String(text)
    .replaceAll('\t', '    ')
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '�');
}

/** `a/x` → `x`, and git's quoted form of a path with odd bytes. */
function pathOf(side) {
  let text = side.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return text.replace(/^[ab]\//, '');
}

/** The header between `diff --git` and the first hunk. */
function readHeaderLine(file, raw) {
  if (raw.startsWith('new file mode')) file.status = 'added';
  else if (raw.startsWith('deleted file mode')) file.status = 'deleted';
  else if (raw.startsWith('rename from ')) {
    file.status = 'renamed';
    file.oldPath = raw.slice(12);
  } else if (raw.startsWith('rename to ')) file.path = raw.slice(10);
  else if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') file.binary = true;
  else if (raw.startsWith('--- ') && file.status === 'deleted') file.path = pathOf(raw.slice(4));
}

/** One line under a hunk header: added, deleted, a note, or context. */
function readBodyLine(file, raw) {
  if (raw.startsWith('+')) {
    file.additions++;
    file.lines.push({ kind: 'add', text: raw });
  } else if (raw.startsWith('-')) {
    file.deletions++;
    file.lines.push({ kind: 'del', text: raw });
  } else if (raw.startsWith('\\')) {
    file.lines.push({ kind: 'note', text: raw });
  } else if (raw !== '' || file.lines.length) {
    file.lines.push({ kind: 'ctx', text: raw });
  }
}

function newFile(raw) {
  const match = /^diff --git (\S+|"[^"]*") (\S+|"[^"]*")$/.exec(raw);
  return {
    path: match ? pathOf(match[2]) : raw.slice(11),
    oldPath: null,
    status: 'modified',
    binary: false,
    additions: 0,
    deletions: 0,
    lines: [],
  };
}

/**
 * `git diff` output → files. Each file: `path` (the new one; the old one for a
 * deletion), `oldPath` when renamed, `status` (added, deleted, renamed,
 * modified), `binary`, `additions`, `deletions`, and `lines`: hunk headers and
 * the lines under them, each `{ kind: 'hunk' | 'add' | 'del' | 'ctx' | 'note', text }`.
 */
export function parseDiff(text) {
  const files = [];
  let file = null;
  for (const raw of String(text).split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = newFile(raw);
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('@@')) {
      file.lines.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (file.lines.length === 0) {
      readHeaderLine(file, raw);
      continue;
    }
    readBodyLine(file, raw);
  }
  // The split leaves a last empty context line where the text ended in \n.
  for (const each of files) {
    while (each.lines.length && each.lines.at(-1).kind === 'ctx' && each.lines.at(-1).text === '') {
      each.lines.pop();
    }
  }
  return files;
}

/** Whether a file opens folded: generated, binary, or too long to read by scrolling. */
export function foldedByDefault(file) {
  return file.binary || GENERATED.test(file.path) || file.lines.length > FOLD_OVER_LINES;
}

/**
 * The rows the reader draws, wrapped to `width`, and where each file starts.
 *
 * @param review `{ files, folded: Set<path>, branch, base, cut, stale }`
 * @returns `{ rows, fileRows }` — `fileRows[i]` is the row of `files[i]`'s header.
 */
export function layoutDiff(review, width, ink) {
  const { files, folded = new Set(), branch, base, cut = false, stale = false } = review;
  const room = Math.max(10, width);
  const rows = [];
  const push = (line) => rows.push(...wrap(line, room));
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  const count = `${files.length} file${files.length === 1 ? '' : 's'}`;
  const into = ink.muted(`into ${base ?? '?'}`);
  const sums = plusMinus(additions, deletions, ink);
  push(`${ink.bold(branch ?? '')} ${into}  ${ink.muted(count)} ${sums}`);
  if (stale) push(ink.warn('origin could not be fetched: this is the checkout\'s copy, and may be behind'));
  if (cut) push(ink.warn('the diff was cut: it is longer than the terminal reads'));
  if (!files.length) {
    push(ink.muted('no change between the two: nothing to review'));
    return { rows, fileRows: [] };
  }
  push('');
  for (const file of files) {
    push(`  ${statusMark(file, ink)} ${printableDiffLine(file.path)}  ${fileSums(file, ink)}`);
  }

  const fileRows = [];
  for (const file of files) {
    push('');
    fileRows.push(rows.length);
    for (const line of fileSection(file, !folded.has(file.path), ink)) push(line);
  }
  return { rows, fileRows };
}

function plusMinus(additions, deletions, ink) {
  const added = ink.success(`+${additions}`);
  const removed = ink.danger(`−${deletions}`);
  return `${added} ${removed}`;
}

function fileSums(file, ink) {
  return plusMinus(file.additions, file.deletions, ink);
}

/** One file's header line and, when it is open, its lines, before wrapping. */
function fileSection(file, open, ink) {
  const named = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  const arrow = open ? '▾' : '▸';
  const title = ink.bold(`${arrow} ${printableDiffLine(named)}`);
  const out = [`${title}  ${fileSums(file, ink)} ${ink.muted(file.status)}`];
  if (file.binary) {
    out.push(ink.muted('  binary: not drawn'));
  } else if (!open) {
    out.push(ink.muted(`  folded: ${file.lines.length} lines · f opens it`));
  } else {
    for (const line of file.lines) out.push(lineInk(line, ink)(printableDiffLine(line.text)));
  }
  return out;
}

function lineInk(line, ink) {
  if (line.kind === 'hunk') return ink.accent;
  if (line.kind === 'add') return ink.success;
  if (line.kind === 'del') return ink.danger;
  return ink.muted;
}

function statusMark(file, ink) {
  if (file.status === 'added') return ink.success('A');
  if (file.status === 'deleted') return ink.danger('D');
  if (file.status === 'renamed') return ink.accent('R');
  return ink.muted('M');
}

/** Which file the row is in: the last header at or above it, or -1 above the first. */
export function fileAt(fileRows, row) {
  let at = -1;
  fileRows.forEach((start, i) => {
    if (start <= row) at = i;
  });
  return at;
}

// --- the plumbing ------------------------------------------------------------

/** One git command in `cwd`; stdout capped at `max` bytes. Never throws. */
export function git(cwd, args, { max = MAX_DIFF_BYTES } = {}) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn('git', ['-C', cwd, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // A fetch never asks a person: the terminal is drawing over the tty.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' },
      });
    } catch (error_) {
      done({ code: -1, out: '', err: error_.message, cut: false });
      return;
    }
    const chunks = [];
    let size = 0;
    let cut = false;
    let err = '';
    child.stdout.on('data', (chunk) => {
      if (cut) return;
      if (size + chunk.length > max) {
        chunks.push(chunk.subarray(0, max - size));
        cut = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', (failure) => done({ code: -1, out: '', err: failure.message, cut: false }));
    child.on('close', (code) => done({ code: cut ? 0 : code, out: Buffer.concat(chunks).toString('utf8'), err: err.trim(), cut }));
  });
}

/**
 * The diff of `branch` against `base` in the checkout at `cwd`: what the
 * branch adds since it left the base (three dots, from the merge base).
 * Fetches both first; a fetch that fails (offline, a branch never pushed)
 * falls back to what the checkout already has, and says so in `stale`.
 * Throws a sentence when neither ref can be found.
 */
export async function branchDiff(cwd, { branch, base }, run = git) {
  const fetched = await run(cwd, ['fetch', '--quiet', 'origin', base, branch], { max: 1 << 20 });
  const ref = async (name) => {
    for (const candidate of [`origin/${name}`, name]) {
      const found = await run(cwd, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], { max: 4096 });
      if (found.code === 0 && found.out.trim()) return candidate;
    }
    return null;
  };
  const head = await ref(branch);
  if (!head) throw new Error(`${branch} is not in ${cwd}, on origin or here`);
  const from = await ref(base);
  if (!from) throw new Error(`${base} is not in ${cwd}, on origin or here`);
  const diff = await run(cwd, ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '-M',
    `${from}...${head}`]);
  if (diff.code !== 0) {
    const why = diff.err || `exit ${diff.code}`;
    throw new Error(`git diff failed: ${why}`);
  }
  return { files: parseDiff(diff.out), cut: diff.cut, stale: fetched.code !== 0, head, from };
}
