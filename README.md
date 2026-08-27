# tools

Plain Node, **zero dependencies**, by design (see `CLAUDE.md`): stdio JSON-RPC
and spawning processes are Node's home turf, and a file with no dependencies is
one you can read before running it against your repositories.

Everything here reads `CAWDEV_URL`, `CAWDEV_TOKEN` and optionally
`CAWDEV_PROJECT` from the environment or a `.env` at the repository root —
**read on every call**, so editing `.env` needs no restart.

Mint a token in the console under **Agent tokens**. It needs `roadmap:write`
and `changelog:write` on the project you are exporting.

## The generated files

`ROADMAP.md` and `CHANGELOG.md` at the repository root are **exports**. Editing
them by hand is lost at the next export. Change the entry in the console or
through MCP, then regenerate:

```sh
node tools/roadmap/export.mjs cawdev
node tools/changelog/export.mjs cawdev
```

Both are byte-stable: the same data produces the same bytes, so a regenerated
file shows a diff only when the roadmap actually changed. CI proves
export → import → export is a fixed point.

## `tools/roadmap/import.mjs`

The one-time move from a hand-written `ROADMAP.md` into the platform, and the
other half of that fixed point.

```sh
node tools/roadmap/import.mjs cawdev --file ROADMAP.md
```

It is **idempotent enough to re-run after a partial failure**: entries that
already exist are updated rather than duplicated. It refuses to start when
preserving ids is impossible — ids are permanent, and silently renumbering them
would break every commit message that points at one.

## `roadmap.mjs` (repository root)

```sh
node roadmap.mjs           # shape: ids unique, statuses legal, required fields present
node roadmap.mjs --live    # also: SHIPPED versions are real tags, CODING branches exist
```

Both forms run in CI. The shape checks catch what a review forgets — an entry
that says `CODING` without naming a branch, a `Related:` pointing at nothing.
`--live` catches the claim a file cannot check about itself: that a version
someone wrote down was in fact tagged.

## Tests

```sh
node --test "tools/**/*.test.mjs"
```

`tools/lib/roadmap-format.test.mjs` covers the parse/render round trip. If those
two stop agreeing, the generated file churns on every export and its diff stops
meaning "the roadmap changed".

## `tools/mcp/`

The MCP server an agent talks to — one zero-dependency file, stdio JSON-RPC.
`tools/mcp/README.md` covers setting it up in a repository, and is also written
for the agent that reads it: it teaches the working method (branch first,
`CODING` names the branch before the first commit, `roadmap_where` when in
doubt).

`tools/mcp/smoke.mjs` drives the server the way a client does — spawn, write
lines to stdin, read lines from stdout — because the parts most likely to break
are the transport and the framing. CI runs it against the compose stack.

## Still to come

- `tools/runner/runner.mjs` — the runner daemon (R11)
