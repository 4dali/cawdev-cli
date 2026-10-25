#!/usr/bin/env node
// What a coding agent may push — R565.
//
// Both a pure function (`judge`) and a Claude Code PreToolUse hook (the bottom
// of the file). The runner wires it in with `--settings`; an exit code of 2
// blocks the tool call and shows stderr to the model.
//
// A guard against MISTAKES, not a security boundary: `git -c alias.x='!…'`, a
// host CLI by absolute path through a script, or any language with a socket
// gets round a pattern match. The wall is branch protection on the host. What
// this buys is that the obvious wrong move is refused with a reason, in the
// session, instead of being discovered afterwards by `auditPushes`.
//
// No dependencies, and in `tools/runner/` on purpose — see git-host.mjs.

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

const HOST_CLIS = new Set(['gh', 'glab', 'hub', 'bb', 'lab', 'tea']);
const HOST_CLI_REASON = 'Branches, pull requests and merges are done from cawdev, not by the agent.';
const WRAPPERS = new Set(['env', 'command', 'exec', 'sudo', 'nohup', 'time']);

/** Splits on `; && || |` and newlines, outside quotes; `$( … )` and backticks become segments of their own. */
export function segmentsOf(command) {
  const out = [];
  const walk = (text) => {
    let current = '';
    let quote = null;
    const flush = () => {
      if (current.trim()) out.push(current.trim());
      current = '';
    };
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (quote === "'") {
        if (c === "'") quote = null;
        current += c;
        continue;
      }
      if (c === '\\' && i + 1 < text.length) {
        current += c + text[i + 1];
        i += 1;
        continue;
      }
      if (c === '$' && text[i + 1] === '(') {
        let depth = 1;
        let j = i + 2;
        while (j < text.length && depth > 0) {
          if (text[j] === '(') depth += 1;
          if (text[j] === ')') depth -= 1;
          j += 1;
        }
        walk(text.slice(i + 2, j - 1));
        current += ' ';
        i = j - 1;
        continue;
      }
      if (c === '`') {
        const end = text.indexOf('`', i + 1);
        const stop = end < 0 ? text.length : end;
        walk(text.slice(i + 1, stop));
        current += ' ';
        i = stop;
        continue;
      }
      if (quote === '"') {
        if (c === '"') quote = null;
        current += c;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        current += c;
        continue;
      }
      if (c === '&' && (text[i - 1] === '>' || text[i - 1] === '<' || text[i + 1] === '>')) {
        current += c; // a redirection (`2>&1`, `&>`), not a command separator
        continue;
      }
      if (c === ';' || c === '\n' || c === '|' || c === '&') {
        flush();
        if ((c === '|' || c === '&') && text[i + 1] === c) i += 1;
        continue;
      }
      current += c;
    }
    flush();
  };
  walk(String(command ?? ''));
  return out;
}

/** Shell-ish words: quotes removed, no expansion. */
export function wordsOf(segment) {
  const words = [];
  let current = '';
  let has = false;
  let quote = null;
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < segment.length) current += segment[++i];
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < segment.length) {
      current += segment[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) words.push(current);
      current = '';
      has = false;
    } else {
      current += c;
      has = true;
    }
  }
  if (has) words.push(current);
  return words;
}

/** Drops `VAR=…`, `env`, `command`, `exec`, `sudo` (and their own flags) from the front. */
function stripPrefix(input) {
  // `(gh …)`, `{ gh …; }`, `! gh`, `then gh`: group and keyword words in front.
  const words = input.map((w, index) => (index === 0 ? w.replace(/^[({]+/, '') : w))
    .filter((w, index) => !(index < 3 && w === ''));
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || /^(\{|!|then|do|else|elif|if|while|until|time)$/.test(w)) {
      i += 1;
    } else if (WRAPPERS.has(basename(w))) {
      i += 1;
      // Their own flags, and the value of those that take one (`env -u X`, `sudo -u root`).
      while (i < words.length && words[i].startsWith('-')) {
        i += /^-(u|g|C|h|p|U|r|t|D)$/.test(words[i]) ? 2 : 1;
      }
    } else {
      break;
    }
  }
  return words.slice(i);
}

/** Drops `2>&1`, `> file`, `>>file`, `&> file`, `< in` so they are not read as arguments. */
function withoutRedirects(words) {
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (/^(\d*|&)[<>]+(&\d+|&-)?$/.test(w)) {
      if (!/&[\d-]+$/.test(w)) i += 1; // the file name that follows
      continue;
    }
    if (/^(\d*|&)[<>]+\S+/.test(w)) continue;
    out.push(w);
  }
  return out;
}

const FORCE = /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes)$/;
const BAD_FLAGS = /^(-d|--delete|--mirror|--all|--prune)$/;
const WITH_VALUE = new Set(['--receive-pack', '--exec', '-o', '--push-option', '--signed']);

/** The first non-option word after `git`'s own global options, and the words after it. */
function gitSubcommand(words) {
  let i = 1;
  const globals = [];
  while (i < words.length && words[i].startsWith('-')) {
    const w = words[i];
    globals.push(w);
    if ((w === '-c' || w === '-C' || w === '--git-dir' || w === '--work-tree' || w === '--namespace') && i + 1 < words.length) {
      globals.push(words[i + 1]);
      i += 2;
    } else {
      i += 1;
    }
  }
  return { sub: words[i] ?? null, rest: words.slice(i + 1), globals };
}

function judgePush(rest, { branch, defaultBranch, allowTags, head, isTag }) {
  const positional = [];
  let hasRepoFlag = false;
  for (let i = 0; i < rest.length; i += 1) {
    const w = rest[i];
    if (FORCE.test(w)) return 'A force push is refused: the agent may only fast-forward its own branch.';
    if (BAD_FLAGS.test(w)) return `git push ${w} is refused: the agent may only push its own branch.`;
    if (/^-[a-zA-Z]*[fd][a-zA-Z]*$/.test(w) && !w.startsWith('--')) {
      // Combined short flags such as -fu or -df.
      if (/[fd]/.test(w.slice(1))) return `git push ${w} is refused: a force or delete is not the agent's to do.`;
    }
    if (w === '--tags' || w === '--follow-tags') {
      if (!allowTags) return `git push ${w} is refused: only a release session pushes tags.`;
      continue;
    }
    if (w === '--repo' || w.startsWith('--repo=')) {
      // The remote is named by the flag, so every positional is a refspec.
      hasRepoFlag = true;
      if (w === '--repo') i += 1;
      continue;
    }
    if (WITH_VALUE.has(w)) {
      i += 1;
      continue;
    }
    if (w.startsWith('-')) continue;
    positional.push(w);
  }
  if (!branch || branch === defaultBranch) {
    return 'Pushing is refused: this session has no branch of its own to push.';
  }
  // A remote that is a URL or a path is somewhere the guard cannot vouch for.
  if (!hasRepoFlag && positional[0] && /[:@/]/.test(positional[0])) {
    return `Pushing to ${positional[0]} is refused: push to a named remote.`;
  }
  const refspecs = hasRepoFlag ? positional : positional.slice(1); // else the first positional is the remote
  if (refspecs.length === 0) {
    return head === branch ? null
      : `A push with no refspec is refused unless HEAD is ${branch} (it is ${head || 'detached'}). Push ${branch} by name.`;
  }
  const own = new Set([
    branch, 'HEAD', `HEAD:${branch}`, `${branch}:${branch}`, `HEAD:refs/heads/${branch}`,
    `refs/heads/${branch}`, `refs/heads/${branch}:refs/heads/${branch}`,
  ]);
  for (const spec of refspecs) {
    if (spec.startsWith('+')) return `The refspec ${spec} forces the update; it is refused.`;
    if (spec.startsWith(':')) return `The refspec ${spec} deletes a ref; it is refused.`;
    if (own.has(spec)) {
      if ((spec === 'HEAD' || spec.startsWith('HEAD:')) && head !== branch) {
        return `HEAD is ${head || 'detached'}, not ${branch}: pushing it would put it on ${branch} or elsewhere. Check out ${branch} first.`;
      }
      continue;
    }
    if (allowTags) {
      const name = spec.replace(/^refs\/tags\//, '');
      const target = spec.includes(':') ? null : name;
      if (target && (spec.startsWith('refs/tags/') || isTag?.(target))) continue;
    }
    return `Pushing ${spec} is refused: this session may push ${branch} and nothing else.`;
  }
  return null;
}

/**
 * `null` when the command may run, otherwise the reason it may not.
 *
 * @param {string} command
 * @param {{ branch: string, defaultBranch?: string, allowTags?: boolean,
 *   head?: string, isTag?: (name: string) => boolean }} context
 */
export function judge(command, context) {
  const ctx = { branch: '', defaultBranch: '', allowTags: false, head: '', isTag: () => false, ...context };
  for (const segment of segmentsOf(command)) {
    const words = withoutRedirects(stripPrefix(wordsOf(segment)));
    if (!words.length) continue;
    const first = basename(words[0]);
    if (HOST_CLIS.has(first)) return HOST_CLI_REASON;
    if (/^(bash|sh|zsh|dash|ksh)$/.test(first) || first === 'eval') {
      // `bash -c "git push origin main"`: judge the script it was handed.
      const at = first === 'eval' ? 0 : words.indexOf('-c');
      const script = first === 'eval' ? words.slice(1).join(' ') : words[at + 1];
      if (script) {
        const inner = judge(script, ctx);
        if (inner) return inner;
      }
      continue;
    }
    if (first !== 'git') continue;
    const { sub, rest, globals } = gitSubcommand(words);
    for (let i = 0; i < globals.length; i += 1) {
      if (globals[i] === '-c' && /^(alias\.|core\.hookspath=|core\.sshcommand=|remote\.[^=]*\.(push)?url=|url\.)/i.test(globals[i + 1] ?? '')) {
        return 'git -c alias.*, core.hooksPath, core.sshCommand and remote/url rewrites are refused: they run commands or send the push somewhere the guard cannot read.';
      }
    }
    if (sub === 'config' && rest.some((w) => /^alias\./i.test(w))) {
      return 'git config alias.* is refused: an alias can run any command.';
    }
    if (sub === 'push') {
      const reason = judgePush(rest, ctx);
      if (reason) return reason;
    }
  }
  return null;
}

// --- the hook -------------------------------------------------------------------

function git(cwd, args) {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: done.status, out: (done.stdout ?? '').trim() };
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    process.stderr.write('push-guard: could not read the hook input; allowing\n');
    process.exit(0); // not a hook call; never block on a parse failure
  }
  if (input?.tool_name !== 'Bash') {
    process.exit(0);
  }
  const cwd = input.cwd || process.cwd();
  const command = input.tool_input?.command ?? '';
  const reason = judge(command, {
    branch: process.env.CAWDEV_PUSH_BRANCH ?? '',
    defaultBranch: process.env.CAWDEV_DEFAULT_BRANCH ?? '',
    allowTags: process.env.CAWDEV_PUSH_TAGS === '1',
    // Only a push cares where HEAD is; every other command skips the git call.
    head: /\bpush\b/.test(command) ? git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out : '',
    isTag: (name) => git(cwd, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}`]).code === 0,
  });
  if (reason) {
    process.stderr.write(`${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

if (process.argv[1]?.endsWith('push-guard.mjs')) {
  main();
}
