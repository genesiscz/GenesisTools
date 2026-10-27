# tools rm

Safe delete for agents and people. It never deletes in place: each path is renamed into a trash folder (instant on
one volume), and a background drainer deletes the trash. Rules decide what may go without asking. Anything else
becomes a request that the user confirms with a command an agent cannot run.

```bash
tools rm <paths...>                 # delete what the rules allow, ask for the rest
tools rm -n <paths...>              # dry run: each rule's verdict and the sizes
tools rm preset node_modules js-build [--in <dir>]   # find and delete preset folders
tools rm presets                    # the folder kinds deleted without asking
tools rm trash                      # what waits for the drain (--sizes measures it)
tools rm restore <batch> [paths...] # undo, while the batch is in its grace period
tools rm drain [--now]              # drain due batches now (--now: all of them)
tools rm requests                   # what agents asked the user to confirm
tools rm request-root <dir> --reason "<why>"   # ask the user to trust a folder
tools rm deny <id>                  # close a request (an agent may cancel its own)

# The user only (an agent's shell call is blocked, and the verb asks a person):
tools rm approve <id>
tools rm roots add <dir> [--note "<why>"]
tools rm config set <key> <value>   # grace-preset, grace-other, trash-root, disable-preset, enable-preset
```

Exit codes: 0 done, 1 something was refused, 3 a request waits for the user.

## The rules

The first rule that answers decides.

1. **hard-deny** (refuse, no approval can override): a missing path, `/`, system folders, volume roots, the home
   folder and anything directly in it, the current folder and its parents, the trash itself, and protected paths
   (agent transcripts, the history index, keychains, Mail, Messages, iCloud and cloud folders, plus `protect` in
   the config) and every folder that holds one.
2. **registered-worktree** (refuse): a linked worktree git still lists. Use `git worktree remove`, which refuses
   uncommitted work.
3. **git-tracked** (ask): files git tracks. Prefer `git rm`.
4. **unsaved-clone** (ask): a clone with uncommitted changes or commits on no remote.
5. **session-scratch** (allow): inside the calling session's `/tmp/cc/<project>/<session id>/`.
6. **own-files** (allow): a file the calling Claude session wrote (its modified-file journal) that git does not track.
7. **git-untracked** (ask): untracked files git does not ignore, which may be new work.
8. **nested-repos** (ask): a folder that holds git repositories.
9. **preset** (allow): a folder a build or install recreates, next to the file that proves it: `node_modules` next to
   `package.json`, `dist`/`build`/`.next`/`.turbo`/... next to `package.json`, `.build` next to `Package.swift`,
   `target` next to `Cargo.toml`, Gradle and CMake output, Python caches, Pods, Xcode DerivedData and more.
10. **root** (allow): inside a folder the user trusts (`tools rm roots add`).
11. **default** (ask).

A person at a terminal (not inside an agent) gets a typed confirmation for an ask instead of a request.

## How a person confirms

`approve`, `roots add` and `config set` need a person, in two layers:

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

`~/.genesis-tools/rm/config.json` holds `roots`, `protect`, `grace`, `trashRoot`, `disabledPresets` and
`customPresets` (`{ "id", "description", "names": ["*.cache"], "markers": ["package.json"] }`). Edit it with the
commands above. A custom preset widens what agents may delete, so add one by hand only.
