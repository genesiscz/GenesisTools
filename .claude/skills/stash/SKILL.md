---
name: stash
description: Save/apply/unapply named code overlays across projects with `tools stash`. Use when the user wants to capture a chunk of working-tree changes for re-use, apply a previously saved stash into the current project, surgically remove an applied stash with diff review, or list/inspect stashes. Triggers on "stash this", "save this overlay", "apply my <name> stash", "pop my debug stash here", "what stashes do I have applied".
---

# `tools stash` — Cross-Project Code Overlay Manager

## What it does

A global named stash store. Save a chunk from Project A; apply it later to Project A, B, or any sibling clone. Apply decorates injected hunks with foldable `// #region @stash:<name> {json}` markers so they're visible, greppable, and reversible. Unapply runs a multi-step state machine (like `git rebase --continue/--abort`) with per-region diff review.

## Authoring discipline (regions in source)

Wrap code that you might want to stash with foldable region markers. Editors fold them automatically.

```ts
// #region @stash:debug-logger
const log = createDebugLogger();
log.debug('hi');
// #endregion @stash:debug-logger
```

- Language comment syntax adapts: `// #region` (TS/JS/PHP/Java/C/Go/Rust/Swift), `# #region` (Python/Ruby/Bash/YAML), `<!-- #region ... -->` (HTML/MD/XML), `/* #region */` (CSS).
- Naming: kebab-case, purpose-prefixed: `debug-<x>`, `feat-flag-<x>`, `hotfix-<x>`, `experiment-<x>`.
- Bare author markers (no JSON) are preserved on save; apply-time markers (with JSON metadata) are stripped on save.

## Save modes

```bash
tools stash save <name> --all          # staged + unstaged + untracked
tools stash save <name> --staged       # only staged (git diff --cached)
tools stash save <name> --unstaged     # only unstaged tracked changes
```

If the name already exists, save bumps to vN+1 automatically (no overwrite). Use `tools stash versions <name>` to inspect history.

## Apply

```bash
tools stash apply <name>               # latest version
tools stash apply <name> --at 2        # specific version
tools stash apply <name> --verbose-markers  # include src/applied metadata in markers
```

If a 3-way merge can't reconcile, conflict markers land in the file (`<<<<<<<` / `=======` / `>>>>>>>`) and you resolve manually before continuing. (Apply-conflict state machine is v1.1.)

## Unapply — the state machine

Surgical, reviewable removal. Multi-region stashes generate one decision per ambiguous region.

```bash
tools stash unapply <name>                                # start; auto-removes unchanged regions; prompts on ambiguous
tools stash unapply <name> --continue                     # resume after pause / ctrl+c
tools stash unapply <name> --continue --decision=update   # decide current region (non-TTY)
tools stash unapply <name> --continue --decision=discard
tools stash unapply <name> --continue --decision=skip
tools stash unapply <name> --skip                         # alias for --continue --decision=skip
tools stash unapply <name> --status                       # progress: "5/17 decided"
tools stash unapply <name> --abort                        # discard all decisions
```

Three per-region decisions:
- **`update`** — capture current code state as new vN+1, then remove from code. Use when local edits are worth preserving.
- **`discard`** — remove using stored content, lose local edits. Use when local edits were experimental.
- **`skip`** — leave both code and store alone, warn about divergence. Use when you want to detach: code keeps its own copy, stash keeps its.

Power-user batch (explicit, never default — the `-dangerous` suffix is mandatory):
```bash
tools stash unapply <name> --continue --decision=discard-all-dangerous
tools stash unapply <name> --continue --decision=update-stash-all-dangerous
```

## CRITICAL: never truncate unapply diff output

The unapply state machine prints full diffs to stderr. **Never** pipe through `| head`, `| tail`, or narrow-grep them. The full diff is the only proof you made the right decision for each region. If output is large, redirect to a file (`2> /tmp/unapply.diff`) and read it whole.

## Update — refresh stash from applied site

```bash
tools stash update <name>              # capture current state of applied regions as new vN+1
```

Useful when you've been iterating on an applied overlay for days and want to push your improvements back to the store. Errors if the stash isn't currently applied in the cwd.

## Discovery

```bash
tools stash list                       # all stashes
tools stash list --project             # only ones related to this project (origin + sibling-clone match)
tools stash list --applied             # only ones currently applied here
tools stash show <name>                # region inventory
tools stash show <name> --diff         # patch content
tools stash versions <name>            # version history
tools stash where <name>               # which projects have this applied
```

## Anti-patterns

- Don't stash secrets, API keys, or `.env` content. The store is plaintext on disk.
- Don't stash binary or large (>1MB) files — they're skipped with a warning.
- Don't try to apply the same stash twice to the same project — use `unapply` or `update` instead.