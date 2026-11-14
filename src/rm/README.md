# tools rm

Safe delete for agents and people. It never deletes in place: each path is renamed into a trash folder (instant on
one volume), and a background drainer deletes the trash after a grace period, so `tools rm restore` can undo a
mistake. Preset folders (`node_modules`, `dist` and other build output) have a grace of 0 minutes by default, so the
drainer can delete them before you restore; pass `--keep 2h` when you may want one back. A table of rules decides each path. Build output, the session's own scratch and files, small temp files and
trusted folders go without asking. Anything else becomes a request that the user confirms with a command an agent
cannot run.

## Quick start

```bash
tools rm node_modules dist                     # delete what the rules allow; the rest becomes a request
tools rm -n ~/Projects/app/build               # dry run: verdict, size and rule per path, nothing moves
tools rm preset node_modules --in ~/Projects   # find and delete every node_modules folder under ~/Projects
tools rm trash                                 # what waits for the drain, with each batch's id tail
tools rm restore fc7b                          # undo a batch while it is in its grace period
tools rm requests                              # what agents asked the user to confirm
```

The user confirms a request with `tools rm approve <id>`. In Claude Code, run `! tools rm approve <id>` from the prompt.

## Commands

Every subcommand takes `-v, --verbose`, and `tools rm --readme` prints this page. A flag goes after the subcommand
name (`tools rm requests --json`). A delete flag typed before a subcommand (`tools rm -n preset all`) is refused with
exit 2: Commander once gave `-n` to the root there, and the run deleted for real.

A verb marked **(person)** is the user's. The shell guard blocks it in an agent's shell call, and the verb itself asks
a person, except `drain --now`, which for an agent drains only its own batches early (see
[How a person confirms](#how-a-person-confirms)).

### Delete

```bash
tools rm <paths...>                 # delete what the rules allow, move the rest aside and ask
tools rm --no-aside <paths...>      # ask, but leave what needs the user in place (--aside forces the move)
tools rm -n <paths...>              # dry run: one row per path (verdict, size, rule, where an ask goes), a summary
tools rm preset node_modules js-build [--in <dir>]   # find and delete the folders of these presets (or: all)
tools rm presets [--json]           # the folder kinds deleted without asking, with their state
```

The flags of a delete run (`tools rm <paths...>` and `tools rm preset`):

| Flag                | What it does                                                          |
|---------------------|-----------------------------------------------------------------------|
| `-n, --dry-run`     | show what each rule decides (and the sizes), move nothing             |
| `--json`            | print the result as JSON                                              |
| `--reason <text>`   | why, recorded with a request for the user                             |
| `--keep <duration>` | how long the trash keeps it before the drain (`30m`, `2h`, `1d`)      |
| `--now`             | no grace period: drain at once                                        |
| `--aside`           | move what needs the user aside, even for a person at a terminal       |
| `--no-aside`        | leave what needs the user where it is                                 |

`preset` also takes `--in <dir>` (the folder to search, default the current folder) and `--depth <n>` (how many
folder levels to search, default 8). An unknown preset id exits 1 and names the known ones. An opt-in preset that
is off counts as unknown too.

### Requests

```bash
tools rm requests [id]              # what agents asked the user to confirm (an id: that request in full)
tools rm request-root <dir> --reason "<why>"   # ask the user to trust a folder (--reason is required)
tools rm ask <id>                   # an agent opens the user's approval window (run it in the background)
tools rm deny <id>                  # close a request and put its aside paths back (an agent may cancel its own)
tools rm prune [-n] [--json]        # close the requests nobody can decide (every path gone, or in place past 24 h)
tools rm measure <id>               # measure a request's paths and save the sizes (tools rm starts it itself)

# (person)
tools rm approve <id>
tools rm approve <id> <id> ... [--session <id>] [--older 1d]   # several requests: one window, one person check
tools rm approve                    # on a terminal: tick requests, then approve, deny or close the gone ones
```

`requests` takes `--all`, `--json`, `--long`, `--paths`, `--session <id prefix>`, `--agent <name>` (`claude-code`,
`codex`, `grok`, `copilot` or `person`), `--project <name>`, `--older <duration>` and `--sort age|size`
([Reading the requests](#reading-the-requests)). `approve --session` and `approve --older` add every pending request
of that session, or older than that age, to the ids you name.

### Trash

```bash
tools rm trash [--sizes] [--json]   # what waits for the drain (--sizes walks the moved folders to measure them)
tools rm restore <batch|request> [paths...]   # undo, while the batch is in its grace period
tools rm drain                      # drain the due batches and sweep the requests a rule now covers

# (person)
tools rm drain --now                # every batch, also those still in their grace period
```

`restore` takes a batch id, the tail of one as `tools rm trash` prints it (`fc7b`, when only one batch ends with it),
or the id of an approved request (each of its batches still in the trash). Given paths, it restores only those
original paths. `drain --background` runs as the background drainer until the trash is empty and no request waits;
`tools rm` starts it by itself.

### Settings, roots and profiles

```bash
tools rm config [show] [--json]     # every setting, its default and where the value comes from
tools rm roots [list] [--json]      # the trusted roots
tools rm roots remove <dir>         # stop trusting a folder (no person check: it only narrows)
tools rm profiles [--json]          # settings per agent, session or project, and what applies to you

# (person)
tools rm config set <key> <value>   # change a setting (keys in Configuration below)
tools rm roots add <dir> [--note "<why>"]     # trust a folder: agents may delete anything inside it
tools rm profile set <name> --agent codex --ask-action request [...]
tools rm profile remove <name>
```

`config show --json` prints the saved file only. The plain view prints each setting with this caller's profiles
applied, the default, and where the value comes from (`default`, `file` or `profile <name>`).

### Audit log

```bash
tools rm log [--since 1d] [--agent codex] [--session <id>] [--each] [--by agent|session|day|rule|action]
```

`log` also takes `--action <list>` (a comma list: `move`, `aside`, `measure`, `return`, `drain`, `restore`, `refuse`,
`request`, `approve`, `deny`; the other actions of [The audit log](#the-audit-log) match too), `--path <text>` (entries
whose path contains it), `--limit <n>` (the newest n, default 50) and `--json`.

## How it works

### The rules

The first rule that answers decides.

1. **hard-deny** (refuse, no approval can override): a missing path, a path too close to the root of the disk, `/`,
   system folders, volume roots, the home folder and anything directly in it, the current folder and its parents,
   the trash itself, and protected paths (agent transcripts, the history index, keychains, Mail, Messages, iCloud and
   cloud folders; secrets in `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.password-store` and the GenesisTools
   vault and AI config; virtual-machine disks of OrbStack, Docker Desktop, colima, lima and minikube; plus `protect`
   in the config) and every folder that holds one.
2. **not-movable** (refuse): a path this user cannot rename, even with an administrator's help: an item of another
   user in a sticky folder that is not root's file below, or an item in a folder this user may not change. The move
   into the trash would fail, so no approval could carry it out. The approval window refuses such a path too.
   **needs-admin** (ask, right after it, macOS only): root's file in a sticky folder, such as a spindump file in
   `/private/var/tmp`. No rule allows it and it never moves aside. After a person approves it, the system asks once
   per approval for an administrator's password, `chown -h` gives the file (or symlink) to this user, and the normal
   verified rename takes it to the trash; a restore puts it back owned by this user. A folder, a file with more than
   one hard link, and a file with a folder above it that this user could swap stay `not-movable`: the password typed
   for one file must never hand over another. Delete those with `sudo` yourself.
3. **aside-pending** (refuse): a path that is, holds, or sits in an aside folder whose request still waits. The
   aside folder lives in the session's scratch, so without this rule the scratch rule would let the agent delete it.
4. **registered-worktree** (refuse): a linked worktree git still lists. Use `git worktree remove`, which refuses
   uncommitted work.
5. **nested-work** (refuse or ask): a folder that holds a linked worktree git still lists is refused, and one that
   holds a clone with uncommitted changes or commits on no remote asks, even in the session's scratch.
6. **git-history** (ask): a `.git` folder or anything inside it, even in the session's scratch: its history and
   unpushed commits go with it.
7. **git-tracked** (ask): files git tracks. Prefer `git rm`.
8. **unsaved-clone** (ask): a clone with uncommitted changes or commits on no remote.
9. **session-scratch** (allow): inside the calling session's `/tmp/cc/<project>/<session id>/` (or the agent's own
   folder, such as `/tmp/codex/<project>/<session id>/`). The folder must be named with the FULL session id: the
   SessionStart hook of the genesis-tools plugin prints it. On 2026-11-01, four of 24 requests (395 MB) came from
   scratch folders named with the 8-character prefix. A profile can turn the rule off (`allowSessionScratch`).
10. **own-files** (allow): a file the calling session wrote that git does not track: with the Write, Edit or
    NotebookEdit tool (Claude's modified-file journal), or with a Bash command (the agents change log,
    `~/.genesis-tools/agents/<session>/changes.jsonl`, any harness). A Bash file counts only when it was born while
    that command ran (between the start the row records and the row itself), so a file the command only changed, or
    moved in (`mv ~/x ./y` keeps its birthtime), never does. A row written before 2026-11-02 records no start and
    counts for nothing. Only the last 8 MB of the log are read. A profile can turn it off (`allowOwnFiles`), or only
    the Bash part (`ownFilesFromBash`, `own-bash-files`).
11. **git-untracked** (ask): untracked files git does not ignore, which may be new work.
12. **tmp-small** (allow): a path in `/tmp` or the per-user temp folder (`getconf DARWIN_USER_TEMP_DIR`, never
    `$TMPDIR`) of at most `tmpSmallMB` (default 10, `tmp-small-mb`; 0 turns it off), with no socket and no repository
    with unsaved work anywhere inside. The rules above already asked for tracked and new work. A scratch root and a
    project folder under it never match, nor the system's folders at the top of a temp root (`com.apple.*`, `tmux-*`,
    `GenesisTools`, ...). Another session's `/tmp/<agent dir>/<project>/<session>` scratch matches only once that
    session ended: the Claude session registry does not list it (an unreadable registry counts as live) and nothing
    inside changed for 12 hours. The reason names the conditions: `/tmp path, 284 KB under 10 MB, not git-tracked,
    no unsaved repo inside`. A folder of `tmpSmallExcluded` (default `["/tmp/removable"]`; `tmp-small-exclude <dir>`
    adds one, `tmp-small-include <dir>` takes it out) never matches, whatever its size, and neither does anything in
    it or a folder that holds it. It is a staging area the person reviews, such as the
    `/tmp/removable/disk-reclaim-<ts>/` folders a disk reclaim leaves. `tools rm` of one from an agent opens a
    request, the default rule's reason says `inside /tmp/removable, a staging area for the user's review: tmp-small
    never deletes there (tmp-small-exclude)`, and `tools rm ask <id>` opens it for the person.
13. **nested-repos** (ask): a folder that holds git repositories.
14. **preset** (allow): a folder a build or install recreates, next to the file that proves it: `node_modules` next to
    `package.json`, `dist`/`build`/`.next`/`.turbo`/... next to `package.json`, `.build` next to `Package.swift`,
    `target` next to `Cargo.toml`, Gradle and CMake output, Python caches, Pods, Xcode DerivedData and more. The ids:
    `node_modules`, `js-build`, `node-cache`, `swiftpm`, `xcode-derived-data`, `cocoapods`, `rust`, `gradle`,
    `python`, `cmake`, `zig`, `dotnet`, plus the [opt-in cache presets](#opt-in-cache-presets).
15. **root** (allow): inside a folder the user trusts (`tools rm roots add`). A root the approval window remembered
    for "this session, this folder" counts only for that session and for 8 hours (`session`, `expiresAt`).
16. **default** (ask).

A person at a terminal (not inside an agent) is asked to confirm an ask at once, in the same approval window, instead
of getting a request. A path the person does not tick stays, and the run exits 1.

### Aside: out of the agent's way until the user decides

With `askAction` `aside` (the default) a path that needs the user is renamed into
`/tmp/<agent dir>/<project>/<session>/rm-aside/<batch>/` (`cc` for Claude Code, `codex`, `grok`, `copilot`, `agents`
for any other), and the request names where each one waits. `tools rm approve <id>` moves the aside copies into the
trash; `tools rm deny <id>` moves them back. An aside request never expires, and `tools rm requests <id>` shows where
each path waits.

- Unsaved work stays in place with a plain request: a `.git` folder, tracked files with uncommitted edits, untracked
  files, clones with unpushed work and folders holding repositories, whichever rule asked. /tmp is cleared on a
  reboot, and that work exists nowhere else. A profile (or `aside-unsaved yes`) moves it aside too.
- A path on another volume stays in place: a rename across volumes would be a copy.
- `--no-aside` leaves a run's paths in place; `--aside` moves them even for a person at a terminal.

**macOS tmp_cleaner.** Every day (at midnight, or on a wake after a missed run) macOS deletes each regular file in /tmp
whose access, modification and change times are all older than 3 days, and each empty folder older than 3 days. A
rename keeps the times inside a moved folder, so an aside copy or a trash item of old files could go at the next run,
before a person decides. A move does not walk the tree, so a large folder never holds the run. The drainer that
every move starts refreshes
the batches made in the last 15 minutes that restore can still bring back, and the request's measurement pass
(`tools rm measure <id>`) refreshes each aside copy seconds after the move. Each file gets access time now (its
modification time stays; a file read in the last 12 hours is skipped) and each empty folder gets both times now.
The daily pass repeats that for every pending request's aside copies and every trash batch `tools rm restore`
can still bring back: in its grace period, incomplete, or failed (a drain that could not delete it leaves it in the trash until
`drain --now`). The daily pass is the GenesisTools logger's once-a-day process (`src/utils/compress/daily-pass.ts`),
started by the first GenesisTools process of each local day.

### Reading the requests

`tools rm requests` prints one summary line (open requests, paths, the size set aside, the paths in place, the oldest
age; all from the disk now, so a gone path is not in place and a lost copy is not aside), a `Needs a look` line, then
one group per asking session, newest first, with one row per request: id, age (yellow from a day, red from three
days), size, live state, a short path and why. The long reason and the aside location print only in the detail view:
`tools rm requests <id>`, or `--long` for every listed request.

The live state comes from the disk at the time of the listing, which reads only:

- `aside`: the path waits in this session's rm-aside folder; `in place`: it waits where it was; `mixed`: both.
- `gone`: no path and no aside copy is left, so nothing is left to decide.
- `came back`: the original path exists again beside its aside copy.
- `copy lost`: the aside copy is gone: deleted outside `tools rm`, by macOS tmp_cleaner or a person. The listing
  explains it under the rows, and the detail view prints it in place of where the copy waited. `approve` prints each
  such path, logs it as `lost`, and decides the rest; a request with nothing else left closes as `gone`.

Filters: `--session <id prefix>`, `--agent <name>`, `--project <name>`, `--older 1d`. `--sort age|size` prints a flat
list instead of groups, `--paths` one row per path, `--all` also the closed requests. A closed one shows its status
(`approved`, `denied`, `expired`, `gone`; per path in `--paths` and the detail), and the summary counts it as closed,
never as something to look at. `--json` prints the saved requests as they are stored.

A request ends as `approved`, `denied`, `expired`, `gone` or `ruled`. An in-place request reads as `expired` 24 hours
after it was made; an aside request never expires. `tools rm prune` writes the two end states nobody can decide:
`gone` (no path and no aside copy is left) and `expired` (in place, past the 24 hours). It moves, restores and deletes
no file, writes one `close` line per request to the audit log, and leaves a request alone while an approval window
holds it. Any caller may run it; `-n` lists what would close. A `copy lost` or `came back` request stays open for a
person.

### A rule that covers a pending request

A request never waits for a path a rule covers now (a tmp-small path, a file a Bash command of the session made, a
folder the user trusted since). The sweep judges each pending delete request again as the session that asked (its
profiles, its scratch, its own files): a path still in place as it is, a copy set aside as its original path with the
copy's content, and only when the default rule asked for it. A covered path goes to the trash with that rule (and its
grace and restore), and the request records it under `ruled` with the rule's words, for example
`refused: rule tmp-small, /tmp path, 284 KB under 10 MB, not git-tracked, no unsaved repo inside; deleted without a
request`. A request with nothing left for a person closes as `ruled` (`decidedVia: rule tmp-small`); one with paths
left stays open with only those. The same sweep closes a request whose every path is gone as `gone`.

The sweep runs in the background drainer, at its start and every `sweep.everyMinutes` (default 5, `sweep-every`).
Every delete run (`tools rm <paths>`) and every approval starts the drainer while a request waits, and the drainer
stays `sweep.lingerMinutes` (default 60, `sweep-linger`) after the trash emptied while requests wait, so a covered
request closes within about 5 minutes of the last such run. `tools rm drain` runs it at once, and `approve` runs it
for its requests before a window opens. `tools rm requests` only reads: it marks a covered request
`<rule>: closes at the sweep` and names them in an `A rule covers:` line.

### How a person confirms

`approve`, `roots add`, `config set`, `profile set|remove` and `drain --now` need a person, in two layers:

- the shell guard rule `rm-user-verbs` (`tools agents hooks`) blocks them in an agent's shell call (Claude Code,
  Codex, Grok). The help of a verb (`tools rm approve --help`) passes, and for `tools rm approve <id>` the rule
  suggests `tools rm ask <id>`;
- the verb itself asks (`drain --now` does not ask: an agent's run drains early only its own session's batches).
  With GenesisTools.app installed, a window shows the paths and who asked, and "Approve with Touch ID" goes on only
  after Touch ID (or the account password). An agent can open the window but cannot touch the sensor. Without the
  app the platform's dialog asks, and only a click on Approve goes on. The default never takes a typed code:
  "outside an agent" is read from environment variables an agent can clear, and a terminal an agent fakes types a
  code as well as a person.

No person check runs as root. Under `sudo` the window and the dialog run as root too, so the system asks for the root
account's password ("System Administrator"), which the person does not have, and the files a decision writes into
`~/.genesis-tools` become root's (2026-11-14). The check says so before any prompt: run the verb without `sudo`. A
file only root may move asks for an administrator's password itself, after the approval (rule `needs-admin`).

The setting `approval` picks the way: `auto` (the default: Touch ID when the installed app offers it, else the
dialog), `touch-id` (refuse without the app) or `code` (never Touch ID: the typed code on a terminal outside an
agent, else the dialog). `tools rm config set approval code` asks the person the current way first. When the app's
window ends without an answer (a rebuild of the app replaced it), `tools rm` asks the app once more instead of
putting up the dialog as a second prompt.

The dialog is one entry per platform in `PERSON_DIALOGS` (`src/utils/rm/approval.ts`), each with Cancel (or No) as
the default button: `osascript` on macOS; `zenity --question`, else `kdialog --warningyesno`, on Linux with a display
(`DISPLAY` or `WAYLAND_DISPLAY`); a Windows Forms message box through `powershell -NoProfile -Command` on Windows
(the text goes in as base64, so a path is never read as PowerShell). Each program comes from its system folder only
(`DIALOG_PROGRAM_PATHS`: `/usr/bin/osascript`; `zenity` or `kdialog` in `/usr/bin` or `/bin`; PowerShell under
`C:\Windows` or `C:\Program Files`), owned by root and writable by nobody else, never from `PATH`, and it starts with
the display, home and language variables only: an agent's `PATH`, `LD_PRELOAD` or `GTK_MODULES` cannot put a fake
Approve in its place. With no dialog program `auto` refuses, since nothing there proves a person answered; the person
then accepts the typed code by writing `"approval": "code"` into `~/.genesis-tools/rm/config.json` by hand.

The typed code (a clack prompt through the `p` facade) is used only when the person set `approval: code` and runs
`approve` in a terminal outside an agent. The typed code and the dialog answer for all paths, to the trash, just this
once. The dialog shows 15 lines, so it refuses a longer request instead of hiding paths: use GenesisTools.app for
those.

#### `tools rm ask <id>`: an agent opens the window

`approve` is the person's verb (the shell guard blocks it for an agent and offers `ask`). `tools rm ask <id>` is the
agent's: it opens the same approval window for one of its delete requests, through the same steps as `approve` (the
sweep, the refusals, the recheck after the wait, deny and the ledger), and never approves by itself:

- The person check takes only the GenesisTools.app window or the platform's dialog, never a typed code. The window
  opens with Touch ID off and arms it when the person clicks "Approve with Touch ID…", so a touch meant for another
  prompt never approves it. The ledger's approve line says `person: { via, opened: "ask" }`.
- A request under `notify.askMinMB` (default 10, `ask-min-mb`; the sizes `approve` would show, an unmeasured one
  counted as 0) opens nothing: `ask` prints ``Request <id> is <size>, under the 10 MB set for agents: hand the user
  `! tools rm approve <id>` `` and exits 1. A root request is the person's to open the same way.
- With no way to ask (no window and no dialog program, or `approval: touch-id` without the app), it prints why and
  the hand-over line, and exits 1. A window nobody answered prints the hand-over line and exits 1 too.
- The window waits up to 180 s, so an agent runs `ask` in the background.

#### What the window can answer

The window answers more than allow or deny, and `approve` does what it picked:

- **rows**: only the ticked paths are approved; the unticked ones are put back from aside, and the request's
  `decided` record lists both. Another pending request that names an approved path is decided with it.
- **disposal**: "Move to the trash" keeps the items 10 minutes for `tools rm restore <request id>`; "Delete
  permanently" queues them with no grace and starts the drain.
- **remember**: "This session, this folder" trusts each item's folder for the asking session for 8 hours; "Always for
  this folder" trusts it for everyone (`tools rm roots` shows the scope).
- **deny**: a person's Deny closes the request and puts everything back. Its note is kept (`tools rm requests --all`)
  and printed to the same session the next time it asks to delete that path.

A new request from an agent reaches the person on its own: the setting `notify-on-request` picks `inbox` (the
default: a GenesisTools inbox message under the asking session), `notification` (a macOS notification) or `none`.
It posts at most once per asking session in 10 minutes and only names `tools rm approve <id>`; it never opens the
approval window by itself.

#### Several requests at once

`tools rm approve <id> <id> ...` (or `--session <id prefix>`, `--older 1d`) opens ONE window with the rows of all of
them and asks the person once. The set is fixed before the window opens, so a request an agent makes meanwhile never
rides along. A request open in another window, a root request, a request with nothing left and one whose denied
paths still wait aside to go home are left out with a line each. An in-place path two requests name is one row. A request that acts on
another copy of a path already in the window (an aside copy beside the live path) waits for a second window, oldest
request first, and is read again after the person answers the first. One whose path holds another object by then, or
that still waits after a window nobody answered, is left out with the `tools rm approve <ids>` command that decides
it, and the exit code is 1.

With no id, on a terminal outside an agent, `tools rm approve` opens a picker: tick requests, then approve them in
one window, deny them (another session's requests after one person check, with an optional note the agent reads), or
close the ticked ones nothing is left of. Inside an agent or without a terminal, `approve` with no id asks you to
name the ids and exits 1.

#### Sizes in the window

The window opens before any tree is walked. When `tools rm` opens a delete request it starts `tools rm measure <id>`
in the background, which saves each path's size, emptiness and file count to
`~/.genesis-tools/rm/requests/measured/<id>/` (one file per path) with the top path's mtime. `approve` shows a saved
size at once while that mtime is unchanged; a row without one says "Measuring…" until its size arrives (from the pass
that still runs, or walked by `approve` itself), and the total under the rows appears when every size is in. The git
facts follow the same way. The typed code prints the sizes as they come. Only the dialog (the fallback when
GenesisTools.app cannot ask) cannot change once it shows, so it lists only the sizes known when it opened.

### The trash and the drain

- Items go to `/tmp/GenesisTools/rm/<batch>/` (setting `trash-root`; it must contain a `GenesisTools` folder). A
  path on another volume goes to `<mount point>/.GenesisTools-rm/<batch>/`, so the move stays a rename.
- Each batch is recorded in `~/.genesis-tools/rm/batches/<id>.json` after every move, so a run that dies halfway
  leaves a record. Every action is a line in `~/.genesis-tools/rm/ledger.jsonl`.
- Grace: 0 minutes for preset folders, 5 for the calling session's own scratch, 60 for the rest (`grace-preset`,
  `grace-scratch`, `grace-other`, or `--keep 2h` / `--now` per run). The built-in `workers` profile gives Codex and
  Grok 240 minutes for the rest. The scratch grace is short because a full disk hid about 11 GB of session scratch
  in the trash for the hour of the other grace (2026-11-01). Until the grace ends, `tools rm restore <batch>` puts
  things back; `tools rm trash` prints each batch's id tail, which `restore` takes when only one batch ends with it.
- A permanent delete ("Delete permanently" in the window) runs in the background drainer and prints its batch id.
- An item the drain cannot delete (a folder without write permission, such as a Go module cache) gets a `fail` line in
  the ledger and stays in the trash, restorable; its batch is marked failed, and only `drain --now` tries it again, so
  the drainer neither loops nor tells twice. The person hears of it once per batch, the way `notify.onFailure` says
  (`inbox` default, `notification`, `none`; `notify-on-failure`).
- A run that died while it moved leaves an incomplete batch. Once its process is gone, the sweep finishes it: the
  items that reached the trash become a normal batch with the run's own grace (a `finish` ledger line), the planned
  items that never moved stay where they are.
- A claim, a lock or a journal names its process by pid; one whose pid now runs a process that started after the
  claim was made (a recycled pid) holds nothing.
- The drainer starts through a double fork, so it is a child of launchd before `tools rm` returns: an agent harness
  that kills its shell's process tree cannot stop it halfway. One drainer runs at a time
  (`~/.genesis-tools/rm/drainer.lock`). It deletes due batches in parallel, sleeps until the next one is due, and
  exits when the trash is empty. Every run also sweeps orphans: a trash folder with no record, and a claim whose
  process died.
- `tools rm drain --now` ends the grace period of every batch, so it is a person's command: the shell guard blocks
  it for an agent. An agent's run that gets past the guard drains early only the batches its own session made; a
  batch of another session, or one a person approved ("Move to the trash"), keeps its grace and its restore.
- An approved path the move cannot rename (EACCES, EPERM) stays where it is with a `refuse` line (`not-movable`); the
  other paths of the batch still move. So does a `needs-admin` file whose administrator prompt was cancelled. When a move stops halfway, what reached the trash counts as approved and the
  rest stays pending, and in a window of several requests one that fails is named and the others are still decided.
- The deletion code only deletes inside a trash root, at batch or item depth (`assertInsideTrash`), so a bug that
  builds a wrong path deletes nothing.

### A full disk

The daily pass keeps a reserve of `diskReserveMB` (default 128, `disk-reserve-mb`, 0 is off) in
`~/.genesis-tools/rm/disk-reserve.bin` while the disk has 2 GB to spare beside it. A `tools rm` run that finds under
64 MB free deletes the reserve before it writes anything, so its locks, records and ledger lines still fit, and says
so on stderr. On a full disk on 2026-11-05, `approve` failed with ENOSPC at its first lock file.

### The audit log

`~/.genesis-tools/rm/ledger.jsonl` holds one line per move, aside, return, drain, restore, refusal, request, decision,
root, profile and setting change. The actions are `move`, `aside`, `measure`, `return`, `drain`, `restore`, `refuse`,
`request`, `approve`, `deny`, `root-add`, `root-remove`, `profile-set`, `profile-remove`, `config-set`, `close`,
`lost`, `take-over` (an administrator gave root's file to this user for an approved move), `finish` and `fail`. Each
line carries the time, the folder, the path and where it went, the rule, the bytes
(moved: measured right after the rename; reclaimed: at the drain) and the caller: agent, session id and title, model,
project, and the operating-system user for a person. A line a person check decided also carries `person`
(`{ via, opened }`); `caller` stays the environment the command ran in, which is the agent's session when a person
types `! tools rm approve` inside it.

`tools rm log` prints the newest entries (local time) with filters: the caller once as a header, and one row per run
of entries that share action, batch and caller (`15:27 drain 13 items 4.9 MB batch …fc7b`; `--each` prints every
entry). A person reads as `person`; only `--json` carries the operating-system user.
`--by agent|session|day|rule|action` prints the totals moved, set aside and reclaimed, with the item, refusal and
request counts.

### Where the data lives

Paths starting `rm/` are under `~/.genesis-tools/`.

| Path                                         | What                                         |
|----------------------------------------------|----------------------------------------------|
| `rm/config.json`                             | settings, roots, profiles, custom presets    |
| `rm/ledger.jsonl`                            | the audit log                                |
| `rm/batches/<id>.json`                       | one record per trash batch                   |
| `rm/requests/`                               | the requests, and `measured/<id>/` sizes     |
| `rm/notify/<session>.json`                   | when this session's last notice went out     |
| `rm/drainer.lock`                            | the single drainer's lock                    |
| `rm/disk-reserve.bin`                        | the full-disk reserve                        |
| `/tmp/GenesisTools/rm/<batch>/`              | the trash (`trash-root`)                     |
| `<mount point>/.GenesisTools-rm/<batch>/`    | the trash for a path on another volume       |
| `/tmp/<agent dir>/<project>/<session>/rm-aside/` | the paths set aside until the user decides |

`tools rm` uses no online service and costs nothing. It runs git to read a path's state, GenesisTools.app for the
approval window and Touch ID, the platform's dialog program as the fallback, and the GenesisTools inbox
([tools question](../question/README.md)) or a macOS notification to tell the person.

## Configuration

`~/.genesis-tools/rm/config.json` holds the settings. Edit it with the commands above; `tools rm config` shows each
value, its default and where it comes from. The file may hold comments and trailing commas. A file that cannot be
read or does not validate stops every run (`rm: invalid safety config <path>; fix it before deleting`), so a broken
config never deletes with weaker rules.

| `config set` key       | config.json field     | Default                 |
|------------------------|-----------------------|-------------------------|
| `approval`             | `approval`            | `auto`                  |
| `notify-on-request`    | `notify.onRequest`    | `inbox`                 |
| `notify-on-failure`    | `notify.onFailure`    | `inbox`                 |
| `ask-min-mb`           | `notify.askMinMB`     | `10`                    |
| `ask-action`           | `askAction`           | `aside`                 |
| `aside-unsaved`        | `asideUnsaved`        | `no`                    |
| `session-scratch`      | `allowSessionScratch` | `yes`                   |
| `own-files`            | `allowOwnFiles`       | `yes`                   |
| `own-bash-files`       | `ownFilesFromBash`    | `yes`                   |
| `tmp-small-mb`         | `tmpSmallMB`          | `10` (0 is off)         |
| `tmp-small-exclude`    | `tmpSmallExcluded`    | `["/tmp/removable"]`    |
| `tmp-small-include`    | `tmpSmallExcluded`    | (takes a folder out)    |
| `grace-preset`         | `grace.presetMinutes` | `0`                     |
| `grace-scratch`        | `grace.scratchMinutes`| `5`                     |
| `grace-other`          | `grace.otherMinutes`  | `60`                    |
| `sweep-every`          | `sweep.everyMinutes`  | `5` (above 0)           |
| `sweep-linger`         | `sweep.lingerMinutes` | `60`                    |
| `disk-reserve-mb`      | `diskReserveMB`       | `128` (0 is off)        |
| `trash-root`           | `trashRoot`           | `/tmp/GenesisTools/rm`  |
| `disable-preset`       | `disabledPresets`     | `[]`                    |
| `enable-preset`        | `enabledPresets`      | `[]`                    |
| `disable-profile`      | `disabledProfiles`    | `[]`                    |
| `enable-profile`       | `disabledProfiles`    | (turns a built-in on)   |

Values: `yes`/`no` (also `true`, `on`, `1` and `false`, `off`, `0`); a duration in minutes, or `30m`, `2h`, `1d`; a
size in megabytes (`10`, `2.5`); an absolute folder for `tmp-small-exclude` and `tmp-small-include`; a preset id or a
built-in profile name. `trash-root` takes an absolute path with a `GenesisTools` folder in it, and it refuses to move
while the old trash still holds batches or leftover folders: restore what you want back, run `tools rm drain --now`,
then change it. A value the setting does not take is refused before anyone is asked.

The other fields: `roots` (`tools rm roots add|remove`), `protect` (extra paths no rule deletes, nor any folder that
holds one), `profiles` (`tools rm profile set|remove`) and `customPresets`
(`{ "id", "description", "names": ["*.cache"], "markers": ["package.json"] }`). A custom preset widens what agents
may delete, so add one by hand only.

### Profiles: settings per agent, session or project

`profiles` in the config, edited with `tools rm profile set|remove` (the user only). A profile has a `match` (agent,
session id prefix, project, folder; every field given must match, `person` matches a run outside any agent, and
`--agent` takes a comma list such as `codex,grok`) and overrides: `askAction`, `asideUnsaved`, `allowSessionScratch`,
`allowOwnFiles`, `ownFilesFromBash`, `tmpSmallMB`, `grace`, plus lists that add to the base config:
`disabledPresets`, `roots`, `protect`. Matching profiles apply in order. The trash root cannot be changed by a
profile, nor the person's own settings (`approval`, `notify`, `sweep`, `diskReserveMB`). `tools rm profiles` lists
them and prints the settings in force for the caller.

`profile set <name>` needs at least one of `--agent`, `--session`, `--project`, `--cwd <dir>` (runs in this folder or
below it); `config set` is the way to change everyone. Its other flags: `--ask-action aside|request`,
`--[no-]aside-unsaved`, `--[no-]session-scratch`, `--[no-]own-files`, `--[no-]own-bash-files`, `--tmp-small-mb <mb>`,
`--grace-preset`, `--grace-other`, `--grace-scratch <duration>`, `--disable-preset <ids...>`, `--root <dirs...>`,
`--protect <paths...>` and `--note <text>`. A profile with an existing name replaces it.

Two profiles ship built in and apply before your own (`tools rm config set disable-profile <name>` turns one off; a
profile of your own with the same name replaces it):

- `person`: a run outside any agent leaves what needs confirmation in place. You confirm by typing at a terminal, and
  no agent is in the way that an aside move would keep the paths from.
- `workers`: Codex and Grok, which often run as unsupervised workers, get a 4-hour undo window instead of 1 hour.

```bash
tools rm profile set codex-careful --agent codex --ask-action request --no-own-files
tools rm profile set web-repo --project web-app --protect ~/Projects/web-app/.env --grace-other 2h
tools rm profile set quiet-tmp --agent claude-code --tmp-small-mb 0 --no-own-bash-files --grace-scratch 30m
```

### Opt-in cache presets

These are safe to delete (the next install refills them), but another install or a running app may be reading one, so
each is off until `tools rm config set enable-preset <id>`: `bun-cache` (`~/.bun/install/cache`), `npm-cache`
(`~/.npm/_cacache`), `pnpm-store` (`~/Library/pnpm/store`), `yarn-cache` (`~/Library/Caches/Yarn`), `homebrew-cache`
(`~/Library/Caches/Homebrew`), and `user-caches` (each app's folder in `~/Library/Caches`; quit the app first).
`tools rm presets` marks them `opt-in`. While one is off, a folder it names needs the user and waits in place (never
aside), and the reason names the command that turns the preset on. Once it is on, this empties that cache:

```bash
tools rm preset bun-cache --in ~/.bun/install/cache
```

## For agents

- **Exit codes.** A delete run (`tools rm <paths...>`, `tools rm preset`): 0 done, 1 something was refused or a
  person kept it at the prompt, 3 a request waits for the user. A failed move (a disk or permission error) still opens
  the request for the asked paths before the run ends with that error. `request-root` exits 3, or 1 when the folder cannot
  be a root. **1 wins over 3**: a run that refused a path and also opened a request exits 1, so read the last line
  of the output (`rm request <id>: ...`), not the exit code alone. A delete flag before a
  subcommand exits 2. `ask` exits 1 when it opened nothing or when the answer was not an approval (a Deny too),
  `requests <id>` exits 1 for an unknown id, `restore` exits 1 when a tail matches several batches or an item stayed
  in the trash, `restore` exits 1 when an item stayed in
  the trash, `drain` exits 1 when an item could not be deleted, and `deny` exits 1 while a put-back still waits.
- **JSON.** `tools rm <paths...> --json` prints `{ items, batches: [{ id, drainAfter, items }], request,
  deniedBefore }`. With `-n`, `--json` prints an array instead, one object per path:
  `{ path, kind, verdict, rule, reason, preset, bytes, willAside, alsoIn }` (`alsoIn`: the pending requests that
  already name the path). `requests`, `trash`, `presets`, `roots list`, `profiles`, `config show`, `prune` and `log` take
  `--json` too.
- **The flow when a path needs the user.** The run prints the request id and exits 3. Its last line stands alone,
  because agents often keep only `| tail -1`: `rm request <id>: 1 path waits for the user. Do not run approve
  yourself. ...`. Run `tools rm ask <id>` in the background for a request of 10 MB or more, so the person sees the
  window; for a smaller one, or when `ask` exits 1, hand the user `! tools rm approve <id>`. Cancel your own with
  `tools rm deny <id>`. When the output was hidden (`>/dev/null 2>&1`), the genesis-tools PostToolUse hook repeats that
  line after the call, for requests of this session from the last 15 minutes. Never retry with plain `rm`: the shell
  guard rule `rm-use-tools-rm` blocks it and suggests
  the `tools rm` form.
- **Delete freely in your own scratch**: `/tmp/cc/<project>/<full session id>/` for Claude Code (the SessionStart hook
  prints the path), `/tmp/codex/<project>/<full session id>/` for Codex. A folder named with a short session id is
  not your scratch.
- **A person's verbs** (`approve`, `roots add`, `config set`, `profile set|remove`, `drain --now`) are blocked by the
  shell guard. `deny <id>` of your own request is yours to run.
- **From code**, delete through `@genesiscz/utils/rm` (`planRemoval()`, `moveToTrash()`, `kickDrainer()`,
  `drainDue()`, `restoreBatch()`), never `rmSync`. `tools video`, `tools meetings` and the screen recorder do, so their
  batches show in `tools rm trash` and restore the same way.

## Troubleshooting

- **`tools rm log` printed the audit log instead of deleting `./log`.** `tools rm -- log` does the same, because
  Commander still runs the subcommand after `--`. Write `tools rm ./log` (any path with a `/`). When a file with the
  subcommand's name is in the current folder, the subcommand prints one line on stderr that says so. A folder of that
  name gets no note (`~/.genesis-tools/rm` holds the `requests` store).
- **`-n, --json, ... must follow the subcommand`, exit 2.** A delete flag went before a subcommand name: write
  `tools rm preset all -n`, not `tools rm -n preset all`.
- **`rm: invalid safety config ...` or `cannot read safety config ...`.** Fix `~/.genesis-tools/rm/config.json`; no
  run deletes until it parses.
- **`ask` says the request is under the 10 MB set for agents.** That is `ask-min-mb`: hand the user
  `! tools rm approve <id>` instead.
- **`the dialog shows 15 lines and this needs N`.** Approve in the GenesisTools.app window, or type the code on a
  terminal with `approval` set to `code`.
- **`Request <id> is open in an approval window (pid N)`.** Another window holds the request. Answer that window.
- **`Request <id>: 1 denied path waits aside to go home`.** A deny found the path taken (or could not write its
  folder), and the path is free now. Run `tools rm deny <id>` to put the copy back. A denied path whose copy is gone
  since then has nothing to put back: `approve` reports it as `lost` and closes the request.
- **`Not confirmed: the person check does not run as root (sudo)`.** Run `tools rm approve` without `sudo`. Root's
  file in `/private/var/tmp` asks for an administrator's password after you approve it.
- **`refuse ...: only an administrator can move it, and the administrator's password was not given`.** The
  administrator prompt was cancelled; the file stays and the request stays pending. Approve it again.
- **`Not changing trash-root: the trash at ... still holds N batches`.** Restore what you want back, run
  `tools rm drain --now`, then set `trash-root` again.
- **A batch stays in `tools rm trash` after its grace.** The drain could not delete an item (a `fail` line in
  `tools rm log`); fix the permission, then `tools rm drain --now`, or restore it.
- **A request reads `copy lost`.** The aside copy was deleted outside `tools rm`. `approve` logs it as `lost` and
  decides the rest.
- **The disk is full.** `tools rm` releases its 128 MB reserve when under 64 MB is free and prints a yellow line; free
  space, and the daily pass makes the reserve again.

## Related

- [tools agents](../agents/README.md): the shell guard (`rm-user-verbs`, `rm-use-tools-rm`) and the Bash change log
  the own-files rule reads.
- [tools compress](../compress/README.md): the daily pass that refreshes aside copies against tmp_cleaner and keeps
  the disk reserve.
- [tools question](../question/README.md): the inbox a new request or a failed drain posts to.
- [tools macos](../macos/README.md): GenesisTools.app, which draws the approval window and asks for Touch ID.
- [tools du](../du/README.md): measure what a folder really takes before you delete it.
- [tools video](../video/README.md) and [tools meetings](../meetings/README.md): they delete through the same trash.
