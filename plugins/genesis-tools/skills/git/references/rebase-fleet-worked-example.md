# Worked example — two real rebases (sanitized)

Self-contained illustrations of the two situations you hit most: a small branch
with one **real-code conflict you must merge both ways**, and a long
**import-heavy** branch where the fast-path does the mechanical work and you only
hand-resolve the rest. Names are genericized; `<MAIN>` is the moved main branch.

---

## Example 1 — small branch, 1 conflict, merge BOTH sides' intent

**Setup.** 6-commit branch `feature/add-checker` rebased onto `<MAIN>`. The branch
adds a new `check-violations` script. Meanwhile `<MAIN>` migrated all script
runners from `tsx` → `bun` (a batch that landed while the branch sat open).

**The conflict** (commit 3/6, in `package.json` `"scripts"`):

`<MAIN>` side (HEAD/ours) — the runner migration:
```json
    "imports": "bun scripts/imports/index.ts",
    "circular-deps": "bun scripts/circular-deps-checker/check.ts"
```

branch side (incoming/theirs) — adds the new script, still on the old runner:
```json
    "imports": "tsx scripts/imports/index.ts",
    "check-violations": "tsx scripts/check-violations/index.ts",
    "circular-deps": "tsx scripts/circular-deps-checker/check.ts"
```

**Correct resolution (manual — keep BOTH intents):**
```json
    "imports": "bun scripts/imports/index.ts",
    "check-violations": "bun scripts/check-violations/index.ts",
    "circular-deps": "bun scripts/circular-deps-checker/check.ts"
```

**Why neither whole side is right:**
- `-X theirs` (take branch) would revert `imports`/`circular-deps` back to `tsx` —
  **undoing `<MAIN>`'s migration.**
- `-X ours` (take `<MAIN>`) would drop `check-violations` entirely — **deleting the
  branch's whole deliverable.**
- Correct = keep `<MAIN>`'s `bun` runtime **and** keep the branch's new
  `check-violations` entry, converting it to `bun` for sibling-consistency.

This single hunk is the canonical reason the no-`-theirs`/`-ours` rule exists.

**Lockfile note.** On the first rebase, install bumped the lockfile by a few lines
(pure workspace self-version catch-up, no dependency drift) — committed so the tree
was clean. `<MAIN>` later received the *same* bump, so on re-rebase git auto-dropped
that reconcile commit ("skipped previously applied commit"). Takeaway: when `<MAIN>`'s
lockfile is current, install produces no drift and this is a no-op.

**Verify gate result:** PASS — all functional patches byte-identical; only deltas were
the intended `tsx→bun` resolution + hunk-header context drift (a signature `<MAIN>`
changed independently). No work lost.

---

## Example 2 — 62-commit branch, import-heavy, use the fast-path

**Setup.** Big rewrite branch `feature/dashboard-rewrite` (62 commits) onto `<MAIN>`.
merge-tree had predicted "2 import-only files" — a gross under-count: a rebase
replays all 62 commits and conflicts at *intermediate* ones. (Lesson: tier by commit
count → this was correctly routed as a **separate sequential agent**, not fanout.)

**Resolution.** Ran the import fast-path. It lives in the internal `rebase-prs` skill
(`scripts/resolve-imports.ts`), not in this one; without that skill the same conflicts are
resolved by hand, or per hunk with `scripts/resolve-hunks.ts`:
```bash
bun "$CLAUDE_PLUGIN_ROOT/skills/rebase-prs/scripts/resolve-imports.ts" <worktree>
```
It auto-resolved the **import-only** hunks toward the branch side and stopped (exit 2)
at the first real-code conflict for a hand merge; re-running continued past it. Net:
3 import-only conflicts auto/union-resolved, 59 commits applied clean.

**Why "take the branch side" is safe for import-only hunks:** the two sides were the
*same imports* in different forms — `<MAIN>` had the normalized full path
(`packages/foo/src/useThing`), the branch had a pre-normalization alias
(`foo/useThing`). The normalization step (step 5) re-normalizes every alias → full
path afterward, so the branch side + normalization == `<MAIN>`'s form.

**The real import gate is NOT range-diff.** range-diff ignores import lines, so a
wrongly-resolved import passes it silently. Proof of correctness was: typecheck green
+ tests green. (Here, normalization rewrote 6 files; tsc + most tests then passed.)

**A pre-existing-red lesson from this branch:** a few tests still failed after the
rebase. One was a genuine regression from a `<MAIN>` dependency bump (a reanimated 4.x
major) breaking a **shared test mock** — fixed the mock once (small), which belongs on
`<MAIN>` so all branches inherit it. The remaining failures were **behavioral domain
logic** (a tile double-rendering after the rewrite met `<MAIN>`'s changes) — NOT
mechanical, NOT obviously a rebase bug, so they were **handed back to the author**
rather than force-greened. When in doubt whether red is pre-existing, diff the file
against the backup tag: no change ⇒ not your rebase.

**Verify gate result:** PASS on patch preservation; HELD on push because behavioral
tests were still red and were flagged for the human, not papered over.
