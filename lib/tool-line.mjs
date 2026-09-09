/**
 * How a tool call is written into a transcript — R130.
 *
 * <p>In `lib/` for `stage-tools.mjs`'s reason: this is a claim about a STRING,
 * and a claim about a string should not need a daemon to check. It has no
 * dependencies and it never throws.
 *
 * <p><strong>This file is one half of a parsing contract.</strong> The runner
 * FORMATS here and the platform PARSES in
 * `backend/src/main/java/dev/caw/cawdev/run/CapabilityUse.java`; the console
 * classifies the same three shapes again for the transcript's gutter badge, in
 * `frontend/src/app/runs/capability-tag.ts`. Three implementations of one rule
 * is two too many, and the mitigation is that all three are tiny, pure, and
 * tested against the same example table — `tool-line.test.mjs`,
 * `CapabilityUseTest.java`, `capability-tag.spec.ts`. Change the strings below
 * and change all three.
 *
 * <p>The shapes are deliberately ones an OLD daemon can never accidentally
 * emit. A daemon that predates this writes `Agent {"description":"…`, which
 * does not match `^(Agent|Task)\(` — so it produces no ledger row rather than a
 * row named `{"description":"…`. Degrading to silence is required; garbage in
 * the panel is not.
 *
 * <p>Everything that is not a capability is byte-identical to what was written
 * before this entry, which is what keeps `driftedFrom` in `stage-tools.mjs`
 * working: it reads the tool name off the front of a TOOL body.
 */

/** A skill's arguments are context, not the identity of the call. */
const ARGS_LIMIT = 120;

/**
 * A tool call as one line: what was called, and enough to know which one.
 *
 * <p>The three capability shapes are named rather than dumped. Before this, a
 * `Skill` call fell through to `JSON.stringify` and an `Agent` call was mostly
 * the prompt — so which skill ran, and which expert was delegated to, was
 * normally lost off the end of the 200-character cut.
 */
export function describeCall(name, input) {
  const args = input && typeof input === 'object' ? input : {};
  if (name === 'Skill' && typeof args.skill === 'string' && args.skill) {
    const extra = typeof args.args === 'string' ? args.args.trim() : '';
    return `Skill(${args.skill})${extra ? ` ${extra.slice(0, ARGS_LIMIT)}` : ''}`;
  }
  if (name === 'Agent' || name === 'Task') {
    // `Task` is normalised to `Agent`, matching DELEGATE in runner.mjs: an
    // older CLI's name for the same act should not produce a second vocabulary
    // on the panel, with one expert appearing twice under two spellings.
    const who = typeof args.subagent_type === 'string' && args.subagent_type
      ? args.subagent_type
      : 'unnamed';
    const what = typeof args.description === 'string' ? args.description : '';
    return `Agent(${who}) ${what}`.trim();
  }
  return `${name} ${describeInput(input)}`.trim();
}

/** A tool's input as one short line — the arguments that identify the call. */
export function describeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const interesting = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'number', 'kind'];
  for (const key of interesting) {
    if (typeof input[key] === 'string' || typeof input[key] === 'number') {
      return String(input[key]).slice(0, 300);
    }
  }
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 199)}…` : json;
}
