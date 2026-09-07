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
export function harnessPrompt({ instincts, briefing, plan, lifecycle, repoConfig }) {
  const parts = [];

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
  if (plan?.body) {
    parts.push(`## The plan for this card\n\n`
      + `This was written and agreed in the plan phase. Follow it. If it turns out to be `
      + `wrong, say so and say why — do not quietly do something else.`
      + `${plan.staleness ? `\n\n**${plan.staleness}**` : ''}`
      + `\n\n${plan.body}`);
  }

  if (lifecycle?.length) {
    const steps = lifecycle.map((stage, at) => {
      const gate = stage.gate === 'ASK'
        ? ' — **stop here and wait**: report the stage, then use `ask_user` and do not '
          + 'continue until somebody answers'
        : '';
      return `${at + 1}. **${stage.stage}**${gate}`;
    });
    parts.push('## The steps to work in\n\n'
      + 'Report each one as you begin and end it, so the people watching can see where you '
      + `are.\n\n${steps.join('\n')}`);
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

