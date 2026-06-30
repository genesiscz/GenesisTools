# Stash Tool v1.1 — Design Spec

**Date:** 2026-06-25
**Status:** Draft (post-advisor revision; plan write-up next)
**Author:** Martin + Claude (session 7cb77c59)
**Supersedes (partially):** `.claude/plans/2026-06-24-StashTool-spec.md` — v1.1 is incremental, the v1 spec stays load-bearing for everything not re-specced here.

---

## 1. Summary

v1 shipped capture (save), apply (with marker-wrapping), and surgical removal (unapply with a multi-region decision walk). v1.1 closes the v1 deferred backlog, and — more importantly — settles a UX model that makes the everyday workflow obvious instead of clever.

**The core insight:** the editor IS the UI. Apply wraps each captured hunk with foldable `// #region @stash:<name>` markers. From there, the user shapes the stash by **deleting marker pairs in their editor** — no special CLI surface needed for "select what to keep." When they're done curating, `tools stash update` walks the remaining regions, classifies each (unchanged / edited / missing), and asks one decision per ambiguous region: `capture`, `restore`, or `skip`.

This collapses three v1 ergonomic gaps into one mechanism:
- "How do I save only some regions?" → apply, delete the unwanted ones in the editor, `update`.
- "How do I merge two applied stashes?" → apply both, delete what doesn't belong, `update --into <newname>`.
- "How do I capture the changes I made to an applied stash?" → `update` (the curation walk catches the edits).

Save stays dumb: take the working tree, write a faithful snapshot, bump if name exists. No per-region prompting at save time. Curation is downstream.

## 2. Goals (v1.1)

- **G1.** Land all 10 v1-deferred items (most as small focused tasks; some in waves).
- **G2.** Unify **update + unapply** UX (not save). One walk machine, one verb set, one diff renderer. Save is correctly NOT part of this.
- **G3.** Make the curate-after-apply workflow obvious in docs, the README, and the skill. Stop conflating region-scoped saves with editor-driven curation.
- **G4.** Save same-name: aggregate v_prev → v_working diff + single yes/no confirm. NOT a per-region walk. Save remains a faithful snapshot.
- **G5.** Settle the region-name vs stash-name conceptual model in code, docs, AND the skill — so agents stop conflating them.
- **G6.** Fix the v1 audit's one remaining active bug (D-31: regions table never populated).
- **G7.** Don't ship complexity that doesn't pay for itself. Each new feature must reduce decisions, not add them.

## 3. Non-Goals (v1.1)

- **NG1.** Still no remote sync, encryption at rest, AST-aware refactoring, or cross-VCS support.
- **NG2.** No fundamental change to the bare-git-repo store or the SQLite schema beyond additive migrations.
- **NG3.** No breaking changes to v1 stashes. v1-saved stashes apply / unapply / update unchanged under v1.1.
- **NG4.** No interactive TUI dashboard.
- **NG5.** No per-region walk on `save` over an existing name. Save is a snapshot; treating it as a merge target violates the "faithful capture" invariant. (See §15 — explicitly rejected.)

## 3a. Architectural Constraint: Dumb Commands, Smart Lib

A discipline carried forward from v1's CLAUDE.md ("Commands as controllers: treat src/<tool>/commands/ files as thin wrappers — parse args, call into src/<tool>/lib/ for business logic. Keep commands lean, keep logic in lib/.") In v1.1 this is **non-negotiable** for every command rewrite. Each command file should:

- Parse the CLI arguments commander passes in.
- Resolve the project, open the DB, open the storage.
- Call exactly ONE lib function per code path (start / continue / abort / status).
- Render the lib's return value via `ui.*` (status to stderr) or `out.print()` / `out.result()` (machine output to stdout).

Lib functions own:
- All decision-making, classification, state-machine transitions.
- All filesystem reads/writes (except `ui.*` writes to stderr).
- All DB writes.
- All git invocations.

Tests:
- Lib tests cover behavior with mock-friendly inputs (tmpdir, in-memory DB).
- Command tests cover argument parsing and the "command → lib" wiring only.

This means in v1.1, every command file in `src/stash/commands/*` should fit on a single screen. Anything longer than ~60 lines of non-comment code in a command is a code smell — push it into lib.

## 4. The Curate-After-Apply Workflow (Headline)

The everyday flow, in five steps:

```
1. Author code in the working tree. Stage what you want to stash.
2. tools stash save <name> --mode staged
   → Faithful snapshot of the staged diff. No prompts.
3. tools stash apply <name> [in same project to round-trip, or another to transplant]
   → Each captured hunk gets wrapped with // #region @stash:<name> markers.
4. In your editor: delete entire marker pairs (open + body + close) for any region
   you decided you don't actually want in this stash.
   → Foldable regions in VS Code / JetBrains / vim make this a 2-keystroke move per block.
5. tools stash update <name>
   → Walks every recorded region of <name>. Each region is classified:
       unchanged  → auto: capture (no prompt — current matches stored)
       edited     → prompt: capture (write current as v_next) | restore (rewrite code to stored) | skip
       missing    → prompt: capture (mark deleted in v_next, drops the region) | restore (re-insert from stored) | skip
       new-extra  → prompt: capture (add to v_next) | discard (delete from code) | skip
   → On completion: v_next reflects exactly what's left in the editor. Stash is curated.
```

This is the workflow the user keeps reaching for ("just let me apply, edit, save the result"). v1.1 makes it the documented happy path.

## 5. The Unified Decision Walk (update + unapply only)

### 5.1 Scope

Shared by `update` and `unapply`. NOT by `save`. The two commands that walk regions are the two commands operating on an *already-applied* stash where divergence between stored and current is meaningful.

`save` is a snapshot of the working tree; there's nothing to walk because there's no prior "stored" state to diverge from (or for same-name saves, the prior version IS the stored state but the comparison answer is "what does the user want to ship as v_next" — `save` answers this implicitly by capturing the tree faithfully and offering a single aggregate confirm).

### 5.2 The single verb set: `capture / restore / skip`

| Verb | Effect on store | Effect on code | Symmetry note |
|---|---|---|---|
| `capture` | Write the CURRENT code state into v_next | (for `unapply`) Remove region after capturing | "What's in the editor is the new truth." Same meaning in update and unapply. |
| `restore` | No store change | Rewrite the code to match STORED content; if region is missing, re-insert it | "What's in the store is the truth — undo my edits." |
| `skip` | No store change | No code change | "Leave both alone, accept divergence." |

These three verbs cover all four region classes (unchanged / edited / missing / new-extra). `unchanged` is the auto-fast-path: applied silently as `capture` (the stored content and current content are identical, so capturing produces a no-op).

### 5.3 The blanket batch flag

Same as v1 unapply:
```bash
tools stash <verb> <name> --continue --decision=capture-all-dangerous
tools stash <verb> <name> --continue --decision=restore-all-dangerous
```

The `-dangerous` suffix is mandatory. Intentionally unergonomic so it's never typed by accident.

### 5.4 Shared CLI surface

```bash
tools stash update <name>                       # start
tools stash update <name> --continue            # resume from paused state
tools stash update <name> --continue --decision=capture
tools stash update <name> --continue --decision=restore
tools stash update <name> --continue --decision=skip
tools stash update <name> --skip                # alias for --continue --decision=skip
tools stash update <name> --abort               # discard decisions, no state changes
tools stash update <name> --status              # show progress
```

Substitute `unapply` for `update`. Same flag shape, same state file format, same TTY/non-TTY rendering. The only difference at the code level: at end of walk, `unapply` ALSO unlinks file husks for created-at-save-time files and writes a `state='unapplied'` row to the applications table.

### 5.5 State file (extended from v1)

```json
{
  "verb": "update" | "unapply",
  "stashId": "...", "stashName": "...", "projectPath": "...", "projectHash": "...",
  "startedAt": "...", "regions": [...], "currentIndex": N, "pausedAt": "...",
  "extension": {  // verb-specific
    "currentVersionId": "uuid",   // update only
    "targetVNext": N+1            // update only — pre-computed so resume is deterministic
  }
}
```

File naming: `<project-hash>--<verb>--<stash-id>.json` (same as v1).

v1 state files without a `verb` field are read as `verb: "unapply"` on load for back-compat. Migrated to the new format on first write.

### 5.6 Preserving v1 unapply correctness fixes during refactor

When the walk machinery is extracted into a shared `lib/walk.ts`, the following audit-confirmed v1 fixes MUST be preserved with a test each:

- **D-22**: `applyDecisionToCode` uses `byName[hunkIndex - 1]`, not `find()`. Multi-hunk files would otherwise always target hunk 1.
- **D-23**: `processAutoRemoves` and `executeAllDecisions` iterate per-file BACK-TO-FRONT by hunkIndex. Forward iteration corrupts line numbers for later regions.
- **D-25**: `failedToFind` is tracked; if > 0, the application stays `active` and the session persists for retry instead of falsely claiming `unapplied`.

The refactor PR description must enumerate these explicitly. The corresponding tests already exist for unapply; they need to be parameterized over `{update, unapply}` to enforce the same correctness for `update`.

## 6. save — Behavior in v1.1

### 6.1 First-time save

Unchanged from v1. Captures working-tree per mode (`--mode staged | unstaged | all`), writes a faithful snapshot as v1.

### 6.2 Same-name save (the small new behavior)

When `<name>` already exists at v_prev:

1. Compute v_next's would-be patch from the working tree.
2. Build the aggregate diff `v_prev_patch ↔ v_next_patch` (whole-patch unified diff, not per-region).
3. Render the aggregate diff (stderr, via `@app/utils/diff`'s `renderUnifiedDiff`).
4. Single clack prompt: `Proceed? (y / n / abort)`. `y` writes v_next; `n` exits without writing; `abort` is a synonym for n.
5. **Non-TTY:** print the diff to stderr, exit non-zero with a `--force-bump` suggestion. No interactive prompt possible without TTY; require an explicit override flag.
6. `tools stash save <name> --force-bump` skips the prompt and writes v_next silently (matches v1 behavior — scripts that genuinely want auto-bump opt in).

This is the version of "diff/confirm UX" the user actually agreed to. NOT a per-region walk (rejected — see §15).

### 6.3 `--mode regions --regions <names...>` — the explicit-subset shortcut

Made stricter in v1.1: `--regions` is no longer accepted with `--mode all`/`staged`/`unstaged`. It requires `--mode regions`. This makes the four modes mutually exclusive and the user's intent unambiguous on the command line.

```bash
tools stash save x --mode regions --regions foo bar    # OK: capture only @stash:foo and @stash:bar spans
tools stash save x --mode regions                      # ERROR: --mode regions requires --regions <names>
tools stash save x --regions foo                       # ERROR: --regions only valid with --mode regions
tools stash save x --mode all --regions foo            # ERROR: --regions only valid with --mode regions
```

Filters captured hunks to those overlapping author OR apply markers matching the given names. This is a power-user shortcut — equivalent to "save, apply, delete unwanted regions, update" but in one command when the author has already marked their regions in source.

**When to use `--mode regions` vs the curate-after-apply workflow:**
- `--mode regions` when you authored bare markers in source code BEFORE saving, with no apply step needed. One-shot capture.
- Curate-after-apply when you didn't pre-mark, OR when you're combining content from already-applied stashes, OR when "what to keep" is easier to decide visually in your editor than via a CLI flag.

## 7. apply — Unchanged in v1.1

v1 behavior is correct. apply: inject patch → wrap each hunk with `// #region @stash:<name> {json}` apply-time markers → record `applications` row with `state='active'`.

Two small additions are deferred-from-v1 items (see §8):
- §8.5: apply-conflict state machine for when `git apply --3way` returns conflicts.
- §8.9: author-marker-aware region splitting (multiple named regions per file instead of one per hunk).

## 8. The Deferred-From-v1 Backlog (the other 9 items)

**Wave 1 — must ship in the first v1.1 PR alongside the unified-walk refactor:**

### 8.1 Standalone `update` command — §5 above.

### 8.2 `tools stash diff <name>`

```bash
tools stash diff <name>           # diff applied regions in cwd vs stored
tools stash diff <name> --at vN   # diff vs a specific version (default: applied version)
```

Uses `@app/utils/diff`'s `renderUnifiedDiff`. Output to stdout (capturable), labels to stderr. For each region: a unified diff block with `--- stored:<file>:<hunk>` / `+++ current:<file>:<hunk>` headers.

Errors if stash isn't applied in cwd. For the full stored patch (no current-vs-stored comparison), use `tools stash show <name> --diff`.

### 8.3 Close audit D-31 (regions table population)

Add per-hunk INSERTs to `regions` inside `saveCommand` after the version row is written. AND a backfill migration `002-populate-regions-table.ts` that walks every existing version, parses its stored PATCH.diff, and writes the missing region rows.

This fixes `tools stash show <name> --regions` (the default `show` mode) so the table actually shows hunks instead of empty.

**Framing note:** D-31 is NOT the symptom from the original handoff. The handoff's "regions: 0" was the `versions.region_count` header field, which counts `@stash:` markers in the saved patch — the user's overlay had no author markers, so 0 was correct. D-31 only affects the per-row inventory (`show --regions` mode), which the original handoff didn't run. Fix D-31 anyway — real bug, just don't claim it explains the original symptom.

### 8.4 `--patch` interactive save (git-add-p style hunk picker)

Three-phase clack flow:
1. Discover hunks via `git diff --no-color [--cached] -U3` per file.
2. For each hunk: render with `renderUnifiedDiff` + clack prompt `(y / n / q / s)` — yes/no/quit/split-finer.
3. Accumulate accepted hunks into the captured patch.

Estimated ~250 LOC new code in `src/stash/lib/patch-picker.ts`.

**Wave 2 — second v1.1 PR, after Wave 1 lands and the unified walk is proven:**

### 8.5 Apply-conflict state machine

Mirrors the unified walk machinery from §5. Created when `git apply --3way` returns conflicts:
1. State file: `state/<project-hash>--apply--<stash-id>.json`.
2. Tracks per-file conflict resolution status.
3. `tools stash apply --resume` checks every conflicted file for remaining `<<<<<<<` markers; advances to "decorated" once clean.
4. `tools stash apply --abort` runs `git apply -R` on the partial application and clears state.

### 8.6 Author-marker-aware unapply (and update)

v1 derives "regions" from patch hunks. v1.1 wave 2 splits hunks at author-marker boundaries when extracting `stored` content from the patch — so one stash can have N named regions per file, not just N anonymous hunks. Region names come from the source's `@stash:<name>` open markers; anonymous hunks keep `name = null`.

This makes the editor-curation workflow more granular: deleting a smaller named region (instead of a whole hunk) is easier on a complex file.

**Wave 3 — focused follow-ups, can ship independently after wave 2:**

### 8.7 `tools stash doctor`

Consistency check:
1. `git -C store fsck --strict` — flags object-DB corruption.
2. Walks `stashes` rows, confirms `refs/stashes/<id>/v<n>` exists in store.
3. Walks `applications` rows with `state='active'`, confirms `version_id` references exist and have matching markers in the recorded `project_path`.
4. With `--rebuild`: regenerates the sqlite `regions` table from patch refs. (Redundant after 8.3 ships; useful for users on older v1.1 installs that pre-date the migration.)

### 8.8 `tools stash rebase-project <old> <new>`

Migrates `applications.project_path` when a project moves on disk:
1. Lookup all active applications with `project_path = <old>`.
2. Verify `<new>` exists and has the expected markers (sanity check).
3. UPDATE the rows. Audit-log to `~/.genesis-tools/logs/`.

### 8.9 Tree-hash sibling-clone detection (v1 spec §8 fallback #3)

When `remote.origin.url` is empty AND the dir-pattern heuristic fails:
1. Compute Jaccard similarity of top-100 file paths between candidate projects.
2. Cache in `projects.tree_hash`.
3. Threshold 0.7 (per v1 spec). Tunable via hidden `--similarity-threshold`.

**Wave never — explicitly out of v1.1:**

### 8.10 Remote sync

Out of scope. v2 candidate. Mentioned only because it was in the v1 deferred list (item 10).

## 9. Region Name vs Stash Name — Settled Model

Two strings, conceptually independent:

| | Stash name | Region name |
|---|---|---|
| **Where it lives** | `stashes.name` in SQLite + `refs/stashes/<id>/v<n>` in store | `@stash:<name>` tag in source code |
| **Who writes it** | User, via `tools stash save <stash-name>` | Either the user (author marker, no JSON) or `tools stash apply` (apply marker = stash name, with JSON metadata) |
| **Uniqueness** | Globally unique (database constraint) | Free-form, can repeat across files |
| **JSON metadata?** | N/A | Author: no. Apply: yes (`{"id":...,"v":...}`) |

**Convention (encouraged by skill + the marker-authoring instructions in `save.ts`):** name your author region the same as the planned stash name. `// #region @stash:debug-logger` → `tools stash save debug-logger`.

**Reality (after this revision):** apply markers ARE stripped on save by `stripApplyMarkersFromPatchFiles`. So the v1.0 spec's claim that "inner @stash:A / @stash:B author markers persist inside an outer @stash:combined wrap" is **false for apply markers**. It's true for *author* markers (bare, no JSON). Concretely:

- Apply stash A → source has `@stash:A {"id":...,"v":1}` markers (with JSON).
- Apply stash B → source has `@stash:B {...}` markers.
- `tools stash save combined --regions A B`: hunks overlapping spans of @stash:A and @stash:B are kept; THEN `stripApplyMarkersFromPatchFiles` removes the `@stash:A` and `@stash:B` opener/closer lines themselves (because they're apply markers, with JSON).
- Stash `combined`'s patch contains the bodies of A and B's regions, WITHOUT any inner stash markers.
- On apply of `combined`: hunks get wrapped with `@stash:combined` apply markers. Source has only `@stash:combined` markers.

For the curate-after-apply workflow, this is the right behavior — the user wants a clean output, not nested markers. If a user genuinely wants nested markers, they author them as bare markers (no JSON) and save preserves those.

## 10. Data Model Changes

Additive only. No column changes to existing tables. Two new migrations:

### Migration `002-populate-regions-table.ts`

Backfills the `regions` table from every existing `versions` row's stored PATCH.diff. For each hunk: derive `(file_path, hunk_index, line_count, region_name)` from the patch + marker parse, INSERT into regions.

Idempotent — checks `SELECT COUNT(*) FROM regions WHERE version_id = ?` and skips if already populated.

### Migration `003-state-file-verb-tag.ts`

No DB change. Adds a one-time scan of `~/.genesis-tools/stash/state/*.json`, rewriting any v1-format file (no `verb` field) to v1.1 format (verb derived from filename pattern: `<hash>--<verb>--<id>.json` → `verb` field).

Idempotent — skips files that already have a `verb` field.

## 11. v1 Audit — What's Closed in v1.1, What's Already Fixed

The 2026-06-25 v1-vs-plan audit found 11 BUG-RISK divergences. **All but one are already silently fixed in v1's code** (the v1 plan was wrong; the v1 code corrected it during build but never updated the plan). The remaining active bug is D-31.

**Closed in this spec:**
- **D-31** (regions table never populated) — §8.3 above.

**Already silently fixed in v1 code, called out in the v1.1 plan as "verify these tests stay green":**
- D-5 (migration table name vs test assertion mismatch — verify in audit harness)
- D-6 (`git mktree` paths-with-slash failure — code uses `writeTreeViaIndex`)
- D-9 (CSS marker regex `\/\*` vs `\*\/` flip — code has fix)
- D-12 (stdin-before-drain deadlock — code has drain-first)
- D-15 (strip-markers `@@` header recomputation — lib/strip-apply-markers.ts)
- D-19 (invalid ref name with leading `.` — code dropped the dot)
- D-21 (deletion-hunk empty marker pair guard — code has `newLines === 0` skip)
- D-22 (`find()` always picks first marker — code uses `byName[hunkIndex-1]`)
- D-23 (forward-iteration line-number corruption — code uses descending order)
- D-25 (false `unapplied` claim — code tracks `failedToFind`)

**Audit-flagged drift requiring v1.1 decisions (resolved here, see §12 + §13):**
- **D-28**: `diff-render.ts` shells out to system `diff` binary. **Decision:** v1.1 replaces this with `@app/utils/diff`'s `renderUnifiedDiff` (no `diff` binary dependency, no temp files, matches Task 16's intent). The replacement happens during the unified-walk refactor in Wave 1.
- **D-38**: `lib/ui.ts` bypasses `@app/logger`'s `out.log.*` convention. **Decision:** v1.1 keeps `lib/ui.ts` BUT promotes it to `src/utils/cli/ui.ts` as a blessed pattern for high-density CLIs (status-heavy commands where clack's `│ ◆ ●` box-drawing is the wrong texture). Updates the root CLAUDE.md `Logging & output` section to document this. The CI guard at `scripts/ci/logging-guard.sh` gets a carve-out for tools that import from `@app/utils/cli/ui`.

## 12. Diff Renderer — One Path Chosen

Per §11's D-28 resolution: **v1.1 uses `@app/utils/diff`'s `renderUnifiedDiff`** everywhere a diff is rendered. The system `diff` binary shell-out in `src/stash/lib/diff-render.ts` is replaced. This:
- Removes the runtime dependency on `diff` being on PATH (portable to barebones containers / minimal Linux distros).
- Eliminates temp-file sync I/O for an in-memory call.
- Matches v1 plan Task 16's original intent.

The `lib/diff-render.ts` file stays as the per-stash-tool wrapper but now delegates to `@app/utils/diff`.

## 13. Logging & Output Discipline — One Path Chosen

Per §11's D-38 resolution: **v1.1 keeps the chalk-based `ui.*` pattern** (high-density stderr status without clack box-drawing) BUT promotes it to a shared utility:

- Move `src/stash/lib/ui.ts` → `src/utils/cli/ui.ts`.
- Update root CLAUDE.md `Logging & output` section to document `ui.*` as the canonical pattern for high-density CLIs (alongside the existing `out.log.*` guidance for clack-shaped flows).
- Add a CI-guard carve-out so stash files importing from `@app/utils/cli/ui` aren't flagged.

`out.print()` / `out.result()` stay the only writers to stdout for machine-readable output (unchanged from v1 spec §12).

## 14. Testing Strategy (v1.1 additions to v1's strategy)

Tests live as `*.test.ts` alongside source; e2e tests in `src/stash/e2e.test.ts`. v1.1 adds:

1. **Curate-after-apply roundtrip:** save → apply → delete marker pair → update → assert v_next reflects deletion + apply v_next in third project shows only kept regions.
2. **Update standalone:** apply → edit one region → `tools stash update` → assert (a) v_next exists, (b) applications.version_id advances to v_next, (c) state file removed on completion.
3. **Same-name save aggregate-diff confirm:** save v1 → modify → save v2 (TTY: prompt-yes; non-TTY: error → re-run with `--force-bump`) — assert v2 is a faithful snapshot, NOT a hybrid.
4. **Multi-region curate (the merge workflow):** apply A → apply B → user deletes some marker pairs (simulated via writeFile) → `tools stash save merged --mode all` → apply merged → assert kept content is present.
5. **D-31 regression test:** save 3 hunks → query `regions` table → assert 3 rows present with correct file_path / hunk_index.
6. **Walk state-file round-trip parametric over {update, unapply}:** start walk → write state → re-load → `--continue` from disk → assert resumes at correct region.
7. **Apply-conflict state machine (wave 2):** apply with intentional conflict → assert state file written + conflict markers in target → `--resume` after manual resolution → assert clean exit.

## 15. Explicitly Rejected (with reasoning)

These were considered and intentionally NOT included. Recorded so future readers don't re-litigate.

### 15.1 Per-region walk on save same-name

**Rejected** (twice — first by advisor, then re-questioned and re-rejected by Martin) because it breaks the "save = faithful snapshot" invariant. A v_next built by mixing v_prev-region content with working-tree-region content yields a synthetic hybrid that matches neither — debuggers and reviewers can't reason about it. The curate-after-apply workflow (§4) covers the legitimate need with strictly better ergonomics: you curate in your editor, where the surrounding code is visible.

The advisor's exact phrasing: *"`keep-old for region X` yields a v2 that matches neither v1 nor the working tree, a synthetic hybrid nobody can reason about, and it directly violates the repeated 'don't make it too complicated.'"*

The symmetry between save and update is superficial:
- **`update`'s `(stored, current)` pair** = `(applied region's stored content, current code between apply markers)`. Both endpoints are well-defined per region — there's a marker pair in source code anchoring the comparison. Per-region decisions are meaningful: which of these two does v_next reflect?
- **`save same-name`'s `(stored, current)` pair** = `(v1's PATCH.diff content, working-tree captured patch content)`. These aren't aligned per region — the working tree may have added/removed/moved hunks since v1. Per-region matching is fuzzy at best; a "merge" outcome is a synthetic hybrid that matches neither v1 nor the working tree.

What v1.1 does instead: §6.2's aggregate-diff confirm (one yes/no), and `--force-bump` for scripts. If a user genuinely wants per-region control over what's in v_next, the canonical path is **save dumb → apply → delete unwanted marker pairs in editor → update**. That's the curate workflow (§4) — strictly better than a save same-name walk because the user is making decisions visually with full context, not in a CLI prompt with just two text blocks.

### 15.2 Unified verb vocabulary across save + update + unapply

**Partially rejected.** save is correctly NOT in the walk machinery, so it doesn't need decision verbs at all. update and unapply DO share verbs (`capture / restore / skip`) per §5.2.

### 15.3 Merging stashes via save with simultaneous per-region selection

**Rejected** in favor of the editor-based curate flow. "Apply A, apply B, delete what you don't want, save as C" works without any new mechanism — and is more obvious because the user is shaping the final stash visually.

## 16. Out of Scope (v1.1)

- Remote sync / publishing.
- Encryption at rest.
- AST-based region detection.
- Auto-application via direnv.
- Cross-VCS support.
- Stash composition with formal dependency graph (the merge workflow in §4 is textual union, not graph).
- A web/TUI dashboard.

---

**End of v1.1 spec.** Plan write-up next: `2026-06-25-StashTool-plan.md`. The plan structures the work into three waves (Wave 1 = unified walk + standalone update + save same-name confirm + D-31 + `--patch` + `tools stash diff`; Wave 2 = apply-conflict state machine + author-marker-aware unapply; Wave 3 = doctor + rebase-project + tree-hash). Each wave is shippable independently.
