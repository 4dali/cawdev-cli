# Roadmap

> **Generated. Do not edit.**
>
> This file is an export of cawdev's own `roadmap_entry` table — cawdev is its
> own first project. A hand edit here is lost at the next export. Change an
> entry in the console, or through the MCP server, then regenerate:
>
> ```sh
> node tools/roadmap/export.mjs cawdev
> ```

What we intend to build, what we decided not to build, and what already shipped.
cawdev is a standalone, self-hosted platform that manages the roadmap and
changelog of **multiple projects** (each on its own git repository), gives
**coding agents** access to both through MCP with user-minted tokens, and — in
phase 3 — lets a user **start a Claude Code session on a roadmap entry** from
the console, read the agent's reports, and answer its questions while it works.
It inherits its working method from the dycrypt project: docs-first,
SESSION-HANDOFF.md as the index, branch-then-PR, generated exports, CI checks
on the things reviews forget.

## Format

Every entry is a level-3 heading carrying a stable id, then a `Status:` line.
An entry may also carry `Related: R4, R7`, an `After: R12` line naming the
cards it starts coding after — a coding session on it waits in the queue until
each of those is MERGED or SHIPPED (R181) — and, depending on status, a
`Branch:` or `Merged:` line. Ids are permanent: renaming an entry is fine;
reusing or renumbering an id is not, because commits and code comments point at
it.

| Status | Requires | Means |
|---|---|---|
| `CONSIDERING` | — | Wanted, but the design is not settled. Open questions listed. |
| `PLANNED` | — | Agreed, specified enough to start, not started. |
| `IN PROGRESS` | — | Started: being designed or investigated. No branch yet. |
| `CODING` | a branch | A branch exists, and the entry names it. |
| `REVIEW` | — | Written, and waiting for somebody to read it. The session has ended; the branch, usually a pull request, is still there. |
| `MERGED` | the merge | Landed, waiting on a release. Names the PR, the merge commit or the sha. The branch may go. |
| `SHIPPED v0.2.0` | a version | Released. The version must be an existing git tag. |
| `DECLINED` | a reason | Decided against. The reason stays, so it is not re-proposed. |

**How work starts (the fixed sequence):** branch off an up-to-date `main`,
named after the entry (`r4-roadmap-entries`); move the entry to `CODING` naming
the branch — before the first commit; finish with a PR, which puts the entry in
`REVIEW`; move the entry to `MERGED` when that PR lands; never push work to
`main` directly. Every release updates both this roadmap and CHANGELOG.md.

As a session ends the platform moves the *branch* — the work item on the
development board — and not the card, which stays in development until its PR
lands. Where the project runs `require_review` the branch goes to `REVIEW` and
somebody is asked to read it; where it does not, the branch goes to `DONE`
marked as a finish nobody was asked about (R132), because no reviewer was
coming. Either way it happens once, and only out of `CODING`, so somebody who
moves it back to carry on working keeps it.

`roadmap.mjs` validates this file's shape on every push, and `--live` also
checks that every `SHIPPED` version is a real git tag and every `CODING` or
`REVIEW` branch exists in this clone. `MERGED` is checked against neither,
because its branch is meant to be gone.

## Decisions already made (do not relitigate without a reason)

- **Stack:** Spring Boot 4.1 on Java 21 for the API, Angular (latest stable)
  for the console, PostgreSQL 16, Flyway migrations. The MCP server and the
  runner daemon are **plain Node, zero dependencies** — stdio JSON-RPC and
  spawning `claude` are Node's home turf, and a zero-dep file is a file anyone
  can read.
- **One origin:** nginx serves the built Angular app and proxies `/api` to the
  backend, so cookies never cross origins.
- **Tenancy:** single schema, `project_id` foreign keys, membership checks on
  every query (see R18 for why not schema-per-project).
- **Agents run on the developer's machine** via a runner daemon that connects
  outbound (see R19 for why not server-side). It is the runner — not the
  spawned session — that reports what a run spent (R20), so an agent cannot
  understate its own usage.
- **Fail fast rather than start open:** no admin password on an empty database
  and the API refuses to boot. Secrets are gitignored (`.env`, `.secrets/`).
- **Touch the API, edit `openapi.yaml`** — a coverage test fails the build when
  the spec and the controllers disagree.
- **A token can only grant what its minter holds**, re-checked against the
  owner's current membership on every call.
