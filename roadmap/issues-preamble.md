# Issues

> **Generated. Do not edit.**
>
> This file is an export of cawdev's own `roadmap_entry` rows where the kind is
> `ISSUE` — cawdev is its own first project. A hand edit here is lost at the
> next export. Change the issue in the console, or through the MCP server, then
> regenerate:
>
> ```sh
> node tools/roadmap/export.mjs cawdev --issues
> ```

What is broken, and how badly. Issues share everything about a roadmap card
but its numbering: comments, history, sessions, and the development board a fix
runs on.

Two sequences, two prefixes — R221. Issues count on their own: `i1` is the
first issue filed, whatever the roadmap has reached, and `i91` and `R91` are
two cards. The ref — the prefix and the number together — is the identity, and
it is what names a card everywhere: in a `Related:` line, in a path, in a
branch name (`i91-…`). Issues filed before R221 keep the numbers they had on the
roadmap's sequence, which is why this file starts where it starts.

What is different is the question. The roadmap answers *what do we intend to
build*; this answers *what is wrong right now*. That is why they are two files
and two boards: an issue has a **severity** rather than a phase, it is
**triaged** before anybody works it, and it ends in a **resolution** — the fix
landed, or it won't be fixed and here is why.

| Status | Means | Must carry |
|---|---|---|
| `NEW` | Filed. Nobody has looked at it yet. | — |
| `CONFIRMED` | Real, and waiting for somebody to take it. | — |
| `IN DEVELOPMENT` | Somebody is fixing it, on a branch. | the branch |
| `RESOLVED` | The fix landed on the default branch. | the merge |
| `RELEASED` | The fix shipped. | a version that is a real git tag |
| `WON'T FIX` | Decided against. | **a reason** |

Sections here are derived from the status and never from a phase: a defect does
not belong to "Phase 3", it belongs to open or fixed. Inside each section the
order is by severity, critical first, because that is the question this file is
read to answer.
