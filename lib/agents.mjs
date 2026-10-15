/**
 * The coding agents a machine can spawn, spelled once.
 *
 * <p>Three CLIs, each a command on the PATH: Claude Code, Antigravity and
 * Codex. The setup walk, `cawdev config agent`, the config screen and the
 * daemon all ask "which agent is this command" and "what is it called", and
 * the answer was a `=== 'agy' ? … : 'Claude Code'` in five places — right for
 * two agents and silently wrong for a third.
 */

/** Every agent, in the order they are offered. */
export const KNOWN_AGENTS = ['claude', 'agy', 'codex'];

const LABELS = { claude: 'Claude Code', agy: 'Antigravity CLI', codex: 'Codex CLI' };

/** Which agent a configured command is — by its name, the rule `agentCommands` always used. */
export function agentOfCommand(command) {
  const name = String(command ?? '').split('/').pop();
  if (name.endsWith('agy')) return 'agy';
  if (name.endsWith('codex')) return 'codex';
  return 'claude';
}

/** What a person calls the agent behind a command. */
export function agentLabel(command) {
  return LABELS[agentOfCommand(command)];
}

/**
 * Why an agent that needs the whole machine was refused, and what to do about
 * it — in steps, for THIS machine. Codex and Antigravity have no per-command
 * allow-list, so a session that writes can only run with everything allowed;
 * the refusal used to say "turn on allow everything" and nothing about where,
 * or that the machine must first agree to take rules from the console.
 *
 * Pure, so the wording is read in a test rather than found in a failed run.
 *
 * @param agent `codex` or `agy`
 * @param machine `{ name, acceptsConsoleRules, configPath, consoleUrl }`
 * @param run `{ entryRef, profile }` — what to start again, and how
 * @param readsWithout whether a read-only session of this agent needs nothing
 */
export function needsEverything(agent, machine = {}, run = {}, { readsWithout = true } = {}) {
  const who = LABELS[agent] ?? agent;
  const short = agent === 'agy' ? 'agy' : agent;
  const again = run.entryRef ? `/new ${run.profile === 'PLAN' ? 'plan' : 'dev'} ${run.entryRef}` : '/new …';
  const lines = [
    `${who} cannot ${readsWithout ? 'write code' : 'run'} on this machine yet: it has no per-command `
      + 'permissions, so a session that commits and pushes must be allowed to run anything — and '
      + 'this machine has not allowed everything.',
    '',
    'To allow it:',
    machine.acceptsConsoleRules
      ? '  1. ✓ This machine already accepts permission rules from the console.'
      : '  1. On this machine: in the cawdev terminal press c → "Accept permission rules from the '
        + `console"${machine.configPath ? ` (or "acceptsRulesFromConsole": true in ${machine.configPath})` : ''}.`,
    `  2. On cawdev: ${machine.consoleUrl ? `${machine.consoleUrl.replace(/\/+$/, '')}/settings/runners` : 'Settings → Runners'}`
      + ` → ${machine.name ?? 'this machine'} → tick "Allow everything".`,
    `  3. Start it again: ${again} --${short}`,
    '',
    'Allowing everything lets every unattended session on this machine run any command in its checkouts.',
    `Or, without it: ${again} --claude${readsWithout && agent === 'codex' && run.entryRef ? ` — or keep ${who} for plans (/new plan ${run.entryRef} --codex)` : ''}.`,
  ];
  return lines.join('\n');
}
