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

## Watching it from a terminal

Start the machine and watch it with one command:

```sh
node runner.mjs --config macbook-laptop.json --attach
```

Or attach to a daemon that is already running, from another window:

```sh
node runner.mjs attach
```

With `--attach` there is **one process and one terminal**: the daemon's log
stops printing (it would paint over the UI) and moves to the `g` pane, and `q`
stops the daemon rather than just closing the view. With sessions live it asks
first — `q` must not be a way to lose three hours of work by leaning on the
keyboard.

A detached daemon would have been the other option, and is worse: it outlives
the window and then has to be found and stopped by pid.

The console shows you a session. This shows you **the machine** — and the
difference is the runs that are *not* moving. The daemon knows why the fifth run
is waiting ("cawdev already has a run here", "at 4 sessions"); nothing else
does, and until now that reason existed only as a line in a log nobody was
tailing.

A rail of every session on this machine — running, claimed, or queued with its
reason — the selected transcript streaming beside it, and the daemon's own log a
keypress away.

| Key | |
|---|---|
| `tab`, `j`, `k` | move between sessions |
| `1`–`9` | pick one |
| `i` | prompt the session; `enter` sends, `esc` cancels |
| `y` / `Y` / `n` | allow once / allow always here / refuse a permission request |
| `x`, twice | cancel the session |
| `g` | the daemon's log instead of the transcript |
| `PgUp` / `PgDn` | scroll back |
| `q` | leave |

### Watching is free; acting means signing in

It asks for your email and password at startup. **Leave the email blank to just
watch** — everything on the socket is readable without it.

Anything that *changes* something goes to the platform over HTTP as you, not
through the daemon. That is not fussiness: prompting a session, cancelling one
and deciding a permission request all refuse an agent token (R51), so a socket
that could do them would either lend the daemon's own credential to a guard
built to prevent exactly that, or keep yours. The password is held in memory for
the life of the process and written nowhere.

`--email you@example.com` skips one prompt; `--watch-only` skips both.

### Where the socket is

`~/.cawdev/run/<runner name>.sock`, in a `0700` directory, removed when the
daemon stops. **Permission to read it is permission to read this machine's
transcripts** — which is why it is under your home directory and shows only this
machine's own work.

More than one daemon here? `attach --runner <name>`. One is chosen for you.

If `attach` says nothing is offering a socket, the daemon is not running — or it
predates R52.

## Workspaces: more than one run at a time

A project can offer several checkouts. A run takes one, and gives it back when
it ends.

```json
{
  "projects": {
    "dycrypt": "/Users/you/code/dycrypt",
    "cawdev": { "workspaces": ["/Users/you/code/cawdev-1", "/Users/you/code/cawdev-2"] }
  }
}
```

A bare path means one workspace, which is what every config meant before this
existed — nothing changes for a machine that serves one checkout per project.

How many coding runs go at once is `min(workspaces, maxSessions)`. A run that
waits now says **"no free workspace in cawdev (2 here, all busy)"** instead of
"that project already has a run here", which was a proxy for it. Asking a
question takes no workspace and never queues behind coding.

### A workspace belongs to the daemon

Before each run it is cleared with `git clean -fd` — **without `-x`**, so
`.env`, `node_modules` and `target` survive and only what the last session left
lying about is removed. What goes is always logged.

**Do not list a directory you work in by hand.** That clean deletes untracked
files. It is skipped when a run was deliberately started on top of uncommitted
work, but the rule stands: a workspace is the machine's, not yours.

Provision them however you like — `git clone`, then whatever the project needs
to build. R48 makes them cheap by cloning a golden checkout per run; until then
they are yours to create, and two or three is plenty.

Nothing is written down about which workspace is busy, so a killed daemon leaks
nothing: restarting frees them all.

### What a person can ask of a checkout

R57. The daemon polls `workspace-requests/claim` every few seconds and does one
of three things to a checkout it serves:

| | |
|---|---|
| `SHOW` | `git status --porcelain`, the untracked list, and `git diff HEAD`. Reads only. |
| `STASH` | `git stash push --include-untracked`, and reports the ref to recover it by. |
| `COMMIT` | `git add -A` and commit. `--no-verify` is not passed — a repository's hooks are its own business. |

Two guards, and they are in different places on purpose. The platform checks
that the runner is **yours**; only this process knows which directories it was
actually given, so **a request naming a path this daemon does not serve is
refused rather than run**. Results are capped, and say in the text that they
were capped: a diff that silently stops halfway is one somebody reads to the
end and then acts on.

## The daemon's tooling is frozen when it starts

The runner spawns the cawdev MCP server from this repository — and **cawdev is
its own first project**, so a run working on cawdev checks this very directory
out onto another branch. The session would then be handed whichever MCP server
happened to be on the branch it is working on.

That is not hypothetical: a run on a branch cut from `main` was given a server
with no `approve` tool while holding a `--permission-prompt-tool` flag naming
it, and died on its first tool call.

So the server is **copied to a temp directory at startup** and sessions are
pointed at the copy. To pick up changes to it, restart the daemon — which is
when its own code reloads anyway, so the two cannot disagree about what exists.

**If you drive cawdev with cawdev, run the daemon from a separate worktree:**

```sh
git worktree add ~/code/cawdev-runner main
cd ~/code/cawdev-runner/tools/runner
node runner.mjs --config ~/code/cawdev/tools/runner/macbook-laptop.json --attach
```

Then a run switching branches in your working copy cannot reach the daemon's own
files at all. R47 removes the need for this by giving each run a workspace.

## What it does with a run

1. **Claims it.** The claim response carries the run's own `cawdr_` token and
   the project's default branch — the runner never touches the project API,
   which is session-only.
2. **Prepares the working copy**: fetch, then branch off the default.
   **A dirty tree stops it unless somebody said otherwise.** An agent let loose
   in a checkout with uncommitted work will at best confuse itself and at worst
   commit somebody's half-finished thoughts — so the console shows what is
   uncommitted before the run is started, and the decision arrives with the
   claim as `allowDirty`. Without it the runner still refuses, with the file
   list, and fails the run saying so: a run that arrives with no flag is one
   nobody was warned about.

   With it, the edits are **carried onto the branch** — stashed, checked out,
   popped (R57). `git checkout` refuses outright when a locally modified file
   differs between the two commits, which is what made *Start anyway* fail one
   step later than the refusal it was meant to replace. If the pop cannot apply
   — the branch rewrote the same lines — the run fails **naming the stash and
   the command to recover it**, because work parked somewhere nobody was told
   about is work lost.
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
6. **Says what its checkouts look like**, on every heartbeat: for each project
   it serves, the porcelain status, capped at twenty paths but counting them
   all. This is the only way the console can know a checkout is dirty before a
   run is started in it — the platform cannot see your machine. A checkout it
   cannot read is reported as unreadable rather than omitted, because "I could
   not look" and "it was clean" are different answers.
7. **Reads each repository for the project's Git tab**, on a slow timer of its
   own — `gitSurveySeconds`, five minutes by default, plus once at startup. Per
   project: `git fetch --prune`, the tail of the default branch's history, and
   every remote branch with whether it is merged, plus any local branch whose
   upstream is `[gone]`. The platform holds no git credentials, so this machine
   is the only thing that can answer; the console shows every reading with when
   it was taken and says **stale** when it has aged.

   Its own timer rather than the heartbeat's, because it pays for a network
   round trip per project and the heartbeat runs every thirty seconds. The
   `fetch` is **skipped while an agent is working in that checkout** — it is the
   only part that writes anything, and taking the ref lock out from under a
   session to refresh a background page is a bad trade. Nothing here writes to
   git: no merging, no branch deletion, no pushing.
8. **Reports the lifecycle back** and, if the session dies without saying
   anything, ends the run rather than leaving it `RUNNING` forever.

Cancelling a run reaches the daemon on its next poll and takes down the child's
whole process group — an agent that started a build should not leave it running.

## What it does after a run is over

A merge happens **after** the run ends, by definition: somebody reviews the pull
request and merges it. So the one event worth recording is the one event a live
session can never be present for, and R25's reading — taken on the runner's last
reporting pass — always stops one question short. `PUSHED` is not `MERGED`.

Every ten minutes, on the loop it already has, the daemon asks
`GET /api/runners/{id}/branches` for the finished runs worth re-checking, looks,
and posts the answers back in one batch. The platform names the branches; the
runner says what happened to them. **cawdev holds no git-host credential** and
could not answer this itself — that division is R19 and R25's, and this keeps it.

How it answers, in order:

1. **`gh pr view`**, preferring the recorded pull request URL over the branch
   name. `gh pr view <branch>` stops finding anything once the branch is deleted,
   which is exactly when the question gets interesting; a URL keeps answering.
   This is also the only thing that can see a **squash merge**.
2. **`git merge-base --is-ancestor <head> origin/<default>`**, which works for
   any remote at all. By SHA, not by branch name: a merged branch is usually
   deleted, but its last commit stays reachable from the default branch for ever,
   which is why `git branch --merged` is not what is used here.
3. **`git ls-remote`** — if ancestry says no and the branch is still on the
   remote, it is genuinely open and waiting.

Anything else is **`UNKNOWN`**, and that is a real answer rather than a missing
one. Proving a merge is possible; disproving one is not — a squashed branch that
was then deleted looks exactly like an abandoned one — so the daemon says it
cannot tell instead of guessing. A project it serves whose checkout it can no
longer read also answers `UNKNOWN`; a project it does **not** serve it says
nothing about at all, so it cannot blank another machine's good answer.

The pass is bounded and rotating, longest-unchecked first, and a run already
recorded as merged is never offered again: **merged is permanent.** A merged
branch is usually deleted within seconds, so the very next pass often cannot
prove anything — and letting that overwrite the record would mean forgetting the
one fact worth learning, minutes after learning it.

**One run at a time per working copy** — for runs that use one. Coding runs
share a checkout, so a second in the same directory would fight the first; the
rest queue.

**Questions are not serialised.** An `ASK` run prepares nothing and writes
nothing, so it runs alongside whatever else is going on — you can ask about a
project while an agent is working in it. `maxSessions` (4 by default) bounds how
many agent processes this machine will host at once.

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

**Anything else stops and asks you** (R51). Rather than being denied in
silence, a session that needs `mvn` or `npm` posts a request that appears in
your inbox and on the run, and waits for an answer. Allow it once, or allow it
always here — which writes a rule on the project that every runner serving it
inherits.

Nobody answering is a decision too: after fifteen minutes the request expires
and the session is told to report blocked rather than wait for ever.

You can still say in advance what a project may do, and for anything a session
needs on every run that is the better answer — with `allowedTools`, which
**adds to** the defaults rather than replacing them:

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

#### `grantable`: what this machine lets a saved rule cover

A rule stored on the platform applies to sessions **nobody is watching**, so the
machine's owner has the last word on it. `grantable` is that word:

```json
{
  "grantable": ["Bash(mvn *)"],
  "projects": {
    "dycrypt": {
      "path": "/Users/you/code/dycrypt",
      "grantable": ["Bash(npm *)"]
    }
  }
}
```

A project rule outside the ceiling is **dropped**, and the drop is reported onto
the run so nobody is left wondering why allowing something changed nothing.

**Empty by default, and that is safe rather than timid**: a machine that has
declared nothing still works, it just asks every time. Widening it is a real
decision about what an unattended agent may run in your checkout, so it is yours
to make rather than a default you inherit without noticing.

The ceiling limits *saved rules only*. A person allowing one call in the moment
is present and looking at the command, and needs no ceiling.

#### Two flags worth knowing about

- `--permission-prompt-tool mcp__cawdev__approve` is what makes the asking
  possible. It is **hidden from `claude --help`** on 2.1.251 but accepted; the
  daemon probes for it at startup and warns loudly if the CLI it was pointed at
  does not take it.
- `--setting-sources ''` stops a run inheriting **your own**
  `~/.claude/settings.json`. Without it, what a session may do depends on an
  invisible file on whichever machine claimed the run — two laptops, two answers
  — and the ceiling above means nothing.

### The model

A run may name one, chosen when it is started. The runner passes it through as
`--model`, **before** `--allowedTools` — that option is variadic and would
swallow it otherwise. A run that names no model is spawned exactly as it was
before R23, so `agentArgs` may still pin one for every run on this machine.

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
