// The git host's side of the runner — R379.
//
// The runner has only ever spoken to GitHub, through `gh`. A GitLab project
// could be pushed to but not opened, found or merged against, and a run's link
// to its pull request came back empty. This is the one place that knows there
// are two: `adapterFor('github')` is the `gh` calls the daemon always made,
// moved here without change; `adapterFor('gitlab')` is the same questions asked
// of `glab`.
//
// No dependencies, and in `tools/runner/` rather than `tools/lib/` on purpose:
// this half of the tree is open-licence and must not import the other.

import { spawn } from 'node:child_process';

// --- the repository --------------------------------------------------------------

/**
 * `{ host, path }` for an origin URL, or null when it is not one we can read.
 * `git@h:a/b/c.git`, `https://h/a/b/c(.git)` and `ssh://git@h:2222/a/b.git` —
 * `path` is the repository's path on the host without `.git`, subgroups kept.
 */
export function repoOf(originUrl) {
  const url = (originUrl ?? '').trim();
  if (!url) {
    return null;
  }
  const scp = /^[\w.-]+@([\w.-]+):(?!\/\/)(.+?)(?:\.git)?\/?$/.exec(url);
  if (scp) {
    return { host: scp[1], path: scp[2].replace(/^\/+/, '') };
  }
  const full = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(url);
  if (full) {
    return { host: full[1], path: full[2] };
  }
  return null;
}

/**
 * Which host's CLI to use: `'github'` or `'gitlab'`.
 *
 * A host the project DECLARED wins; otherwise a host name containing `gitlab` is
 * GitLab; otherwise GitHub, which is what the runner has always assumed — so a
 * project that never set anything behaves exactly as it did.
 */
export function hostFor({ declared = null, originUrl = null } = {}) {
  const said = String(declared ?? '').trim().toUpperCase();
  if (said === 'GITLAB') return 'gitlab';
  if (said === 'GITHUB') return 'github';
  const repo = repoOf(originUrl);
  return repo && /gitlab/i.test(repo.host) ? 'gitlab' : 'github';
}

/**
 * A link somebody can click to open a pull or merge request themselves. It
 * always contains `/compare/` — the platform tells a real pull request from this
 * by that, and nothing else.
 */
export function compareUrl(host, repo, base, branch) {
  if (!repo) {
    return null;
  }
  const name = encodeURIComponent(branch);
  if (host === 'gitlab') {
    return `https://${repo.host}/${repo.path}/-/compare/${encodeURIComponent(base || 'main')}...${name}`;
  }
  return `https://${repo.host}/${repo.path}/compare/${name}`;
}

/** The merge request URL a `glab mr create` printed, or null. */
export function mrUrlIn(text) {
  const found = String(text ?? '').match(/https?:\/\/\S+?\/-\/merge_requests\/\d+/g);
  return found ? found[found.length - 1] : null;
}

/** The iid at the end of a merge request URL. */
export function iidOf(url) {
  return /\/merge_requests\/(\d+)/.exec(url ?? '')?.[1] ?? null;
}

const GITLAB_WAIT = new Set(['checking', 'unchecked', 'preparing', 'ci_still_running']);
const GITLAB_BLOCKED = new Set([
  'not_approved', 'blocked_status', 'ci_must_pass', 'discussions_not_resolved',
  'draft_status', 'not_open', 'requested_changes',
]);

/**
 * What `glab mr view --output json` says about whether a merge request can
 * merge: `CONFLICT`, `UNKNOWN` (the host has not computed it — wait),
 * `NOT_PERMITTED` or `KNOWN`.
 */
export function gitlabMergeability(view) {
  if (!view || typeof view !== 'object') {
    return 'KNOWN';
  }
  const status = String(view.detailed_merge_status ?? '').toLowerCase();
  if (view.has_conflicts === true || status === 'conflict') return 'CONFLICT';
  if (GITLAB_WAIT.has(status)) return 'UNKNOWN';
  if (GITLAB_BLOCKED.has(status)) return 'NOT_PERMITTED';
  return 'KNOWN';
}

// --- running a CLI ---------------------------------------------------------------

/** Runs `bin` and hands back everything it said, including on failure. */
export function runCli(bin, cwd, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', (failure) => resolvePromise({
      code: -1,
      out: '',
      err: failure.code === 'ENOENT'
        ? `${bin} is not installed on this machine, so it cannot talk to the git host.`
        : failure.message,
    }));
    // `close`, not `exit`: stdout may still hold data when the process exits.
    child.on('close', (code) => resolvePromise({ code, out: out.trim(), err: err.trim() }));
  });
}

function parse(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return null;
  }
}

// --- the adapters ----------------------------------------------------------------

const github = {
  name: 'github',
  bin: 'gh',
  noun: 'pull request',
  installHint: 'brew install gh && gh auth login',

  run: (cwd, args) => runCli('gh', cwd, args),

  /** The URL of the pull request for a branch, or null. */
  async find(cwd, branch) {
    const asked = await runCli('gh', cwd, ['pr', 'view', branch, '--json', 'url', '--jq', '.url']);
    return asked.code === 0 && asked.out ? asked.out : null;
  },

  create: (cwd, { branch, base, title, body }) => runCli('gh', cwd, [
    'pr', 'create',
    '--head', branch,
    ...(base ? ['--base', base] : []),
    '--title', title,
    '--body', body,
  ]),

  /** The URL a successful create printed. */
  urlOf: (created) => created.out.split('\n').pop().trim(),

  /** `'UNKNOWN'` while the host has not computed it; anything else is "stop waiting". */
  async mergeability(cwd, url) {
    const asked = await runCli('gh', cwd, ['pr', 'view', url, '--json', 'mergeable,mergeStateStatus']);
    if (asked.code !== 0) return 'KNOWN';
    const view = parse(asked.out);
    return view && view.mergeable === 'UNKNOWN' ? 'UNKNOWN' : 'KNOWN';
  },

  merge: (cwd, url, { mergeCommit }) => runCli('gh', cwd,
    ['pr', 'merge', url, mergeCommit ? '--merge' : '--squash', '--delete-branch']),

  /** Why a merge was refused, when the host can say: `CONFLICT`, `NOT_PERMITTED` or null. */
  async refusal(cwd, url) {
    const asked = await runCli('gh', cwd, ['pr', 'view', url, '--json', 'mergeable,mergeStateStatus']);
    if (asked.code !== 0) return null;
    const view = parse(asked.out);
    if (!view) return null;
    if (view.mergeable === 'CONFLICTING' || view.mergeStateStatus === 'DIRTY') return 'CONFLICT';
    if (view.mergeStateStatus === 'BLOCKED') return 'NOT_PERMITTED';
    return null;
  },

  /** The compare link fallback — only for github.com, as it always was. */
  fallbackLink(repo, _base, branch) {
    return repo && repo.host === 'github.com' ? compareUrl('github', repo, null, branch) : null;
  },
};

// `glab mr merge` queues an auto-merge by default on versions that have the
// flag; asked once per process whether this glab does.
let glabHasAutoMerge = null;

async function autoMergeFlag(cwd) {
  if (glabHasAutoMerge === null) {
    const help = await runCli('glab', cwd, ['mr', 'merge', '--help']);
    const has = /--auto-merge/.test(`${help.out}\n${help.err}`);
    // Only a real answer is remembered: glab not installed yet, or a failed first
    // call, must not decide for the life of the daemon.
    if (help.code !== 0) {
      return has ? ['--auto-merge=false'] : [];
    }
    glabHasAutoMerge = has;
  }
  return glabHasAutoMerge ? ['--auto-merge=false'] : [];
}

const gitlab = {
  name: 'gitlab',
  bin: 'glab',
  noun: 'merge request',
  installHint: 'install glab and run `glab auth login --hostname <your GitLab host>`',

  run: (cwd, args) => runCli('glab', cwd, args),

  async find(cwd, branch) {
    const asked = await runCli('glab', cwd, ['mr', 'list', '--source-branch', branch, '--output', 'json']);
    if (asked.code !== 0) return null;
    const rows = parse(asked.out);
    const first = Array.isArray(rows) ? rows[0] : null;
    return first?.web_url ?? null;
  },

  create: (cwd, { branch, base, title, body }) => runCli('glab', cwd, [
    'mr', 'create',
    '--source-branch', branch,
    ...(base ? ['--target-branch', base] : []),
    '--title', title,
    '--description', body,
    '--yes',
  ]),

  urlOf: (created) => mrUrlIn(`${created.out}\n${created.err}`),

  async mergeability(cwd, url) {
    const iid = iidOf(url);
    if (!iid) return 'KNOWN';
    const asked = await runCli('glab', cwd, ['mr', 'view', iid, '--output', 'json']);
    if (asked.code !== 0) return 'KNOWN';
    return gitlabMergeability(parse(asked.out)) === 'UNKNOWN' ? 'UNKNOWN' : 'KNOWN';
  },

  async merge(cwd, url, { mergeCommit }) {
    const iid = iidOf(url) ?? url;
    return runCli('glab', cwd, [
      'mr', 'merge', iid, '--yes', '--remove-source-branch',
      ...(mergeCommit ? [] : ['--squash']),
      ...(await autoMergeFlag(cwd)),
    ]);
  },

  async refusal(cwd, url) {
    const iid = iidOf(url);
    if (!iid) return null;
    const asked = await runCli('glab', cwd, ['mr', 'view', iid, '--output', 'json']);
    if (asked.code !== 0) return null;
    const verdict = gitlabMergeability(parse(asked.out));
    return verdict === 'CONFLICT' || verdict === 'NOT_PERMITTED' ? verdict : null;
  },

  fallbackLink: (repo, base, branch) => compareUrl('gitlab', repo, base, branch),
};

export function adapterFor(host) {
  return host === 'gitlab' ? gitlab : github;
}
