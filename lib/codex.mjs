/**
 * OpenAI's Codex CLI as a third agent — the arguments a spawn is given and the
 * events it prints, and nothing that touches a process.
 *
 * In lib/ for `code-map.mjs`'s reason: the hard parts are a command line and a
 * stream, both testable without a daemon, a platform or a model. The spawn
 * itself is `spawnCodex` in runner.mjs, beside `spawnAntigravity`.
 *
 * <p>Every flag and field here was checked against the real CLI (0.155) by
 * hand rather than read off documentation:
 *
 * <ul>
 * <li>`codex exec --json` prints JSONL: `thread.started` (carries the id
 *   `resume` takes), `item.started`/`item.completed` for `agent_message`,
 *   `command_execution`, `mcp_tool_call`, `file_change`…, then
 *   `turn.completed` with `usage` or `turn.failed` with `error`.
 * <li>In `exec` the approval policy is NEVER, so an MCP call is refused
 *   outright ("requires approval, but approval policy is never") unless its
 *   server says `default_tools_approval_mode = "approve"`. With it, cawdev's
 *   own server is reached even under `--sandbox read-only`, network included:
 *   the sandbox is the SHELL's, not the MCP servers'.
 * <li>`enabled_tools` really narrows a server — a tool left out is not offered
 *   at all — and `disabled_tools` takes one away.
 * <li>`env_vars` forwards named variables from Codex's own environment to a
 *   server, which keeps the run's token off the command line, where `ps`
 *   would show it to anybody on the machine.
 * <li>`shell_environment_policy.set` blanks a variable for every command the
 *   model runs — and `exclude` does NOT (tried: `echo $CAWDEV_TOKEN` still
 *   printed it). The token reaches cawdev's server through `env_vars`, which
 *   reads Codex's own environment and not the shell's, so blanking it for the
 *   shell costs the server nothing.
 * <li>`resume` takes the exec-level options BEFORE the subcommand:
 *   `codex exec --json -s read-only resume <id> -`; after it, `-s` is refused.
 * <li>`--strict-config` refuses a field it does not know, so a key misspelled
 *   here fails the spawn out loud instead of being ignored.
 * </ul>
 */

/** The `mcp__cawdev__` prefix off a Claude Code tool list, keeping cawdev's own names only. */
export function cawdevToolNames(tools) {
  const prefix = 'mcp__cawdev__';
  return [...new Set((Array.isArray(tools) ? tools : [])
    .filter((tool) => typeof tool === 'string' && tool.startsWith(prefix))
    .map((tool) => tool.slice(prefix.length)))];
}

/**
 * A value as TOML, which is what `-c key=value` parses.
 *
 * <p>A JSON string is a TOML basic string for everything JSON escapes; DEL is
 * the one control character JSON leaves alone and TOML refuses.
 */
export function tomlValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map(tomlValue).join(', ')}]`;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, each]) => `${tomlKey(key)} = ${tomlValue(each)}`);
    return `{ ${entries.join(', ')} }`;
  }
  return JSON.stringify(String(value ?? '')).replace(/\u007f/g, '\\u007f');
}

function tomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlValue(String(key));
}

/**
 * The command line for one Codex turn. The prompt goes on stdin (`-`).
 *
 * @param options.sandbox `read-only` — the OS refuses every write the shell
 *   attempts — or `bypass`, which is `--dangerously-bypass-approvals-and-sandbox`
 *   and is only ever passed where the machine has allowed everything.
 * @param options.servers `[{ name, command, args, env, envVars, enabledTools,
 *   disabledTools }]`, each approved, since nobody is there to approve a call.
 * @param options.hideFromShell variables blanked for the model's own commands.
 */
export function codexArgs({
  model = null, effort = null, sandbox, resumeId = null, servers = [], hideFromShell = [],
}) {
  if (sandbox !== 'read-only' && sandbox !== 'bypass') {
    throw new Error(`codexArgs: sandbox must be read-only or bypass, not ${sandbox}`);
  }
  // `--ignore-user-config` is `--setting-sources ''` for this CLI: the
  // operator's own ~/.codex/config.toml can add MCP servers, hooks and an
  // approval reviewer, and none of that may widen what a run was given. The
  // sign-in is untouched — it is read from CODEX_HOME either way.
  const args = ['exec', '--json', '--strict-config', '--ignore-user-config'];
  args.push(...(sandbox === 'bypass'
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : ['--sandbox', 'read-only']));
  if (model) {
    args.push('--model', model);
  }
  if (effort) {
    args.push('-c', `model_reasoning_effort=${tomlValue(effort)}`);
  }
  if (hideFromShell.length) {
    args.push('-c', `shell_environment_policy.set=${tomlValue(
      Object.fromEntries(hideFromShell.map((name) => [name, ''])))}`);
  }
  for (const server of servers) {
    const key = `mcp_servers.${tomlKey(server.name)}`;
    args.push('-c', `${key}.command=${tomlValue(server.command)}`);
    if (server.args?.length) {
      args.push('-c', `${key}.args=${tomlValue(server.args)}`);
    }
    if (server.env && Object.keys(server.env).length) {
      args.push('-c', `${key}.env=${tomlValue(server.env)}`);
    }
    if (server.envVars?.length) {
      args.push('-c', `${key}.env_vars=${tomlValue(server.envVars)}`);
    }
    if (server.enabledTools) {
      args.push('-c', `${key}.enabled_tools=${tomlValue(server.enabledTools)}`);
    }
    if (server.disabledTools?.length) {
      args.push('-c', `${key}.disabled_tools=${tomlValue(server.disabledTools)}`);
    }
    // How long one call may take before Codex gives up on it — 60 s unless
    // set, which is shorter than a person answering a question.
    if (server.toolTimeoutSec) {
      args.push('-c', `${key}.tool_timeout_sec=${tomlValue(server.toolTimeoutSec)}`);
    }
    args.push('-c', `${key}.default_tools_approval_mode="approve"`);
  }
  if (resumeId) {
    args.push('resume', resumeId);
  }
  args.push('-');
  return args;
}

/** A tool result's text, whatever shape the MCP server gave it. */
function resultText(result) {
  const content = result?.content;
  if (Array.isArray(content)) {
    const text = content.map((each) => each?.text ?? '').filter(Boolean).join('\n');
    if (text) return text;
  }
  return result == null ? '(no output)' : JSON.stringify(result);
}

/**
 * One line of `codex exec --json`, as what the transcript and the run need.
 *
 * <p>Returns `{ sessionId?, lines: [{ kind, body }], usage?, failed?, error?, ended? }`.
 * `ended` is true on `turn.completed` — the turn ending, which is the whole of
 * what a stage is judged by. `failed` is `turn.failed`'s sentence; `error` a
 * top-level error's, which may be passing. An event this version does not know
 * yields nothing.
 */
export function translateCodexEvent(event) {
  const out = { lines: [] };
  const item = event?.item ?? {};
  switch (event?.type) {
    case 'thread.started':
      out.sessionId = event.thread_id ?? null;
      break;
    case 'item.started':
      if (item.type === 'command_execution') {
        out.lines.push({ kind: 'TOOL', body: `Bash(${item.command ?? ''})` });
      } else if (item.type === 'mcp_tool_call') {
        out.lines.push({
          kind: 'TOOL',
          body: `mcp__${item.server}__${item.tool}(${JSON.stringify(item.arguments ?? {})})`,
        });
      }
      break;
    case 'item.completed':
      if (item.type === 'agent_message' && item.text) {
        out.lines.push({ kind: 'ASSISTANT', body: item.text });
      } else if (item.type === 'command_execution') {
        const output = String(item.aggregated_output ?? '').slice(0, 4000);
        out.lines.push({
          kind: 'TOOL_RESULT',
          body: output || `(exit ${item.exit_code ?? '?'})`,
        });
      } else if (item.type === 'mcp_tool_call') {
        out.lines.push({
          kind: 'TOOL_RESULT',
          body: item.error
            ? `failed: ${item.error.message ?? JSON.stringify(item.error)}`
            : resultText(item.result).slice(0, 4000),
        });
      } else if (item.type === 'file_change') {
        const changes = (item.changes ?? [])
          .map((each) => `${each.kind ?? 'update'} ${each.path ?? ''}`.trim());
        out.lines.push({ kind: 'TOOL', body: `Edit(${changes.join(', ') || 'files'})` });
      } else if (item.type === 'error' && item.message) {
        out.lines.push({ kind: 'SYSTEM', body: item.message });
      }
      break;
    case 'turn.completed':
      out.ended = true;
      out.usage = {
        input: Number(event.usage?.input_tokens) || 0,
        output: Number(event.usage?.output_tokens) || 0,
      };
      break;
    case 'turn.failed':
      out.failed = event.error?.message ?? 'Codex reported the turn failed.';
      out.lines.push({ kind: 'SYSTEM', body: out.failed });
      break;
    case 'error':
      // NOT `failed`: a top-level error is also how a retried stream says
      // "Reconnecting… 2/5". Only `turn.failed` ends a turn badly; this is
      // kept as the last thing it said, for when nothing better arrives.
      out.error = event.message ?? 'Codex reported an error.';
      out.lines.push({ kind: 'SYSTEM', body: out.error });
      break;
    default:
      break;
  }
  return out;
}
