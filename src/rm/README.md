# tools rm

Safe delete for agents and people. It never deletes in place: each path is renamed into a trash folder (instant on
one volume), and a background drainer deletes the trash. Rules decide what may go without asking. Anything else
becomes a request that the user confirms with a command an agent cannot run.

```bash
tools rm <paths...>                 # delete what the rules allow, move the rest aside and ask
tools rm --no-aside <paths...>      # ask, but leave what needs the user in place (--aside forces the move)
tools rm -n <paths...>              # dry run: each rule's verdict and the sizes
tools rm preset node_modules js-build [--in <dir>]   # find and delete preset folders
tools rm presets                    # the folder kinds deleted without asking
tools rm trash                      # what waits for the drain (--sizes measures it)
tools rm restore <batch|request> [paths...] # undo, while the batch is in its grace period (a request id: its batch)
tools rm drain [--now]              # drain due batches now (--now: all of them)
tools rm requests [id]              # what agents asked the user to confirm (an id: that request in full)
tools rm request-root <dir> --reason "<why>"   # ask the user to trust a folder
tools rm deny <id>                  # close a request and put its aside paths back (an agent may cancel its own)
tools rm measure <id>               # measure a request's paths and save the sizes (tools rm starts it in the background)
tools rm log [--since 1d] [--agent codex] [--session <id>] [--by agent|session|day|rule|action]   # audit log
tools rm profiles                   # settings per agent, session or project, and what applies to you

# The user only (an agent's shell call is blocked, and the verb asks a person):
tools rm approve <id>
tools rm roots add <dir> [--note "<why>"]
tools rm config set <key> <value>   # approval, ask-action, aside-unsaved, session-scratch, own-files, grace-preset,
                                    # grace-other, trash-root, disable-preset, enable-preset,
                                    # disable-profile, enable-profile
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
9. **own-files** (allow): a file the calling Claude session wrote (its modified-file journal) that git does not track.
   A profile can turn it off (`allowOwnFiles`).
10. **git-untracked** (ask): untracked files git does not ignore, which may be new work.
11. **nested-repos** (ask): a folder that holds git repositories.
12. **preset** (allow): a folder a build or install recreates, next to the file that proves it: `node_modules` next to
   `package.json`, `dist`/`build`/`.next`/`.turbo`/... next to `package.json`, `.build` next to `Package.swift`,
   `target` next to `Cargo.toml`, Gradle and CMake output, Python caches, Pods, Xcode DerivedData and more.
13. **root** (allow): inside a folder the user trusts (`tools rm roots add`). A root the approval window remembered
   for "this session, this folder" counts only for that session and for 8 hours (`session`, `expiresAt`).
14. **default** (ask).

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

## Reading the requests

`tools rm requests` prints one summary line (open requests, paths, the size set aside, the paths in place, the oldest
age), a `Needs a look` line, then one group per asking session, newest first, with one row per request: id, age
(yellow from a day, red from three days), size, live state, a short path and why. The long reason and the aside
location print only in the detail view: `tools rm requests <id>`, or `--long` for every listed request.

The live state comes from the disk at the time of the listing, which reads only:

- `aside`: the path waits in this session's rm-aside folder; `in place`: it waits where it was; `mixed`: both.
- `gone`: no path and no aside copy is left, so nothing is left to decide.
- `came back`: the original path exists again beside its aside copy.
- `copy lost`: the aside copy is gone (something outside `tools rm` deleted it).

Filters: `--session <id prefix>`, `--agent <name>`, `--project <name>`, `--older 1d`. `--sort age|size` prints a flat
list instead of groups, `--paths` one row per path, `--all` also the closed requests. `--json` prints the saved
requests as before. A flag goes after the subcommand name (`tools rm requests --json`); a delete flag typed before a
subcommand (`tools rm -n preset all`) is refused with exit 2.

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
project, and the operating-system user for a person. `tools rm log` prints the newest entries (local time) with filters;
`--by agent|session|day|rule|action` prints the totals moved, set aside and reclaimed.

## How a person confirms

`approve`, `roots add`, `config set` and `profile set|remove` need a person, in two layers:

- the shell guard rule `rm-user-verbs` blocks them in an agent's shell call (Claude Code, Codex, Grok);
- the verb itself asks. With GenesisTools.app installed, a window shows the paths and who asked, and "Approve with
  Touch ID" goes on only after Touch ID (or the account password). An agent can open the window but cannot touch the
  sensor. Without the app a macOS dialog asks, and only a click on Approve goes on. The default never takes a typed
  code: "outside an agent" is read from environment variables an agent can clear, and a terminal an agent fakes
  types a code as well as a person.

The setting `approval` picks the way: `auto` (the default: Touch ID when the installed app offers it, else the
dialog; on Linux and Windows, which have neither, it refuses), `touch-id` (refuse without the app) or `code` (never
Touch ID: the typed code on a terminal outside an agent, else the macOS dialog). `tools rm config set approval code`
asks the person the current way first. On Linux and Windows, where `auto` cannot ask, the person accepts the typed
code by writing `"approval": "code"` into `~/.genesis-tools/rm/config.json` by hand.

In Claude Code, run `! tools rm approve <id>` from the prompt.

The window answers more than allow or deny, and `approve` does what it picked:

- **rows**: only the ticked paths are approved; the unticked ones are put back from aside, and the request's `decided`
  record lists both. Another pending request that names an approved path is decided with it.
- **disposal**: "Move to the trash" keeps the items 10 minutes for `tools rm restore <request id>`; "Delete
  permanently" queues them with no grace and starts the drain.
- **remember**: "This session, this folder" trusts each item's folder for the asking session for 8 hours; "Always for
  this folder" trusts it for everyone (`tools rm roots` shows the scope).
- **deny**: a person's Deny closes the request and puts everything back. Its note is kept (`tools rm requests --all`)
  and printed to the same session the next time it asks to delete that path.

The typed code and the dialog answer for all paths, to the trash, just this once.

The window opens before any tree is walked. When `tools rm` opens a delete request it starts `tools rm measure <id>`
in the background, which saves each path's size, emptiness and file count to
`~/.genesis-tools/rm/requests/measured/<id>/` (one file per path) with the top path's mtime. `approve` shows a saved size at once
while that mtime is unchanged; a row without one says "Measuring…" until its size arrives (from the pass that still
runs, or walked by `approve` itself), and the total under the rows appears when every size is in. The git facts
follow the same way. The typed code prints the sizes as they come. Only the AppleScript dialog (the fallback when
GenesisTools.app cannot ask) cannot change once it shows, so it lists only the sizes known when it opened.

## The trash and the drain

- Items go to `/tmp/GenesisTools/rm/<batch>/` (setting `trash-root`; it must contain a `GenesisTools` folder). A
  path on another volume goes to `<mount point>/.GenesisTools-rm/<batch>/`, so the move stays a rename.
- Each batch is recorded in `~/.genesis-tools/rm/batches/<id>.json` after every move, so a run that dies halfway
  leaves a record. Every action is a line in `~/.genesis-tools/rm/ledger.jsonl`.
- Grace: 0 minutes for preset folders, 60 for the rest (`grace-preset`, `grace-other`, or `--keep 2h` / `--now` per
  run). Until then `tools rm restore <batch>` puts things back.
- The drainer starts through a double fork, so it is a child of launchd before `tools rm` returns: an agent harness
  that kills its shell's process tree cannot stop it halfway. One drainer runs at a time. It deletes due batches in
  parallel, sleeps until the next one is due, and exits when the trash is empty. Every run also sweeps orphans: a
  trash folder with no record, and a claim whose process died.
- The deletion code only deletes inside a trash root, at batch or item depth (`assertInsideTrash`), so a bug that
  builds a wrong path deletes nothing.

## Opt-in cache presets

These are safe to delete (the next install refills them), but another install or a running app may be reading one, so
each is off until `tools rm config set enable-preset <id>`: `bun-cache`, `npm-cache`, `pnpm-store`, `yarn-cache`,
`homebrew-cache`, and `user-caches` (each app's folder in `~/Library/Caches`; quit the app first). `tools rm presets`
marks them. Then `tools rm preset bun-cache --in ~/.bun/install/cache` empties that cache.

## Configuration

`~/.genesis-tools/rm/config.json` holds `askAction`, `asideUnsaved`, `allowSessionScratch`, `allowOwnFiles`,
`roots`, `protect`, `grace`, `trashRoot`, `disabledPresets`, `enabledPresets`, `profiles`, `disabledProfiles` and
`customPresets` (`{ "id", "description", "names": ["*.cache"], "markers": ["package.json"] }`). Edit it with the
commands above. A custom preset widens what agents may delete, so add one by hand only.
