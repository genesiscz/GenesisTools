# tools stash

`tools stash` keeps named code overlays in one store for the whole Mac and applies them to any git project. Think
`git stash`, JetBrains Shelf and `quilt` in one: an overlay is not tied to one repository, each applied hunk is wrapped
in foldable `@stash:` markers, and a per-region decision walk lets you reshape or remove it later.

This page describes the v1.1 behavior (the curate-after-apply unification). v1.1 added `apply --resume` and
`apply --abort`, `update`, `diff`, `doctor` and husk handling, and renamed the walk verbs. The tool's `--version`
prints `0.1.0`.

## Quick start

```bash
tools stash save debug-logger --mode all        # capture the changes to tracked files as a named overlay
cd ~/Projects/app-2
tools stash apply debug-logger                  # inject it here; each hunk is wrapped in @stash markers
tools stash update debug-logger                 # turn your edits of the applied code into a new version
tools stash diff debug-logger                   # after an update: does the code match the stored copy? (exit 1 = drift)
tools stash unapply debug-logger                # remove it again, region by region
tools stash list --applied                      # what is applied in this project and its sibling clones
```

## The mental model

You carry some code as an overlay: debug logging you add while you investigate, a feature-flag setup you reuse, a fix
you also want in a sibling clone. `git stash` works in one repository only, JetBrains Shelf is bound to the IDE, and a
snippet library does not know where a snippet is applied.

`tools stash` stores named, versioned overlays in a global store. You can:

- capture an overlay from the working tree (`save`);
- inject it into any git project, with markers around each inserted hunk (`apply`);
- edit the applied code in the editor, then capture the result as a new version (`update`);
- remove it later with a per-region decision walk (`unapply`);
- check the drift between the stored content and the applied code (`diff`).

The editor is the UI. `apply` wraps each hunk in `// #region @stash:<name> {...}` and `// #endregion @stash:<name>`.
Every major editor folds `#region` blocks, so you fold, edit or delete them where the code lives.

## Workflows

### Curate after apply (the headline workflow)

Use this when the working tree holds the overlay plus unrelated changes and you want a focused stash.

```bash
# 1. Capture everything that is staged. save never changes the working tree.
tools stash save debug-logger --mode staged
#    It prints a recoverable command that clears what it captured, for example:
#    git stash push --staged -m "debug-logger" -- src/logger.ts src/screens/Home.tsx src/screens/Settings.tsx

# 2. Optional: clear the staged changes so apply starts from a clean tree.
git stash push --staged -m "debug-logger" -- src/logger.ts src/screens/Home.tsx src/screens/Settings.tsx

# 3. Apply the stash again. Each hunk is now wrapped:
tools stash apply debug-logger
#    // #region @stash:debug-logger {"id":"a1b2c3","v":1}
#    const log = (...args) => console.log("[debug]", ...args);
#    // #endregion @stash:debug-logger

# 4. In the editor, delete the marker blocks you do not want in the stash
#    (in this example, the block in src/screens/Settings.tsx).

# 5. Walk the regions and write the next version. The stash stays applied.
tools stash update debug-logger

# 6. Check that the applied code and the new version agree.
tools stash diff debug-logger
#    ✓ "debug-logger" applied region matches stored content; no drift
```

Read this before step 4:

- An apply marker wraps the whole hunk, so a block also holds up to four unchanged lines above and below the change
  (the patch context). Deleting a whole block deletes those original lines too.
- The walk finds region k of a file as the k-th `@stash:<name>` block in that file, counted when it looks. When you
  delete a block that is not the last one of its file, every later block moves up one number. The walk then compares
  each later block with the region before it and shows it as `edited`, and the last region of the file shows as
  `missing`. A `capture` writes that later block's code in place of the earlier region's original lines, and a
  `capture` of the last region deletes its original lines. This is a known defect. In a file with more than one
  block, delete only the last block, or keep the marker lines and delete only the body (see below), and read each
  region's diff in the walk before you capture.
- In `update`, a deleted block (the last one of its file) is a `missing` region. `capture` records it as empty, so
  the new version removes every original line the block held, its context lines included. `skip` leaves the region
  out of the new version. Only a region in a file that the stash created drops out cleanly either way.
- To drop a change and keep the code around it, keep the two marker lines and delete only the added lines between
  them (put back any line the overlay replaced). The region is then `edited`, and `capture` records what is left.

Check the new version with `tools stash show debug-logger --diff` before you apply it in another project.

To remove the overlay from this project later, run `tools stash unapply debug-logger`.

### Move a fix to another project

```bash
cd ~/Projects/app
tools stash save hotfix-null-deref --mode staged

cd ~/Projects/other-app
tools stash apply hotfix-null-deref
# If this code drifted, the 3-way merge leaves <<<<<<< ======= >>>>>>> markers and exits 1.
# Resolve them by hand, then:
tools stash apply hotfix-null-deref --resume    # checks no conflict markers remain, then adds the @stash markers
# or give up and put the files and the index back:
tools stash apply hotfix-null-deref --abort

# Adapt the code, then keep the adapted copy as v2:
tools stash update hotfix-null-deref
```

### Merge two applied stashes into a third

```bash
tools stash apply auth-logging              # the source now has @stash:auth-logging apply markers
tools stash apply feature-flag-debug        # and @stash:feature-flag-debug apply markers
tools stash save combined --mode regions --regions auth-logging feature-flag-debug
```

`combined` captures every hunk that overlaps either marker span. `save` strips apply markers (the ones with JSON), so
when you apply `combined` its hunks get `@stash:combined` markers, not the two old names.

## Commands

Every command accepts `-v, --verbose` (verbose logging), `--readme` (print this page) and `-h, --help`.
`tools stash help <command>` prints the help of one command.

### save: capture working-tree changes

```bash
tools stash save <name>                                  # interactive mode picker (needs a terminal)
tools stash save <name> --mode all                       # staged and unstaged changes to tracked files (git diff HEAD)
tools stash save <name> --mode staged                    # only git diff --cached
tools stash save <name> --mode unstaged                  # only unstaged changes to tracked files
tools stash save <name> --mode regions --regions A B     # only hunks that overlap @stash:A or @stash:B blocks
tools stash save <name> --mode patch                     # git add -p style hunk picker (needs a terminal)
tools stash save <name> --mode all --tag debug --tag web # -t, repeatable
tools stash save <name> --mode all --desc "debug logger" # -d, a description
tools stash save <name> --mode all --force-bump          # name exists: write the next version without the prompt
```

| Flag | Meaning |
|---|---|
| `-m, --mode <mode>` | `staged`, `unstaged`, `all`, `regions` or `patch` |
| `--regions <names...>` | author or apply marker names; needs `--mode regions` |
| `-t, --tag <tag>` | add a tag; repeat the flag for more (default: none) |
| `-d, --desc <text>` | description |
| `--force-bump` | skip the same-name confirmation |

- `save` does not change the working tree. It is a snapshot, not `git stash push`. It prints a recoverable
  `git stash push` command that fits the mode (`--staged`, `--keep-index` or `-u`) and the file list.
- `tools stash save` with no name prints the help of `save`.
- Without a terminal, `--mode` is required, and `--mode patch` is refused.
- `--mode regions` requires `--regions`, and `--regions` requires `--mode regions` (exit 2 otherwise). The flag
  is variadic, so put the stash name before it.
- Same name: `save` shows the diff from the previous version to the new patch and asks `Bump?`. Without a terminal it
  refuses unless you pass `--force-bump`. An identical patch is not saved again.
- `--tag` and `--desc` count on the first save of a name only. A later version keeps the first tags and description.

Which mode to use:

- `all`: everything you changed in tracked files. Good for curate-after-apply: capture all, shape later. The
  interactive picker lists it first, so Enter picks it. The picker's label says "untracked" too, but a brand-new file
  is not in `git diff HEAD`, so `git add` it (or `git add -N`) first.
- `staged`: you already picked the hunks with `git add -p`.
- `unstaged`: only what is not staged yet.
- `regions`: you marked the code with bare author markers and want it in one step, without the apply and curate
  steps. The filter keeps whole hunks: a hunk that overlaps a block comes in complete, never split.
- `patch`: pick hunks one by one (`yes`, `no`, or `quit` to keep nothing more), without staging or marking.

### apply: inject a stash into the current project

```bash
tools stash apply <name>                     # the latest version
tools stash apply <name> --at 2              # a given version (a positive whole number)
tools stash apply <name> --verbose-markers   # also write hunk number, source and apply time into each marker
tools stash apply <name> --resume            # finish after you resolved the 3-way merge conflicts
tools stash apply <name> --abort             # undo a conflicted or failed apply and drop its session
```

- Apply runs `git apply --3way --whitespace=fix`, so whitespace errors (such as trailing spaces) in the added lines
  are fixed.
- A stash is applied once per project. A second `apply` is refused: use `update` or `unapply`.
- On a conflict, the files get inline conflict markers and the session is saved under
  `~/.genesis-tools/stash/state/`. Resolve, then `--resume`. `--resume` refuses while a file still holds conflict
  markers.
- When the target has drifted too far from the source, apply fails with "cannot apply patch" and suggests a new save
  from this project. If the failed apply changed files, run `--abort` to restore them.
- A deleted file gets no markers. `unapply` restores it from its saved pre-image.

### update: capture applied edits as a new version

```bash
tools stash update <name>                                 # start the walk
tools stash update <name> --continue                      # resume a paused walk
tools stash update <name> --continue --decision=capture   # keep the current code in the next version
tools stash update <name> --continue --decision=restore   # rewrite the code to the stored content
tools stash update <name> --continue --decision=skip      # leave both alone (same as --skip)
tools stash update <name> --status                        # progress, for example "5/12 decided"
tools stash update <name> --abort                         # drop the decisions; nothing changes
```

The walk visits every region of the applied version and puts it in one class:

- **unchanged**: the code matches the stored copy (trailing whitespace ignored). Decided as capture, no prompt.
- **edited**: the markers are there, the body differs.
- **missing**: the markers are gone (you deleted the block). The interactive walk offers only capture or skip,
  because restore needs the markers. The prompt without a terminal still lists `--decision=restore`. In `update`
  that decision stops with "Stash restore marker is missing".

The walk reads region k of a file from the k-th block of the stash in that file. After you delete a block that is
not the last one of its file, the classes of the later regions are wrong (see "Read this before step 4" above).

For each `edited` or `missing` region you choose:

- `capture`: the current code goes into the next version.
- `restore`: the code between the markers is rewritten to the stored content.
- `skip`: nothing changes; the walk warns that the stash and the code diverged.

At the end, update writes the next version from the captured regions (auto-captured ones included), points this
project's application at it, and the stash stays applied. A restored or skipped region stays in the code, and a later
`unapply` still walks it, but it is not part of the new version. With nothing captured, no version is written.

The code also names a class `new-extra`, but no walk produces it: `update` only visits the regions the stash already
has. New code outside those regions needs a new `save`.

### unapply: remove an applied stash

```bash
tools stash unapply <name>                                 # start the walk; unchanged regions are removed at once
tools stash unapply <name> --continue --decision=capture   # keep the edits as a new version, then remove
tools stash unapply <name> --continue --decision=restore   # remove and lose the local edits
tools stash unapply <name> --continue --decision=skip      # keep this region's code (same as --skip)
tools stash unapply <name> --status                        # progress and the current file and hunk
tools stash unapply <name> --abort                         # drop the session file; removed regions stay removed
```

- The walk is the same as in `update`, but at the end the code is removed: the markers go and each region's original
  lines (the pre-image saved at apply time) come back. The application is marked `unapplied`.
- The start removes every `unchanged` region from the code at once, before any decision. `--abort` deletes only the
  session file. It does not put those regions back (`unapply --help` says "restore state", but nothing is restored),
  and the application stays `active`, so a later `unapply` or `update` sees them as `missing` and reads a later
  block of the same file under the wrong number. Finish the walk instead when you can. To undo the start, put that
  code back by hand (`tools stash show <name> --diff` shows it).
- An `edited` region that comes after an `unchanged` region in the same file cannot be removed. The start removes the
  unchanged block, the walk still looks for the edited block by its old number, finds no marker, and ends in a
  partial unapply that `--continue` cannot finish. This is a known defect. Run `update` first and capture the edited
  regions: `unapply` then finds every region unchanged and removes them all at the start. When you are already
  stuck, see Troubleshooting.
- The block numbering from "Read this before step 4" holds here too. After you delete a block that is not the last
  one of its file, a restore or capture of region k puts region k's original lines in place of the next block.
- `unapply --help` lists the v1 verbs `update` (same as `capture`) and `discard` (same as `restore`). Both still work.
- In `unapply`, a `missing` region can only be skipped cleanly. Capture or restore on it finds no marker and ends in a
  partial unapply.
- Husk handling: a file that the apply created is deleted at the end when it is empty, instead of staying as a 0-byte
  file. A created file that still holds code (for example a skipped region) stays.
- Partial unapply: when a region has no marker, or the stash changed a symlink, a binary file or a file mode, or made
  an empty file appear or go away, the application stays `active` and the files are listed. The command still exits
  0. Fix them by hand, then run `unapply --continue`, or `unapply --abort`.

### Blanket decisions (update and unapply)

One flag decides every region that is still open. The suffix `-all-dangerous` is mandatory, and none of these is a
default.

```bash
tools stash update <name> --continue --decision=capture-all-dangerous    # capture every open region
tools stash unapply <name> --continue --decision=discard-all-dangerous   # restore every open region
```

The parser knows one restore form: `discard-all-dangerous`. Any other value that ends in `-all-dangerous` means
capture all. That includes `update-stash-all-dangerous` from `unapply --help`, and also `restore-all-dangerous`, which
`update --help` lists but which captures today. For a blanket restore, use `discard-all-dangerous` with either
command.

### diff: drift between the applied code and the stored copy

```bash
tools stash diff <name>          # per-region unified diff against the applied version
tools stash diff <name> --at 1   # against another version
```

Exit 0 when there is no drift, 1 when a region drifted. It also exits 1 when the stash is unknown or not applied in
this project. In CI: `tools stash diff important-overlay || echo "drift detected"`.

Two known defects make `diff` report drift that is not there. Read the diff before you act on exit 1:

- Right after a fresh `apply`. The apply markers wrap hunks with four context lines, but the stored `PATCH.diff` comes
  from `git diff`, which keeps three. Where four or more unchanged lines sit above or below a change, the region holds
  one more line on that side than the stored copy. Two changes with seven or eight unchanged lines between them are
  one block in the code and two hunks in the stored copy. After the first `update`, the stored copy is the code
  between the markers, so this goes away.
- After an `update`, in a file with two or more regions. The new `PATCH.diff` holds one file header per region, and
  `diff` counts the hunks from 1 again at each header, so it compares every region of the file with the first block.

### show: one stash in detail

```bash
tools stash show <name>              # metadata and the region inventory (file, hunk, lines, region name)
tools stash show <name> --regions    # the same, said explicitly
tools stash show <name> --diff       # metadata, then the stored PATCH.diff on stdout
tools stash show <name> --meta       # metadata only
tools stash show <name> --at 2       # another version
tools stash show                     # no name: the same as tools stash list
```

`--diff`, `--meta` and `--regions` exclude each other (exit 2). The metadata and the region inventory go to stderr.
Only the patch of `--diff` goes to stdout, so `tools stash show <name> --diff > overlay.patch` writes a clean patch
file.

### list: all stashes

```bash
tools stash list                  # every stash, newest change first: NAME, VER, TAGS, STATUS
tools stash list --project        # applied in, or saved from, this project or a sibling clone
tools stash list --applied        # only stashes with an active application in this project or a sibling clone
tools stash list --tag debug      # filter by tag
```

`--project` and `--applied` need a git repository. With them, STATUS shows `● applied here`.

### versions, where, drop, doctor

```bash
tools stash versions <name>                  # VER, FILES, REGIONS, CREATED, ORIGIN, newest first
tools stash where <name>                     # every project path with an active application, and when

tools stash drop <name>                      # the latest version (asks in a terminal)
tools stash drop <name> --at 2               # one version
tools stash drop <name> --all-versions       # every version (cannot be combined with --at)
tools stash drop <name> --orphan-active      # drop even when it is applied somewhere

tools stash doctor                           # git fsck of the store, missing refs, orphaned applications
tools stash doctor --rebuild                 # also regenerate the regions table from the stored patches
```

- `drop` refuses while any project has the stash applied. `--orphan-active` marks every active application of the
  stash `orphaned`, whatever version you drop. The markers stay in those projects and `unapply` no longer knows them,
  so remove them by hand. Without a terminal, `drop` does not ask.
- When the last version goes, the stash itself goes.
- `doctor` exits 1 when it finds an error (a failed `git fsck`, a version whose store ref is missing, an application
  that names a missing version). An active application without a version is a warning.

### rebase-project (planned, not built)

A planned follow-up, moved out of v1.1 to its own PR. It will re-point active applications when a project moves on
disk (for example `rebase-project /old/path /new/path`).

## Markers

An apply marker carries JSON: the last six characters of the stash id and the version.

```ts
// #region @stash:debug-logger {"id":"a1b2c3","v":1}
const log = createDebugLogger();
// #endregion @stash:debug-logger
```

With `--verbose-markers` the JSON also holds `hunk`, `src` (the source folder name and short SHA) and `applied` (the
time).

A bare author marker has no JSON. You write it before you save, and `save` keeps it in the patch:

```ts
// #region @stash:debug-logger
log.debug("cache miss", key);
// #endregion @stash:debug-logger
```

- Names may use letters, digits, `_`, `.` and `-`. Use kebab case with a purpose prefix: `debug-<x>`,
  `feat-flag-<x>`, `hotfix-<x>`, `experiment-<x>`.
- The comment syntax comes from the file extension:
  - `//`: ts, tsx, js, jsx, mjs, cjs, php, java, c, h, cpp, hpp, go, rs, swift, kt, scala, dart, and any other
    extension;
  - `#`: py, rb, sh, bash, zsh, fish, yaml, yml, toml;
  - `<!-- ... -->`: html, xml, svg, md, vue;
  - `/* ... */`: css, scss, less.
- The interactive region picker (`save` with no `--mode`, then "Marked regions") scans the whole tree. It skips files
  over 1,000,000 bytes and the folders `node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `.turbo`, `.bun`,
  `.cache`, `coverage`, `target`, `vendor`, `.venv` and `__pycache__`, without a warning. `--regions` reads only the
  changed files and has no size limit.

### Region name and stash name

| | Stash name | Region name |
|---|---|---|
| Lives in | `stashes.name` in SQLite and `refs/stashes/<id>/v<n>` in the store | the `@stash:<name>` tag in source |
| Written by | you, with `tools stash save <name>` | you (author marker) or `apply` (apply marker) |
| JSON | none | author marker: none; apply marker: `{"id":...,"v":...}` |

Convention: give the author region the same name as the stash, so `// #region @stash:debug-logger` goes with
`tools stash save debug-logger --mode regions --regions debug-logger`. The two may differ; the merge workflow above
depends on that.

## How it works

Everything lives under `~/.genesis-tools/stash/`:

- `store/`: a bare git repository. Each version is a commit at `refs/stashes/<id>/v<n>` holding `PATCH.diff`. The
  content of the touched files at HEAD when you saved is at `refs/baselines/<id>/v<n>`.
- `index.db`: SQLite with the tables `stashes`, `versions`, `regions`, `applications` (state `active`, `unapplied` or
  `orphaned`) and `projects`.
- `state/`: one JSON file per session, named `<project-hash>--<kind>--<stash-id>.json`. The project hash is the
  SHA-256 of the project's root path. `apply` is a pending apply, `applied` is the archive that `update` and `unapply`
  need (the pre-images of every touched file), and `update` and `unapply` are paused walks. The `apply` and `applied`
  files hold base64 copies of your files and of the git index, so they are written `0600`. The walk files hold the
  region code and get the default file mode. The whole `state/` folder is `0700`.
- `cache/`: created, not used yet.
- Logs go to the shared day log `~/.genesis-tools/logs/<YYYY-MM-DD>.log`.

The tool calls only `git`: `git diff` to save, and `git apply --3way` to apply. Before an apply it fetches the baseline
blobs from the store into the target repository under `refs/gtstash-baseline`, so the 3-way merge has real bases, and
deletes that ref after a clean apply. A conflicted or failed apply, `--resume` and `--abort` leave
`refs/gtstash-baseline` behind; `git update-ref -d refs/gtstash-baseline` removes it. No network, no account, no app,
no macOS permission, and nothing costs money.

A project is its git root path. `list --project` and `list --applied` also count sibling clones: folders next to the
project that are git repositories with the same normalized `origin` URL. Without an origin, a folder counts when the
Jaccard similarity of the two projects' first 100 file paths (sorted) is at least 0.7.

## Configuration

There is no config file. One environment variable:

- `GENESIS_TOOLS_STASH_ROOT`: replaces the storage root `~/.genesis-tools/stash`. It exists for test isolation; you
  do not need it in normal use.

## For agents

- There is no `--json`. Status lines go to stderr. Tables (`list`, `versions`, `where`), `diff` output and the patch
  of `show --diff` go to stdout. `show` prints its metadata and region inventory to stderr, so the stdout of
  `tools stash show <name>` is empty.
- Without a terminal (stdin is not a TTY): `save` needs `--mode`, a same-name `save` needs `--force-bump`,
  `--mode patch` is refused, and `drop` does not ask.
- A walk without a terminal applies the decision flags it got, saves its state, and prints the current region, its
  full diff and the next commands (`--continue --decision=capture|restore|skip`, `--abort`) to stderr. It exits 0.
  Exit 0 does not mean the walk is done; run the next command until the summary line appears.
- Never pipe walk output through `head`, `tail` or a narrow `grep`. The full diff is the only proof that each
  decision was right. Redirect it to a file and read it whole: `tools stash unapply <name> 2> /tmp/walk.diff`.
- Exit codes: 0 success, a paused walk, or "nothing to do"; 1 failure (not a git repository, unknown stash or
  version, conflict, drift in `diff`, an error in `doctor`, a refused `drop`); 2 a bad flag combination (`save` mode
  and regions, `show` view flags).
- A same-name `save` without `--force-bump` and without a terminal prints an error and "save aborted" but exits 0.
  Check for the `saved "<name>" v<n>` line.
- A partial unapply ("partial unapply: ... application kept ACTIVE") also exits 0. Check for the
  `unapplied "<name>"` summary line.
- Never pass `--decision=restore` for a region whose class is `missing`, although the prompt lists it. `update` then
  stops with "Stash restore marker is missing", and `unapply` ends in a partial unapply.
- The plugin skill `stash` (`plugins/genesis-tools/skills/stash/SKILL.md`) has more scenarios.

## Gotchas

- Do not stash secrets, API keys or `.env` content. The store is plaintext on disk.
- Binary files and symlinks travel in the patch (`git diff --binary`), but `unapply` cannot undo them. It keeps the
  application active and lists them for you to restore by hand.
- Do not `git checkout -- <file>` while a stash is applied. It destroys the markers and leaves the application row
  pointing at nothing. Use `tools stash unapply`.
- Finish or abort an open `update` walk before you start `unapply`. `update` refuses to run over an open `unapply`
  walk, but `unapply` does not check what kind of walk it resumes.
- Do not edit the stash's regions after a walk starts. The walk reads each region's code once, at its start. After
  an edit, `unapply` stops with "changed after the decision was recorded", and a restore in `update` stops with
  "changed after the restore decision". A capture in `update` does not stop: it stores the code as it was when the walk
  started, so an edit made during a paused walk is lost from the new version.

## Troubleshooting

- **"not applied here" after you moved or renamed the project folder.** Applications are stored by absolute path.
  `rebase-project` is planned but not built, so `tools stash where <name>` shows the old path.
- **"an apply session is already pending".** An earlier apply stopped on a conflict or a failure. Run
  `tools stash apply <name> --resume` after you resolve it, or `--abort`.
- **"no hunks overlap with the requested region(s)".** The marker blocks are not in changed lines, or the name is
  spelled differently. Check the names with the interactive picker (`tools stash save <name>`, then "Marked
  regions").
- **"in-progress unapply session blocks update".** Finish it with `tools stash unapply <name> --continue` or drop it
  with `--abort`.
- **"marker missing in: <file>" after a partial unapply, but the markers are still in the file.** An unchanged region
  earlier in the same file was removed when the walk started, and the walk looks for the later block by its old
  number. `--continue` repeats the same lookup and cannot finish. A `capture` decision already wrote its new version.
  Remove that block by hand: replace the two marker lines and the code between them with the original lines
  (`git diff` shows them when they are committed). Then run `tools stash unapply <name> --abort`, run
  `tools stash unapply <name>` again, and skip each region whose class is `missing`. The walk then ends and marks the
  application `unapplied`.
- **The store and the index disagree.** Run `tools stash doctor`, then `tools stash doctor --rebuild` if the regions
  table is wrong.

## Related

- Plugin skill for agents: `plugins/genesis-tools/skills/stash/SKILL.md`.
- Source: `src/stash/`.
