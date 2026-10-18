# cawdev MCP server

Plain Node, zero dependencies, stdio JSON-RPC — `server.mjs`, plus the shared
rule matcher in `tools/lib/tool-rules.mjs` that the runner uses too. It gives a coding
agent a project's roadmap and changelog — the same verbs a person gets in the
console, because the API was built to mirror these tools one-for-one. This README says
**card** for the roadmap thing and **run** for the work on it, as the console does; the API and
the tool names say *entry* (`roadmap_list`, `propose_entry`, `EntryRef`) and keep doing so.

## Setting it up in a repository

Mint a token in the cawdev console under **Agent tokens**. Grant it
`roadmap:write` and `changelog:write` on the project. **You can only grant what
you hold** — if you are a `READER` there, you get read scopes. A token that
should only be able to *file feedback* — an application built beside cawdev,
say — needs just `backlog:write`, which a `READER` may grant and which reaches
nothing else, not even the roadmap (R199).

Then in the repository the agent works in, add `.mcp.json`:

```json
{
  "mcpServers": {
    "cawdev": {
      "command": "node",
      "args": ["/path/to/cawdev/tools/mcp/server.mjs"],
      "env": {
        "CAWDEV_URL": "http://localhost:4200",
        "CAWDEV_TOKEN": "cawd_…"
      }
    }
  }
}
```

Or leave `env` out and put `CAWDEV_URL` / `CAWDEV_TOKEN` / `CAWDEV_PROJECT` in a
`.env` at the repository root — **gitignore it.** The server searches upward
from its working directory.

**Configuration is read on every call, never cached.** Edit `.env` and the next
call sees it; no restart. That matters more than it sounds: an agent that has
been writing to the wrong platform for an hour, because the value changed and
the process was still holding the old one, is a bad afternoon.

### Which project

- A token granted **exactly one** project needs no `project` argument.
- A multi-project token takes `project` per call, or set `CAWDEV_PROJECT`.
- Get it wrong and the error lists what the token can actually see.

---

## For the agent reading this

**Run `roadmap_where` first** when anything is surprising. It tells you which
platform you are talking to, which token you are using, *where each value was
read from*, and who the platform thinks you are. Most confusion is one of those
four being different from what you assumed.

### How work starts here

The sequence is fixed, and the second step is the one people skip:

1. Branch off an up-to-date `main`, named after the card — `r4-roadmap-entries`.
2. **Move the card to `IN_DEVELOPMENT` naming the branch, before your first commit**
   (`roadmap_set_status`). Not after. The roadmap should be able to answer
   "what is being worked on right now" without asking anyone.
3. Build to the card's "Done when" list.
4. Finish with a PR. Never push to `main`. As your session ends the platform
   moves the *branch* on the development board, not the card: to `REVIEW` where
   the project runs `require_review` and somebody is going to read it, and to
   `DONE` where it does not — a finish nobody was asked about (R132), because
   there is no reviewer coming.
5. When the PR merges, move the card to `MERGED` naming it. The branch may then
   be deleted — `IN_DEVELOPMENT` is for work somebody is doing, not work that is done.

### What a status must carry

`roadmap_statuses` will tell you, and it is worth reading rather than guessing:
`IN_DEVELOPMENT` needs a branch, `MERGED` needs the merge — a pull request, a merge
commit, or a sha — `SHIPPED` needs a version that is a real git tag, and
`DECLINED` needs a reason. `REVIEW` needs nothing, deliberately: the pull
request it would otherwise carry belongs to the run, and a project that reviews
without opening pull requests has none to give it.

**A card you file may land in the `BACKLOG`** (R371). Where a new card goes
when you name no status is the project's rule, per door, and the default for a
card or issue an agent files is the backlog: waiting until a person or a sprint
brings it in, in no sprint and on no board column. Its origin names your
session and the card your run was on. A plan run's card lands where the console's
do (R380). Name a status (`CONSIDERING`, `NEW`) when
you mean the pipeline. Giving a backlog card a sprint moves it to the first
status of its kind; moving a card to `BACKLOG` takes it out of its sprint.

**Sprints are a team's** (R474, R489). The `sprint` of `roadmap_create`,
`roadmap_update` and the filter of `roadmap_list` take an integer or a string:
`7` or `"S7"` when the project's teams have one S7, `"Core team · S7"` (or
`"Core team / S7"`) when two do — the API refuses an ambiguous `S7` naming both
spellings, so read the sentence and send the long one — a sprint id, and `0` or
`""` to take a card out. A completed sprint refuses a card that is not already
in it, and only a person can reopen one; do not retry. `sprint_list` says which
sprints there are. A card prints its sprint as `Core team · S7 Name (active)`.
Opening, starting, completing and renaming a sprint stay a person's.

**Any status may move to any other.** There is no transition diagram — a card
really can go from `CONSIDERING` straight to `SHIPPED` if that is what happened.
The rules are about what a status *carries*, not the path it took.

### The body is what we want; the plan is how; the comments are the argument

`roadmap_get` gives you all three, and `task_current` gives you them for the
card you are working on.

**The plan is the one to read before doing any of the work.** It was written by
a plan phase and agreed by somebody, and it names the files — R124. If you are
carrying it out and it turns out to be wrong, say so and stop rather than
improvising a different change: what was approved was that plan, and a different
one has not been approved.

You cannot write a plan through this server, and you cannot start a plan phase
either. The first is the platform's — it stores what a plan phase reports when
the phase ends, so that a session which must not write is not handed a writer to
do its own bookkeeping with. The second is refused outright: *an agent cannot
start another agent*, which is `RunAccess.requireCanStart`'s rule and not an
omission here. **Read the discussion before you propose anything about a
card.** It is where an objection was answered and where an obvious-looking
approach was ruled out with a reason — and re-proposing what was talked out
three months ago is precisely what it exists to stop.

Use `roadmap_comment` for the argument: what you measured, what you tried, why
you did not take the route somebody would expect. Use `roadmap_update` when the
discussion reaches a conclusion — the body is where a settled answer goes, so
that the next reader does not have to reconstruct it from the thread.

A comment you write is attributed to your run as well as to the account that
minted your token, so a person can tell an agent's reading from a colleague's.

### Read what the earlier runs did before repeating it

`task_current` lists **every run this card has already had** — how each ended,
on what branch, with what model, whether the work was pushed, and the commits it
made by subject. A card that failed twice on the same branch is telling you
something its status does not, and the second attempt is the one that most needs
to know what the first tried.

No transcripts come with it, deliberately: the terminal log is on the run's own
page in the console, and nine of them would fill the context this call exists to
orient. If you need the detail, the discussion under the card is where a
previous run should have written down what it learned — and where yours
should.

### There is no delete

Not in these tools, not in the API. `roadmap_decline` with a reason is the only
exit a card has, and the reason is the point: it is what stops the same idea
being proposed again in six months. Same for changelog entries — correct the
text, do not remove the record. Same for comments: nothing removes one, and the
most you can do to your own is correct its wording.

### Ids are permanent, and a card is named by its ref

A card's number never changes and is never reused. Commit messages and code
comments point at it. Since R221 a roadmap card and an issue each count on
their own sequence, so `R91` and `i91` are two cards: wherever a tool takes
`number`, `related`, `after` or `entryNumber`, pass the ref — `"i91"` for an
issue — and a bare `91` is read as the roadmap card, which is what it always
was.

### When a call is refused

The message is the platform's own and it names the rule you hit — a missing
scope, a status that needs a branch, a project this token cannot see. Read it
rather than retrying: the refusal is usually telling you something true about
what you are allowed to do.

---

## Tools

| Tool | What it does |
|---|---|
| `roadmap_where` | Which platform, which token, read from where, and who you are. Start here. |
| `roadmap_statuses` | The eight statuses, what they mean, what each requires. |
| `roadmap_list` | Cards, optionally by status or `sprint` (any spelling below). `brief` omits bodies — use it to survey. |
| `sprint_list` | The project's sprints with how far each has got (R489): `Core team · S7 Notifications — active — 4 of 9 landed`. ACTIVE and UPCOMING unless `state` says otherwise. A read: PLAN and VERIFY have it. |
| `roadmap_get` | One card in full: its body, **the plan agreed for it**, and the discussion on it. |
| `roadmap_create` | Create a card; the platform allocates its permanent number. |
| `roadmap_update` | Title, body, section, sprint (R489: `7`, `S7`, `"Core team · S7"`, a sprint id; `0` or `""` takes the card out — see below), related ids, the cards it starts coding after (`after` — R181), when it is due and how big it is (`due` — R351: an ISO date, `""` clears; `estimate`: a positive number, `0` clears), the version it is meant for (`targetVersion` — R358, `""` clears; since R362 it must be one the project defined under Project settings → Versions, and any other name is refused), the versions an issue was found in (`affectedVersions` — R378, issues only: names the project defined or shipped in, `[]` clears), and who it is assigned to (`assignee` — R331: a username, `""` clears; `roadmap_list`/`issue_list` take `assignee` too, and `me` means the token's owner). |
| `roadmap_comment` | Say something *beside* a card rather than inside it. |
| `done_when_tick` | Tick (or untick) one numbered item of the card's Done-when checklist as built, with one line of evidence (R368). `task_current` lists the items. Defaults to the run's own card and refuses another; the reviewer's column is a person's and no token can set it. |
| `roadmap_set_status` | Move a card, carrying whatever the status requires. |
| `roadmap_decline` | Decline with a reason. The only exit. |
| `backlog_file` | File **feedback**, not a card — something a person should decide about. A WRITER accepts it as a card or an issue, or refuses it (R199). Tagged `agent` as a source, plus any `tags` you pass — `customer` when you relay what a user said (R372). |
| `changelog_list` | The changelog, grouped by release, newest first. |
| `changelog_get` | One entry. |
| `changelog_add` | Add an entry; no version means `Unreleased`. |
| `changelog_update` | Edit one, including moving it to a release when it ships. |
| `quality_get` | The SonarQube reading — the default branch's gate, a named branch's gate and new problems (inside a run, this run's branch by default), and the open findings with links. Read-only: nothing here refreshes, scans or files (R302). |

### Inside a run

These only work when the token is a **run token** (`cawdr_`), which the runner
mints when a run starts and hands to the session it spawns. A plain `cawd_`
token gets a refusal saying so.

| Tool | What it does |
|---|---|
| `task_current` | The card you are working on, its branch, everything already said and asked on this run, **and every earlier run on the same card**. **Call it first**, and again whenever you are unsure where you are. |
| `report` | `progress` as often as useful; `done` when finished, naming the branch and any PR; `blocked` when a person must resolve something. `done` and `blocked` end the run; on a review run the `done` body is filed as the branch's review (R529), so write it for the person reading the thread; on a coding run `done` is refused until everything is committed and pushed (R345). |
| `ask_user` | Ask the person who started the run, and wait. Blocks up to ten minutes, then hands back a `question_id`. |
| `await_answer` | Resume waiting for a question `ask_user` handed back. |
| `ask_group` | Ask a **round** — up to twelve questions that belong together, under one title. Blocks until every one of them has been answered, then hands back a `group_id`. |
| `await_group` | Resume waiting for a round `ask_group` handed back. |
| `propose_entry` | **Audit and scoping runs only.** Record a finding — or a card cut from a bigger idea (R227) — as a proposal, naming its kind — `issue` with a severity, or `roadmap` without — and, optionally, the `section` it belongs under; a scoping session names one section for every card of the idea. A `roadmap` card **must** say what it starts `after`: `[]` for the first, `"#2"` for the second card proposed in this run (the number the tool answered with — it has to exist already, so file in build order), `"R12"` for a card on the roadmap. A person accepts it as either, or leaves it (R214) — and adds the cards in that order: #2 is refused until #1 is on the roadmap. |
| `approve` | **Not yours to call.** Claude Code calls it itself, as `--permission-prompt-tool`, when no rule covers a tool call. |

**`ask_user` is for decisions that are genuinely theirs** — an architectural
choice, a trade-off with no right answer, something the card does not settle.
Not for checking work you can check yourself. Every question stops the run and
costs somebody's attention.

When `ask_user` returns without an answer, **do not guess and carry on.** You
asked because the decision was not yours. Call `await_answer`, or `report`
`blocked` and stop.

**`ask_group` is for when you have several questions at once** — R96. One
question at a time is right for a decision you hit halfway through a piece of
work; it is wrong when you are trying to understand something, because forty
separate Waiting on you items arriving over an afternoon is not a conversation, it is an
interruption repeated forty times. A round arrives as one form under one title,
the person answers it in one sitting, and you are woken once when all of it is
answered.

Rounds, then, rather than one enormous list: at most twelve, and the next round
should be shaped by the answers to this one. Give each round an `intro` saying
what it is about, and offer `options` where there is a small set of plausible
answers — they can always write their own.

After `report done` or `report blocked`, the run is over and your token has
expired with it. There is nothing further to do.

On a coding run, `report done` is **refused** while the checkout has
uncommitted files or commits the remote has not seen (R345) — the answer names
them. Commit what belongs to the work (discard what does not), `git push`, and
report done again; `report blocked` if something stops you.

### When something you need is not allowed (R51)

You will not usually notice this happening. When you call a tool no rule covers
— `mvn`, `npm`, anything outside what the project has granted — Claude Code
asks `approve` on your behalf, a person is shown the command, and your call
either goes ahead or comes back refused. From inside the session it looks like a
tool call that took a while.

Two things to do with the answer:

- **A refusal carries a reason.** Act on it. "Not from an unattended session" is
  something you can work with — report `blocked` saying what you needed, or find
  an approach that does not need it. Do not retry the same call hoping for a
  different person.
- **An expiry means nobody was there.** Do not loop. Report `blocked`, say
  exactly what you needed to run and why, and let somebody allow it and start
  you again.

## Checking it works

Two smoke tests, both driving the server over real stdio.



```sh
CAWDEV_URL=http://localhost:4200 CAWDEV_TOKEN=cawd_… node tools/mcp/smoke.mjs scratch-project
```

**Name a scratch project.** The smoke test creates a roadmap card and declines
it, and cards cannot be deleted — so it refuses to guess which project you
meant. It left two declined cards in cawdev's own roadmap before it did.

It drives the server the way a client does — spawn, write lines to stdin, read
lines from stdout — rather than importing its functions, because the parts most
likely to break are the transport and the framing. CI runs it against the
compose stack.

The orchestration tools, including the case R10 exists for — the agent blocks
on `ask_user`, something else answers, and the tool call returns the answer:

```sh
node tools/mcp/orchestration-smoke.mjs scratch-project
```

It starts a real run (which needs a session, since an agent cannot start another
agent), drives it through a runner, and exercises the pending path on a
shortened `CAWDEV_ASK_TIMEOUT_SECONDS`.

A single call, by hand:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"roadmap_where","arguments":{}}}' \
  | CAWDEV_TOKEN=cawd_… node tools/mcp/server.mjs
```
