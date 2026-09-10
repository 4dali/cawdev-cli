# The runner daemon

The piece that lives on your machine. It holds the repositories and the Claude
Code login; **the platform holds neither.**

It connects **outbound** and polls, so there is no inbound port and NAT and
firewalls are not anybody's problem. See R19 in the roadmap for the server-side
alternative that was declined, and why.

Plain Node, zero dependencies. You are about to let it spawn agent sessions
against your working copies — it should be a file you can read first.

## Setting it up

Write the config — what this machine serves, and where:

```json
{
  "url": "http://localhost:4200",
  "name": "my-laptop",
  "projects": {
    "cawdev": "/Users/you/code/cawdev",
    "dycrypt": "/Users/you/code/dycrypt"
  }
}
```

Then run `cawdev` (below). Finding no token it can use, it signs you in through
your browser and mints a `runner:operate` one scoped to exactly those projects,
storing it in `~/.cawdev/token.json`, mode 0600. **Nothing is typed or pasted**,
and you can still revoke it in the console under Agent tokens, which stops the
machine.

There is deliberately no `"token"` in the config above. This file names working
copies and permissions, so it is the kind people keep beside their code and
commit — `macbook-laptop.json` in this directory is tracked, and
`configs.test.mjs` fails if one of them ever grows a credential. A token in a
config is still *read*, because R93's generated `~/.cawdev/runner.config.json`
is that shape and lives under a home directory.

Driving the daemon directly, without the `cawdev` command, means supplying the
credential yourself — it does not open browsers:

```sh
CAWDEV_TOKEN=cawd_… node tools/runner/runner.mjs --config runner.config.json
```

`readConfig` takes the token from `CAWDEV_TOKEN`, then the config, then
`~/.cawdev/token.json` — the store last, because it is the one nobody typed.

The name is how you will recognise it in the console's runner picker.
Registering is idempotent by (owner, name), so restarting the daemon is the same
runner rather than a third entry in the list.

## `cawdev` — the terminal, in one word

```sh
cawdev
```

That is the whole of it. Install the command once — `npm i -g ./tools`, or
`npm link` from `tools/` while you are working on it — and typing `cawdev` gets
you a working machine: it looks for a daemon here, **starts one if it finds
none**, and drops you into the UI.

Signing in happens **in your browser**. The first launch opens cawdev's sign-in
page and waits for you to approve a code; after that it is remembered, and
`/login` does it again on demand. No password is ever typed into the terminal —
that belongs on a page your browser has told you the origin of.

```
cawdev                    the runner here, starting one if there is none
cawdev --runner <name>    when this machine runs more than one
cawdev --url <url>        which cawdev to sign in to (or CAWDEV_URL)
cawdev --config <path>    the runner config to start a daemon from
cawdev --no-start         attach only; never launch a daemon
cawdev --watch-only       do not sign in; watch without being able to act
cawdev --leave-running    leave the daemon running when you quit
```

**Quitting stops the daemon** — R123. One word starts the machine and the
window; one key ends both, and it asks twice while sessions are running because
they go with it. A background process you did not know you started is the cost
of one word doing all this, and the earlier answer to that — naming the `kill`
on the way out — left the chore with the person rather than doing it.

`cawdev --leave-running` is the old behaviour for a machine that should keep
claiming work after the window closes; there the goodbye names the runner and
the command that stops it.

The other two ways in still work and are not deprecated. `node runner.mjs
--config macbook-laptop.json --attach` runs the daemon and the UI in **one
process and one terminal**, which is what you want when the daemon should die
with the window — there `q` stops it, and asks first when sessions are live.
`node runner.mjs attach` joins a daemon started elsewhere.

### What it shows you

The console shows you a session. This shows you **the machine** — and the
difference is the runs that are *not* moving. The daemon knows why the fifth run
is waiting ("cawdev already has a run here", "at 4 sessions"); nothing else
does, and that reason exists nowhere but here.

**The transcript is in your terminal's own scrollback.** Session output is
printed rather than painted, so the wheel, `shift+PgUp`, your terminal's search
and its copy all work exactly as they always have, and scrolling up reaches the
start of the session. The only thing pinned is the footer at the bottom, and it
never scrolls away: which cawdev, who you are signed in as, this machine's
runner, the per-project session counts against their checkouts and the machine's
total against `maxSessions` — plus the run you are watching and the keys that
work right now. Anything *stopping* a session sits above all of that, because it
is the only thing in there waiting on a person.

`L` lists the runs as an overlay: every one this machine is driving, claiming or
leaving queued, with the reason each waiting one waits. Arrows move, `enter`
opens that run — laying its history into the scrollback so you are not staring
at a blank terminal — and `esc` leaves without changing anything.

A **status line** sits with the footer while something is running: which run, how
long it has been going, and the key that stops it. It is absent when nothing is.

| Key | |
|---|---|
| `enter`, `i` | prompt the session you are watching |
| `/` | a command — the list filters as you type |
| `L` | the run list; arrows, `enter` to open, `esc` to leave |
| `1`–`9` | jump straight to a run |
| `a` | answer the question it stopped on — if it is yours (R58) |
| `y` / `s` / `n` | a permission request: allow once / for the rest of this run / refuse (R51, R60) |
| `Y` | allow always, here — writes a project rule |
| `x`, twice | cancel the session |
| `g` | print the daemon's own log instead of the transcript |
| `q` | stop the runner and leave (`--leave-running` keeps it up) |
| `esc` | close whatever is open, without ending the session |
| `ctrl+c`, twice | the same, and then leave |

In any list: arrows move, `1`–`9` pick straight away, `enter` chooses, `esc`
leaves. While typing: `↑`/`↓` walk your history, `tab` completes, and the arrows
move through the command list while one is open.

| Command | |
|---|---|
| `/help` | the list |
| `/login` | sign in through the browser |
| `/logout` | forget the stored session on this machine |
| `/runs` | the run list — the same as `L` |
| `/cancel` | cancel the session you are watching |
| `/log` | the daemon's own log, on or off |
| `/quit` | leave |

**Typing `/` filters that list as you go**, each row with its description; arrows
and `enter` pick one and `tab` completes as far as the matches agree. Guessing a
command name and being told `no such command` is a step, and it is the step this
removes.

**`↑` recalls what you last sent**, kept in `~/.cawdev/history.json` at mode
`0600` and keyed by URL like the session beside it — so it survives quitting.
`/logout` forgets it along with the session.

**A paste stays one line.** Paste four hundred lines and the input shows
`[pasted, 342 lines]`; all of it is sent. A paste that scrolled the transcript
away would bury the thing this program exists to keep.

Under `NO_COLOR` it is the same terminal without the colour: the picker still
moves, and the `❯`, the numbers and the words carry what the colour did — colour
and cursor are two different questions. Through a pipe or on a dumb terminal
there is no cursor at all, so a picker becomes a **numbered list read from
stdin** — type the number, or for a question type the answer itself. The fixed
answers are printed when they change and the escape codes are stripped; a log
file full of `ESC[32m` is not legible, whatever else it is.

### Answering is picking, not retyping

The agent has usually already worked out the two or three answers it can act on
— `ask_user` has carried `options` since R10 — and until R83 this was the one
surface that threw them away and asked you to retype one of them, spelled
correctly.

Now a question with options arrives as a list: the question prints into the
transcript, the options become a live selection, arrows or a digit choose one,
and that is the answer. A question with no options goes straight to the line, as
it always did.

**The last row is always "write my own answer"**, and it opens a real line to
type on with the question still on screen. The options are the agent's *guess* at
the shape of the decision, and the whole value of asking a person is that they
can say the thing that was not on the list — so getting there costs one key, and
`esc` from it comes back to the list rather than abandoning the answer. A chosen
option and a typed sentence resolve the same question the same way, through the
same endpoint the inbox and the run page post to: one record, the same
`answeredBy`, and the badge clears at once.

A permission request is the same widget — R60's lengths of yes as rows, with the
tool and its arguments printed above them so you are deciding about something you
can read. The single keys keep working for anybody who has learned them.

R58 is unchanged by any of this: a question that is not yours is shown with the
name of the person it is waiting on, and no picker is offered.

### A question on this machine is not necessarily yours

Since R58 a question belongs to the person who **started the run**, and only
they — or somebody they hand it to — may answer it. The banner has two shapes
because of that: `a answer` when it is yours, and `waiting on alice@…` when it
is not.

It shows you the question either way. This program exists to answer "why is that
run not moving", and on a machine serving a team the answer is often a name. What
it will not do is offer you a key that the platform would then refuse, because a
terminal that takes an answer and hands back a 403 reads as cawdev being broken
rather than as the question belonging to a colleague.

If the person it is waiting on cannot be reached, a project owner can take the
question over from the console — the run page has the button, and the takeover
is recorded on the question rather than appearing as an unexplained answer.

`i` is refused while a session is asking, and says so: a run blocked inside
`ask_user` cannot read a prompt, and the words typed into one queue behind the
answer they were meant to be. R78 put that refusal in the API, so this client,
the run page and the home composer cannot disagree about it.

### Three lengths of yes

A permission request has R60's three answers here as well as in the console, as
three rows of a list and as three keys. `y` is this call; `s` is the rest of this
run and no longer; `Y` writes a project rule that outlives the session, the
person and the reason they said yes. Refusing asks why.

`s` names what it covers — `Bash(mvn *)` when the server could render a rule for
the command, and `every Bash` when it could not, because those are two different
promises and a banner that said the same words for both would be lying about one
of them. `Y` is offered only when there is a rule to write: a compound command
like `cd backend && ./mvnw test` cannot be settled by a pattern about its first
word, and a key that quietly became an allow-once would be worse than no key.

### Watching is free; acting means signing in

Everything on the socket is readable without signing in — `--watch-only` skips
the browser entirely, and watching is the larger half of what this is for.

Anything that *changes* something goes to the platform over HTTP as you, not
through the daemon. That is not fussiness: prompting a session, cancelling one,
answering a question and deciding a permission request all refuse an agent
token (R51), so a socket that could do them would either lend the daemon's own
credential to a guard built to prevent exactly that, or keep yours.

**Signing in is a browser round trip, and no password reaches this process.**
`cawdev` asks the platform for a code, opens R55's sign-in page, and waits.
You approve the code there; the page names the machine that asked, and the code
is on both screens so you can check they match. What comes back is *your*
session, stored in `~/.cawdev/session.json` at mode `0600` and keyed by URL — so
one machine can hold sessions for two different cawdevs without either
pretending to be the other.

Over ssh, where there is no browser to open, the URL is printed: carry it to a
browser anywhere and the terminal collects the session when you approve.

`/logout` forgets it. A stored session the platform no longer honours is not an
error — it is what an expired session looks like, and the answer is the same as
having none.

### Where the socket is

`~/.cawdev/run/<runner name>.sock`, in a `0700` directory, removed when the
daemon stops. **Permission to read it is permission to read this machine's
transcripts** — which is why it is under your home directory and shows only this
machine's own work.

More than one daemon here? `cawdev --runner <name>`. One is chosen for you.

A named runner is never started for you: naming one is a claim that it is there,
and launching a *different* daemon under that name because the first was not
answering is not what was asked.

A killed daemon leaves its socket file behind, and a stale file is
indistinguishable from a live one until you try it — so `cawdev` connects before
it believes one, which is what stops it attaching to nothing instead of starting
a daemon. `CAWDEV_RUN_DIR` moves the directory, which is mostly for tests.

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
"that project already has a run here", which was a proxy for it.

**This number caps coding and nothing else** (R70). `ASK`, `ROADMAP` and `AUDIT`
runs take no workspace, so a project whose checkouts are all busy still starts a
question, an entry-writing session and an audit at once. What holds those back
is `maxSessions`, which counts every profile — **"at 4 sessions on this machine
(every profile counts)"** is the other thing a waiting run can say, and the log
always says which of the two it was.

**One thing this gate cannot express, and does not try to.** It serialises on a
checkout, so two runs on *the same branch* in two checkouts are, to this daemon,
two free workspaces and two runs to take. That is right for a branch each and
wrong for one branch shared — so R67's *one branch, in order* is held by the
platform instead: a run that follows another is simply not offered here until
that one has ended. Nothing in this file changes for it, and that is the point.
Do not add a branch check to the gate; it would be a second, weaker copy of a
rule that already exists where it can see every machine rather than one.

### A workspace belongs to the daemon

Before each run it is cleared with `git clean -fd` — **without `-x`**, so
`.env`, `node_modules` and `target` survive and only what the last session left
lying about is removed. What goes is always logged.

**Do not list a directory you work in by hand.** That clean deletes untracked
files. It is skipped when a run was deliberately started on top of uncommitted
work, but the rule stands: a workspace is the machine's, not yours.

**A held workspace is not cleaned and not offered** (R80). When a code run
fails, the platform marks its checkout *held* — the uncommitted work is still
in it — and tells this daemon so on every heartbeat (`heldWorkspaces`). The
daemon counts it as busy: a new run does not land there, and `git clean` does
not run there, until somebody on the run page either **carries on** (the run
re-queues onto this machine and picks up its own session in the same
directory) or **discards** it, which is the only thing that frees it. The
runners page lists what each machine is holding, so a workspace nobody
remembers cannot quietly sit taken.

Provision them however you like — `git clone`, then whatever the project needs
to build. R48 makes them cheap by cloning a golden checkout per run; until then
they are yours to create, and two or three is plenty.

Nothing is written down about which workspace is busy, so a killed daemon leaks
nothing: restarting frees them all.

### What it looks like

R62. Starting the daemon prints the mark and then the five settings that decide
what it will actually do — the platform it registered against, this machine's
name, every project with **how many checkouts it has**, the session cap, and
whether the browser is allowed. Those five answer nearly every "why did that
not happen", and they used to be spread across a config file and a shrug.

Attaching adds a second bar row: the URL, each project as **coding sessions over
checkouts** (`cawdev 1/2`), and the machine's total against `maxSessions`.
Both gates, on screen, counting what each actually bounds — a question is in the
total on the right and not in any project's figure, because it took no checkout.
A run that is waiting is explained by the bar
above it rather than by reading the source. A narrow terminal drops projects
from the end (with an `…`) and never the total, because on a machine at its cap
the total is the number that answers the question.

Colour is `tools/lib/ansi.mjs`: truecolor where the terminal says so, the
256-colour cube where it does not, and **nothing at all** under `NO_COLOR`,
through a pipe, or on a dumb terminal. Nothing carries meaning in colour alone
— every state that has a colour also has a word — so a piped log reads exactly
as it always did.

One thing worth knowing about the tinting: a line matching `skipped` is muted
*before* anything matches `failed`. `fetch skipped: git fetch --prune origin
failed: no origin` is a repository with no remote, which happens on every
survey of every scratch checkout and is fine. Painting it red teaches people
that red means nothing.

### Letting a run drive the browser

R61. `--chrome` connects a session to Claude in Chrome — verified in print mode
against 2.1.252, with no terminal and no settings sources: the tools are there
and a call reaches the extension.

**Off by default, and this machine has the last word.**

```json
{ "browser": true, "projects": { "cawdev": { "path": "…", "browser": false } } }
```

It reaches the extension in **your own Chrome**: your logged-in sessions, your
cookies, your mail. That is a different kind of permission from `Bash(mvn *)`,
and it must not be reachable by writing a roadmap card in a project this machine
happens to serve — so the platform records what was asked for and the config
decides whether it happens. A per-project `browser` overrides the machine's
answer in either direction.

A run that asks and is refused is **not failed**. It runs without a browser and
says so on its own transcript, because a capability withheld and a broken run
are different things.

**Turning it on does not pre-allow it.** The tools become available; the first
call still stops and asks. `mcp__claude-in-chrome` — the server with no tool
after it — covers every tool on it, so one answer settles the session rather
than twenty-six. A machine that wants it unattended puts that string in its own
`allowedTools`.

### What a person can ask of a checkout

R57. The daemon polls `workspace-requests/claim` every few seconds and does one
of **seven** things to a checkout it serves. It said six for two entries, and
`HANDOFF` had been missing from the list since R148 — a table that quietly does
not describe one of the things a person can ask for is worse than no table.

| | |
|---|---|
| `SHOW` | `git status --porcelain`, the untracked list, and `git diff HEAD`. Reads only. |
| `STASH` | `git stash push --include-untracked`, and reports the ref to recover it by. |
| `COMMIT` | `git add -A` and commit. `--no-verify` is not passed — a repository's hooks are its own business. |
| `INDEX` | R77's map button: refreshes the code map, then builds the project's skill index if one is turned on. No session, no branch. |
| `RESET` | R87's start-over, and the destructive one: `reset --hard`, `clean -fd`, then back to `origin/<branch>` — or, for a branch never pushed, onto the default branch with the branch deleted. |
| `MERGE` | R134's Merge button on the development board: `gh pr merge <url> --squash --delete-branch` for the branch in `message`. The only kind whose effect is **not** in the checkout — it lands a branch on the host and touches no working tree, which is why several branches merge safely from one clone. The URL is reported on the result's first line, and the platform reads that line as the evidence to put on the card. |
| `HANDOFF` | R148's hand-off, and the only kind addressed to a **run** rather than to a directory alone: the branch is pushed, whatever was uncommitted is packaged as a patch on its base sha, and the checkout is put back on the default branch. The next claim can then go to any machine. |

**A `MERGE` that fails also says which KIND of failure it was** — R155, in one
of five words beside `gh`'s own unchanged text:

| | |
|---|---|
| `CONFLICT` | `gh pr view --json mergeable` says `CONFLICTING`. The one an agent can do something about, and the only failure the console offers **Merge with an agent** on. |
| `NO_PULL_REQUEST` | There is nothing on the host to merge. R134 already named this case; it now has a word. |
| `NOT_PERMITTED` | 403, a protected branch, a required review or a required status check. The host said no, and it will say no again. |
| `UNREACHABLE` | No `gh`, or the host could not be reached at all. Nothing is known about the pull request. |
| `OTHER` | Anything else — **including `mergeable: UNKNOWN`**, which GitHub answers when it has not computed mergeability yet. Unknown is not "no conflict", and reading it as one is the single way this feature would disappear silently. |

The classification is made **here**, on the machine, and never by the platform:
the platform has no `gh` and parsing this text would make it a platform with an
opinion about a git version it does not run. A daemon older than R155 sends no
word at all, which the platform stores as null and the console reads as
*unknown* — offering the agent merge anyway, because being wrong there costs one
`git fetch`.

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

   When the claim carries a `resume` (R69), it spawns `--resume <session-id>`
   and writes the **follow-up** to stdin instead of the opening prompt — the
   session is being handed back its own transcript, so it already has the
   question, and re-sending it would be a repeat wearing a resume's clothes.
   Nothing else changes: the same profile, so the same permissions. Being
   started a second time is not a reason to be allowed to write files.
4. **Streams the transcript.** Every stream-json event the session emits is
   summarised into a line and batched to the platform, which is what the
   console's live terminal reads. It summarises rather than forwards — the
   `init` event alone is kilobytes of tool inventory nobody reads.

   Two things are kept out of that event rather than summarised away: the model,
   and — since R69 — the **session id**, which is reported to the platform as
   the handle `claude --resume` takes. It is reported **every** time an `init`
   arrives, because a resumed session announces itself again and the id a
   *further* resume needs is the most recent one.
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
   not look" and "it was clean" are different answers. One entry **per
   workspace**, in this daemon's own `workspaces` order and carrying the run
   holding each: R71 has the console pick the first unheld entry to decide which
   checkout a run is headed for, so re-ordering this list would move a warning
   onto a checkout nothing is going to touch.
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
   session to refresh a background page is a bad trade. Nothing in *this* pass
   writes to git: no merging, no branch deletion, no pushing. (A project's own
   rules can ask for all three — see below — but that is a queued action with a
   name on it, not something the survey does in passing.)
8. **Reports the lifecycle back** and, if the session dies without saying
   anything, ends the run rather than leaving it `RUNNING` forever.

Cancelling a run reaches the daemon on its next poll and takes down the child's
whole process group — an agent that started a build should not leave it running.

## What a project's rules can ask of it (R40)

A project may decide that a finished run **pushes its branch**, **opens a pull
request**, and — if somebody with `OWNER` deliberately turned it on — **merges
it with nobody reading the diff**. The rules are set in the console, ride along
with the claim, and the daemon logs them when it takes a run, so you find out
what is going to happen before it happens rather than afterwards. `auto_merge`
gets a shouted line of its own.

The daemon does not decide any of this. The platform queues `PUSH`, `OPEN_PR`
and `MERGE` on the same `run_action` queue the console's *Commit* button uses,
and the daemon performs them in `settleActions` — one pass right after the
session ends, because the working-copy watcher stopped with the child and the
rules queue their work at exactly that moment.

**cawdev still holds no git-host credential.** This machine does, which is why
the work happens here and why R19 and R25's division is unchanged. All that is
new is that the platform can ask.

What it actually runs:

- `git push --set-upstream <remote> <branch>`. Never `--force`: a rule that
  pushes must never be a rule that overwrites somebody else's commits.
- `gh pr create --head <branch>`, titled with the run's label, after pushing if
  the branch is not out yet. An existing pull request is a **success**, not a
  conflict — the rule wanted one to exist and one does.
- `gh pr merge <url> --squash --delete-branch`, and only if a real pull request
  is found. A `/compare/` URL is not one, and it refuses rather than guessing.

Every one of them reports a result or a reason, and a machine with no `gh`, no
remote or no credentials simply says so. **A rule is a request, not a grant** —
the same asymmetry `grantable` gives the R51 tool rules.

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
many agent processes this machine will host at once, and it is the **only**
thing bounding a question, a roadmap session or an audit (R70). It counts runs
this daemon has claimed, not children it has spawned: a claim takes a second or
two to become a process, and counting processes let one pass of the loop claim
the whole queue.

## If the daemon dies mid-run

The platform notices. `StaleRunSweeper` fails a run whose runner has stopped
heartbeating for five minutes, with `failureReason: RUNNER_VANISHED` and a
summary saying so — otherwise the run would sit `RUNNING` forever and block the
project from starting anything else. The workspace is **kept**, not reclaimed:
when the daemon comes back, the run page offers *Carry on*, which re-queues the
run onto this machine and resumes its own session in the same checkout, with
whatever it had written still there. Nothing is lost by a crash that a person
does not choose to discard.

A run **`WAITING_ON_USER` is never swept.** That is the one state where nothing
happening is correct: it is stalled on a person, who may reasonably take a day.
Nor is a `PAUSED` or `USAGE_LIMITED` one (below) — there is no process to lose.

## When the usage limit hits (R73)

Claude Code stops with a message naming the window — the five-hour one or the
weekly one — and when it resets. The daemon reads that off the session's last
output (`tools/lib/usage-limit.mjs`, tested) and reports the run as
**`USAGE_LIMITED`** with the window and the reset time, rather than `FAILED`
with a stack of text. The run page says *Usage limit — resumes after …*; the
card stays where it was; the workspace stays taken. It also posts the reading
to `POST /api/runners/{id}/limits`, so the runners page shows what this machine
has used of each window.

**Pause** is the same state with a person's hand on it: the run page's *Pause*
button moves a `RUNNING` run to `PAUSED`, and the runners page's *Pause* switch
stops a machine claiming anything new without stopping what it is driving.
Both are yours to undo. *Carry on* re-queues the run onto its runner, which
resumes the session it already had.

**Auto-resume** is per machine, off by default, on the runners page. With it
on, the platform re-queues a `USAGE_LIMITED` run the minute its window opens,
onto the same machine. It never touches a `PAUSED` run: a person stopped that,
and only a person starts it. The runner has no say in any of this beyond
obeying its heartbeat — `paused` and `heldWorkspaces` come from the platform,
and `runner.mjs` reads them rather than deciding them.

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

#### Skills need no configuration here — R76

A skill is a capability a project turns on in cawdev, and the runner attaches it
to the session as an MCP server. **There is nothing to configure on the
machine**: turn CodeGraph on for a project in the console and the next run in
that project has it.

That is deliberate, and narrower than it sounds. A skill's command is not
something anybody types — the `skill` table is seeded by migration and has no
create endpoint, so enabling one runs a command cawdev itself shipped. An
allowlist on every machine would have been guarding against a project owner
switching on a vetted skill, which is friction rather than a boundary.

**The machine's consent did not go away; it moved to where it was already
being asked.** The skill's tools are not added to `--allowedTools`, so the
session's first call stops and asks a person (R51), and *allow `mcp__codegraph`
for this session* (R60) is the answer that fits. A machine that wants it
unattended says so in its own `allowedTools` — the same place every other
standing permission lives, rather than a second list that only skills use.

**The index lives outside the checkout.** CodeGraph parses the repository into
a graph beside it; the runner builds that once per repository, keeps it in
`~/.cawdev/skills/<skill>/<project>`, and copies it into each workspace — so
R47's several checkouts of one project do not each pay for a parse. The pidfile
and socket are never copied: they name a live process, and in another workspace
they point at a daemon serving another tree. The index directory is added to
that checkout's `.git/info/exclude`, so it neither shows up as a dirty tree nor
gets deleted by the reset between runs.

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
