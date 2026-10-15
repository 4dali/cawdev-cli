import { existsSync, statSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Whether a workspace folder can be used at all, and how to say so — R377.
 *
 * Node reports a missing `cwd` as `spawn claude ENOENT`, which reads as "the
 * agent CLI is not installed" and sends a person looking at their PATH. The
 * folder is checked before it gets that far, and said in its own words.
 *
 * `.git` is checked with `access`, never `isDirectory()`: in a worktree —
 * including the `-read` copy — it is a file.
 */
export async function workspaceProblem(path) {
  try {
    const found = await stat(path);
    if (!found.isDirectory()) return { kind: 'not-a-directory', path };
  } catch (failure) {
    // ENOTDIR: a parent of it is a file, so it is no more there than if absent.
    if (failure.code === 'ENOENT' || failure.code === 'ENOTDIR') return { kind: 'missing', path };
    return { kind: 'unreadable', path, code: failure.code };
  }
  try {
    await access(join(path, '.git'));
  } catch {
    return { kind: 'not-git', path };
  }
  return null;
}

/**
 * The sentence for a problem. `first` is the project's `workspaces[0]`.
 * The wording must not change from one poll to the next: `noteQueued` only
 * logs again when the text does.
 */
export function workspaceProblemSaid(slug, problem, { first = null } = {}) {
  const { kind, path } = problem;
  if (kind === 'missing') {
    const base = `${slug}'s workspace ${path} does not exist on this machine. `
      + 'Clone the repository there, or correct "workspaces" with `cawdev config`.';
    // `createAutoWorkspace` clones FROM the first workspace, so the advice
    // cannot help when that is the one that is missing.
    return path !== first
      ? `${base} Or remove it and set "autoWorkspaces" so the runner clones checkouts beside ${first} itself.`
      : base;
  }
  if (kind === 'not-a-directory') {
    return `${slug}'s workspace ${path} is a file, not a folder. `
      + 'Correct "workspaces" with `cawdev config`.';
  }
  if (kind === 'unreadable') {
    return `${slug}'s workspace ${path} cannot be read (${problem.code ?? 'unknown error'}). `
      + 'Fix its permissions, or correct "workspaces" with `cawdev config`.';
  }
  return `${slug}'s workspace ${path} exists but is not a git checkout (no .git in it). `
    + 'Clone the repository there, or correct "workspaces" with `cawdev config`.';
}

function problemSync(cwd) {
  if (!cwd || !existsSync(cwd)) return { kind: 'missing', path: cwd };
  if (!statSync(cwd).isDirectory()) return { kind: 'not-a-directory', path: cwd };
  return null;
}

/**
 * What to tell a person when `spawn` fails. Runs inside an `'error'` handler,
 * hence the synchronous checks. `label` is "the agent", "Antigravity" or "Codex".
 */
export function spawnFailureSaid({ failure, command, cwd, slug, label, first = null }) {
  if (failure?.code === 'ENOENT') {
    const problem = problemSync(cwd);
    if (problem) return workspaceProblemSaid(slug, problem, { first });
    return `\`${command}\` not found on this runner's PATH — set "agentCommands" to its full path `
      + `(run \`which ${command}\` where it works).`;
  }
  return `Could not spawn ${label}: ${failure?.message}`;
}
