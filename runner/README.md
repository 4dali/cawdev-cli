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
4. **Reports the lifecycle back** and, if the session dies without saying
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

```sh
CAWDEV_STUB_SCRIPT=ask-then-finish \
CAWDEV_TOKEN=cawd_… \
  node tools/runner/runner.mjs --config runner.config.json
```

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

```json
{ "agentCommand": "claude", "agentArgs": ["-p", "--output-format", "stream-json", "--verbose"] }
```

The prompt deliberately teaches the **method**, not the task. The task is in the
roadmap entry, which the agent reads for itself with `task_current` — putting it
in the prompt too would be a second copy that can disagree with the entry.
