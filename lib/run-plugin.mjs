/**
 * The experts and skills a run was given, written as ONE Claude Code plugin —
 * R104, R105.
 *
 * Pure but for the writing, and in `lib/` for `code-map.mjs`'s reason: the hard
 * part is a FILE — a subagent whose frontmatter somebody else's punctuation
 * broke is an agent the CLI silently never loads, and the only symptom is a
 * session that quietly does not delegate. That is testable without a daemon, a
 * platform or a repository, and it should be.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Writes the experts and skills this run was given, as ONE Claude Code plugin —
 * R104, R105.
 *
 * <p>Into a directory this daemon owns, and never into the checkout. That is
 * the whole reason it is done this way. The agent is spawned with
 * `--setting-sources ''` on purpose: without it a session silently inherits
 * whatever the operator has allowed themselves, and a repository's own
 * `.claude/` would be able to widen what a run may do — which makes R51's
 * ceiling decorative. Writing agents into the working copy to get them loaded
 * would reopen exactly that door, and dirty the tree on the way through.
 *
 * A plugin directory is the mechanism that needs neither: `--plugin-dir` loads
 * `agents/` and `skills/` from a path, and leaves every setting source off.
 *
 * Returns the directory, or null when the project turned nothing on — in which
 * case no flag is passed at all, rather than an empty plugin being loaded.
 */
export async function writeRunPlugin(directory, expertAgents, skills) {
  if (!expertAgents.length && !skills.length) {
    return null;
  }
  const root = join(directory, 'cawdev-run');
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'cawdev-run',
    description: 'What this project turned on in cawdev.',
    version: '1.0.0',
  }, null, 2));

  for (const agent of expertAgents) {
    await mkdir(join(root, 'agents'), { recursive: true });
    await writeFile(join(root, 'agents', `${agent.key}.md`), agentFile(agent));
  }
  for (const skill of skills) {
    await mkdir(join(root, 'skills', skill.key), { recursive: true });
    await writeFile(join(root, 'skills', skill.key, 'SKILL.md'), skillFile(skill));
  }
  return root;
}

/**
 * A subagent file, frontmatter rebuilt rather than passed through.
 *
 * <p>The platform stores the body and the four fields separately, so this
 * writes the four it knows and nothing else. A field the file originally
 * carried and cawdev does not store is DROPPED, deliberately: passing through
 * frontmatter nobody parsed would be handing the CLI keys cawdev never looked
 * at, out of a repository somebody else wrote.
 */
export function agentFile(agent) {
  const head = ['---', `name: ${agent.key}`, `description: ${yamlScalar(agent.description)}`];
  if (agent.tools) {
    head.push(`tools: ${agent.tools}`);
  }
  if (agent.model) {
    head.push(`model: ${agent.model}`);
  }
  head.push('---', '');
  return `${head.join('\n')}\n${agent.body ?? ''}\n`;
}

export function skillFile(skill) {
  const head = [
    '---',
    `name: ${skill.key}`,
    `description: ${yamlScalar(skill.description)}`,
    '---',
    '',
  ];
  return `${head.join('\n')}\n${skill.body ?? ''}\n`;
}

/**
 * One line of YAML that cannot end the block early.
 *
 * <p>A description is somebody else's text — it arrived from a git repository
 * through R106 — and a newline or a stray `---` in it would either truncate the
 * frontmatter or spill the rest of it into the body. Quoted and escaped, on one
 * line, because the alternative is a file whose meaning depends on what an
 * upstream author typed.
 */
export function yamlScalar(text) {
  const flat = String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
  return `"${flat.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

