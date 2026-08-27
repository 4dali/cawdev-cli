# cawdev MCP server

One file of plain Node, zero dependencies, stdio JSON-RPC. It gives a coding
agent a project's roadmap and changelog — the same verbs a person gets in the
console, because the API was built to mirror these tools one-for-one.

## Setting it up in a repository

Mint a token in the cawdev console under **Agent tokens**. Grant it
`roadmap:write` and `changelog:write` on the project. **You can only grant what
you hold** — if you are a `READER` there, you get read scopes.

Then in the repository the agent works in, add `.mcp.json`:

```json
{
  "mcpServers": {
    "cawdev": {
      "command": "node",
      "args": ["/path/to/cawdev/tools/mcp/server.mjs"],
      "env": {
        "CAWDEV_URL": "http://localhost:8091",
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

1. Branch off an up-to-date `main`, named after the entry — `r4-roadmap-entries`.
2. **Move the entry to `CODING` naming the branch, before your first commit**
   (`roadmap_set_status`). Not after. The roadmap should be able to answer
   "what is being worked on right now" without asking anyone.
3. Build to the entry's "Done when" list.
4. Finish with a PR. Never push to `main`.

### What a status must carry

`roadmap_statuses` will tell you, and it is worth reading rather than guessing:
`CODING` needs a branch, `SHIPPED` needs a version that is a real git tag,
`DECLINED` needs a reason.

**Any status may move to any other.** There is no transition diagram — an entry
really can go from `CONSIDERING` straight to `SHIPPED` if that is what happened.
The rules are about what a status *carries*, not the path it took.

### There is no delete

Not in these tools, not in the API. `roadmap_decline` with a reason is the only
exit an entry has, and the reason is the point: it is what stops the same idea
being proposed again in six months. Same for changelog entries — correct the
text, do not remove the record.

### Ids are permanent

An entry's R-number never changes and is never reused. Commit messages and code
comments point at it.

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
| `roadmap_statuses` | The six statuses, what they mean, what each requires. |
| `roadmap_list` | Entries, optionally by status. `brief` omits bodies — use it to survey. |
| `roadmap_get` | One entry in full. |
| `roadmap_create` | Create an entry; the platform allocates its permanent number. |
| `roadmap_update` | Title, body, section, related ids. |
| `roadmap_set_status` | Move an entry, carrying whatever the status requires. |
| `roadmap_decline` | Decline with a reason. The only exit. |
| `changelog_list` | The changelog, grouped by release, newest first. |
| `changelog_get` | One entry. |
| `changelog_add` | Add an entry; no version means `Unreleased`. |
| `changelog_update` | Edit one, including moving it to a release when it ships. |

### Inside a run

These four only work when the token is a **run token** (`cawdr_`), which the
runner mints when a run starts and hands to the session it spawns. A plain
`cawd_` token gets a refusal saying so.

| Tool | What it does |
|---|---|
| `task_current` | The entry you are working on, its branch, and everything already said and asked on this run. **Call it first**, and again whenever you are unsure where you are. |
| `report` | `progress` as often as useful; `done` when finished, naming the branch and any PR; `blocked` when a person must resolve something. `done` and `blocked` end the run. |
| `ask_user` | Ask the person who started the run, and wait. Blocks up to ten minutes, then hands back a `question_id`. |
| `await_answer` | Resume waiting for a question `ask_user` handed back. |

**`ask_user` is for decisions that are genuinely theirs** — an architectural
choice, a trade-off with no right answer, something the entry does not settle.
Not for checking work you can check yourself. Every question stops the run and
costs somebody's attention.

When `ask_user` returns without an answer, **do not guess and carry on.** You
asked because the decision was not yours. Call `await_answer`, or `report`
`blocked` and stop.

After `report done` or `report blocked`, the run is over and your token has
expired with it. There is nothing further to do.

## Checking it works

Two smoke tests, both driving the server over real stdio.



```sh
CAWDEV_URL=http://localhost:8091 CAWDEV_TOKEN=cawd_… node tools/mcp/smoke.mjs scratch-project
```

**Name a scratch project.** The smoke test creates a roadmap entry and declines
it, and entries cannot be deleted — so it refuses to guess which project you
meant. It left two declined entries in cawdev's own roadmap before it did.

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
