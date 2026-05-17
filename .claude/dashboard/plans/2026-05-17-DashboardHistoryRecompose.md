# Dashboard History Recompose — clean PR #1

**Date:** 2026-05-17
**Status:** AWAITING APPROVAL (destructive: force-push on shared branches, history rewrite)
**Goal:** PR #1 (`feature/dashboard` → `master`) shows ONLY genuine dashboard work as ~12–18 clean conventional commits on top of current `origin/master`. No dashboard work lost.

---

## Why (root cause recap)

- `feature/dashboard` branched from a Jan-2026 master, **never rebased**. PR #1 shows **1189 files** because GitHub diffs against the ancient merge-base; the real delta vs *current* master is **524 files**.
- Of those 524: **`src/dashboard/**` (379) + `src/utils/ui/**` (48) are 0-contested with master** (pure dashboard work). The other **62 are contested drift** (`src/macos/mail`, `jenkins-mcp`, `daemon`, `search`, `cli`, `azure-devops`, `github`, `indexer`, `logger.ts`, `date.ts`, config/docs) — 4 months of cross-cutting edits that ALSO landed on master independently. These are NOT dashboard work.
- `feature/dashboard-prod` (PR #169) = `feature/dashboard` + 20 commits, linear superset → its tip already contains ALL dashboard work.

## Proven-safe strategy: drop-drift recompose (NOT a 163-commit rebase)

Deterministic gate already run and **PASSED**:
- dashboard/ui import nothing from the 62 drift files (self-contained: only `@ui` alias + relative + npm).
- Tentative assembly (`origin/master` + `src/dashboard`+`src/utils/ui` from backup tip) → file tree **byte-identical** to backup, **`tsc -p tsconfig.build.json` 0 errors**.
- ⇒ Taking master's version of all 62 drift files does **not** break the dashboard. We never merge the drift; we drop it (defer to master). Conflicts ≈ none.

## Backups (DONE — rollback anchors)

- Local tags: `backup/dashboard-prod-20260517-175225` (ce20a9a1, incl. housekeeping), `backup/feature-dashboard-20260517-175225` (cf698a4a), `backup/feature-dashboard-prod-remote-20260517-175225` (ebf42cd9), `backup/master-20260517-175225` (0d89de23).
- Remote branches pushed: `backup/dashboard-prod-20260517-175225`, `backup/feature-dashboard-20260517-175225`.
- Rollback = `git push --force-with-lease origin backup/feature-dashboard-20260517-175225:feature/dashboard` (restores pre-rewrite state exactly).

---

## Procedure

### Step 1 — assemble clean branch
```
git checkout origin/master -b feature/dashboard-clean
git checkout backup/dashboard-prod-20260517-175225 -- src/dashboard src/utils/ui
git checkout backup/dashboard-prod-20260517-175225 -- .claude/dashboard .claude/work .claude/plans  # docs (see Open Q2)
```
Everything else = master as-is (drift dropped). Working tree now = target end-state.

### Step 2 — per-config-file hand-merge (the only judgement step)
For each contested config file, base = master; re-apply ONLY the dashboard-required delta:
- `package.json` — add the `src/dashboard` workspace/script entry only (drop unrelated drift).
- `bun.lock` / `pnpm-lock.yaml` — regenerate from the merged `package.json` (`bun install`), don't hand-pick.
- `tsconfig.json` — add only dashboard path/reference additions.
- `.gitignore` — add only the dashboard test-artifact lines (`test-results`, `playwright-report`, `.playwright-mcp`).
- `CLAUDE.md`, `bunfig.toml` — diff master vs backup; keep master unless a line is dashboard-required (expected: none → keep master's).
Each decision recorded inline in the commit body.

### Step 3 — recompose into ~12–18 commits (DRAFT shape — needs your sign-off, Open Q1)
Scoped per master's convention (`feat(scope):`). Proposed slices:
1. `feat(ui): shared @ui component library (shadcn-based primitives)` — `src/utils/ui/**`
2. `feat(dashboard): scaffold TanStack Start app + turbo workspace` — app shell, configs, package.json/tsconfig/.gitignore deltas, turbo.json
3. `feat(dashboard): SQLite + Drizzle data layer + migrations` — drizzle, schema, migrations
4. `feat(dashboard): server-side WorkOS auth + per-user isolation`
5. `feat(dashboard): timer engine (stopwatch/countdown/pomodoro) + SSE/broadcast sync`
6. `feat(dashboard): assistant — tasks kanban, blockers, handoffs, decisions`
7. `feat(dashboard): assistant — what's next / critical path / context parking`
8. `feat(dashboard): Focus Mode`
9. `feat(dashboard): Daily Planner`
10. `feat(dashboard): AI assistant chat`
11. `feat(dashboard): Quick Notes + Bookmarks`
12. `feat(dashboard): dashboard home, settings, profile, shared chrome`
13. `feat(dashboard): production hardening — auth/data-isolation, error boundaries, health, mobile (C1–C8)`
14. `fix(dashboard): infinite render loop on task detail + Settings select wiring`
15. `chore(dashboard): plans, audit reports, ideas docs` — `.claude/**` (or dropped per Open Q2)

Mechanism: `git reset --soft origin/master` on the clean branch, then stage path-by-path per slice (`git add <globs>` → `git commit`). Pure re-slicing of one final tree — no per-commit conflicts.

### Step 4 — VERIFICATION GATE (must pass before any push; "no dashboard work lost")
```
# 1. byte-identical dashboard+ui vs backup — MUST be empty:
git diff feature/dashboard-clean backup/dashboard-prod-20260517-175225 -- src/dashboard src/utils/ui
# 2. file-list parity — MUST match:
diff <(git ls-tree -r --name-only feature/dashboard-clean -- src/dashboard src/utils/ui|sort) \
     <(git ls-tree -r --name-only backup/dashboard-prod-20260517-175225 -- src/dashboard src/utils/ui|sort)
# 3. build green:
cd src/dashboard && bun run build:prod
```
Any failure → STOP, do not push, investigate.

### Step 5 — repoint + push (only after Step 4 green + your approval)
```
git push --force-with-lease=feature/dashboard:cf698a4a origin feature/dashboard-clean:feature/dashboard
```
(`--force-with-lease` pinned to the known SHA; if lease fails the branch moved → stop & investigate, never plain `-f`.)

### Step 6 — PR housekeeping
- PR #1: re-fetch, confirm it now shows ~15 clean commits / ~427 dashboard files vs master, no infra/drift.
- PR #169: close with a comment — its work is folded into PR #1 (clean recompose includes all 20 prod commits' dashboard delta). Delete `origin/feature/dashboard-prod` (backed up).
- Keep `backup/*` refs until PR #1 merges.

---

## Open questions (need your answers before Step 3)

1. **Commit shape** — is the 15-slice breakdown above the granularity you want, or slice differently (e.g., per-route, or fewer/bigger)?
2. **`.claude/**` docs in PR #1** — keep (`chore(dashboard):` commit, ~35 files: plans/audit/ideas/work) or **drop entirely** so PR #1 is strictly dashboard *code*? (You wanted PRs to be only dashboard work — leaning drop, but the audit/plan docs are useful review context.)
3. **Config drift** — confirm: take master's `CLAUDE.md`/`bunfig.toml`/etc. and re-apply only dashboard-required lines (expected near-zero). OK?
4. **PR #169** — confirm close-and-fold (vs keep it as a separate follow-up PR retargeted onto the new clean `feature/dashboard`).

## Rollback

`git push --force-with-lease origin backup/feature-dashboard-20260517-175225:feature/dashboard` + restore `feature/dashboard-prod` from `backup/feature-dashboard-prod-remote-*`. Backups are local tags AND remote branches.

---

## 2026-05-17 — Drift insight (user asked: "maybe there are global fixes worth keeping")

**Answer: NO. Every one of the 62 contested drift files is a stale duplicate of work already on `origin/master`.** The branch's global-fix commits all have a same-subject equivalent already upstream:

- `feat(daemon): harden polling…` → master `4e74b0f2`
- `feat(search): stabilize sqlite-vec…` → master `fa0ddea0`
- `feat(macos-mail): improve search export…` → master `fac7aad4`
- `fix(jenkins-mcp): fall back to /api/json…` → master `8bb219c6`
- `feat(say): auto-fallback to macos TTS…` → master `95150210`
- `feat(claude): claude history dashboard` → master `5eea3a35e`; root scratch docs (CodeExamples/findings/progress/task_plan.md, pnpm-lock.yaml) = junk, drop.

Master often has the *newer* version (e.g. `d5b176d9` fixes `src/logger.ts` specifically for the dashboard's `noUnusedLocals` tsconfig). ⇒ **Drop all 62, defer to master. No scoped global-fix commits needed.** Confirmed safe by the earlier tsc gate (0 errors on master's drift versions).

## Locked decisions (user)

1. Approach: drop-drift recompose ✅ (insight delivered; no fixes to rescue).
2. `.claude/**`: consolidate ALL dashboard docs under `.claude/dashboard/` → single FINAL `chore(dashboard):` commit (not dropped).
3. ~15 per-feature commits.
4. PR #169: close & fold (inherent — `ce20a9a1` ⊃ `feature/dashboard`).

## .claude consolidation (decision 2)
Move into `.claude/dashboard/`: `.claude/work/**`, dashboard-related `.claude/plans/2026-05-*` (DashboardProdReadiness, this recompose plan, reconciliation plans), `.claude/dashboard/ideas/**` (already moved). Result = one `.claude/dashboard/` tree, one final `chore(dashboard): plans, audit, ideas` commit. Non-dashboard `.claude/**` (commands, docs, skills, github, benchmarks, old) = leave as master's (they're repo infra, identical/drift).
