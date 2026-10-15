/**
 * The shell commands a Claude Code session started in the BACKGROUND and never
 * saw the end of — read off its stream-json events.
 *
 * A lifecycle stage is one turn (R112): the daemon closes the session the
 * moment the turn ends. A stage that ran `npm test` with `run_in_background`
 * and ended its turn to wait for it loses the run — the result never comes
 * back, nothing is recorded, and the walk marched on to MEMORY and FINISHED
 * with the work unproven and uncommitted (R15, saasng). So the walk asks this,
 * at the stage's end, whether anything it started is unfinished or unread;
 * `walkLifecycle` then fails the stage instead of calling it done, which is
 * what lets `/continue` pick the run back up at that stage.
 *
 * Pure: events in, a list out. Three tool shapes, by name:
 * - `Bash` with `run_in_background: true` starts one; its result names the id
 *   ("… running in background with ID: <id>");
 * - `BashOutput` (or `TaskOutput`) reads one by `bash_id`/`shell_id`/`task_id`;
 *   the command is over only when a read says a status other than running;
 * - `KillShell`/`KillBash`/`TaskStop` ends one.
 * And a delegation started in the background: `Agent` (or `Task`) with
 * `run_in_background: true`, or whose result says "Async agent launched" —
 * its id is the result's `agentId: <id>`. It is over when a `<task-notification>`
 * naming that id arrives with a status other than running, when a
 * `TaskOutput` read says so, or when `TaskStop` ends it. R6 on saasng is why:
 * IMPLEMENT handed the whole card to two background agents, said "both agents
 * are still working in the background" and ended its turn; the walk marched on
 * and the run FINISHED with nothing built.
 *
 * A command whose id cannot be read off its result stays unfinished: failing
 * loudly and re-running a stage costs a turn, calling unproven work proven
 * costs somebody's afternoon.
 *
 * @author Claude Opus 5.5 (Claude Code)
 * @author Moez Ben MBarka
 */

const READS = new Set(['BashOutput', 'TaskOutput']);
const DELEGATES = new Set(['Agent', 'Task']);
const KILLS = new Set(['KillShell', 'KillBash', 'TaskStop']);

/** The text of a tool_result's content, whichever of its two shapes it came in. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  }
  return '';
}

function shellIdOf(input) {
  const id = input?.bash_id ?? input?.shell_id ?? input?.task_id ?? input?.id;
  return typeof id === 'string' && id ? id : null;
}

export class BackgroundShells {
  constructor() {
    /** tool_use id of each background `Bash` or `Agent` → { command, shellId, done }. */
    this.started = new Map();
    /** tool_use id of each `Agent` call not yet known to be in the background → its label and input. */
    this.delegations = new Map();
    /** tool_use id of each read → the shell id it read. */
    this.reads = new Map();
  }

  /** One stream-json event. Anything that is not about a shell is ignored. */
  observe(event) {
    const content = event?.message?.content;
    if (event?.type === 'user') this.notified(textOf(content));
    const parts = content;
    if (!Array.isArray(parts)) return;
    if (event.type === 'assistant') {
      for (const part of parts) {
        if (part?.type !== 'tool_use') continue;
        if (part.name === 'Bash' && part.input?.run_in_background === true) {
          this.started.set(part.id, {
            command: String(part.input.command ?? '').trim(),
            shellId: null,
            done: false,
          });
        } else if (DELEGATES.has(part.name)) {
          const label = `Agent: ${String(part.input?.description ?? part.input?.subagent_type ?? 'a delegation').trim()}`;
          this.delegations.set(part.id, { label, background: part.input?.run_in_background === true });
        } else if (READS.has(part.name)) {
          const id = shellIdOf(part.input);
          if (id) this.reads.set(part.id, id);
        } else if (KILLS.has(part.name)) {
          this.finish(shellIdOf(part.input));
        }
      }
      return;
    }
    if (event.type === 'user') {
      for (const part of parts) {
        if (part?.type !== 'tool_result') continue;
        const text = textOf(part.content);
        const delegation = this.delegations.get(part.tool_use_id);
        if (delegation) {
          this.delegations.delete(part.tool_use_id);
          // A foreground delegation's result IS its end; only one that came
          // back as "launched" is still out there.
          if (delegation.background || /async agent launched/i.test(text)) {
            const id = /\bagentId:?\s*([A-Za-z0-9_-]+)/i.exec(text);
            this.started.set(part.tool_use_id, { command: delegation.label, shellId: id ? id[1] : null, done: false });
          }
          continue;
        }
        const launched = this.started.get(part.tool_use_id);
        if (launched && !launched.shellId) {
          const id = /\bID:?\s*([A-Za-z0-9_-]+)/.exec(text);
          if (id) launched.shellId = id[1];
          continue;
        }
        const read = this.reads.get(part.tool_use_id);
        if (read) {
          // Over only when the read says so; a read of a command still going
          // is the command still going.
          if (!/<status>\s*running\s*<\/status>|\bstatus:\s*running\b/i.test(text)) {
            this.finish(read);
          }
        }
      }
    }
  }

  /**
   * The CLI tells a session that a background task ended with a
   * `<task-notification>` in a user turn — `<task-id>` and `<status>`. Any
   * status but running is over: a failed or killed agent is not one to wait for.
   */
  notified(text) {
    if (!text || !text.includes('<task-notification>')) return;
    for (const block of text.split('<task-notification>').slice(1)) {
      const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(block);
      const status = /<status>\s*([^<\s]+)\s*<\/status>/.exec(block);
      if (id && status && status[1].toLowerCase() !== 'running') this.finish(id[1]);
    }
  }

  finish(shellId) {
    if (!shellId) return;
    for (const each of this.started.values()) {
      if (each.shellId === shellId) each.done = true;
    }
  }

  /** The commands and delegations started in the background whose end this session never saw. */
  unfinished() {
    return [...this.started.values()].filter((each) => !each.done).map((each) => each.command);
  }
}
