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
tools rm restore <batch> [paths...] # undo, while the batch is in its grace period
tools rm drain [--now]              # drain due batches now (--now: all of them)
tools rm requests                   # what agents asked the user to confirm
tools rm request-root <dir> --reason "<why>"   # ask the user to trust a folder
tools rm deny <id>                  # close a request and put its aside paths back (an agent may cancel its own)
tools rm log [--since 1d] [--agent codex] [--session <id>] [--by agent|session|day|rule|action]   # audit log
tools rm profiles                   # settings per agent, session or project, and what applies to you

# The user only (an agent's shell call is blocked, and the verb asks a person):
tools rm approve <id>
tools rm roots add <dir> [--note "<why>"]
tools rm config set <key> <value>   # ask-action, aside-unsaved, session-scratch, own-files, grace-preset,
                                    # grace-other, trash-root, disable-preset, enable-preset
tools rm profile set <name> --agent codex --ask-action request [...]
tools rm profile remove <name>
```

Exit codes: 0 done, 1 something was refused, 3 a request waits for the user.

## The rules

The first rule that answers decides.

1. **hard-deny** (refuse, no approval can override): a missing path, `/`, system folders, volume roots, the home
   folder and anything directly in it, the current folder and its parents, the trash itself, and protected paths
   (agent transcripts, the history index, keychains, Mail, Messages, iCloud and cloud folders, plus `protect` in
   the config) and every folder that holds one.
2. **aside-pending** (refuse): a path that is, holds, or sits in an aside folder whose request still waits. The
   aside folder lives in the session's scratch, so without this rule the scratch rule would let the agent delete it.
3. **registered-worktree** (refuse): a linked worktree git still lists. Use `git worktree remove`, which refuses
   uncommitted work.
4. **git-tracked** (ask): files git tracks. Prefer `git rm`.
5. **unsaved-clone** (ask): a clone with uncommitted changes or commits on no remote.
6. **session-scratch** (allow): inside the calling session's `/tmp/cc/<project>/<session id>/` (or the agent's own
   folder, such as `/tmp/codex/...`). A profile can turn it off (`allowSessionScratch`).
7. **own-files** (allow): a file the calling Claude session wrote (its modified-file journal) that git does not track.
   A profile can turn it off (`allowOwnFiles`).
8. **git-untracked** (ask): untracked files git does not ignore, which may be new work.
9. **nested-repos** (ask): a folder that holds git repositories.
10. **preset** (allow): a folder a build or install recreates, next to the file that proves it: `node_modules` next to
   `package.json`, `dist`/`build`/`.next`/`.turbo`/... next to `package.json`, `.build` next to `Package.swift`,
   `target` next to `Cargo.toml`, Gradle and CMake output, Python caches, Pods, Xcode DerivedData and more.
11. **root** (allow): inside a folder the user trusts (`tools rm roots add`).
12. **default** (ask).

A person at a terminal (not inside an agent) gets a typed confirmation for an ask instead of a request.

## Aside: out of the agent's way until the user decides

With `askAction` `aside` (the default) a path that needs the user is renamed into
`/tmp/<agent dir>/<project>/<session>/rm-aside/<batch>/` (`cc` for Claude Code, `codex`, `grok`, ...), and the request
names where each one waits. `tools rm approve <id>` moves the aside copies into the trash; `tools rm deny <id>` moves
them back. An aside request never expires, and `tools rm requests` shows where each path waits.

- Unsaved work stays in place with a plain request: untracked files, clones with unpushed work and folders holding
  repositories (rules `git-untracked`, `unsaved-clone`, `nested-repos`). /tmp is cleared on a reboot, and that work
  exists nowhere else. A profile (or `aside-unsaved yes`) moves it aside too.
- A path on another volume stays in place: a rename across volumes would be a copy.
- `--no-aside` leaves a run's paths in place; `--aside` moves them even for a person at a terminal.

## Profiles: settings per agent, session or project

`profiles` in the config, edited with `tools rm profile set|remove` (the user only). A profile has a `match` (agent,
session id prefix, project, folder; every field given must match, `person` matches a run outside any agent) and
overrides: `askAction`, `asideUnsaved`, `allowSessionScratch`, `allowOwnFiles`, `grace`, plus lists that add to the
base config: `disabledPresets`, `roots`, `protect`. Matching profiles apply in order. The trash root cannot be
changed by a profile. `tools rm profiles` lists them and prints the settings in force for the caller.

```bash
tools rm profile set codex-careful --agent codex --ask-action request --no-own-files
tools rm profile set web-repo --project web-app --protect ~/projects/web-app/.env --grace-other 2h
```

## The audit log

`~/.genesis-tools/rm/ledger.jsonl` holds one line per move, aside, return, drain, restore, refusal, request, decision,
root and profile change. Each line carries the time, the folder, the path and where it went, the rule, the bytes
(moved: measured right after the rename; reclaimed: at the drain) and the caller: agent, session id and title, model,
project, and the operating-system user for a person. `tools rm log` prints the newest entries (local time) with filters;
`--by agent|session|day|rule|action` prints the totals moved, set aside and reclaimed.

## How a person confirms

`approve`, `roots add`, `config set` and `profile set|remove` need a person, in two layers:

- the shell guard rule `rm-user-verbs` blocks them in an agent's shell call (Claude Code, Codex, Grok);
- the verb itself asks: outside an agent on a terminal you type the code it shows; inside an agent, or without a
  terminal, a macOS dialog asks and only a click on Approve goes on. A terminal an agent fakes still gets the dialog.

In Claude Code, run `! tools rm approve <id>` from the prompt.

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

## Configuration

`~/.genesis-tools/rm/config.json` holds `askAction`, `asideUnsaved`, `allowSessionScratch`, `allowOwnFiles`,
`roots`, `protect`, `grace`, `trashRoot`, `disabledPresets`, `profiles` and `customPresets` (`{ "id", "description", "names": ["*.cache"], "markers": ["package.json"] }`). Edit it with the
commands above. A custom preset widens what agents may delete, so add one by hand only.
