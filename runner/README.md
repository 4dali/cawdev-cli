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

When the platform stops honouring that session — it expired, you signed out in
the console, or your account went — the first request answered 401 says so
once, the footer pins `session expired — /login to sign in again`, and the
terminal drops to watching only until `/login` succeeds. The polls pick up again
on their own after it. In advanced mode `/login` stays in advanced mode: the URL
and the code are printed in the prompt window.

```
cawdev                    the runner here, starting one if there is none
cawdev --runner <name>    when this machine runs more than one
cawdev --url <url>        which cawdev to sign in to (or CAWDEV_URL)
cawdev --config <path>    the runner config to start a daemon from
cawdev --no-start         attach only; never launch a daemon
cawdev --watch-only       do not sign in; watch without being able to act
cawdev --leave-running    leave the daemon running when you quit
cawdev --version          this CLI's version, and the platform's
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

### `c`, `/config`, `cawdev config` — one change, not the whole walk

`cawdev --setup` (above) asks everything a fresh machine needs at once. Once a
machine is configured, most changes are smaller than that. **Inside the
terminal, press `c`** (or type `/config`): a picker over what this machine does
— add a project, add a workspace, each agent with its current state ("Disable
claude", "Enable codex"), the console-rules switch, **Stop serving** each
project, and the config itself with the token cut short. Every row is one of the shell commands below, driven through
the terminal's own line editor and picker; `esc` anywhere in a step changes
nothing. The screen edits the file the daemon says it booted from (the hello
carries `configPath` since R288), so an older daemon is told to restart rather
than guessed at, and adding a project asks for a `/login` first because it
widens the machine's token.

**Choosing where a checkout goes** (R289) is a picker before it is a line: the
folder beside the checkouts this machine already serves, the default
`~/cawdev/<slug>`, for a second workspace `<checkout>-2` — each row saying what
is there now ("new folder — will clone here", "already a checkout of cawdev",
"a checkout of …/else, not cawdev"). The last row opens a line **pre-filled**
with the first suggestion; `tab` completes directories from disk the way a
shell does, `~` expands, and a preview under the line says what the path is as
you type. Before anything is cloned the URL and the path are confirmed once; a
checkout of the same repository already at the path is taken as it is, with no
question; anything else that exists is refused in words. `paths.mjs` is that
logic, shared with the shell form below so the two doors agree. The shell form
is for scripts and for a machine with no daemon to attach to:

```
cawdev config                          a menu, the same Select widget as everywhere else
cawdev config add-project              serve one more project you can write to, or create one
cawdev config add-workspace            another checkout for a project already served
cawdev config remove-project <slug>    stop serving a project; its checkouts stay on disk
cawdev config agent enable|disable <claude|agy|codex>
cawdev config rules on|off             accept permission rules from the console — R126
cawdev config show                     this machine's config, token redacted
```

Every one of these writes `runner.config.json` and nothing else. Adding a
project widens the machine's existing `runner:operate` token in place
(`PUT /api/tokens/{id}/grants`) rather than minting a second one — the id
travels beside the secret since this card, and a machine set up before it
falls back to a lookup by label the first time this runs, after which it
remembers.

**Add a project lists what you can serve, and ends with "Create a new project on
cawdev".** The list is shown even when one project is left — the screen names
what it is about to clone. Creating asks for a name (the slug is cawdev's,
`<username>-<name>`, and is shown before anything is made), the git URL — blank
when the checkout is already on this machine, whose `origin` is then the
repository — and where the checkout goes. The clone happens first and the
project is created on cawdev (`POST /api/projects`) only after one last
confirmation, so a clone that fails leaves nothing on the platform. Then it is
served like any added project, and the rest of the console's setup walk —
rules, members, the CTO Interview — is linked at
`<url>/projects/<slug>/setup`.

**What takes effect when** (R294). Four settings a running daemon takes
without a restart — `agentCommands`, `grantable`, `acceptsRulesFromConsole`
and `autoWorkspaces`,
the `HOT_SWAPPABLE` list in `tools/lib/runner-config.mjs`, spelled once —
because the daemon reads them fresh on every use. Everything else in the file
(`projects` and their workspaces, `url`, `name`, the token, `browser`, the
tuning) is read once at boot. Every change made by either door ends the same
way: the running daemon is sent a `SIGHUP` (through the pid the hello names —
a unix convention asked of a process this operator already owns, not a command
over the control socket in `attach.mjs`, which is deliberately read-only), it
re-reads the file, applies what it can, and **says what it could not**: the
hello carries `restartNeeded`, the keys the file has moved on from since boot
that only a restart applies, and `configReadAt`. The door waits for that
re-read and repeats the daemon's own verdict — "applied, no restart needed",
or "needs a restart to pick up `projects` — q, then cawdev". A daemon too old
to answer gets the door's own reading of the same function.

While `restartNeeded` is non-empty the attached terminal pins a row in its
footer — `! config changed: projects — restart to apply (q, then cawdev)` — and
the `c` screen names what is in the file and not yet served ("serves cawdev ·
dycrypt after a restart", "cawdev: 1, 2 after a restart"). It is compared
against the file the daemon **booted** with, not the last one it read, so an
edit reverted by hand clears it. And it is off the file's own mtime, checked
on every heartbeat: a change made in an editor with nobody signalling anything
reaches the footer within thirty seconds. A notice, never a restart — the
daemon says, a person decides.

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
total — plus the run you are watching and the keys that
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
| `c` | configure this machine — the `cawdev config` menu, inside the terminal (R288) |
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
| `/config` | this machine's config — the same as `c` |
| `/cancel` | cancel the session you are watching |
| `/log` | the daemon's own log, on or off |
| `/quit` | leave |

**Typing `/` filters that list as you go**, each row with its description; arrows
and `enter` pick one and `tab` completes as far as the matches agree — then
moves down the list, so `/lo` `tab` `tab` reaches `/login` past `/log`. A name
typed in full is the first row, so `/log` `enter` runs `/log`. Advanced mode
draws the same list above its prompt, six rows at a time. Guessing a
command name and being told `no such command` is a step, and it is the step this
removes.

**`↑` recalls what you last sent**, kept in `~/.cawdev/history.json` at mode
`0600` and keyed by URL like the session beside it — so it survives quitting.
`/logout` forgets it along with the session.

**A paste stays one line.** Paste four hundred lines and the input shows
`[pasted, 342 lines]`; all of it is sent — into a prompt or into a command alike
(`/new plan <paste>`, `/card <paste>`), its line breaks kept (`commandWords`). A paste that scrolled the transcript
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
same endpoint the Waiting on you page and the run page post to: one record, the same
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

### Advanced mode: one window per session

`/advanced-mode` splits the terminal the way emacs does: **one window per
session** this machine is running — or ran since you attached — above **the
prompt, which stays at the bottom** the way a shell's does. Each window's title says what kind of
session it is (`plan`, `dev`, `review`, `ask`…), where it stands, the card and
the project, and its body is that session's output as it arrives. A frame's
colour is its session's state — **red while it runs, green once it finished**
(a plan planned, a dev developed), amber if it stopped any other way — and
the focused window is drawn in heavy lines; `tab` and `shift+tab` move the focus, `1`–`9`
jump to a window, and `enter` prompts the focused session exactly as it does
outside the mode. `/advanced-mode` again (or `/advanced-mode off`) leaves.

It is drawn on the terminal's **alternate screen**, like nano or emacs, and
holds still the way they do: auto-wrap is off, so nothing ever scrolls the
screen, and the wheel is sent to the program as arrow keys instead of sliding
the terminal up. The normal screen and its scrollback are exactly as you left
them — R81's reason
for printing into the scrollback still holds, and this mode is something you
ask for rather than the default. On the way out, what the watched session said
meanwhile is laid into the scrollback, so nothing was lost by watching it here.

**The PLANNED cards run across the top, grouped by project** — a line with
each project's name over its cards and a rule between two projects, every
project this machine serves included ("nothing planned" is an answer) — one
small box each, titled with the card and its status — `R3 (Planned)` — the cards of
every project this machine serves that are ready to be developed, read again
every thirty seconds. **`d`** lists them and develops the one you pick, on this
machine and on the card's own branch — except on a finished plan's window, where
it is that plan's `/develop` (below) with no list; `/new dev` with nothing after it does the
same anywhere, and `/new dev R3` goes straight to one. A full-width rule
under the strip separates the board from the session windows; it comes out of
the strip's own rows, never the windows'.

**`/refresh`** reads the cards again now rather than on the next tick, and
says what it found per project — `saasng: 5 considering · 2 planned · 1 in
development` — and which project could not be read, and why. A project that
cannot be read keeps its last cards and no other's: one unreadable slug used
to leave every column of every project at 0, silently.

**Four windows at most.** Past four, the rest are named on one line above the
prompt — number, kind, state, card, in the state's colour — and `tab` (or the
number) onto one brings it up in place of another. The focused session always
has a window, then the ones still running, then the ended ones, each most
recently looked at first.

A window stays up when its session ends, and its last line says what can be
done next:

- **`d`** or **`/develop`** on a finished plan — the window says `d develops R2
  here, in place of this plan` — starts the development of its card, on
  this machine (the branch is the card's own). `/develop R30` names another
  card, `@slug` its project, and `--codex`/`--claude`/`--agy` the agent —
  otherwise the agent that PLANNED the card when its finished plan has a
  window here, else `/agent`'s choice, exactly as `/new dev R30` does, because
  it IS that command. Once the development has started the plan's window
  closes, and the development's window takes its focus when this machine
  takes the run; a start the platform refused leaves the plan's window up.
- **`/pr`** on a finished session that wrote a branch opens its pull request
  (`POST runs/{id}/pull-request` — through the card's work item, or from the
  run itself for a session started from a sentence): this machine pushes the
  branch if origin does not have it and runs `gh pr create` (so `gh` has to be
  installed and signed in here). The POST answers with the workspace REQUEST,
  and the terminal follows it (`GET /api/runners/{id}/workspace-requests/{id}`)
  to its result: the URL — which the daemon confirms with `gh pr view` after
  `gh pr create`, so "made" is the host's word and not gh's — or why there is
  none, printed in full (no `gh` comes with its install line and the compare
  link to open it by hand). It watched the run's `prUrl` before, which a
  failure never writes, and said "asked for…" for as long as it was open.
  A checkout cloned on demand is served like any other: the set of paths a
  request may name is read per request, not taken at boot.
- **`/continue`** on a failed or stopped session is the console's *Carry on*,
  on this machine (`POST runs/{id}/carry-on` with this runner): the same run
  re-queued, its window coming back to life when the daemon takes it. A
  session that stopped BEFORE this terminal attached — the daemon forgets a
  run as it ends, so after a restart nothing here knew of it — is found on
  attach and on sign-in (`findStopped`: the first page of each served
  project's runs, kept when `carriesOnHere` — yours, `canCarryOn`, and its
  checkout on this machine or none), listed in the scrollback, and given a
  window that opens on why it stopped.
- **Finished, having built nothing** — a dev session that ended FINISHED
  with no commit (IMPLEMENT stopped on a plan it would not follow, say) —
  reads `finished · nothing built`, in amber rather than green, offers no
  `/pr` but the re-plan instead, and its window shows its summary, where it
  said why (`builtNothing`; the terminal reads the run's commits once it
  ends, and claims nothing until it has).
- **`/open`** opens the pull request in your browser. It reads the run again
  first — the runner records the link after the run is FINISHED, so the copy
  taken at that moment has none — and falls back to the card's work item.
  On a finished PLAN, which opens no pull request, it opens the card on cawdev
  instead — `roadmap/R2?show=plan` (`issues/…` for an issue) — with the plan
  of record unfolded and scrolled to: that plan is what the session produced.
- **`/drop`** deletes the checkout the session was cloned into, when it was one
  made on demand (below): asked first, naming the path, and refused while a
  run is in it or holds it, with uncommitted files, or with a commit origin
  does not have. The checkouts in the config are never offered — a project
  always keeps them.
- **`/close`** takes the window away.

**`/new`** starts a session from the prompt, aimed at this machine so its
window opens here: `/new plan R3`, `/new dev R3`, `/new ask <question>` — or a
task in words with no card: `/new plan add a CSV export of the invoices` writes
its card first and plans it (R150), and `/new dev fix the sort on the client
list` writes its card too (`cardTitleFor`: the sentence, cut between words
near a hundred characters, the whole text in the body) and then develops it
exactly as `/new dev R12` would — a number, a work item on the development
board, a branch of its own, and the card session's instruction to commit. It
was a manual session on a `task-…` branch with no card, which never reached
the board and was never told to commit. A card reference on its own is that card; anything
else is the task in words. **The project is always asked** — a list of what
this machine serves — unless the command names it with `@project`, or
advanced mode is narrowed to ONE project (`/projects`), which is a choice
already made rather than a guess. Never guessed from the focused window, nor
from a machine serving just one, since a session on the wrong project is a
card planned or a branch cut in the wrong repository. `/new dev` alone and `d` list the planned cards and the confirmed issues of every project,
each with its own, so they ask nothing more. A usage window over this machine's threshold is refused in a
sentence; `--anyway` starts it regardless, the same decision the console's
panel asks for. All four commands need you signed in (`/login`), and they work
outside advanced mode too, on the session you are watching.

**The prompt says which window it acts on.** In advanced mode the line at the
bottom leads with the focused window's number — `[2] cawdev ▸ /pr`, `[2]
enter prompts “…”` — and a command's answer keeps the number of the window it
was about (`[2] A session on … is running`), so a note left on screen after
the focus moved still says whose it was.

**A project deleted in the console is not offered.** The config on this
machine still names it, and nothing on the platform can change that file, so
the terminal asks: a served project whose roadmap read answers 404 — deleted,
or your access went — is left out of the picker, the strip, `/new` and `/card`,
and one line says so, once, after the mode is on screen. `c` → **Stop serving
ngsign** (`cawdev config remove-project ngsign`) takes it out of the config;
the checkouts stay where they are, and the daemon stops polling for it at its
next restart, because `projects` is read at boot.

**Which projects it shows is yours to pick.** `/advanced-mode` on a machine
serving several projects opens a picker with every one ticked — space (or a
digit) ticks and unticks, `a` all or none, enter confirms — and only the
projects ticked are drawn: their windows, their roadmap on top, and the ones
`/new` asks between. `/advanced-mode @saasng @ngsign` names them and asks
nothing; `/projects` asks again from inside the mode; `/reload` keeps the
pick. A prompt never talks to a session of a project that is not shown.

**↑ is history, as in a shell.** On a line nothing has been typed on yet —
empty, or the bare `/` a command line opens with — ↑ and ↓ walk what was
typed before (kept across launches, `history.mjs`); a command line walks only
the commands. Once something is typed, the arrows move in the list of
commands instead, and enter sends a recalled line as it is. Outside advanced
mode ↑ with no line open recalls the last entry onto the line it belongs to;
in advanced mode the wheel arrives as arrows, so there it is `/` or enter,
then ↑.

**`/view`** opens the focused session's page on cawdev — transcript, stages,
card — in the browser, on the console this terminal signed in to.

**On a session waiting for you** — a question, or a permission such as a stage
gate whose summary is the whole plan — the prompt only has room for the start
of it, and says so: `/view reads it all · /open answers it on cawdev`.
**`/view`** then opens the READER: one window over the whole screen with the
session's output and, under a rule, the request in full (the question and its
options; the permission's summary, its input and its keys). It opens on the
request; `↑`/`↓` (and the wheel), `PgUp`/`PgDn`, `g`/`G` scroll it, `esc`
closes it, and any other key closes it and does what it always does — `a`
answers, `y`/`s`/`n` decide. Outside advanced mode `/view` prints the request
whole into the scrollback. When the question has options its list opens by
itself and hides the banner; the list's own key line says `/view reads it all`,
and `/` there leaves the list for the command line (`a` brings it back).
**`/open`** opens the session's run page on cawdev,
where the question panel and the decision are. `readerFrame` in split.mjs is
the window, pure.

**`/view R29`** prints a card here instead: its status, section, tags, branch,
work item and pull request, who is coding or reviewing it, what it is related
to, its page on the web, and the first thirty lines of its body (`cardLines`,
pure). `/view <words>` finds it by its title among the cards of the projects on
screen and offers a list when several match; `@slug` names the project;
**`/view card`** is the focused session's own card.

**Which agent `/new` asks for.** `--claude`, `--codex` or `--agy` on a `/new`
names that session's agent (`/new dev R12 --codex`); `/agent codex` makes it
the terminal's choice for every `/new` after it, kept across launches
(`prefs.mjs`, `~/.cawdev/terminal.json`) and shown in advanced mode's prompt
title; `/agent default` hands the choice back to the project. A flag beats
`/agent`, and with neither nothing is named — the project's default decides,
as it always has. A name no runner spawns is refused, by `/agent` and by the
platform alike, rather than spawned as Claude Code; `/agent codex` on a
machine that does not list codex says so (`c` → Enable codex). The window's
`Codex · GPT-5-codex` line says which one actually ran.

**A stage asks rather than stops.** A decision that is the person's — a scope
the card leaves open, a plan the code has moved away from — is asked with
`ask_user`, and the stage carries on with the answer; PLAN asks before it
writes, so a plan never hands IMPLEMENT an open question, and IMPLEMENT asks
when its plan is wrong or incomplete instead of stopping (`ASK_DONT_STOP`).
Codex is given the time to: cawdev's MCP server gets `tool_timeout_sec` 660 on
its side, longer than `ask_user`'s ten-minute wait — Codex's own default of
60 s cut every question off before anybody could answer it.

**Codex and Antigravity write only on a machine that allows everything.**
Neither has per-command permissions — Codex's sandbox is read-only, blocks the
network (no push) or is off — so a session of theirs that writes is refused,
unspawned, until the machine accepts console rules AND "Allow everything" is
ticked on it. The refusal says so in steps, for this machine
(`needsEverything`, lib/agents.mjs): which of the two is done, the Runners page
on this console, the command to start it again — and it is written on the
run's transcript as well as its summary, so the window shows it; a failed
window prints its run's summary (`sayWhyItFailed`) rather than just "failed".

**`/card <the idea in words>`** writes a card in **Considering** and starts
nothing — no session, no branch, nothing spent: the roadmap's first column
is where an idea waits to be decided on, and writing one down does not need
a model. Titled by its words (`cardTitleFor`), the whole text in its body;
the project chosen exactly as `/new` chooses it (`@project`, else advanced
mode narrowed to one, else asked).

**Across the top, the roadmap** (`roadmapStrip`): every project this machine
serves as a small board — Considering, Planned and In development side by
side, one line per card, `●` on a card with a session running now; Merged,
Shipped and Declined — work that is over, and only grows — are counts beside
the project's name (`1 merged · 2 shipped`), as the console's board folds its
own last columns. The Backlog is a count there too, first (`3 backlog`): since
R371 it is where a new issue lands, and it would be the first column to go. **Issues are on it too** (R85's other board, read from
`/issues` beside `/roadmap`): a NEW issue sits in Considering and a CONFIRMED
one in Planned — their counterparts — first in the column and most severe first,
so a `+N more` never hides a critical defect, with the ref (`i12`) in the colour
of its severity. As tall as the fullest column, never more than a
third of the screen, and gone before the windows are on a short terminal.
When the room runs out it is SAID: a column ends in `+N more`, empty columns
go first when the width does, then whole columns (Considering, then Planned —
In development stays longest), named in the header as `considering 3
hidden`, then projects, counted as `+N projects`. Read every 30 s.

**A window says which agent and which model** — `Claude · Opus 5.5`,
`Codex · GPT-5-codex` — bold and underlined at the head of its second line
(`agentModelFor`, `modelLabel`). A live session's is the daemon's word, what
it actually spawned: the model asked for, replaced by the one Claude Code
announces on `init`, and per STAGE on a walked run, since each stage is its
own process. An ended one's is the platform's. No model named reads
`default model` — the CLI's own choice — rather than a guess.

**A window's project has a line of its own**, the second, under the title
(`subtitleFor`) — at the end of the title a long card name pushed it out of
sight. **A dev window adds where it is working**: the project and the absolute
path of the checkout — on a machine with `saasng` and its `-auto-N` clones, the
one directory to open. Cut from the left when narrow, so the end of the path
survives.

**The prompt shows what is open, not what was.** A question is the prompt's
banner alone, whole and wrapped between words, and it goes the moment it is
answered — here or in the console. A permission request's lines are tagged
with it (`sayAbout`) and leave when it is decided.

**A question says which window it came from.** With four sessions on screen,
"waiting for an answer" is not enough to know whose. A question or a
permission request names its session (`sessionTag`) — `2 · dev · R3 Client
mail… — saasng`: the window's number, its kind, its card and its project — in
the line announcing it, in the title of the picker that answers it, and above
the banner. The card is cut to 32 columns so the question itself still fits.

### Checkouts made on demand: `autoWorkspaces`

`"autoWorkspaces": 3` in the machine's config lets the daemon CLONE up to three
more checkouts of a project by itself, when a coding run would otherwise wait
for "no free workspace" — so `/new dev R4` starts while R3 is still being
developed. Absent or 0 is none, as it has always been. The clone sits beside
the project's first checkout as `<first>-auto-2`, `-auto-3`…; it is a local
clone of the first (no credential, no download) with `origin` put back to the
project's remote. Nothing is written to the config: the daemon finds these by
their name at boot and on SIGHUP, so deleting one — `/drop`, or by hand — is
the whole of removing it. A clone and not a `git worktree`, on purpose: the
daemon's reset checks the default branch out, which git refuses in a second
worktree. Changed without a restart, like `agentCommands`.

### Where a session with no branch reads: `<first>-read`

A plan, a verify or an ask cuts no branch and takes no checkout, so it used to
run in the project's first checkout **as that checkout happened to be** — on
whatever branch the last run left there. A cancelled CTO Interview left
`cto-interview` checked out, hundreds of commits behind, and every plan after
it read that code. Such a session now reads `<first>-read`, beside the first
checkout: a **detached `git worktree`** of it, brought to `origin/<default
branch>` at the start of a session whenever no other session is reading there.
The checkout itself is never moved, because a coding run may be working in it.
One per project rather than one per run, because the CLI keeps a resumable
conversation by its folder. Detached, so the default branch is never checked
out twice. If it cannot be made — no remote, not a repository — the session
reads the first checkout as before, and the log says why.

### `/reload`

Quitting and starting again, in one word — for when the client's code changed
on disk. The same command line runs again in a fresh process. When nothing is
running here the runner is stopped first (as `q` does), so the relaunch starts
it on the new code too; when sessions are live it is kept, and the terminal
says so — restarting it would end them. Under `runner.mjs --attach` the runner
is the terminal's own process, so `/reload` says to quit and start again.

It comes back **as you left it**: advanced mode if it was on, the same window
focused and the same session watched, the daemon's log shown or not, and the
windows of sessions that had ended — with their `/develop` and `/pr` — except
the ones you closed. The state travels to the new process in
`CAWDEV_RELOAD_STATE`, which that process reads once and removes, so nothing it
spawns inherits it.

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

How many coding runs go at once is the number of workspaces. A run that
waits now says **"no free workspace in cawdev (2 here, all busy)"** instead of
"that project already has a run here", which was a proxy for it.

**A free checkout with uncommitted work in it is not preferred over a clean
one** (R71/i258). A coding run with no pinned checkout and no free preferred
one now takes the first free checkout whose tree reads clean, checking each
free checkout in `workspaces` order until one does. It only falls back to a
free checkout somebody stranded work in — and today's *Start anyway* flow —
when every free checkout of that project is dirty; the log says so when it
happens. A *preferred* checkout (R212) is still taken whether it is clean or
not: it is the checkout the branch last ran in, so its uncommitted work is
plausibly that branch's own.

**Unless the run asked to wait for a clean one instead** (`waitForClean`,
R270). Then a preferred checkout is taken only when it reads clean, and when
nothing free reads clean the run is left queued — with a reason saying so —
rather than falling back to the first free checkout regardless. See "Prepares
the working copy" below for where that flag comes from and what the daemon
says about knowing it.

**This number caps coding and nothing else** (R70). `ASK`, `ROADMAP`, `AUDIT`
and `SCOPE` runs take no workspace, so a project whose checkouts are all busy
still starts a question, a card-writing run, an audit and a scoping
run at once. `INTERVIEW`, `MERGE`
and `RELEASE` do take one — each commits something — and count against this
number; what each may *write* in it is far narrower than a coding run's and is
decided by the profile, not by the prompt: an interview writes `docs/brief/`,
a merge writes the files git put conflict markers in, and a release (R187)
writes exactly the version files the platform names on the claim, with `git`,
`gh pr create`, `gh pr view` and `node` for the exports — no build tools, no
permission prompt, no `gh pr merge`. What holds a coding run back
is a free workspace, and the log says so (R109 removed `maxSessions`).

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

**A branch goes back where it was, until it does not have to** (R86, R212). A
branch's later runs are offered the checkout it last ran in; while that
checkout holds commits origin does not — or a failed run's tree — it is the
only answer and the run waits, saying so (*waiting for …, which is busy — the
branch has work only that checkout holds*). Once the last run pushed and
nothing is writing the branch, the platform only *prefers* it: a busy preferred
checkout means any free one, on this machine or another, and a stale local ref
is fast-forwarded to `origin` before the session starts.

**A cancelled run's uncommitted work is stashed if the person cancelling asked
for it** (R217). A cancelled run releases its checkout — nothing can come back
for it — so the run page, when the daemon's last look counted uncommitted
files, offers *Cancel and stash the changes* beside *Cancel, leave them in the
checkout*. The stash is this daemon's, taken in the child's close handler once
the agent process is dead and never a moment earlier: `git stash push
--include-untracked -m "cawdev: stashed when <run> was cancelled"`. The
transcript then ends with what was parked and the `git -C <path> stash pop`
that recovers it, or that there was nothing to park, or why it could not be —
never a second failure, since the run is already over. A run that took no
checkout of its own (an ASK standing in your working copy) is refused the
option by the platform.

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
checkouts** (`cawdev 1/2`), and the machine's total.
The gate, on screen, counting what it actually bounds — a question is in the
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
of **eleven** things to a checkout it serves. It said six for two entries, and
`HANDOFF` had been missing from the list since R148 — a table that quietly does
not describe one of the things a person can ask for is worse than no table. So
count the rows below against that number before you trust either. `CUT_BRANCH`
is the ninth, R260's; `OPEN_PR` the tenth, R261's, `CREATE_BRANCH` the eleventh, R379's.

| | |
|---|---|
| `SHOW` | `git status --porcelain`, the untracked list, and `git diff HEAD`. Reads only. |
| `STASH` | `git stash push --include-untracked`, and reports the ref to recover it by. |
| `COMMIT` | `git add -A` and commit. `--no-verify` is not passed — a repository's hooks are its own business. |
| `INDEX` | R77's map button: refreshes the code map, then builds the project's skill index if one is turned on. No session, no branch. |
| `RESET` | R87's start-over, and the destructive one: `reset --hard`, `clean -fd`, then back to `origin/<branch>` — or, for a branch never pushed, onto the default branch with the branch deleted. |
| `MERGE` | R134's Merge button on the development board: `gh pr merge <url> --squash --delete-branch` for the branch in `message`. The only kind whose effect is **not** in the checkout — it lands a branch on the host and touches no working tree, which is why several branches merge safely from one clone. The URL is reported on the result's first line, and the platform reads that line as the evidence to put on the card. **The platform hands a project's merges to machines one at a time, in the order they were asked for** (R188), so a claim may come back without a merge that is plainly queued — it is offered on a later poll, once the one ahead of it is over. **A claim with `mergeMethod: "MERGE_COMMIT"` runs `--merge` instead of `--squash`** — R261, and only a sprint's branch is asked for that way: nine card squashes onto it stay nine commits on the default. The second line of the result says which happened ("merged with a merge commit" / "squashed and merged"), and the platform quotes it on every card of the sprint — so a daemon older than R261, which squashes whatever the claim says, is noticed on nine cards rather than nowhere. Restart the daemon after updating. |
| `HANDOFF` | R148's hand-off, and the only kind addressed to a **run** rather than to a directory alone: the branch is pushed, whatever was uncommitted is packaged as a patch on its base sha, and the checkout is put back on the default branch. The next claim can then go to any machine. |
| `TAG` | R156's release: `git ls-remote --tags origin refs/tags/<version>` for the version in `message`. **The remote, not this clone** — a local tag nobody pushed is exactly the state a release is trying to rule out, and `git tag --list` cannot tell the two apart. A read; it fetches nothing and moves no ref. The sha is reported on the result's first line, the way `MERGE` reports its URL, because the platform will not confirm a release on `ok: true` alone. **A tag that is not there yet is `ok: false` with a sentence, and that is a normal answer** — the release procedure pushes the tag last, so the first check correctly finds nothing. Addressed to a **release** rather than to a directory alone, which is why it is asked for from the roadmap board and refused on this channel. |
| `CUT_BRANCH` | R260's sprint branch: `git push origin origin/<default>:refs/heads/<name>` for the branch in `message`, after a fetch — so the sprint's cards are cut from what everyone else has, not from whatever this checkout was left on. The second kind after `MERGE` whose effect is **not** in the checkout: the push names two refs and this clone's HEAD is not one of them, so any live checkout of the project will do and nothing local moves. **A branch already on origin is `ok: true`** ("already on origin at <sha>") — the sprint wanted one to exist, and one does. The sha is reported on the result's first line, the way `TAG` reports its. Addressed to a **sprint** and asked for from the sprint page by an OWNER, for `MERGE`'s reason — it reaches the remote — and refused on this channel. A `MERGE` of a card's pull request into a sprint branch still runs `--squash --delete-branch`: the card's branch goes, the sprint's stays. Landing the sprint branch itself is `OPEN_PR` then `MERGE` below. |
| `OPEN_PR` | R261's sprint merge, first half: `gh pr create --head <branch> --base <base> --title <title>` for the branch in `message` — the sprint's — to `baseBranch ?? defaultBranch`, titled as the claim's `title` (*S1 Notifications*). **An existing pull request is `ok: true` with its URL** — the same `gh pr view` lookup the `auto_pr` rule makes, and the reason the platform can ask this every time: it holds no git-host credential and cannot know whether one exists. The URL is reported on the result's first line, and the platform queues the `MERGE` to this same checkout when it reads one. Nothing is pushed: the branch is on origin already, cut there by `CUT_BRANCH` and merged into by every card. Addressed to a **work item** — the sprint's — and asked for by Merge on the development board or *Merge sprint* on the sprint page, by an OWNER; refused on this channel for `MERGE`'s reason. |
| `CREATE_BRANCH` | R379's New branch from the console: pushes `origin/<fromBranch>` to `refs/heads/<name>` for the name in `message`. Unlike `CUT_BRANCH` a name already on origin is a **refusal**, because the person asked for a new branch and the existing one may be somebody else's work. Touches no working tree; a daemon that knows the kind says `createBranch: true` in its hello. |

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

   **Base branches** (R260). The claim may also carry `baseBranch`: the
   branch of the sprint the card is in, copied onto the work item when it was
   opened. When it is there, cutting, the daemon's own merge-in (R155), the
   pull request's `--base` and the merge check's git fallback use it; a
   reset, the code map and the brief go on reading `defaultBranch`. When it
   is not — every run until a sprint has a branch — every git and `gh` call
   is byte for byte what it was. A base that is not on origin **fails the
   run** saying so, rather than falling back to the default under the
   sprint-branch's name. The daemon says `baseBranches: true` in its
   capabilities, and that key is how the platform knows not to offer a based
   run to an older daemon.
2. **Prepares the working copy**: fetch, then branch off the default — or
   off `origin/<baseBranch>` when the claim carried one.
   **A dirty tree stops it unless somebody said otherwise.** An agent let loose
   in a checkout with uncommitted work will at best confuse itself and at worst
   commit somebody's half-finished thoughts — so the console shows what is
   uncommitted before the run is started, and the decision arrives with the
   claim as `allowDirty`. Without it the runner still refuses, with the file
   list, and fails the run saying so: a run that arrives with no flag is one
   nobody was warned about. **Except when the dirt is the branch's own**: the
   platform NAMED the checkout (a carried-on run's held workspace, R80, or a
   pinned work item's next run, R86) and it is already on the run's branch.
   Then the work is kept and not cleaned — refusing it made every *Carry on*
   a second failure about work the run itself had written.

   **Or the run may have said, before it got this far, to wait instead**
   (`waitForClean`, R270) — the console's third way out of the dirty-checkout
   panel, alongside *Start anyway* and *Cancel*. That is decided earlier, in
   `pickWorkspace`, at poll time: with `waitForClean` set, the preferred
   checkout is taken only when it reads clean, and when nothing free reads
   clean the run is left queued with a reason rather than claimed at all — so
   by the time a claim reaches this step, the checkout it names is already
   clean and this whole paragraph does not apply. The daemon says
   `waitForClean: true` in its capabilities, the same way it says
   `baseBranches: true`, and an older daemon that does not is not offered such
   a run — the platform tells it apart rather than letting it take a dirty
   checkout the person explicitly asked it not to.

   With it, the edits are **carried onto the branch** — stashed, checked out,
   popped (R57). `git checkout` refuses outright when a locally modified file
   differs between the two commits, which is what made *Start anyway* fail one
   step later than the refusal it was meant to replace. If the pop cannot apply
   — the branch rewrote the same lines — the run fails **naming the stash and
   the command to recover it**, because work parked somewhere nobody was told
   about is work lost.

   **A refused move to RUNNING is never the run's failure** (i267). The move
   can be refused only when the platform no longer holds this claim: the run
   was cancelled while the checkout was prepared, or put back in the queue. The
   daemon then logs `the platform did not let this run start`, posts nothing,
   and leaves the run exactly as the platform has it; if it is QUEUED, the next
   poll offers it again and it is claimed properly. Only 400, 404, 409 and 410
   count as a refusal; any other status (401, 403, 408, 429), a network error or
   a 5xx still fails the run.
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
7b. **A stage is not done while its commands are still running.** A stage is
   one turn, closed the moment the turn ends, so a test suite started with
   `run_in_background` and never waited for is a result lost. The daemon
   follows the session's background shells (`lib/background-shells.mjs`:
   `Bash` with `run_in_background`, `BashOutput`, `KillShell`); a stage whose
   turn ends with one still running, or finished and never read, is reported
   FAILED with the commands named, and the run fails with it — keeping its
   checkout and its session (R80), so **`/continue` picks it up**. Where it
   resumes is the platform's (R263: the claim's lifecycle starts at the first
   stage not DONE, with what the DONE ones said); what the daemon adds is WHY
   the stage stopped — the re-run is handed that and told to run its commands
   in the foreground. IMPLEMENT and TEST are also told up front to
   wait for every command, and TEST to commit — no stage after it writes code.
8. **Reports the lifecycle back** and, if the session dies without saying
   anything, ends the run rather than leaving it `RUNNING` forever.

   **What each stage used, and what the run used** (R76, R305). Every `result`
   event the CLI prints carries the process's cumulative token counts, and the
   daemon files two absolute readings off each: the *stage's* (`POST
   …/stages/{stage}/usage` — the stage's own processes, across its attempts,
   so a stage re-run after a refused gate keeps adding to the first attempt's
   total) and the *run's* (`POST …/usage`). Each stage is its own process
   counting from zero, so the daemon keeps the run's running total itself and
   adds each child's figure to it: **the run's total is the sum of its stages'
   processes**, and a resumed run starts from whatever the claim already
   carried. The platform keeps the larger reading on both, so a lost report is
   healed by the next one. Tokens, never money, and cache reads are not
   counted — `tools/lib/usage.mjs` says why. A daemon older than R305 reports
   the run and never a stage, and every stage after the first on a staged run
   was ignored as a reading that went backwards; restart the daemon to get
   the per-stage figures and the summed total.

Cancelling a run reaches the daemon on its next poll and takes down the child's
whole process group — an agent that started a build should not leave it running.

### Scanning every branch (R300)

A project with a `quality` block has its branch scanned with SonarQube
**after a coding run's TEST stage settles and before the next stage begins**,
on the tree the tests just ran against:

```json
"cawdev": {
  "workspaces": ["/Users/you/code/cawdev"],
  "quality": { "command": "sonar-scanner", "tokenEnv": "SONAR_TOKEN" }
}
```

Both keys have those defaults, so `"quality": {}` is enough. `cawdev config
quality on <slug>` writes the block (and `off` removes it), as does the
`c` screen inside the attached terminal. The block is read once at boot
like the rest of `projects`, so **restart the daemon** after adding or
changing it — the daemon says so itself when it is signalled.

**It is the daemon that scans, not the session.** The scanner is a subprocess
this process starts and nothing the spawned agent can call — a session that
reported its own gate could lie about it. It runs in the run's checkout with
the project's key and the branch's name from the claim
(`-Dsonar.projectKey=`, `-Dsonar.branch.name=`), the repository's own
`sonar-project.properties` for everything else, and a working directory in the
daemon's temp dir rather than `.scannerwork/` inside the checkout, which the
next reset would otherwise clean and the working-copy watcher report. Then it
waits for the server to finish the analysis, reads the branch's quality gate
and its new-code measures, and tells the platform:
`POST /api/runners/{id}/quality/{slug}`, on the machine's `runner:operate`
token, the same door as the git survey. The run page and the development
board show the result — *Quality gate: failed · 3 new problems · Open in
SonarQube* — found by the branch's name.

**The token stays on this machine.** `tokenEnv` names the environment variable
the daemon reads the scanner token from — export it where the daemon runs;
it is never written to the config file, never sent to the platform, and goes
to the scanner in its environment, never on its command line. It is **not**
the token the project's owner entered under the project's Settings →
SonarQube: that one is the platform's reader credential and never leaves the
platform. Two credentials, two custodians. The scanner has to read
`SONAR_TOKEN` from its environment, which `sonar-scanner` does from 4.7 on;
older scanners want `-Dsonar.login`, which would put the token in `ps`, so
this daemon does not offer it. The block may also name `url`, for a machine
that reaches the server by another name than the platform does (a LAN
hostname), and `timeoutSeconds` (600) bounding the scan and the wait.

**Community Edition.** A server that refuses `sonar.branch.name` — every
Community Edition without the plugin below — is *skipped by default*: the
reading carries an error saying so, and nothing is analysed.
`"whenBranchesRefused"` in the block opts into one of two fallbacks; `skip`
stays the default and nothing opts in for you.

- `"main"` re-scans the branch as the project's **main** analysis and marks
  the reading `MAIN` with a warning. Understand what that trades: the
  project's own dashboard, and the platform's project reading with it, then
  describe whichever branch scanned last.
- `"project"` scans the branch as its **own scratch SonarQube project**
  instead — `<key>:branch:<branch>-<hash>`, overwritten on each run of the
  branch, and never touching the project's own dashboard. A fresh project has
  no new-code period, so "new" is redefined as *on a line this branch
  changed*; the reading is marked `PROJECT`, its gate is always `NONE`
  (nothing to gate a scratch project on), and there is no new-code coverage.
  This needs the scanner's token to hold **Create Projects** on the server —
  check its default project visibility too, since *public* would publish the
  code. cawdev never deletes these scratch projects; cleaning them up is the
  operator's own housekeeping.

The project itself can say which of these it needs: its Settings →
SonarQube card offers *Developer Edition or above (or Community with the
[sonarqube-community-branch-plugin](https://github.com/mc1arke/sonarqube-community-branch-plugin)
installed)*, *Community Edition*, or *Not sure — find out on the first scan*.
Set correctly, the daemon skips the doomed branch attempt and goes straight
to the chosen fallback; left at "not sure", behaviour is exactly as above.
**Restart the daemon after upgrading it to use `"project"`**: an older
runner does not know the value and refuses to boot with it in its config.

**A failed scan never fails a run.** A machine with no block scans nothing and
says nothing. A machine with a block and a project with no key logs `not
scanned` and reports nothing. Everything after that reports *something*: no
scanner on this machine, no token exported, no server, a server that refused —
each is an `error` reading with the sentence on it, so the run page says the
scan could not run rather than showing a branch nobody looked at, and the
run goes on to its next stage exactly as it would have. Only a staged run
with a TEST stage is scanned: a lifecycle without one, an unstaged run, a run
whose gate refused TEST twice or one that reported done inside TEST has no
settled TEST stage to scan after. The log line is
`quality: <branch> gate OK · 0 new problems`, or `quality: could not scan
<branch>: <why>`.

## A finished run is committed and pushed (R345)

Whatever the project's rules say, a coding run (`CODE`) reaches `FINISHED`
only with a clean checkout and its branch's commits on the remote. Two doors,
one check (`tools/lib/finish-check.mjs`):

- **`report done` refuses** while anything is left and tells the session what —
  the uncommitted files by name, the commits the remote has not seen — so the
  session that made them commits what belongs and pushes, in its own turn.
- **When the daemon ends the run** (the lifecycle's last stage, or a session
  that exited without reporting) it settles the branch itself: commits what is
  left as `<card>: what the session left uncommitted`, pushes without force,
  and says so in the summary. It does **not** commit anything that looks like a
  credential, and it does not win a push the remote refuses — either is a
  `FAILED` run with the reason in its summary and the checkout held, so
  *Carry on*, *Commit* or *Discard* decide, not the next run.

Before this, R325's run finished with a file modified and nothing pushed, and
the next run in that checkout refused to start on top of it. A checkout with no
remote commits what is left and asks nothing of a push.

## Git hosts: GitHub, GitLab and Bitbucket — and what the agent may push (R565)

Branches, pull requests and merges are opened **from cawdev** and performed by
this daemon, with credentials that live on this machine. The platform never
holds one. A project says which host it is on (`/projects/*/settings`, "Git
host"), or the daemon works it out from `origin`.

| Host | How the daemon talks to it |
|---|---|
| GitHub | `gh`, signed in (`gh auth login`) |
| GitLab | `glab`, signed in (`glab auth login --hostname <host>`) |
| Bitbucket Cloud (bitbucket.org) | its REST API, with a token this machine keeps |

Bitbucket Server / Data Center is not supported.

**Bitbucket's token** goes in the environment, and the config names the
variable — never the token itself:

```json
{
  "bitbucket": { "email": "you@example.com", "tokenEnv": "BITBUCKET_TOKEN" }
}
```

With `email`, the token is an Atlassian API token and is sent as Basic
`email:token`. Without it, it is a workspace or repository access token, sent
as a Bearer token. `tokenEnv` defaults to `BITBUCKET_TOKEN`. The daemon logs,
once at boot, where it reads the token from (or that it is missing). That
variable is **removed from the environment of every agent session** it starts;
`GH_TOKEN` and `GITLAB_TOKEN` are not, because `git push` may authenticate
through them.

**After updating, restart the daemon.** A daemon that predates this does not
advertise `bitbucket` in its `gitHosts`, and cawdev will not address a
Bitbucket project's pull request or merge to it: the button says "No machine of
yours runs a cawdev runner that speaks Bitbucket. Restart the daemon to update
it."

### What the agent may push

A coding session may commit on its card's branch and push **that branch and
nothing else**. For Claude Code the daemon passes a `PreToolUse` hook
(`push-guard.mjs`) and disallows `gh` and `glab`: a host CLI, a force, a delete,
`--mirror`, `--all`, a `+` refspec, or a push to any other branch is refused
with a reason the session reads. A release session may also push its own tag.

After **any** writing session, for Claude, Codex and Antigravity alike, the
daemon compares the remote with what it held before and, if the session pushed a
ref other than its branch, says so on the run: *"This session pushed `<ref>`,
which is outside its branch …"*. Deletions cannot be attributed to a session and
are not flagged.

**This is a guard against mistakes, not a security boundary.** An agent with a
shell and your credentials can get round a pattern match (`git -c alias.x='!…'`,
a host CLI called through a script). **The real wall is branch protection on the
host: protect the default branch and require a pull request.** Do that.

## What a project's rules can ask of it (R40)

A project may decide that a finished run **pushes its branch**, **opens a pull
request**, and — if somebody with `OWNER` deliberately turned it on — **merges
it with nobody reading the diff**. The rules are set in the console, ride along
with the claim, and the daemon logs them when it takes a run, so you find out
what is going to happen before it happens rather than afterwards. `auto_merge`
gets a shouted line of its own.

The daemon does not decide any of this. The platform queues `PUSH` and
`OPEN_PR` on the same `run_action` queue the console's *Commit* button uses,
and the daemon performs them in `settleActions` — one pass right after the
session ends, because the working-copy watcher stopped with the child and the
rules queue their work at exactly that moment. `auto_merge` is asked for
later, when the branch reaches Done on the development board (R306): the
platform queues a `MERGE` **workspace request** attributed to the rule —
`requestedByRule: "auto_merge"` on the claim — to the machine that wrote the
branch, and the daemon logs `MERGING <branch> — by auto_merge, nobody is
reading this diff` when it takes it. It is the same `gh pr merge` the board's
button runs. (A platform older than R306 still queues a `MERGE` run action,
and the daemon still performs it.)

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
  Before merging it asks `gh pr view --json mergeable,mergeStateStatus` and,
  while the host answers `UNKNOWN` — mergeability is computed lazily, and a
  merge seconds after `gh pr create` used to fail for no reason a person could
  act on — waits up to six times five seconds (R306). Any other answer merges
  at once; the merge is what says whether it could.

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
project while an agent is working in it. Nothing bounds a question, a roadmap session or an audit but the platform's
own queue: `maxSessions` was removed in R109, and the workspace gate above is
the only one.

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

### When the daemon itself was killed (R339)

A daemon that dies and is restarted — by systemd, by `cawdev`, by hand — comes
back with nothing in its hands, and the platform could only infer that five
minutes later, as "its runner is alive but stopped driving it". So the daemon
keeps a note of the runs it is driving (`~/.cawdev/driving/<runner id>.json`,
rewritten when the set changes), and on boot the next one reads it: every run
the dead daemon was driving that the platform still believes in is failed **at
once** as `DAEMON_RESTARTED`, with the old and new pids and where to look for the
cause. A session the old daemon left running is stopped first — only when its
pid still runs the command it was spawned with. The workspace is held exactly as
for a vanished runner, and a machine with **auto-resume** on carries such a run
on by itself **once**; a second restart on the same run waits for a person,
because a test suite that killed the daemon twice will kill it a third time.

The usual cause on a small Linux box is memory: the session runs a test suite,
the kernel's OOM killer picks the biggest process, and that is sometimes the
daemon. `journalctl -k | grep -i "killed process"` says so. Two fixes, both on
the machine:

- **`"sessionMemoryMax": "6G"`** in `runner.config.json` spawns each agent
  session under `systemd-run --scope -p MemoryMax=…` (a size systemd reads —
  `6G`, `512M`, `75%`). A session that blows through it is killed on its own,
  the ordinary "agent was terminated" failure, and the daemon stays up. Linux
  only, and it needs a systemd manager for the user (`loginctl enable-linger
  <user>` on a box with nobody logged in) or a daemon running as root; the
  daemon probes once at boot and says in its log whether it applied. Needs a
  restart to change.
- **Protect the daemon and give the box room**: in the daemon's systemd unit,
  `OOMScoreAdjust=-800` makes the kernel pick a test worker over the daemon;
  and add swap (`fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap
  /swapfile && swapon /swapfile`, plus its `/etc/fstab` line).

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

**The thresholds (R158) are set in the console, on the runners page, not in
`runner.config.json`.** *Stop claiming at %* pauses this machine when one of its
whole windows crosses the line, and *Ask before starting at %* makes a start
bound to it state the numbers first. There is nothing to configure here and
nothing to upgrade: the platform sets the same `paused` flag a person's click
sets, and this daemon already obeys it on the next beat.

**A queued run says why a paused machine leaves it queued (R571).** The daemon
logs and shows one of two lines, from `pause-note.mjs` (pure, tested):
`this machine is paused from the console (resume it on Settings → Machines, or
press c)` for a person's pause, and `cawdev paused this machine for usage: its
five-hour window is at 92%, back in 1h 20m — it resumes by itself` for the
platform's. The attached terminal's `c` menu has a **Pause this machine** /
**Resume this machine** row, which makes the first line's "press c" true: it
writes the platform through `POST /api/runners/{id}/pause` (`setPaused` in
`configure.mjs`), never the config file, and the daemon reads it off its next
heartbeat. A running daemon needs a **restart** to show these lines and to tell
attached terminals about a pause; an older one keeps saying *paused from the
console* and has no pause row in `c`.

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
  the entire loop is unreachable** — no reading the task, no moving the card,
  no reporting, no asking. A real session found this by being denied
  `task_current` and stopping rather than guessing, which was the right call
  and a good sign for the prompt.

They are named explicitly rather than reached with `bypassPermissions`, because
nothing here should imply the agent may run arbitrary commands.

Both lines above are the **coding** defaults, and only a session that writes
code is spawned with them. A profile that does not — `ASK`, `PLAN`, `REVIEW`,
`AUDIT`, `SCOPE` (R227 — an audit's list, name for name, with a prompt that
asks it to cut an idea into cards rather than to look for what is wrong), and
the rest — and a read-only stage of a coding run — `PLAN`,
`VERIFY`, `MEMORY` — get their own `--allowedTools` and neither a permission
mode nor a permission prompt: the list is the whole permission. That is what
makes "cannot write" true rather than asked for (`acceptEdits` on its own lets
a session write a file its list does not name), and it is why such a session
never asks you anything — an unlisted tool is refused, not raised (i138).

- `Bash(git *)` lets it commit. The prompt tells it to commit its work, so the
  default has to allow that — a default configuration that forbids what the
  default prompt asks for is a broken default. A real session wrote the file,
  could not commit, and reported `blocked`: correct behaviour, avoidable cause.

**Anything else stops and asks you** (R51). Rather than being denied in
silence, a session that needs `mvn` or `npm` posts a request that appears in
your Waiting on you page and on the run, and waits for an answer. Allow it once, or allow it
always here — which writes a rule on the project that every runner serving it
inherits.

Nobody answering is a decision too: after the project's wait — fifteen minutes
unless its Rules page says otherwise, and possibly never (R339) — the request
expires and the session is told to carry on without it. Allowing it later still
works: the grant lasts the rest of the run and the session is sent a message to
try again. A stage gate never expires.

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
roadmap card, which the agent reads for itself with `task_current` — putting it
in the prompt too would be a second copy that can disagree with the card.

### Codex CLI

`codex` in `agentCommands` (`cawdev config agent enable codex`) lets a run name
`codex` as its agent. It is spawned by `spawnCodex`, one `codex exec --json`
per turn like Antigravity, and every flag it is given is in
`../lib/codex.mjs` with what was checked against the real CLI (0.155). Sign in
once with `codex login`; the run uses that sign-in and **not** your
`~/.codex/config.toml` (`--ignore-user-config`, this CLI's `--setting-sources
''`), so a model or MCP server you configured for yourself does not reach it.

Codex has a sandbox the operating system enforces, and that decides what it
may do:

- **A run that must change nothing** — ASK, AUDIT, SCOPE, REVIEW, PLAN, and the
  PLAN, VERIFY and MEMORY stages of any run — gets `--sandbox read-only`. Its
  shell reads and cannot write, and it needs nothing from the machine. Only
  cawdev's server is attached, narrowed with `enabled_tools` to the list Claude
  Code would be handed, and no stage ever holds `report`.
- **A run that writes** — CODE, INTERVIEW, MERGE, RELEASE and their IMPLEMENT
  and TEST — must commit and push, which the sandbox refuses, and Codex has no
  allow-list for its shell. So it runs with
  `--dangerously-bypass-approvals-and-sandbox`, and **only on a machine that
  allows everything** (R126); anywhere else the run fails before anything is
  spawned, saying so.

Every MCP server is marked `default_tools_approval_mode = "approve"` — in `exec`
the approval policy is *never*, and without it every call to cawdev is refused.
The run's token reaches cawdev's server through `env_vars`, never the command
line, and is blanked for the model's own commands
(`shell_environment_policy.set`).

Not reached on Codex: experts (the session is told it cannot delegate), a
project's tool rules and R51's permission prompt (both are Claude Code's
`--allowedTools` grammar and its `approve` handler), the command half of R110's
shield (the transcript half — secrets taken out of a result — runs in the daemon
and applies), and live prompting (the process ends with its turn; a follow-up is
`codex exec resume`). Skills are inlined whole, as for Antigravity. No usage
windows are read: Codex has no `-p /usage`.
