/**
 * What a session is told before its task — R107, R108, R109.
 *
 * In `lib/` for `run-plugin.mjs`'s reason: this is where R107's TWO LEVELS of
 * configuration meet — the console's instincts and the repository's own
 * `.ai-config.md` — and "did both halves arrive, labelled, in the right order"
 * is a question about a string. It needs no daemon, no platform and no
 * repository to answer, so it should not need them to test.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Where R107's advanced half lives, in the target repository. */
export const AI_CONFIG = '.ai-config.md';

/** A ceiling on the repository's half. See `readRepoConfig`. */
const MAX_CONFIG_BYTES = 32 * 1024;

/**
 * What this project makes an agent do without being asked, and what the last
 * session left — R107, R108, R109.
 *
 * <p>APPENDED to the profile's prompt rather than woven into it, and the three
 * blocks are labelled. A session that cannot tell "what this project always
 * wants" from "what you were asked to do" will treat one as the other, and the
 * failure mode of getting that backwards is a run that does the standing rule
 * instead of the task.
 *
 * <p>The `.ai-config.md` half of R107 is read HERE, out of the checkout, and
 * never through the platform: the repository is the source of truth for what is
 * in it, and a file copied into a database is a reading that goes stale. So the
 * two halves meet in this function and nowhere else.
 */
export function harnessPrompt({
  instincts, briefing, plan, lifecycle, repoConfig, experts, skills, cannotDelegate,
}) {
  const parts = [];

  // R147. What this session was handed, by the NAME the CLI answers to. Before
  // this the experts and skills reached the session only through the CLI's own
  // tool listing, beside its built-in agents, and nothing in a hundred and
  // forty runs chose one. A capability nobody mentions is a capability nobody
  // uses; this is the mention. Experts and skills are listed separately
  // because they are used differently — one is delegated to, the other is read
  // before work it covers — and each line carries its own description, which
  // is what the model decides on.
  //
  // R161. A REQUIRED one is named FIRST and in its own block. Two lists rather
  // than one annotated list, because a `(required)` suffix on a line in a list
  // of twelve is a detail; a heading is an instruction. The AS_NEEDED wording
  // below is byte-for-byte what it was — when a project requires nothing, and
  // that is every project until somebody says otherwise, this function returns
  // exactly what it returned before the entry.
  const reach = [];
  const requiredOf = (list) => (list ?? []).filter((each) => each.required);
  const optionalOf = (list) => (list ?? []).filter((each) => !each.required);
  const lines = (list) => list
    .map((each) => `- \`${each.qualified}\` — ${each.description}`).join('\n');

  const mustExperts = requiredOf(experts);
  const mayExperts = optionalOf(experts);
  if (mustExperts.length) {
    reach.push('**Experts you MUST use** — this project requires each of these. Delegate '
      + 'with the `Agent` tool, `subagent_type` exactly as written, before this stage is '
      + `finished.\n${lines(mustExperts)}`);
  }
  if (mayExperts.length) {
    reach.push('**Experts** — delegate with the `Agent` tool, `subagent_type` exactly as '
      + 'written. Use one whenever its description fits the step you are on; they were '
      + 'chosen for this project.\n'
      + lines(mayExperts));
  } else if (!mustExperts.length && cannotDelegate?.length) {
    reach.push(`**Experts** — ${cannotDelegate.join(' ')}`);
  }

  const mustSkills = requiredOf(skills);
  const maySkills = optionalOf(skills);
  if (mustSkills.length) {
    reach.push('**Skills you MUST use** — this project requires each of these. Invoke it '
      + 'with the `Skill` tool, `skill` exactly as written, before this stage is '
      + `finished.\n${lines(mustSkills)}`);
  }
  if (maySkills.length) {
    reach.push('**Skills** — invoke with the `Skill` tool, `skill` exactly as written, BEFORE '
      + 'work its description covers.\n'
      + lines(maySkills));
  }
  if (reach.length) {
    parts.push(`## What this session may reach\n\n${reach.join('\n\n')}`);
  }

  const rules = [
    ...(instincts ?? []).map((each) => `- **${each.name}** — ${each.body}`),
  ];
  if (rules.length) {
    parts.push(`## How work is done here\n\n${rules.join('\n')}`);
  }
  if (repoConfig) {
    // Verbatim and last of the two, so a rule somebody put in the repository
    // wins a disagreement with one set in the console. The file is the thing
    // they can see from the checkout they are standing in.
    parts.push(`## From \`${AI_CONFIG}\` in this repository\n\n${repoConfig}`);
  }

  if (briefing) {
    parts.push(`## Where this work had got to\n\nA previous session on this branch left `
      + `this. It is what it believed, not necessarily what is true now — check `
      + `anything you are about to rely on.\n\n${briefing}`);
  }

  // R124. The plan somebody approved, handed to the phase that carries it out.
  //
  // AFTER the briefing and BEFORE the steps, which is the order a person would
  // read them in: what this project always wants, where the work had got to,
  // what was decided for this card, and then what to do about it.
  //
  // VERBATIM, for `stagePrompt`'s reason — a session that re-derived the plan
  // from a précis would be planning again, which is the one thing a phase after
  // an approved plan must not do.
  //
  // The staleness note is part of the same block rather than a warning
  // somewhere else. A plan and the reason to doubt it belong in one place, or
  // the plan gets read and the doubt does not.
  //
  // R145's collisions sit beside it for the same reason, and NOT in bold: bold
  // is for the line that says the plan itself may be wrong. This one says
  // something ELSE may be moving, and it is a heads-up rather than a stop.
  if (plan?.body) {
    parts.push(`## The plan for this card\n\n`
      + `This was written and agreed in the plan phase. Follow it. If it turns out to be `
      + `wrong, say so and say why — do not quietly do something else.`
      + `${plan.staleness ? `\n\n**${plan.staleness}**` : ''}`
      + `${plan.collisions ? `\n\n${plan.collisions}` : ''}`
      + `\n\n${plan.body}`);
  }

  // i138. The steps are the DAEMON's to report, and the wording used to say the
  // opposite. R109 handed the lifecycle to the session as an instruction —
  // "report each one as you begin and end it" — and R112 took it back: one
  // process per stage, the daemon reports each, and `toolsForStage` strips
  // `report` from every stage because "done" ends the RUN. The sentence stayed.
  // So every staged session was told to use a tool it did not hold, and a
  // session told to do something finds a way: on a stage spawned with a
  // permission prompt, `report` became a question on the inbox — one of the two
  // i138 was filed about — and where a person allowed it, the run ended in the
  // middle of the walk with the stages behind it SKIPPED. The gate line said the
  // same thing about `ask_user`, and the daemon raises the gate itself.
  if (lifecycle?.length) {
    const steps = lifecycle.map((stage, at) => {
      const gate = stage.gate === 'ASK'
        ? ' — **a person decides here**: when this step ends, they read what it produced, '
          + 'and the next step waits for their answer'
        : '';
      // R129. The one step whose MEANING the project can change. A person
      // reading this list should not have to know the project's settings to
      // understand what the TEST step was going to do.
      const mode = stage.stage === 'TEST' && stage.testMode === 'TESTBOOK'
        ? ' — writing the testbook, not running it'
        : '';
      return `${at + 1}. **${stage.stage}**${mode}${gate}`;
    });
    parts.push('## The steps to work in\n\n'
      + 'Each step is its own session, and this session is one of them — which one is said '
      + 'below. The daemon reports each step as it begins and ends, so the people watching '
      + 'can see where you are; you do not, and `report` is not among this step\'s tools. '
      + 'Where the instructions above say to finish with `report`, that is a run with no '
      + 'steps: here, say it as your last message instead. That message is what is recorded '
      + 'as this step\'s output, what the next step is handed, and what a person reads at a '
      + `gate. The step ends when your turn does.\n\n${steps.join('\n')}`);
  }

  return parts.length ? `\n\n---\n\n${parts.join('\n\n')}` : '';
}

/**
 * The repository's own half of R107, if it has one.
 *
 * <p>Capped, and the cap is not paranoia: this goes into an opening prompt, and
 * a repository that committed a megabyte here would crowd out the task without
 * anybody being told why.
 */
export async function readRepoConfig(cwd) {
  try {
    const path = join(cwd, AI_CONFIG);
    const size = (await stat(path)).size;
    if (size > MAX_CONFIG_BYTES) {
      return `(${AI_CONFIG} is ${Math.round(size / 1024)}kB and was not read — it is meant to `
        + 'be a page of rules, not a document.)';
    }
    return (await readFile(path, 'utf8')).trim() || null;
  } catch {
    // Not having one is the ordinary case, not a failure.
    return null;
  }
}

