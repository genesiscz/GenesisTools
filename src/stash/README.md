# tools stash

Global cross-project code-overlay manager. `git stash` × JetBrains Shelf × `quilt` — with a multi-step decision walk for surgical removal, foldable `@stash:` markers in source, and the same overlay applicable across sibling clones or unrelated projects.

> **Scope of this README:** describes the tool's behavior at and after v1.1 (the curate-after-apply unification). For the original v1 design, see `.claude/plans/2026-06-24-StashTool-spec.md`; for v1.1's deltas + plan, see `.claude/plans/2026-06-25-StashTool-spec.md` and `2026-06-25-StashTool-plan.md`.

---

## The mental model in 60 seconds

You have code you want to **carry as an overlay** — debug logging you sprinkle in while investigating something, a feature-flag dance you reuse across projects, a fix you want to also drop into a sibling clone. `git stash` only works within one repo. JetBrains Shelf is IDE-bound. Snippet libraries don't track per-region application state.

`tools stash` stores **named, foldable overlays** in a global store. You can:

- Capture an overlay from the working tree (`save`).
- Inject it into any project, with foldable markers wrapping each inserted hunk (`apply`).
- Shape it in the editor by deleting unwanted regions, then capture the result (`update`).
- Surgically remove it later with a per-region decision walk (`unapply`).
- Inspect drift between stored content and the current applied code (`diff`).

The editor IS the UI. Apply wraps each hunk with `// #region @stash:<name>` markers; you fold, edit, or delete them right where the code lives.

## Headline workflow: curate-after-apply

The cleanest way to capture a focused stash from a messy working tree:

```bash
# 1. You have staged logging + unrelated changes.
git status   # M src/logger.ts  M src/screens/Home.tsx  M src/screens/Settings.tsx

# 2. Save dumb — capture the whole staged set.
tools stash save debug-logger --mode staged
#   ⚠ working tree is unchanged — this captured an overlay, it did NOT remove the changes
#   ℹ   to clear the staged changes (recoverable): git stash push --staged -m "debug-logger" -- <files>

# 3. Reset working tree (optional; the suggestion above tells you the safe command).
git stash push --staged -m "debug-logger" -- src/logger.ts src/screens/Home.tsx src/screens/Settings.tsx

# 4. Apply the stash back. Each hunk gets wrapped with foldable markers.
tools stash apply debug-logger
#   ✓ applied "debug-logger" v1
#   ℹ   3 files affected
# Source now contains:
#   // #region @stash:debug-logger {"id":"abc123","v":1}
#   const log = (...) => ...;
#   // #endregion @stash:debug-logger

# 5. In your editor: DELETE the marker pairs (and bodies) for regions you don't want
#    in this stash. VS Code / JetBrains / vim all fold #region blocks — collapse,
#    select, delete.
#
#    (In this example, you decide src/screens/Settings.tsx changes were unrelated;
#    delete that marker pair entirely.)

# 6. Update the stash to reflect what's left in code.
tools stash update debug-logger
#   walks each remaining region; classifies (unchanged/edited/missing/new-extra);
#   per-region decision: capture / restore / skip
#   On completion: v_next exists; applications.version_id advances.

# 7. Verify drift is zero now.
tools stash diff debug-logger
#   ✓ "debug-logger" applied region matches stored content; no drift
```

The stash now contains only what you wanted, AND it's still applied so you can keep iterating. To remove it from this project later:

```bash
tools stash unapply debug-logger
#   walks each region; auto-removes unchanged ones; prompts on ambiguous.
```

## Commands

### save — capture from working tree

```bash
tools stash save <name>                          # interactive mode selector (TTY only)
tools stash save <name> --mode all               # staged + unstaged + untracked
tools stash save <name> --mode staged            # only `git diff --cached`
tools stash save <name> --mode unstaged          # only unstaged tracked changes
tools stash save <name> --mode regions --regions A B  # only hunks overlapping @stash:A or @stash:B markers
tools stash save <name> --mode patch             # git-add-p-style interactive hunk picker (TTY only)
tools stash save <name> --tag <tag>              # repeatable tag for filtering
tools stash save <name> --desc "<text>"          # human-readable description
tools stash save <name> --force-bump             # if <name> already exists, skip the same-name diff/confirm prompt
```

**Same-name behavior:** if `<name>` already exists, save shows the v_prev → working aggregate diff and prompts `Bump? (y/n)`. Non-TTY without `--force-bump` errors with a suggestion. Once confirmed, writes v_next.

**`save` does NOT modify the working tree.** It's a snapshot, not a `git stash push`. The success message includes a mode-aware `git stash push` command if you want to clear what you captured.

### apply — inject into the cwd project

```bash
tools stash apply <name>                  # latest version
tools stash apply <name> --at <version>   # specific version
tools stash apply <name> --verbose-markers   # include src/applied metadata in markers
tools stash apply <name> --resume         # continue after manually resolving a 3-way merge conflict (v1.1)
tools stash apply <name> --abort          # reverse-apply a conflict-failed apply (v1.1)
```

Each captured hunk gets wrapped with `// #region @stash:<name> {json}` open and `// #endregion @stash:<name>` close markers. Comment syntax adapts: `// #region` (TS/JS/PHP/Java/C/Go/Rust/Swift), `# #region` (Python/Ruby/Bash/YAML), `<!-- #region ... -->` (HTML/MD/XML), `/* #region */` (CSS).

On 3-way merge conflict: inline `<<<<<<< / ======= / >>>>>>>` markers in the affected files + a state file written to `~/.genesis-tools/stash/state/`. Resolve manually, then `--resume`.

### update — shape v_next via decision walk (v1.1)

```bash
tools stash update <name>                                  # start the walk
tools stash update <name> --continue                       # resume after pause
tools stash update <name> --continue --decision=capture    # accept current code as v_next region
tools stash update <name> --continue --decision=restore    # rewrite code to stored content
tools stash update <name> --continue --decision=skip       # accept divergence
tools stash update <name> --status                         # progress: "5/12 decided"
tools stash update <name> --abort                          # discard decisions, no changes
tools stash update <name> --continue --decision=capture-all-dangerous   # batch (mandatory suffix)
tools stash update <name> --continue --decision=restore-all-dangerous   # batch
```

Walks every recorded region of `<name>`. Classifies each:
- **unchanged** — stored matches current. Auto-decided as `capture` (no-op writeback).
- **edited** — markers present but body differs from stored.
- **missing** — markers absent from source (you deleted them).
- **new-extra** — source has additional `@stash:<name>` regions not in v_prev.

For each ambiguous region: prompt **capture / restore / skip**.

- `capture` writes the current code into v_next.
- `restore` rewrites the source to match stored.
- `skip` leaves both alone, logs divergence.

On completion: v_next is written; `applications.version_id` advances. The stash stays applied.

### unapply — surgical removal

Same walk shape as `update`, but at the end the code IS removed (markers + body stripped) and the application is marked `state='unapplied'`. The walk's verbs are the same: `capture / restore / skip`. (v1's `update / discard / skip` verbs were renamed in v1.1; old `--decision=update` / `--decision=discard` aliases are kept for back-compat.)

```bash
tools stash unapply <name>                            # walks ambiguous regions
tools stash unapply <name> --continue --decision=capture    # capture current as v_next, then remove
tools stash unapply <name> --continue --decision=restore    # rewrite code to stored (lose local edits), then remove
tools stash unapply <name> --continue --decision=skip       # leave both alone
tools stash unapply <name> --abort                    # discard decisions, code untouched
```

**Husk handling (v1.1):** if a region spans a file that didn't exist at HEAD when the stash was saved (i.e. the overlay introduced the file), unapply unlinks the file at the end of the walk instead of leaving a 0-byte husk.

### diff — drift between applied and stored (v1.1)

```bash
tools stash diff <name>           # per-region diff: stored vs current applied
tools stash diff <name> --at vN   # vs a specific version (default: applied version)
```

Exit 0 if clean, 1 if drift. Useful in CI: `tools stash diff important-overlay || alert`.

### show — inspect stash metadata + content

```bash
tools stash show <name>                # default: region inventory (file, hunk, line count, name)
tools stash show <name> --diff         # full PATCH.diff to stdout
tools stash show <name> --meta         # just the metadata header
tools stash show <name> --at <version> # specific version
```

### list — enumerate stashes

```bash
tools stash list                       # all stashes
tools stash list --project             # only stashes from cwd's project (origin URL + sibling-clone match)
tools stash list --applied             # only stashes currently applied in cwd
tools stash list --tag <tag>           # filter by tag
```

### versions — history of one stash

```bash
tools stash versions <name>            # vN | created | regions | files | source
```

### where — which projects have it applied

```bash
tools stash where <name>               # paths of all active applications on this machine
```

### drop — delete a stash

```bash
tools stash drop <name>                          # latest version (with confirm)
tools stash drop <name> --at <version>           # specific version
tools stash drop <name> --all-versions           # nuke every version
tools stash drop <name> --orphan-active          # drop even if currently applied (marks apps 'orphaned')
```

### doctor — consistency check (v1.1)

```bash
tools stash doctor                     # report sqlite/store-repo inconsistencies
tools stash doctor --rebuild           # regenerate regions table from stored patches
```

### rebase-project — re-point applications to a moved path (planned, not yet implemented)

> Planned follow-up command — moved out of v1.1 to a separate PR. Will let you re-point active
> applications when a project moves on disk (e.g. `rebase-project /old/path /new/path`).

## Region name vs stash name

Two strings, conceptually independent:

| | Stash name | Region name |
|---|---|---|
| **Where it lives** | `stashes.name` in SQLite + `refs/stashes/<id>/v<n>` in store | `@stash:<name>` tag in source code |
| **Who writes it** | You, via `tools stash save <stash-name>` | You (bare author marker, no JSON) OR `tools stash apply` (apply-time marker = stash name, with JSON metadata) |
| **Has JSON?** | N/A | Author: no. Apply: yes (`{"id":...,"v":...}`) |

**Convention:** name your author region the same as the planned stash. `// #region @stash:debug-logger` → `tools stash save debug-logger --mode regions --regions debug-logger`.

**They CAN diverge.** The "merge two applied stashes" workflow uses this:

```bash
tools stash apply A          # source now has @stash:A apply markers
tools stash apply B          # source also has @stash:B apply markers
tools stash save combined --mode regions --regions A B
# stash `combined` captures hunks overlapping either marker span.
# Apply markers are stripped on save; on apply of `combined`, the hunks get
# wrapped with @stash:combined apply markers (NOT @stash:A or @stash:B).
```

## Save modes — when to use which

- **`--mode all`** (default in interactive picker): staged + unstaged + untracked. Use for the curate-after-apply workflow — capture everything, shape later in the editor.
- **`--mode staged`**: only `git diff --cached`. Use when you've already used `git add -p` to stage the right hunks.
- **`--mode unstaged`**: only unstaged tracked changes.
- **`--mode regions --regions A B`**: only hunks overlapping author/apply marker spans. Use when you've already authored bare `// #region @stash:` markers in source and want a one-shot capture without the apply+curate dance.
- **`--mode patch`**: interactive hunk picker (TTY-only). Use when you want to pick a subset without staging or marking.

## Anti-patterns

- **Don't stash secrets, API keys, or `.env` content.** The store is plaintext on disk.
- **Don't stash binary or large (>1MB) files** — they're skipped with a warning.
- **Don't apply the same stash twice to the same project.** Use `unapply` or `update` instead.
- **Don't `| head` / `| tail` / narrow-grep unapply or update output.** The full diff is the only proof you made the right decision for each region. Redirect to a file if needed: `2> /tmp/walk.diff`.
- **Don't `git checkout -- <file>` if a stash is applied.** Use `tools stash unapply` to remove it cleanly; checkout will destroy the markers and leave the application row pointing at nothing.

## Storage

- Patches: bare git repo at `~/.genesis-tools/stash/store/`. Each version = a commit at `refs/stashes/<id>/v<n>`; baseline blobs at `refs/baselines/<id>/v<n>`.
- Index: SQLite at `~/.genesis-tools/stash/index.db`. Tables: `stashes`, `versions`, `regions`, `applications`, `projects`.
- In-progress walks: JSON at `~/.genesis-tools/stash/state/<project-hash>--<verb>--<stash-id>.json`.
- Logs: day-stamped pino at `~/.genesis-tools/logs/<YYYY-MM-DD>.log`.

## Environment variables

- `GENESIS_TOOLS_STASH_ROOT` — override the default storage root (`~/.genesis-tools/stash`). Used primarily for test isolation; production users shouldn't need to set this.

## Design

- Original v1 spec: `.claude/plans/2026-06-24-StashTool-spec.md` (region marker format, state machine, sibling-clone detection).
- v1.1 spec: `.claude/plans/2026-06-25-StashTool-spec.md` (unified walk, curate workflow, deferred backlog).
- v1.1 implementation plan: `.claude/plans/2026-06-25-StashTool-plan.md`.

## See also

- Skill (agent-facing usage guide): `.claude/skills/stash/SKILL.md`
- Source: `src/stash/`
