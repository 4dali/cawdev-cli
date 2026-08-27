# The runner daemon

The piece that lives on your machine. It holds the repositories and the Claude
Code login; **the platform holds neither.**

It connects **outbound** and polls, so there is no inbound port and NAT and
firewalls are not anybody's problem. See R19 in the roadmap for the server-side
alternative that was declined, and why.

Plain Node, zero dependencies. You are about to let it spawn agent sessions
against your working copies — it should be a file you can read first.

## Setting it up

Mint a token in the console under **Agent tokens** with the `runner:operate`
scope on each project this machine should serve. Revoking that token stops the
machine.

```json
{
  "url": "http://localhost:8091",
  "name": "my-laptop",
  "projects": {
    "cawdev": "/Users/you/code/cawdev",
    "dycrypt": "/Users/you/code/dycrypt"
  }
}
```

```sh
CAWDEV_TOKEN=cawd_… node tools/runner/runner.mjs --config runner.config.json
```

The name is how you will recognise it in the console's runner picker.
Registering is idempotent by (owner, name), so restarting the daemon is the same
runner rather than a third entry in the list.

## What it does with a run

1. **Claims it.** The claim response carries the run's own `cawdr_` token and
   the project's default branch — the runner never touches the project API,
   which is session-only.
2. **Prepares the working copy**: fetch, then branch off the default.
   **It refuses a dirty tree**, with the file list, and fails the run saying so.
   An agent let loose in a checkout with uncommitted work will at best confuse
   itself and at worst commit somebody's half-finished thoughts.
3. **Spawns the agent** in that directory, in its own process group, with the
   run token in its environment and an `.mcp.json` pointing at cawdev's MCP
   server. **Your own token never reaches the child.**
4. **Streams the transcript.** Every stream-json event the session emits is
   summarised into a line and batched to the platform, which is what the
   console's live terminal reads. It summarises rather than forwards — the
   `init` event alone is kilobytes of tool inventory nobody reads.
5. **Delivers prompts.** It long-polls for prompts typed in the console and
   writes them into the session's stdin, which stays **open** for exactly this
   reason (`--input-format stream-json`). One process, one session, many turns.
   A prompt is acknowledged only after the write, so one that never landed is
   retried rather than lost.
6. **Reports the lifecycle back** and, if the session dies without saying
   anything, ends the run rather than leaving it `RUNNING` forever.

Cancelling a run reaches the daemon on its next poll and takes down the child's
whole process group — an agent that started a build should not leave it running.

**One run at a time per working copy.** Runs share a checkout, so a second
session in the same directory would fight the first; the rest queue.

## If the daemon dies mid-run

The platform notices. `StaleRunSweeper` fails a run whose runner has stopped
heartbeating for five minutes, with a reason saying so — otherwise the run would
sit `RUNNING` forever and block the project from starting anything else.

A run **`WAITING_ON_USER` is never swept.** That is the one state where nothing
happening is correct: it is stalled on a person, who may reasonably take a day.

## Trying it without spending Claude usage

`stub-agent.mjs` stands in for `claude`. It is spawned the same way, talks to
the platform through the same API, and follows a fixed script instead of
thinking:

Point `agentCommand` straight at it — an **absolute path, with no `agentArgs`**:

```json
{ "agentCommand": "/…/cawdev/tools/runner/stub-agent.mjs", "agentArgs": [] }
```

```sh
CAWDEV_STUB_SCRIPT=ask-then-finish \
CAWDEV_TOKEN=cawd_… \
  node tools/runner/runner.mjs --config runner.config.json
```

Not `"agentCommand": "node"` with the script in `agentArgs`: the runner puts
`--mcp-config` first, so node gets a flag it does not know and exits with `bad
option` before the script runs. The shebang avoids that, and the flags land in
the stub's argv where it ignores them. Absolute, because the child's cwd is the
working copy rather than this repository.

| `CAWDEV_STUB_SCRIPT` | What it does |
|---|---|
| `report-and-finish` | progress, then done (default) |
| `ask-then-finish` | asks a question, waits for the answer, then done |
| `crash` | exits non-zero without reporting |
| `hang` | never exits — for testing cancellation |

## The agent command

`agentCommand` and `agentArgs` are configuration, not code. That is what makes
the stub possible, and it is also how R17's second CLI would arrive.

The defaults are for Claude Code, verified against 2.1.247:

See `DEFAULTS` in `runner.mjs` for the full list — it is long because the
cawdev MCP tools are named individually.

### About permissions

**A spawned agent has no terminal**, so anything that stops to ask a human for
permission stops forever.

- `--permission-mode acceptEdits` lets it write files.
- `--allowedTools mcp__cawdev__…` lets it use the cawdev tools. **Without this
  the entire loop is unreachable** — no reading the task, no moving the entry,
  no reporting, no asking. A real session found this by being denied
  `task_current` and stopping rather than guessing, which was the right call
  and a good sign for the prompt.

They are named explicitly rather than reached with `bypassPermissions`, because
nothing here should imply the agent may run arbitrary commands.

- `Bash(git *)` lets it commit. The prompt tells it to commit its work, so the
  default has to allow that — a default configuration that forbids what the
  default prompt asks for is a broken default. A real session wrote the file,
  could not commit, and reported `blocked`: correct behaviour, avoidable cause.

**Nothing else runs.** A task needing tests or a build will stall waiting for
permission that never comes, so add what that project needs — with
`allowedTools`, which **adds to** the defaults rather than replacing them:

```json
{
  "allowedTools": ["Bash(node *)"],
  "projects": {
    "dycrypt": {
      "path": "/Users/you/code/dycrypt",
      "allowedTools": ["Bash(mvn *)", "Bash(gh *)", "mcp__roadmap"]
    },
    "medymo": "/Users/you/code/medymo"
  }
}
```

A project is a path, or a path with permissions of its own; both forms work, so
the one project that runs Maven does not force the long form on the rest.

Do **not** reach for `agentArgs` to add a permission: it replaces the whole
default list, so you would have to repeat all sixteen MCP tool names to add one
`Bash` pattern.

### The project's own MCP servers

A repository that ships its own `.mcp.json` means it. Those servers are
**passed through** into the config the runner generates, because a server
merely *discovered* in a repository is project-scoped — Claude Code asks whether
you trust it, and a spawned session has no terminal to answer with, so it
auto-denies and the repository's own tooling is silently missing.

Their tools still need naming in `allowedTools`, as `mcp__<server>__<tool>`.
cawdev's own entry is written last, so a project cannot shadow it with a server
of the same name and intercept the run's token. On a machine
dedicated to this, `bypassPermissions` covers everything — but that is a real
decision about what an unattended agent may do in your checkout, and it should
be yours to make rather than a default you inherit without noticing.

**Both `--mcp-config` and `--allowedTools` are variadic**, so whatever follows
them is swallowed as another value. The runner puts `--mcp-config` first and the
prompt on **stdin** for exactly this reason — passing the prompt as an argument
after `--mcp-config` fails with `ENAMETOOLONG`, which names neither the flag nor
the prompt.

The prompt deliberately teaches the **method**, not the task. The task is in the
roadmap entry, which the agent reads for itself with `task_current` — putting it
in the prompt too would be a second copy that can disagree with the entry.
