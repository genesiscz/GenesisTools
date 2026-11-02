# tools rm

Safe delete for agents and people. It never deletes in place: each path is renamed into a trash folder (instant on
one volume), and a background drainer deletes the trash. Rules decide what may go without asking. Anything else
becomes a request that the user confirms with a command an agent cannot run.

```bash
tools rm <paths...>                 # delete what the rules allow, move the rest aside and ask
tools rm --no-aside <paths...>      # ask, but leave what needs the user in place (--aside forces the move)
tools rm -n <paths...>              # dry run: one row per path (verdict, size, rule, where an ask goes), then a summary
tools rm preset node_modules js-build [--in <dir>]   # find and delete preset folders
tools rm presets                    # the folder kinds deleted without asking
tools rm trash                      # what waits for the drain (--sizes measures it)
tools rm restore <batch|request> [paths...] # undo, while the batch is in its grace period (a batch id tail such as fc7b; a request id: each of its batches)
tools rm drain [--now]              # drain due batches and sweep the requests now (--now, a person's: all batches)
tools rm requests [id]              # what agents asked the user to confirm (an id: that request in full)
tools rm request-root <dir> --reason "<why>"   # ask the user to trust a folder
tools rm deny <id>                  # close a request and put its aside paths back (an agent may cancel its own)
tools rm ask <id>                   # an agent opens the user's approval window for its request (run it in the background)
tools rm prune [-n]                 # close the requests nobody can decide (every path gone, or in place past 24 h)
tools rm measure <id>               # measure a request's paths and save the sizes (tools rm starts it in the background)
tools rm log [--since 1d] [--agent codex] [--session <id>] [--each] [--by agent|session|day|rule|action]   # audit log
tools rm profiles                   # settings per agent, session or project, and what applies to you

# The user only (an agent's shell call is blocked, and the verb asks a person):
tools rm approve <id>
tools rm approve <id> <id> ... [--session <id>] [--older 1d]   # several requests: one window, one person check
tools rm approve                    # on a terminal: tick requests, then approve, deny or close the gone ones
tools rm roots add <dir> [--note "<why>"]
tools rm config set <key> <value>   # approval, notify-on-request, notify-on-failure, ask-min-mb, ask-action, aside-unsaved,
                                    # session-scratch, own-files, own-bash-files, tmp-small-mb, tmp-small-exclude,
                                    # tmp-small-include, grace-preset, grace-other, grace-scratch, sweep-every,
                                    # sweep-linger, trash-root, disable-preset, enable-preset, disable-profile,
                                    # enable-profile
tools rm profile set <name> --agent codex --ask-action request [...]
tools rm profile remove <name>
```

Exit codes of a delete run (`tools rm <path> ...`): 0 done, 1 something was refused or a person kept it at the prompt,
3 a request waits for the user. A failed move (a disk or permission error) still opens the request for the asked paths
before the run ends with that error.

## The rules

The first rule that answers decides.

1. **hard-deny** (refuse, no approval can override): a missing path, `/`, system folders, volume roots, the home
   folder and anything directly in it, the current folder and its parents, the trash itself, and protected paths
   (agent transcripts, the history index, keychains, Mail, Messages, iCloud and cloud folders; secrets in `~/.ssh`,
   `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.password-store` and the GenesisTools vault and AI config; virtual-machine
   disks of OrbStack, Docker Desktop, colima, lima and minikube; plus `protect` in the config) and every folder that
   holds one.
2. **aside-pending** (refuse): a path that is, holds, or sits in an aside folder whose request still waits. The
   aside folder lives in the session's scratch, so without this rule the scratch rule would let the agent delete it.
3. **registered-worktree** (refuse): a linked worktree git still lists. Use `git worktree remove`, which refuses
   uncommitted work.
4. **nested-work** (refuse or ask): a folder that holds a linked worktree git still lists is refused, and one that
   holds a clone with uncommitted changes or commits on no remote asks, even in the session's scratch.
5. **git-history** (ask): a `.git` folder or anything inside it, even in the session's scratch: its history and
   unpushed commits go with it.
6. **git-tracked** (ask): files git tracks. Prefer `git rm`.
7. **unsaved-clone** (ask): a clone with uncommitted changes or commits on no remote.
8. **session-scratch** (allow): inside the calling session's `/tmp/cc/<project>/<session id>/` (or the agent's own
   folder, such as `/tmp/codex/...`). A profile can turn it off (`allowSessionScratch`).
9. **own-files** (allow): a file the calling session wrote that git does not track: with the Write, Edit or
   NotebookEdit tool (Claude's modified-file journal), or with a Bash command (the agents change log,
   `~/.genesis-tools/agents/<session>/changes.jsonl`, any harness). A Bash file counts only when it was born while
   that command ran (between the start the row records and the row itself), so a file the command only changed, or
   moved in (`mv ~/x ./y` keeps its birthtime), never does; a row written before 2026-11-02 records no start and
   counts for nothing. Only the last 8 MB of the log are read. A profile can turn it off (`allowOwnFiles`), or only
   the Bash part (`ownFilesFromBash`, `own-bash-files`).
10. **git-untracked** (ask): untracked files git does not ignore, which may be new work.
11. **tmp-small** (allow): a path in `/tmp` or the per-user temp folder (`getconf DARWIN_USER_TEMP_DIR`, never
   `$TMPDIR`) of at most `tmpSmallMB` (default 10, `tmp-small-mb`; 0 turns it off), with no socket and no repository
   with unsaved work anywhere inside. The rules above already asked for tracked and new work. A scratch root and a
   project folder under it never match, nor the system's folders at the top of a temp root (`com.apple.*`, `tmux-*`,
   `GenesisTools`, ...). Another session's `/tmp/<agent dir>/<project>/<session>` scratch matches only once that
   session ended: the Claude session registry does not list it (an unreadable registry counts as live) and nothing
   inside changed for 12 hours. The reason names the conditions: `/tmp path, 284 KB under 10 MB, not git-tracked,
   no unsaved repo inside`. A folder of `tmpSmallExcluded` (default `["/tmp/removable"]`; `tmp-small-exclude <dir>`
   adds one, `tmp-small-include <dir>` takes it out) never matches, whatever its size, and neither does anything in
   it or a folder that holds it: it is a staging area the person reviews, such as the
   `/tmp/removable/disk-reclaim-<ts>/` folders a disk reclaim leaves. `tools rm` of one
   from an agent opens a request, the default rule's reason says `inside /tmp/removable, a staging area for the
   user's review: tmp-small never deletes there (tmp-small-exclude)`, and `tools rm ask <id>` opens it for the person.
12. **nested-repos** (ask): a folder that holds git repositories.
13. **preset** (allow): a folder a build or install recreates, next to the file that proves it: `node_modules` next to
   `package.json`, `dist`/`build`/`.next`/`.turbo`/... next to `package.json`, `.build` next to `Package.swift`,
   `target` next to `Cargo.toml`, Gradle and CMake output, Python caches, Pods, Xcode DerivedData and more.
14. **root** (allow): inside a folder the user trusts (`tools rm roots add`). A root the approval window remembered
   for "this session, this folder" counts only for that session and for 8 hours (`session`, `expiresAt`).
15. **default** (ask).

A person at a terminal (not inside an agent) is asked to confirm an ask at once (see below) instead of a request.

## Aside: out of the agent's way until the user decides

With `askAction` `aside` (the default) a path that needs the user is renamed into
`/tmp/<agent dir>/<project>/<session>/rm-aside/<batch>/` (`cc` for Claude Code, `codex`, `grok`, ...), and the request
names where each one waits. `tools rm approve <id>` moves the aside copies into the trash; `tools rm deny <id>` moves
them back. An aside request never expires, and `tools rm requests <id>` shows where each path waits.

- Unsaved work stays in place with a plain request: a `.git` folder, tracked files with uncommitted edits, untracked
  files, clones with unpushed work and folders holding repositories, whichever rule asked. /tmp is cleared on a
  reboot, and that work exists nowhere else. A profile (or `aside-unsaved yes`) moves it aside too.
- A path on another volume stays in place: a rename across volumes would be a copy.
- `--no-aside` leaves a run's paths in place; `--aside` moves them even for a person at a terminal.

**macOS tmp_cleaner.** Every day (at midnight, or on a wake after a missed run) macOS deletes each regular file in /tmp
whose access, modification and change times are all older than 3 days, and each empty folder older than 3 days. A
rename keeps the times inside a moved folder, so an aside copy or a trash item of old files could go at the next run,
before a person decides. So every move into the aside folder, or into a trash batch with a grace period, sets each
moved file's access time to now (the modification time stays) and each empty folder's times to now, and the daily pass
(started by the first GenesisTools process of each day) repeats that for every pending request's aside copies and
every trash batch still in its grace period.

## Reading the requests

`tools rm requests` prints one summary line (open requests, paths, the size set aside, the paths in place, the oldest
age; all from the disk now, so a gone path is not in place and a lost copy is not aside), a `Needs a look` line, then one group per asking session, newest first, with one row per request: id, age
(yellow from a day, red from three days), size, live state, a short path and why. The long reason and the aside
location print only in the detail view: `tools rm requests <id>`, or `--long` for every listed request.

The live state comes from the disk at the time of the listing, which reads only:

- `aside`: the path waits in this session's rm-aside folder; `in place`: it waits where it was; `mixed`: both.
- `gone`: no path and no aside copy is left, so nothing is left to decide.
- `came back`: the original path exists again beside its aside copy.
- `copy lost`: the aside copy is gone: deleted outside `tools rm`, by macOS tmp_cleaner or a person. The listing
  explains it under the rows, and the detail view prints it in place of where the copy waited. `approve` prints each
  such path, logs it as `lost`, and decides the rest; a request with nothing else left closes as `gone`.

Filters: `--session <id prefix>`, `--agent <name>`, `--project <name>`, `--older 1d`. `--sort age|size` prints a flat
list instead of groups, `--paths` one row per path, `--all` also the closed requests: a closed one shows its status
(`approved`, `denied`, `expired`, `gone`; per path in `--paths` and the detail), and the summary counts it as closed,
never as something to look at. `--json` prints the saved
requests as before. A flag goes after the subcommand name (`tools rm requests --json`); a delete flag typed before a
subcommand (`tools rm -n preset all`) is refused with exit 2.

A request ends as `approved`, `denied`, `expired`, `gone` or `ruled`. An in-place request reads as `expired` 24 hours after it
was made; an aside request never expires. `tools rm prune` writes the two end states nobody can decide: `gone` (no
path and no aside copy is left) and `expired` (in place, past the 24 hours). It moves, restores and deletes no file,
writes one `close` line per request to the audit log, and leaves a request alone while an approval window holds it.
Any caller may run it; `-n` lists what would close. A `copy lost` or `came back` request stays open for a person.

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
request closes within about 5 minutes of the last such run. `tools rm drain` runs it at once, and `approve` runs it for its requests before a window opens.
`tools rm requests` only reads: it marks a covered request `<rule>: closes at the sweep` and names them in an
`A rule covers:` line.

## Profiles: settings per agent, session or project

`profiles` in the config, edited with `tools rm profile set|remove` (the user only). A profile has a `match` (agent,
session id prefix, project, folder; every field given must match, `person` matches a run outside any agent) and
overrides: `askAction`, `asideUnsaved`, `allowSessionScratch`, `allowOwnFiles`, `grace`, plus lists that add to the
base config: `disabledPresets`, `roots`, `protect`. Matching profiles apply in order. The trash root cannot be
changed by a profile. `tools rm profiles` lists them and prints the settings in force for the caller.

Two profiles ship built in and apply before your own (`tools rm config set disable-profile <name>` turns one off; a
profile of your own with the same name replaces it):

- `person`: a run outside any agent leaves what needs confirmation in place. You confirm by typing at a terminal, and
  no agent is in the way that an aside move would keep the paths from.
- `workers`: Codex and Grok, which often run as unsupervised workers, get a 4-hour undo window instead of 1 hour.

```bash
tools rm profile set codex-careful --agent codex --ask-action request --no-own-files
tools rm profile set web-repo --project web-app --protect ~/projects/web-app/.env --grace-other 2h
```

## The audit log

`~/.genesis-tools/rm/ledger.jsonl` holds one line per move, aside, return, drain, restore, refusal, request, decision,
root, profile and setting change. Each line carries the time, the folder, the path and where it went, the rule, the bytes
(moved: measured right after the rename; reclaimed: at the drain) and the caller: agent, session id and title, model,
project, and the operating-system user for a person. `tools rm log` prints the newest entries (local time) with filters:
the caller once as a header, and one row per run of entries that share action, batch and caller (`15:27 drain 13
items 4.9 MB batch …fc7b`; `--each` prints every entry). A person reads as `person`; only `--json` carries the
operating-system user. `--by agent|session|day|rule|action` prints the totals moved, set aside and reclaimed.

## How a person confirms

`approve`, `roots add`, `config set`, `profile set|remove` and `drain --now` need a person, in two layers:

- the shell guard rule `rm-user-verbs` blocks them in an agent's shell call (Claude Code, Codex, Grok);
- the verb itself asks (`drain --now` does not ask: an agent's run drains early only its own session's batches).
  With GenesisTools.app installed, a window shows the paths and who asked, and "Approve with
  Touch ID" goes on only after Touch ID (or the account password). An agent can open the window but cannot touch the
  sensor. Without the app the platform's dialog asks, and only a click on Approve goes on. The default never takes a typed
  code: "outside an agent" is read from environment variables an agent can clear, and a terminal an agent fakes
  types a code as well as a person.

The setting `approval` picks the way: `auto` (the default: Touch ID when the installed app offers it, else the
dialog), `touch-id` (refuse without the app) or `code` (never Touch ID: the typed code on a terminal outside an
agent, else the dialog). `tools rm config set approval code` asks the person the current way first.

The dialog is one entry per platform in `PERSON_DIALOGS` (`src/utils/rm/approval.ts`), each with Cancel (or No) as
the default button: `osascript` on macOS; `zenity --question`, else `kdialog --warningyesno`, on Linux with a display
(`DISPLAY` or `WAYLAND_DISPLAY`); a Windows Forms message box through `powershell -NoProfile -Command` on Windows
(the text goes in as base64, so a path is never read as PowerShell). Each program comes from its system folder only
(`DIALOG_PROGRAM_PATHS`: `/usr/bin/osascript`; `zenity` or `kdialog` in `/usr/bin` or `/bin`; PowerShell under
`C:\Windows` or `C:\Program Files`), owned by root and writable by nobody else, never from `PATH`, and it starts with
the display, home and language variables only: an agent's `PATH`, `LD_PRELOAD` or `GTK_MODULES` cannot put a fake
Approve in its place. With no dialog program `auto` refuses, since nothing there proves a person answered; the person
then accepts the typed code by writing `"approval": "code"` into `~/.genesis-tools/rm/config.json` by hand.

In Claude Code, run `! tools rm approve <id>` from the prompt.

### `tools rm ask <id>`: an agent opens the window

`approve` is the person's verb (the shell guard blocks it for an agent and offers `ask`). `tools rm ask <id>` is the
agent's: it opens the same approval window for one of its delete requests, through the same steps as `approve` (the
sweep, the refusals, the recheck after the wait, deny and the ledger), and never approves by itself:

- The person check takes only the GenesisTools.app window or the platform's dialog, never a typed code. The window opens
  with Touch ID off and arms it when the person clicks "Approve with Touch ID…", so a touch meant for another prompt
  never approves it. The ledger's approve line says `person: { via, opened: "ask" }`.
- A request under `notify.askMinMB` (default 10, `ask-min-mb`; the sizes `approve` would show, an unmeasured one
  counted as 0) opens nothing: `ask` prints `Request <id> is <size>, under the 10 MB set for agents: hand the user
  \`! tools rm approve <id>\`` and exits 1. A root request is the person's to open the same way.
- With no way to ask (no window and no dialog program, or `approval: touch-id` without the app), it prints why and
  the hand-over line, and exits 1.
- The window waits up to 180 s, so an agent runs `ask` in the background.

Without GenesisTools.app, `approve` and `ask` fall back to the platform's dialog. The typed code (a clack prompt
through the `p` facade) is used only when the person set `approval: code` and runs `approve` in a terminal outside an
agent: a terminal an agent fakes types a code as well as a person.

The window answers more than allow or deny, and `approve` does what it picked:

- **rows**: only the ticked paths are approved; the unticked ones are put back from aside, and the request's `decided`
  record lists both. Another pending request that names an approved path is decided with it.
- **disposal**: "Move to the trash" keeps the items 10 minutes for `tools rm restore <request id>`; "Delete
  permanently" queues them with no grace and starts the drain.
- **remember**: "This session, this folder" trusts each item's folder for the asking session for 8 hours; "Always for
  this folder" trusts it for everyone (`tools rm roots` shows the scope).
- **deny**: a person's Deny closes the request and puts everything back. Its note is kept (`tools rm requests --all`)
  and printed to the same session the next time it asks to delete that path.

The typed code and the dialog answer for all paths, to the trash, just this once. The dialog shows 15 lines, so it
refuses a longer request instead of hiding paths: use GenesisTools.app for those.

A new request from an agent reaches the person on its own: the setting `notify-on-request` picks `inbox` (the
default: a GenesisTools inbox message under the asking session), `notification` (a macOS notification) or `none`.
It posts at most once per asking session in 10 minutes and only names `tools rm approve <id>`; it never opens the
approval window by itself.

Several requests at once: `tools rm approve <id> <id> ...` (or `--session <id prefix>`, `--older 1d`) opens ONE
window with the rows of all of them and asks the person once. The set is fixed before the window opens, so a request
an agent makes meanwhile never rides along; a request open in another window, a root request, a request with nothing
left and one with unfinished recovery are left out with a line each. An in-place path two requests name is one row.
A request that acts on another copy of a path already in the window (an aside copy beside the live path) waits for
a second window, oldest request first, and is read again after the person answers the first. One whose path holds
another object by then, or that still waits after a window nobody answered, is left out with the
`tools rm approve <ids>` command that decides it, and the exit code is 1.
With no id, on a terminal outside an agent, `tools rm approve` opens a picker: tick requests, then approve them in one
window, deny them (another session's requests after one person check, with an optional note the agent reads), or
close the ticked ones nothing is left of.

The window opens before any tree is walked. When `tools rm` opens a delete request it starts `tools rm measure <id>`
in the background, which saves each path's size, emptiness and file count to
`~/.genesis-tools/rm/requests/measured/<id>/` (one file per path) with the top path's mtime. `approve` shows a saved size at once
while that mtime is unchanged; a row without one says "Measuring…" until its size arrives (from the pass that still
runs, or walked by `approve` itself), and the total under the rows appears when every size is in. The git facts
follow the same way. The typed code prints the sizes as they come. Only the dialog (the fallback when
GenesisTools.app cannot ask) cannot change once it shows, so it lists only the sizes known when it opened.

## The trash and the drain

- Items go to `/tmp/GenesisTools/rm/<batch>/` (setting `trash-root`; it must contain a `GenesisTools` folder). A
  path on another volume goes to `<mount point>/.GenesisTools-rm/<batch>/`, so the move stays a rename.
- Each batch is recorded in `~/.genesis-tools/rm/batches/<id>.json` after every move, so a run that dies halfway
  leaves a record. Every action is a line in `~/.genesis-tools/rm/ledger.jsonl`.
- Grace: 0 minutes for preset folders, 5 for the calling session's own scratch, 60 for the rest (`grace-preset`,
  `grace-scratch`, `grace-other`, or `--keep 2h` / `--now` per run). The scratch grace is short because a full disk hid
  about 11 GB of session scratch in the trash for the hour of the other grace (2026-11-01). Until then
  `tools rm restore <batch>` puts things back; `tools rm trash` prints each batch's id tail, which `restore` takes
  when only one batch ends with it.
- A permanent delete ("Delete permanently" in the window) runs in the background drainer and prints its batch id.
- An item the drain cannot delete (a folder without write permission, such as a Go module cache) gets a `fail` line in
  the ledger and stays in the trash, restorable; its batch is marked failed, and only `drain --now` tries it again, so
  the drainer neither loops nor tells twice. The person hears of it once per batch, the way `notify.onFailure` says
  (`inbox` default, `notification`, `none`; `notify-on-failure`).
- A run that died while it moved leaves an incomplete batch. Once its process is gone, the sweep finishes it: the items
  that reached the trash become a normal batch with the run's own grace (a `finish` ledger line), the planned items
  that never moved stay where they are.
- A claim, a lock or a journal names its process by pid; one whose pid now runs a process that started after the
  claim was made (a recycled pid) holds nothing.
- The drainer starts through a double fork, so it is a child of launchd before `tools rm` returns: an agent harness
  that kills its shell's process tree cannot stop it halfway. One drainer runs at a time. It deletes due batches in
  parallel, sleeps until the next one is due, and exits when the trash is empty. Every run also sweeps orphans: a
  trash folder with no record, and a claim whose process died.
- `tools rm drain --now` ends the grace period of every batch, so it is a person's command: the shell guard blocks
  it for an agent. An agent's run that gets past the guard drains early only the batches its own session made; a
  batch of another session, or one a person approved ("Move to the trash"), keeps its grace and its restore.
- The deletion code only deletes inside a trash root, at batch or item depth (`assertInsideTrash`), so a bug that
  builds a wrong path deletes nothing.

## A file named like a subcommand

`tools rm log` lists the audit log, also when the file `./log` was meant; `tools rm -- log` does the same, because
Commander still runs the subcommand after `--`. Write `tools rm ./log` (any path with a `/`). When a file with the
subcommand's name is in the current folder, the subcommand prints one line on stderr that says so. A folder of that
name gets no note (`~/.genesis-tools/rm` holds the `requests` store).

## Opt-in cache presets

These are safe to delete (the next install refills them), but another install or a running app may be reading one, so
each is off until `tools rm config set enable-preset <id>`: `bun-cache`, `npm-cache`, `pnpm-store`, `yarn-cache`,
`homebrew-cache`, and `user-caches` (each app's folder in `~/Library/Caches`; quit the app first). `tools rm presets`
marks them. While one is off, a folder it names needs the user and waits in place (never aside), and the reason
names the command that turns the preset on. Then `tools rm preset bun-cache --in ~/.bun/install/cache` empties that cache.

## Configuration

`~/.genesis-tools/rm/config.json` holds `askAction`, `asideUnsaved`, `allowSessionScratch`, `allowOwnFiles`,
`ownFilesFromBash`, `tmpSmallMB`, `tmpSmallExcluded`, `roots`, `protect`, `grace` (`presetMinutes`, `otherMinutes`,
`scratchMinutes`),
`trashRoot`, `disabledPresets`, `enabledPresets`, `profiles`, `disabledProfiles`, `approval`, `notify` (`onRequest`,
`onFailure`, `askMinMB`), `sweep` (`everyMinutes`, `lingerMinutes`) and `customPresets` (`{ "id", "description",
"names": ["*.cache"], "markers": ["package.json"] }`). The rule settings (`ownFilesFromBash`, `tmpSmallMB`, `grace`)
are profile settings too (`tools rm profile set ... --tmp-small-mb 0 --no-own-bash-files --grace-scratch 30m`); the
person's own (`approval`, `notify`, `sweep`) are not. Edit it with the commands above. A custom preset widens what
agents may delete, so add one by hand only.
