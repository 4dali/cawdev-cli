/**
 * What each stage of a lifecycle may do — R112.
 *
 * In `lib/` for `run-plugin.mjs`'s and `harness-prompt.mjs`'s reason: the claim
 * this whole entry rests on is a claim about a LIST OF STRINGS, and a list of
 * strings should not need a daemon, a platform and a spawned agent to check.
 *
 * The claim: **PLAN and VERIFY have no tool that can change anything.** Not
 * "are asked not to" — cannot. That is the difference between enforcement and
 * hope, and it is the difference R28's profiles were built on:
 *
 * > a session told not to touch the code but able to is one refusal away from
 * > touching it; a session that cannot has nothing to decide, and nothing to be
 * > talked out of.
 */

/** Reading git without being able to change it. */
export const GIT_READS = [
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git show *)',
  'Bash(git status *)',
];

/**
 * cawdev's OWN tools that only read — NAMED, because this is the one registry
 * this repository knows the whole of.
 *
 * <p>Everything else under `mcp__cawdev__` is a writer. That inverts how the
 * rest of this file works and it is deliberate: for a registry we do not
 * control, shape is the only signal there is; for ours it is the WORST one
 * available, because we can simply say. `roadmap_comment` is the proof — a
 * write to an append-only, undeletable discussion, whose name ends in a noun,
 * which a shape test reads as a read.
 *
 * <p>The direction of failure is the argument. Forget to add a new READER here
 * and a read-only stage says out loud that it cannot do something. Forget to add
 * a new WRITER to a list of writers and the stage quietly has it. R112's claim
 * survives only while the silence is on the safe side.
 *
 * <p>`report`, `ask_user`, `await_answer` and `approve` are here in spite of
 * writing something: they are the loop every PROFILE runs on, and a session that
 * cannot report has no way to finish. A read-only STAGE is the exception, and
 * {@link STAGE_READS} below is where that is said.
 */
export const CAWDEV_READS = new Set([
  'approve',
  'task_current',
  'report',
  'ask_user',
  'await_answer',
  // R96's rounds are `ask_user` and `await_answer` in the interview's shape:
  // one asks a person something, the rest are waits. The regex this list
  // replaced kept all four, and they belong with the two above rather than
  // with the tools that change a card.
  'ask_group',
  'await_group',
  'interview_rounds',
  'await_more_rounds',
  'roadmap_where',
  'code_map',
  'file_deps',
  'roadmap_statuses',
  'roadmap_list',
  'roadmap_get',
  'issue_list',
  'changelog_list',
  'changelog_get',
]);

/**
 * The same list minus `report`, which is what a read-only STAGE may hold.
 *
 * <p>The one name where a profile and a stage genuinely disagree, and it is not
 * a subtlety: `report` kind "done" ends the **run**, not the stage. A profile
 * needs it — that is how an ASK or a REVIEW session finishes at all. A PLAN
 * stage calling it would finish the whole run in the middle of the walk, and
 * every stage behind it would be skipped with "the run was reported finished
 * during the PLAN stage".
 *
 * <p>Derived rather than typed out twice: the two lists differ by exactly one
 * name, and a second literal is a second thing to keep in step.
 */
const STAGE_READS = new Set([...CAWDEV_READS].filter((name) => name !== 'report'));

/** The `mcp__cawdev__` prefix, once. */
const CAWDEV = 'mcp__cawdev__';

/** The one tool no STAGE may hold — see {@link toolsForStage}. */
const REPORT = `${CAWDEV}report`;

/** The tool a session delegates with, and what an older CLI called it. */
const DELEGATES = /^(Agent|Task)\b/;

/**
 * Tools a subagent may hold and still change nothing — R147.
 *
 * <p>A NAMED list, on `CAWDEV_READS`'s argument rather than `canChangeThings`'s:
 * an expert's `tools:` line is somebody else's frontmatter, out of a marketplace
 * repository, and the question is not "does this look like a writer" but "is
 * every one of these a tool we know only reads". Forget a reader here and an
 * expert is refused from a planning stage, which is loud; a shape test that
 * let `WebFetch` through would have let `Bash` through the day somebody wrote
 * it as `bash`.
 */
export const SUBAGENT_READS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoRead',
]);

/**
 * Whether an expert can change nothing — R147, and the half of R112's claim
 * that delegation used to break.
 *
 * <p>`canChangeThings` calls `Agent` a writer because a subagent has its own
 * tool list, and a PLAN stage holding it could write through a helper. True of
 * an expert that inherits every tool, or asks for `Write` — and false of one
 * whose frontmatter names only reads, which is what `architect`, `planner` and
 * `code-explorer` do. Those are the experts a planning stage exists to consult,
 * and R112 was refusing them the one tool that reaches an expert.
 *
 * <p>Judged from the same fields `run-plugin.mjs` writes into the file the CLI
 * loads, so what is checked is what the subagent is actually spawned with. An
 * expert with NO `tools:` line inherits the parent's — which in a PLAN stage is
 * read-only anyway, but "inherits whatever the CLI decides" is not a claim this
 * file can make, so it is not read-only here.
 */
export function readOnlyExpert(agent) {
  const declared = String(agent?.tools ?? '').split(',').map((each) => each.trim())
    .filter(Boolean);
  return declared.length > 0 && declared.every((tool) => SUBAGENT_READS.has(tool));
}

/**
 * Anything that can change something, recognised by shape rather than by name.
 *
 * A list of forbidden tool names would go stale the day the CLI ships a new
 * writer — and the failure would be silent, because a stage would simply have a
 * tool nobody thought to exclude. This asks the opposite question: does this
 * permission let the session change anything? Everything that does is refused
 * from a read-only stage, including tools that do not exist yet.
 *
 * <p>cawdev's own tools are the exception and are judged by {@link STAGE_READS}
 * instead — see the note there for why shape is the worst available signal on
 * the one registry we own.
 */
export function canChangeThings(tool) {
  // Delegation is the loudest writer there is, and it does not look like one.
  // `Agent` spawns a SUBAGENT with its own tool list — so a PLAN stage holding
  // it could write every file it was carefully not given a tool for, through a
  // helper. R112's load-bearing claim is that a planning stage *cannot* write,
  // and it survives only if this says so. IMPLEMENT and TEST keep it, which is
  // where an expert was always meant to be reached from.
  if (/^(Agent|Task)\b/.test(tool)) {
    return true;
  }
  // A PREFIX, deliberately without a word boundary: `WriteMany` is a writer and
  // `\b` would let it through, because `Write` is followed by another word
  // character. Recognising by shape only helps if the shape is the loose one.
  if (/^(Write|Edit|MultiEdit|NotebookEdit|Update)/.test(tool)) {
    return true;
  }
  if (/^Bash\b/.test(tool)) {
    // Bash is the one that has to be judged rather than named: `Bash(git *)`
    // can commit, `Bash(git diff *)` cannot. Anything not on the read list is
    // treated as able to change something, which is the safe direction and the
    // one that stays right when somebody adds a pattern here.
    return !GIT_READS.includes(tool);
  }
  // Our own registry is judged by the list, because we have one. Anything under
  // this prefix that is not a known read is a writer — including a tool added
  // tomorrow and forgotten here, which is the direction that fails loudly.
  if (tool.startsWith(CAWDEV)) {
    return !STAGE_READS.has(tool.slice(CAWDEV.length));
  }
  // Everybody else's MCP tools, where shape is all there is: one that writes
  // usually says so in its name. A guess, and acceptable only because the
  // alternative — treating every third-party MCP tool as a writer — would strip
  // a read-only stage of R76's registry entirely.
  return /(create|update|set_status|decline|add|save|report)$/.test(tool);
}

/**
 * Anything that can RUN something, recognised by shape rather than by name.
 *
 * R129's mirror of `canChangeThings`, and the same question asked the other way
 * round: not "does this let the session change anything" but "does this let the
 * session EXECUTE anything". A TEST stage set to write the testbook may write
 * all it likes — it has a file to write — and must not be able to run the suite
 * it is describing.
 *
 * Deliberately narrower than `canChangeThings`: `Write` and `Edit` are not
 * runners, and a stage refused them could not produce the artefact it exists
 * for.
 */
export function canRunThings(tool) {
  // Delegation runs anything: a subagent with its own tool list could run the
  // very suite this stage was spawned unable to run. The same argument
  // canChangeThings makes about writing, and it is the same tool making it.
  if (/^(Agent|Task)\b/.test(tool)) {
    return true;
  }
  if (/^Bash\b/.test(tool)) {
    // The git READS are kept, for the read-only stages' reason: `git diff` is
    // how this stage finds out what the run it is describing actually changed.
    // Anything else that reaches a shell is treated as able to run something,
    // which is the safe direction.
    return !GIT_READS.includes(tool);
  }
  return false;
}

/**
 * The tools one stage gets, narrowed from what the PROFILE already allows.
 *
 * <p>Narrowed, never widened: a stage cannot be handed something the profile
 * would have refused, so an interview's IMPLEMENT stage gets an interview's
 * tools rather than a coding run's. That ordering is what keeps R28's decision
 * the outer one.
 *
 * @param stage one of PLAN, VERIFY, IMPLEMENT, TEST, MEMORY
 * @param profileTools what the run's profile allows
 * @param testMode R129, and only TEST reads it: `TESTBOOK` narrows the stage to
 *   what cannot run anything. Absent — an older platform that does not send it —
 *   means `RUN`, which is what TEST has always been.
 */
export function toolsForStage(stage, profileTools, testMode, options = {}) {
  // R147. A read-only stage keeps `Agent` when EVERY expert it is handed is
  // read-only — the caller narrows the list to those before spawning, and
  // `readOnlyExpert` is the judge. The claim stays intact: a subagent holding
  // only Read, Grep and Glob can no more write than the stage that called it.
  const delegates = Boolean(options.delegatesReadOnly);
  // `report` kind "done" ends the RUN, not the stage — so NO stage may hold it,
  // whatever else it may do. STAGE_READS says this above and only said it to the
  // read-only stages, because IMPLEMENT and TEST were handed the profile's list
  // untouched. They therefore kept `report`, used it, and every stage behind
  // them was marked SKIPPED with "the run was reported finished during the TEST
  // stage" — which is how MEMORY came to run once in fifty runs.
  //
  // A stage ends by its turn ending; the walk advances on `close` and finishes
  // the run when it runs out of stages. Nothing here needs to announce it. A run
  // with NO lifecycle never comes through this function and keeps `report`,
  // which is the case the tool exists for. It applies to a TESTBOOK stage too:
  // narrowing what a stage may RUN and refusing it the tool that ends the run
  // are two different questions, and this one is asked of every stage.
  const allowed = (Array.isArray(profileTools) ? profileTools : [])
    .filter((tool) => tool !== REPORT);
  switch (stage) {
    case 'PLAN':
    case 'VERIFY':
    case 'MEMORY':
      // The load-bearing claim. Note this filters the PROFILE's list rather
      // than naming a list of its own: a stage's tools are always a subset of
      // what the run was already allowed, and a fresh list here would be a
      // second place deciding what a profile may do.
      return [...allowed.filter((tool) => !canChangeThings(tool)
          || (delegates && DELEGATES.test(tool))),
        ...GIT_READS.filter((tool) => allowed.includes(tool) || allowed.includes('Bash(git *)'))];
    case 'TEST':
      // R129. The mirror of the claim above, with the other question asked: a
      // stage that may WRITE and cannot RUN. Same filtering of the PROFILE's
      // own list, for the same reason — a fresh list here would be a second
      // place deciding what a profile may do.
      if (testMode === 'TESTBOOK') {
        return [...allowed.filter((tool) => !canRunThings(tool)),
          ...GIT_READS.filter((tool) => allowed.includes(tool) || allowed.includes('Bash(git *)'))];
      }
      return allowed;
    case 'IMPLEMENT':
      return allowed;
    default:
      // A stage this version does not know is given the profile's own tools —
      // the same as no lifecycle at all. Refusing everything would turn a
      // rollback into a run that can do nothing and cannot say why.
      return allowed;
  }
}

/**
 * Whether a TOOL line is one of the git reads a narrowed stage legitimately has.
 *
 * A tool line is `<name> <described input>`, and for a shell call the name is
 * the bare `Bash` — the PATTERN it was allowed under is not in the line, only
 * the command. So the first word alone cannot tell `git diff` from `npm test`,
 * and a check that judged by it would fire on the very `git diff` a testbook
 * stage is TOLD to run. A note that appears on every run makes nothing visible,
 * which is the one thing R113's note has to do.
 */
function readsGit(toolLine) {
  const command = String(toolLine ?? '').split(/\s+/).slice(1).join(' ');
  return GIT_READS.some((read) => {
    const verb = read.slice('Bash('.length, -' *)'.length);
    return command === verb || command.startsWith(`${verb} `);
  });
}

/**
 * Whether a tool call contradicts the stage that claims to be running — R113.
 *
 * <p>Returns a sentence, or null. **It never blocks.** R112 does the blocking,
 * by not handing over the tool in the first place; this is the cross-check that
 * catches the case where it somehow did — a stage list that grew a tool nobody
 * meant, a CLI that ignored `--allowedTools`, a version of this file that is
 * wrong. A second thing that can stop a run is a second thing that can stop it
 * wrongly, and that is a worse failure than a line in a transcript.
 *
 * <p>Said in the transcript rather than only in the daemon's log, because the
 * person who needs to know is the one reading the run.
 */
export function driftedFrom(stage, toolLine, testMode, readOnlyExperts = []) {
  const readOnly = stage === 'PLAN' || stage === 'VERIFY' || stage === 'MEMORY';
  // R129. A TEST stage set to write the testbook has its own thing it should
  // not have been able to do, and the same reason for saying so out loud.
  const testbook = stage === 'TEST' && testMode === 'TESTBOOK';
  if (!readOnly && !testbook) {
    return null;
  }
  // `linesOf` writes a TOOL line as `<name> <described input>`, so the name is
  // the first word and the pattern is what follows it.
  const name = String(toolLine ?? '').split(/\s/, 1)[0];
  if (!name) {
    return null;
  }
  const notice = 'The work was not stopped — this is a note that what ran and what was '
    + 'permitted have disagreed, which should not be possible and is worth looking at.';
  if (testbook) {
    if (!canRunThings(name) || readsGit(toolLine)) {
      return null;
    }
    return `cawdev: the TEST stage is set to write the testbook and called ${name}, which it `
      + `should not have been able to. ${notice}`;
  }
  if (!canChangeThings(name)) {
    return null;
  }
  // R147. A delegation to an expert this stage was allowed is the one call
  // `canChangeThings` names a writer that is not one here. `describeCall`
  // writes it as `Agent(<name>) …`, and the name is the CLI's qualified one.
  const delegated = /^(?:Agent|Task)\(([^)]+)\)/.exec(String(toolLine ?? ''));
  if (delegated && readOnlyExperts.includes(delegated[1])) {
    return null;
  }
  return `cawdev: the ${stage} stage called ${name}, which it should not have been able to. `
    + notice;
}
