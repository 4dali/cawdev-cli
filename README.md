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

### Where a section goes in the file

An entry's `section` is a planning decision and lives in the database. The
**order** the sections appear in is prose layout, and lives beside the exporter
as `SECTION_ORDER` in `tools/roadmap/export.mjs`. `Considering` and `Declined`
are not in that list: they are derived from status by `sectionOf`, and always
come last.

A section that is not in `SECTION_ORDER` is **appended, and named in the note
the exporter prints** under its per-status counts, along with the number of
entries it holds. It is a note rather than a failure — a new phase is
legitimate, and an exporter that refused one would block the release that
introduced it — but it should not arrive unannounced. Silence is how the list
fell three sections behind and `"Roadmap"`, the fallback for an entry with no
section of its own, became a junk drawer holding eight built features (R45).

When you see the note: add the section to `SECTION_ORDER` in the position it
should read in, or give those entries a section that is already there.

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
node roadmap.mjs --live    # also: SHIPPED versions are real tags, CODING branches
                           # exist, and the file matches the database
node roadmap.mjs --live --project cawdev   # when CAWDEV_PROJECT is not set
```

Both forms run in CI. The shape checks catch what a review forgets — an entry
that says `CODING` without naming a branch, an entry that says `MERGED` without
naming the merge, a `Related:` pointing at nothing. `--live` catches the claims a
file cannot check about itself: that a version someone wrote down was in fact
tagged, and that the file is still the export it says it is. A `MERGED` entry is
checked against neither tags nor branches, because its branch is meant to have
been deleted.

That last one re-runs `tools/roadmap/export.mjs` into a temporary file and
compares the bytes. It goes through the exporter rather than rendering a second
copy of it, so the two cannot drift apart. A difference fails and names the
entries — missing here, missing there, or changed — with the remedy. If every
entry agrees and the bytes still differ, the preamble or the section layout was
edited by hand.

It needs a `CAWDEV_TOKEN` and a project. Without them it prints a note saying it
was skipped and the git checks still run; a check that cannot answer says so
rather than passing (R41). If the token is set and the platform rejects it or is
down, that is not "cannot answer" — it fails, with the API's own message.

## Tests

```sh
node --test "tools/**/*.test.mjs"
```

`tools/lib/roadmap-format.test.mjs` covers the parse/render round trip. If those
two stop agreeing, the generated file churns on every export and its diff stops
meaning "the roadmap changed".

`tools/lib/usage.test.mjs` covers what a turn reports. One of its tests asserts
that **no dollar figure reaches a transcript**: the CLI quotes list prices, and
a subscription does not work that way.

## `tools/mcp/`

The MCP server an agent talks to — one zero-dependency file, stdio JSON-RPC.
`tools/mcp/README.md` covers setting it up in a repository, and is also written
for the agent that reads it: it teaches the working method (branch first,
`CODING` names the branch before the first commit, `roadmap_where` when in
doubt).

`tools/mcp/smoke.mjs` drives the server the way a client does — spawn, write
lines to stdin, read lines from stdout — because the parts most likely to break
are the transport and the framing. CI runs it against the compose stack.

## `tools/runner/`

The daemon that claims queued runs and spawns a real agent CLI in a working
copy. `tools/runner/README.md` covers running one.

## `tools/console/`

`console-smoke.mjs` is the end-to-end test for the console's half of the loop
(R12): start a run on an entry, watch the messages, answer the question from the
inbox, see the finish report carrying the branch — all over the endpoints the
browser calls, on a real session cookie. Point it at a **scratch project**: it
creates an entry, cancels any live run, and declines the entry afterwards.

```sh
node tools/console/console-smoke.mjs scratch
```

Unlike everything else here it signs in rather than using `CAWDEV_TOKEN`, because
starting a run and answering a question are both a *person's* acts — an agent
cannot do either, so the test cannot bootstrap itself from a token.
