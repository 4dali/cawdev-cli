// R294 — which parts of a runner's config a running daemon can take without a
// restart, and which it cannot.
//
// The daemon reads its config ONCE at boot and threads most of it by value —
// `projects` and their checkouts, `url`, `name`, the token, the MCP servers.
// Three keys are the exception: they are read fresh off the live `config`
// object on every use (a spawn, or the next heartbeat), so a SIGHUP that
// re-reads the file is enough to apply them. That list was spelled in three
// places — configure.mjs's header, attach.mjs's `reloadDaemon`, runner.mjs's
// handler — and nothing pinned that the three agreed. It is spelled HERE and
// nowhere else now, and the one question everything asks of it is
// `restartNeededFor`: given what the daemon booted with and what the file says
// now, which keys would only a restart change?
//
// Pure, because the daemon answers it and both config doors repeat the answer,
// and a function all three share is the only way they cannot disagree.
//
// Zero dependencies, like everything in tools/.

/**
 * The keys runner.mjs's SIGHUP handler applies without a restart.
 *
 * Only settings that are genuinely safe to hot-swap belong here: each one
 * must be read off `config` at the moment it is used, never captured at boot.
 * Adding a key that IS captured would make the daemon claim it applied
 * something it did not, which is worse than saying restart.
 */
/**
 * R577: the name this machine registers under — the environment first, then the
 * file, then a default. The daemon and the CLI both ask it, so `cawdev config
 * planning-limit` finds the same machine the daemon registered.
 */
export function runnerNameOf(file, env = process.env) {
  return env.CAWDEV_RUNNER_NAME ?? file?.name ?? 'this-machine';
}

export const HOT_SWAPPABLE = Object.freeze(['agentCommands', 'grantable', 'acceptsRulesFromConsole',
  'autoWorkspaces']);

/**
 * The legacy spelling of one key, read as the current one — so a config that
 * says `agentCommand: "claude"` is not reported as differing from one that
 * says `agentCommands: ["claude"]`. runner.mjs's `readConfig` makes the same
 * move; this is it applied to a raw file rather than a booted config.
 */
export function normaliseConfigFile(file) {
  const { agentCommand, ...rest } = file ?? {};
  if (agentCommand !== undefined && rest.agentCommands === undefined) {
    rest.agentCommands = [agentCommand];
  }
  return rest;
}

/**
 * The keys a restart would change: everything that differs between what the
 * daemon booted with and what the file says now, minus {@link HOT_SWAPPABLE}.
 *
 * Compared against the BOOTED file and not the last one read, so an edit
 * somebody reverts by hand clears the notice by itself. Values are compared
 * with a key-sorted stringify, because `{workspaces: [...], name}` and
 * `{name, workspaces: [...]}` are one config. Names only, never values: the
 * answer is shown in a footer and logged, and the token is one of the keys.
 *
 * @returns {string[]} sorted, empty when nothing needs a restart
 */
export function restartNeededFor(booted, file) {
  const before = normaliseConfigFile(booted);
  const after = normaliseConfigFile(file);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => !HOT_SWAPPABLE.includes(key))
    .filter((key) => canonical(before[key]) !== canonical(after[key]))
    .sort((a, b) => a.localeCompare(b));
}

/** Applied, or would be on a SIGHUP: the hot-swappable keys that differ. */
export function reloadableFor(booted, file) {
  const before = normaliseConfigFile(booted);
  const after = normaliseConfigFile(file);
  return HOT_SWAPPABLE.filter((key) => canonical(before[key]) !== canonical(after[key]));
}

/** JSON with object keys in one order, so two spellings of one value agree. */
function canonical(value) {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value, (_, inner) => (
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.keys(inner).sort((a, b) => a.localeCompare(b)).map((key) => [key, inner[key]]))
      : inner
  ));
}
