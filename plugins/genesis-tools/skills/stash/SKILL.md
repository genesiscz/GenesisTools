---
name: stash
description: Save/apply/unapply named code overlays across projects with `tools stash`. Use when the user wants to capture a chunk of working-tree changes for re-use, apply a previously saved stash into the current project, shape an applied stash by editing source then capturing the result (update), surgically remove an applied stash with diff review (unapply), inspect drift between stored and applied content (diff), or list/inspect stashes. Triggers on "stash this", "save this overlay", "apply my <name> stash", "pop my debug stash here", "what stashes do I have applied", "merge stashes", "curate this overlay".
---

# `tools stash` — Cross-Project Code Overlay Manager

> **Scope:** describes v1.1 behavior (unified update + unapply walk; curate-after-apply workflow). For v1, see `.claude/plans/2026-06-24-StashTool-spec.md`.

## The mental model

A global named stash store for **overlays you carry across projects** — debug logging, feature-flag dances, hotfix patterns, experiment harnesses. `git stash` is per-repo and not reusable; this is global and shapeable.

Apply wraps each hunk with foldable `// #region @stash:<name>` markers — the editor IS the UI. From there, you shape the stash by editing in the editor and using `tools stash update` to capture what you kept.

Five commands cover 95% of usage:
- **`save`** — dumb snapshot of the working tree (per mode), no walk, no prompting (except same-name confirm).
- **`apply`** — inject the stash + wrap each hunk with markers.
- **`update`** — walk applied regions, classify drift, decide capture/restore/skip per region. Stash stays applied.
- **`unapply`** — same walk as `update` BUT removes the code at the end (and unlinks new-file husks).
- **`diff`** — read-only per-region drift report.

## Authoring discipline (regions in source)

For author markers (bare, no JSON — meaningful BEFORE you save):

```ts
// #region @stash:debug-logger
const log = createDebugLogger();
log.debug('hi');
// #endregion @stash:debug-logger
```

- Language comment syntax adapts: `// #region` (TS/JS/PHP/Java/C/Go/Rust/Swift), `# #region` (Python/Ruby/Bash/YAML), `<!-- #region ... -->` (HTML/MD/XML), `/* #region */` (CSS).
- Naming: kebab-case, purpose-prefixed (`debug-<x>`, `feat-flag-<x>`, `hotfix-<x>`, `experiment-<x>`).
- Bare author markers are **preserved** on save. Apply-time markers (with JSON `{id, v}` metadata, written by `tools stash apply`) are **stripped** on save.

## Save modes

```bash
tools stash save <name>                                  # interactive picker
tools stash save <name> --mode all                       # staged + unstaged + untracked
tools stash save <name> --mode staged                    # git diff --cached
tools stash save <name> --mode unstaged                  # unstaged tracked changes
tools stash save <name> --mode regions --regions A B     # only hunks overlapping @stash:A or @stash:B spans
tools stash save <name> --mode patch                     # git-add-p-style hunk picker (TTY only)
tools stash save <name> --tag <tag>                      # repeatable
tools stash save <name> --desc "<text>"                  # description
tools stash save <name> --force-bump                     # if <name> exists, write v_next without prompting
```

`--mode regions` REQUIRES `--regions <names>`. `--regions` REQUIRES `--mode regions`. They're mutually exclusive with the other modes.

If `<name>` already exists, save shows the v_prev → v_working aggregate diff and prompts `y/n` to bump. Non-TTY without `--force-bump` errors. `save` does NOT modify the working tree; it's a faithful snapshot.

## The state machine (`update` and `unapply`)

Same walk machinery; same verbs (`capture / restore / skip`); same `--continue / --abort / --status` lifecycle. They differ only in what happens at the end:

- `update` keeps the stash applied; advances `applications.version_id` to v_next.
- `unapply` removes the code (markers + body) and marks the application `state='unapplied'`. Also unlinks any file that was created by the overlay (had no HEAD baseline) and is now empty.

Walk classifies each region:
- **unchanged** — auto-decided as `capture` (no prompt, no-op).
- **edited** — markers present, body differs. Prompt.
- **missing** — markers absent from code (you deleted them). Prompt.
- **new-extra** — code has additional @stash:<name> regions not in v_prev. Prompt.

Verbs:
- **capture** — write current code as v_next region.
- **restore** — rewrite code to stored content.
- **skip** — leave both alone, log divergence.

Power-user batch (mandatory `-all-dangerous` suffix; never default):

```bash
tools stash update <name> --continue --decision=capture-all-dangerous
tools stash update <name> --continue --decision=restore-all-dangerous
tools stash unapply <name> --continue --decision=capture-all-dangerous
tools stash unapply <name> --continue --decision=restore-all-dangerous
```

## CRITICAL: never truncate walk diff output

The walk prints full diffs to stderr. **Never** pipe through `| head`, `| tail`, or narrow-grep them. The full diff is the only proof you made the right decision for each region. If output is large, redirect to a file (`2> /tmp/walk.diff`) and read it whole.

---

## Workflow scenarios

### Scenario 1 — Personal debug overlay across sibling clones

You're investigating a flaky test in `col-fe` and want to add `console.log` instrumentation that you'll also apply to `col-fe2` (a sibling clone) where the same bug reproduces.

```bash
# In col-fe — author the markers AS you write the debug code:
# (or write the code first, mark it after — order doesn't matter)

# src/screens/Login.tsx
# // #region @stash:burn-auth-debug
# console.log('callback hit at', new Date().toISOString());
# console.log('queue size:', getQueueSize());
# // #endregion @stash:burn-auth-debug

cd ~/Projects/col-fe
tools stash save burn-auth-debug --mode regions --regions burn-auth-debug
# captures only the marked spans; the rest of your in-progress work is left alone.

cd ~/Projects/col-fe2
tools stash apply burn-auth-debug
# both repos now have the same instrumentation; you can re-run the test in both.

# When done:
tools stash unapply burn-auth-debug   # in col-fe2 (removes instrumentation)
cd ../col-fe
tools stash unapply burn-auth-debug   # in col-fe
tools stash drop burn-auth-debug      # if you don't expect to need it again
```

### Scenario 2 — Curate-after-apply (the headline workflow)

You have a mess of staged changes — some are the actual feature, some are unrelated experiments. You want to stash JUST the feature.

```bash
git status
# M src/api/login.ts        ← feature changes (keep)
# M src/api/logger.ts       ← feature changes (keep)
# M src/utils/random.ts     ← unrelated experiment (drop)
# M src/screens/Home.tsx    ← mixed: some lines are feature, some are experiment

# Step 1: Dumb save of everything staged.
tools stash save login-feature --mode staged

# Step 2: (Optional) Clear the staged changes from the working tree so apply has a clean slate.
git stash push --staged -m "login-feature-pre-curate" -- src/api/login.ts src/api/logger.ts src/utils/random.ts src/screens/Home.tsx
# (Hint: the previous command's success line printed this exact suggestion.)

# Step 3: Apply. Each captured hunk is wrapped with @stash:login-feature markers.
tools stash apply login-feature

# Step 4: In your editor, DELETE the marker pairs for chunks you don't want.
# - Open src/utils/random.ts → fold #region → select the entire @stash:login-feature block (open marker, body, close marker) → delete.
# - Open src/screens/Home.tsx → find the @stash:login-feature blocks → for each one, decide keep or delete.
# - Leave src/api/login.ts and src/api/logger.ts marker blocks alone.

# Step 5: Update the stash to reflect what's left in code.
tools stash update login-feature
#   Walks remaining regions:
#     - src/api/login.ts blocks → classified `unchanged` → auto-capture (no prompt)
#     - src/api/logger.ts blocks → `unchanged` → auto-capture
#     - src/utils/random.ts blocks → `missing` (you deleted them) → prompt:
#         capture (drop from v_next) / restore (re-insert) / skip
#       → you pick `capture` to drop them.
#     - src/screens/Home.tsx blocks → mix of `missing` and `unchanged`; same per-region prompt.
#   On completion: v2 reflects only what you kept. Stash stays applied.

tools stash diff login-feature
#   ✓ "login-feature" applied region matches stored content; no drift
```

### Scenario 3 — Merge two applied stashes into a third (via curate)

You have stash `auth-logging` and stash `feature-flag-debug` both useful for the current investigation. You want a combined stash to hand to a teammate.

```bash
tools stash apply auth-logging          # source now has @stash:auth-logging markers
tools stash apply feature-flag-debug    # source also has @stash:feature-flag-debug markers

# In editor: delete any specific marker blocks you don't want in the combined stash.
# (Skip if you want the full union.)

# Capture everything currently in the working tree as a new stash.
tools stash save investigation-combo --mode all

# Now `investigation-combo` v1 contains the union (minus anything you deleted).
# Note: apply markers from auth-logging and feature-flag-debug are stripped on save;
# investigation-combo's patch is clean.

# Hand it off:
tools stash show investigation-combo --diff > /tmp/investigation-combo.patch
# (Or your teammate pulls from a shared store, future work.)
```

### Scenario 4 — Cross-project transplant + cleanup

You wrote a hotfix in Project X. You realize Project Y has the same bug. You want to drop the hotfix into Y as a starting point, iterate, then save Y's version as a new stash.

```bash
cd ~/Projects/x
tools stash save hotfix-null-deref --mode staged   # capture the hotfix

cd ~/Projects/y
tools stash apply hotfix-null-deref
# 3-way merge might produce inline <<<<<<< conflict markers if Y's code drifted.

# If conflicts: resolve manually, then:
tools stash apply hotfix-null-deref --resume       # (v1.1) — verifies clean, decorates with markers

# Iterate on the applied region; edits get classified as `edited` at update time:
# (you tweaked the null check to match Y's idioms)

tools stash update hotfix-null-deref
#   Region 1/2: src/api.ts → edited → diff shown → pick `capture` (preserves Y's improvements as v2)
#   Region 2/2: src/lib.ts → unchanged → auto-capture
#   ✓ captured 1 region to v2; application now pinned to v2

# Carry the improved v2 back to X (optional):
cd ~/Projects/x
tools stash apply hotfix-null-deref     # gets v2 by default
# Or do an in-place update there too if X's code has also drifted.

# Done. Clean up Y:
cd ~/Projects/y
tools stash unapply hotfix-null-deref
```

### Scenario 5 — "I have an applied stash and I want to know if my edits diverged"

```bash
tools stash diff investigation-combo
# Per-region unified diff between stored and current applied code.
# Exit code 0 if no drift, 1 if drift.

# CI hook for an overlay you want to keep clean:
tools stash diff important-overlay || (echo "drift detected; investigate" && exit 1)
```

## Region name vs stash name (settled model)

Two strings, conceptually independent:

| | Stash name | Region name |
|---|---|---|
| **Where it lives** | `stashes.name` in SQLite + `refs/stashes/<id>/v<n>` in store | `@stash:<name>` tag in source code |
| **Who writes it** | You, via `tools stash save <stash-name>` | You (author marker, no JSON) OR `tools stash apply` (apply marker, with JSON) |
| **Has JSON metadata?** | N/A | Author: no. Apply: yes (`{"id":"abc","v":1}`) |

**Convention:** name them the same string so the round-trip is obvious. `// #region @stash:debug-logger` → `tools stash save debug-logger --mode regions --regions debug-logger`. They CAN diverge (Scenario 3 above), but the default should be alignment.

**Apply markers are stripped on save.** So `tools stash save C --mode regions --regions A B` (where A and B are existing applied stashes) captures the BODIES of A's and B's regions, drops the `@stash:A` / `@stash:B` apply markers, and ends up as a clean stash C whose apply markers will be `@stash:C` when applied next time.

## Anti-patterns

- **Don't stash secrets, API keys, or `.env` content.** Store is plaintext on disk.
- **Don't stash binary or large (>1MB) files** — they're skipped with a warning.
- **Don't apply the same stash twice to the same project.** Use `unapply` or `update` instead.
- **Don't `| head` / `| tail` / narrow-grep walk diff output.** Full diff is the only proof of decisions. Redirect to a file if needed.
- **Don't `git checkout -- <file>` while a stash is applied.** Use `tools stash unapply` to remove cleanly; checkout destroys markers and orphans the application row.
- **Don't expect `--mode all` + `--regions` to work** — they're mutually exclusive. Use `--mode regions --regions <names>`.
