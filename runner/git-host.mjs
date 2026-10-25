// The git host's side of the runner — R379.
//
// The runner has only ever spoken to GitHub, through `gh`. A GitLab project
// could be pushed to but not opened, found or merged against, and a run's link
// to its pull request came back empty. This is the one place that knows there
// are three: `adapterFor('github')` is the `gh` calls the daemon always made,
// moved here without change; `adapterFor('gitlab')` is the same questions asked
// of `glab`; `adapterFor('bitbucket')` (R565) asks Bitbucket Cloud's REST API
// with a token that lives on this machine (`configureBitbucket`), because
// Bitbucket has no CLI to lean on.
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
 * Which host to talk to: `'github'`, `'gitlab'` or `'bitbucket'`.
 *
 * A host the project DECLARED wins; otherwise a host name containing `gitlab` is
 * GitLab, `bitbucket.org` is Bitbucket; otherwise GitHub, which is what the
 * runner has always assumed — so a
 * project that never set anything behaves exactly as it did.
 */
export function hostFor({ declared = null, originUrl = null } = {}) {
  const said = String(declared ?? '').trim().toUpperCase();
  if (said === 'GITLAB') return 'gitlab';
  if (said === 'GITHUB') return 'github';
  if (said === 'BITBUCKET') return 'bitbucket';
  const repo = repoOf(originUrl);
  if (repo && /bitbucket\.org$/i.test(repo.host)) return 'bitbucket';
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
  if (host === 'bitbucket') {
    return `https://bitbucket.org/${repo.path}/branches/compare/${name}%0D${encodeURIComponent(base || 'main')}`;
  }
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

/** The pull request id at the end of a Bitbucket pull request URL. */
export function prIdOf(url) {
  return /\/pull-requests\/(\d+)/.exec(url ?? '')?.[1] ?? null;
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

const STATES = { OPEN: 'OPEN', MERGED: 'MERGED', CLOSED: 'CLOSED' };

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

  /** `{ state, mergedAt, mergeCommit }` for a pull request URL (or branch), or null. */
  async view(cwd, target) {
    const asked = await runCli('gh', cwd, ['pr', 'view', target, '--json', 'state,mergedAt,mergeCommit']);
    const parsed = asked.code === 0 ? parse(asked.out) : null;
    if (!parsed?.state) return null;
    return {
      state: STATES[parsed.state] ?? null,
      mergedAt: parsed.mergedAt ?? null,
      mergeCommit: parsed.mergeCommit?.oid ?? null,
    };
  },

  /** Every pull request whose head is `branch`, in the shape all three hosts share. */
  async listByHead(cwd, branch) {
    const asked = await runCli('gh', cwd, ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '10', '--json',
      'number,url,state,mergedAt,mergeCommit,baseRefName,headRefName,isCrossRepository']);
    const rows = asked.code === 0 ? parse(asked.out) : null;
    if (!Array.isArray(rows)) return null;
    return rows.map((row) => ({
      number: row.number,
      url: row.url ?? null,
      state: STATES[row.state] ?? null,
      mergedAt: row.mergedAt ?? null,
      mergeCommit: row.mergeCommit?.oid ?? null,
      baseRefName: row.baseRefName ?? null,
      headRefName: row.headRefName ?? null,
      isCrossRepository: Boolean(row.isCrossRepository),
    }));
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

  async view(cwd, target) {
    const asked = await runCli('glab', cwd, ['mr', 'view', iidOf(target) ?? target, '--output', 'json']);
    const row = asked.code === 0 ? parse(asked.out) : null;
    if (!row?.state) return null;
    const { state, mergedAt, mergeCommit } = gitlabRow(row);
    return state ? { state, mergedAt, mergeCommit } : null;
  },

  async listByHead(cwd, branch) {
    // `--all` is newer than some installs; without it, ask for merged and closed
    // separately and join them to the open ones.
    if (glabHasAll === null) {
      const help = await runCli('glab', cwd, ['mr', 'list', '--help']);
      if (help.code === 0) glabHasAll = /--all\b/.test(`${help.out}\n${help.err}`);
    }
    const ask = (...flags) => runCli('glab', cwd,
      ['mr', 'list', '--source-branch', branch, ...flags, '--output', 'json']);
    const asked = glabHasAll === false ? null : await ask('--all');
    const lists = asked
      ? [asked]
      : await Promise.all([ask(), ask('--merged'), ask('--closed')]);
    const rows = [];
    for (const one of lists) {
      const parsed = one.code === 0 ? parse(one.out) : null;
      if (Array.isArray(parsed)) rows.push(...parsed);
    }
    if (!rows.length && lists.every((one) => one.code !== 0)) return null;
    return rows.map((row) => gitlabRow(row));
  },

  fallbackLink: (repo, base, branch) => compareUrl('gitlab', repo, base, branch),
};

let glabHasAll = null;

/** A merge request as the shared row. A squash merge's commit is `squash_commit_sha`. */
function gitlabRow(row) {
  return {
    number: row.iid ?? null,
    url: row.web_url ?? null,
    state: { opened: 'OPEN', merged: 'MERGED', closed: 'CLOSED', locked: 'OPEN' }[row.state] ?? null,
    mergedAt: row.merged_at ?? null,
    mergeCommit: row.merge_commit_sha ?? row.squash_commit_sha ?? null,
    baseRefName: row.target_branch ?? null,
    headRefName: row.source_branch ?? null,
    isCrossRepository: row.source_project_id != null && row.source_project_id !== row.target_project_id,
  };
}

// --- Bitbucket Cloud --------------------------------------------------------------
//
// No CLI: the REST API, with a token this machine keeps (`configureBitbucket`,
// from the runner's own config). The platform never sees it, and the agent's
// environment has it removed (`agentEnv` in runner.mjs).

let bitbucketSettings = { email: null, token: null, apiUrl: 'https://api.bitbucket.org/2.0' };

/** Called once at boot, and by tests. `apiUrl` is only for tests. */
export function configureBitbucket({ email = null, token = null, apiUrl = null } = {}) {
  bitbucketSettings = {
    email: email || null,
    token: token || null,
    apiUrl: (apiUrl || 'https://api.bitbucket.org/2.0').replace(/\/+$/, ''),
  };
}

const NO_TOKEN = 'Bitbucket needs an API token on this machine. Set "bitbucket": { "email": "…", '
  + '"tokenEnv": "BITBUCKET_TOKEN" } in this machine\'s cawdev config and export the token.';

/** `{ status, json, headers }`, or `{ status: -1, error }` when the call never landed. */
async function bitbucketCall(method, url, body) {
  const { email, token } = bitbucketSettings;
  const auth = email
    ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
    : `Bearer ${token}`;
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: auth,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    return { status: response.status, json: parse(text), headers: response.headers };
  } catch (failure) {
    return { status: -1, error: failure.message };
  }
}

/** `{ base, ws, repo }` for the checkout's origin, or an error result. */
async function bitbucketRepo(cwd) {
  if (!bitbucketSettings.token) {
    return { failure: { code: -1, out: '', err: NO_TOKEN } };
  }
  const origin = await runCli('git', cwd, ['remote', 'get-url', 'origin']);
  const repo = origin.code === 0 ? repoOf(origin.out) : null;
  const [ws, slug] = (repo?.path ?? '').split('/');
  if (!ws || !slug) {
    return { failure: { code: 1, out: '', err: 'Could not read the Bitbucket workspace and repository from origin.' } };
  }
  return { base: `${bitbucketSettings.apiUrl}/repositories/${ws}/${slug}` };
}

function bitbucketProblem(reply) {
  if (reply.status === -1) return reply.error;
  return reply.json?.error?.message ?? `Bitbucket answered ${reply.status}`;
}

const BITBUCKET_STATES = { OPEN: 'OPEN', MERGED: 'MERGED', DECLINED: 'CLOSED', SUPERSEDED: 'CLOSED' };

function bitbucketRow(row) {
  const state = BITBUCKET_STATES[row.state] ?? null;
  return {
    number: row.id ?? null,
    url: row.links?.html?.href ?? null,
    state,
    mergedAt: state === 'MERGED' ? (row.updated_on ?? null) : null,
    mergeCommit: row.merge_commit?.hash ?? null,
    baseRefName: row.destination?.branch?.name ?? null,
    headRefName: row.source?.branch?.name ?? null,
    isCrossRepository: row.source?.repository?.full_name !== row.destination?.repository?.full_name
      && Boolean(row.source?.repository?.full_name),
  };
}

/** A value inside a Bitbucket query's double quotes. */
const quoted = (value) => String(value).replace(/[\\"]/g, '\\$&');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const bitbucket = {
  name: 'bitbucket',
  bin: null,
  noun: 'pull request',
  installHint: 'set "bitbucket": { "email": "…", "tokenEnv": "BITBUCKET_TOKEN" } in this machine\'s cawdev config and export the token',

  async run() {
    return { code: -1, out: '', err: 'Bitbucket has no command line here; cawdev calls its API directly.' };
  },

  async find(cwd, branch) {
    const where = await bitbucketRepo(cwd);
    if (where.failure) return null;
    const q = encodeURIComponent(`source.branch.name="${quoted(branch)}" AND state="OPEN"`);
    const reply = await bitbucketCall('GET', `${where.base}/pullrequests?q=${q}`);
    return reply.status === 200 ? (reply.json?.values?.[0]?.links?.html?.href ?? null) : null;
  },

  async create(cwd, { branch, base, title, body }) {
    const where = await bitbucketRepo(cwd);
    if (where.failure) return where.failure;
    const reply = await bitbucketCall('POST', `${where.base}/pullrequests`, {
      title,
      description: body,
      source: { branch: { name: branch } },
      ...(base ? { destination: { branch: { name: base } } } : {}),
      close_source_branch: true,
    });
    if (reply.status === 201 && reply.json?.links?.html?.href) {
      return { code: 0, out: reply.json.links.html.href, err: '' };
    }
    return { code: 1, out: '', err: bitbucketProblem(reply) };
  },

  urlOf: (created) => created.out,

  /** Bitbucket does not compute mergeability lazily: there is nothing to wait for. */
  async mergeability() {
    return 'KNOWN';
  },

  async merge(cwd, url, { mergeCommit }) {
    const where = await bitbucketRepo(cwd);
    if (where.failure) return where.failure;
    const id = prIdOf(url);
    if (!id) return { code: 1, out: '', err: `Not a Bitbucket pull request URL: ${url}` };
    const reply = await bitbucketCall('POST', `${where.base}/pullrequests/${id}/merge`, {
      merge_strategy: mergeCommit ? 'merge_commit' : 'squash',
      close_source_branch: true,
    });
    if (reply.status === 200) {
      return { code: 0, out: reply.json?.links?.html?.href ?? url, err: '' };
    }
    if (reply.status !== 202) {
      return { code: 1, out: '', err: bitbucketProblem(reply) };
    }
    // 202: the merge runs as a background task; its URL is in Location.
    const task = reply.headers.get('location');
    // Only ever follow it on the API we were talking to: the poll carries our token.
    if (task && !task.startsWith(bitbucketSettings.apiUrl) && !task.startsWith(new URL(bitbucketSettings.apiUrl).origin)) {
      return { code: 1, out: '', err: 'Bitbucket accepted the merge but pointed at a task on another host; not following it.' };
    }
    if (!task) return { code: 1, out: '', err: 'Bitbucket accepted the merge but gave no task to follow.' };
    const wait = Number(process.env.CAWDEV_MERGEABILITY_WAIT_MS ?? 5000);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await sleep(wait);
      const polled = await bitbucketCall('GET', task);
      const status = polled.json?.task_status;
      if (status === 'SUCCESS') return { code: 0, out: url, err: '' };
      if (status === 'FAILED') {
        return { code: 1, out: '', err: polled.json?.merge_result?.error?.message ?? polled.json?.error?.message ?? 'Bitbucket failed to merge the pull request.' };
      }
    }
    return { code: 1, out: '', err: 'Bitbucket is still merging this pull request; check it in a moment.' };
  },

  async refusal(cwd, url) {
    const where = await bitbucketRepo(cwd);
    const id = prIdOf(url);
    if (where.failure || !id) return null;
    const reply = await bitbucketCall('GET', `${where.base}/pullrequests/${id}/diffstat`);
    const values = reply.status === 200 ? reply.json?.values : null;
    return Array.isArray(values) && values.some((entry) => /conflict/i.test(entry?.status ?? ''))
      ? 'CONFLICT'
      : null;
  },

  async view(cwd, target) {
    const where = await bitbucketRepo(cwd);
    if (where.failure) return null;
    const id = prIdOf(target);
    if (!id) {
      // A branch name, not a URL: the newest pull request from it.
      const rows = await this.listByHead(cwd, target);
      const newest = rows?.sort((a, b) => b.number - a.number)[0];
      return newest ? { state: newest.state, mergedAt: newest.mergedAt, mergeCommit: newest.mergeCommit } : null;
    }
    const reply = await bitbucketCall('GET', `${where.base}/pullrequests/${id}`);
    if (reply.status !== 200 || !reply.json) return null;
    const row = bitbucketRow(reply.json);
    return row.state ? { state: row.state, mergedAt: row.mergedAt, mergeCommit: row.mergeCommit } : null;
  },

  async listByHead(cwd, branch) {
    const where = await bitbucketRepo(cwd);
    if (where.failure) return null;
    const q = encodeURIComponent(`source.branch.name="${quoted(branch)}"`);
    const states = ['OPEN', 'MERGED', 'DECLINED'].map((state) => `state=${state}`).join('&');
    const reply = await bitbucketCall('GET', `${where.base}/pullrequests?q=${q}&${states}&pagelen=10`);
    if (reply.status !== 200 || !Array.isArray(reply.json?.values)) return null;
    return reply.json.values.map(bitbucketRow);
  },

  fallbackLink: (repo, base, branch) => compareUrl('bitbucket', repo, base, branch),
};

export function adapterFor(host) {
  return host === 'gitlab' ? gitlab : host === 'bitbucket' ? bitbucket : github;
}
