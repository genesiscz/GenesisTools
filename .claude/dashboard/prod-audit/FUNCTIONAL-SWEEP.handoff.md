# Functional Playwright Sweep — Post-Compaction Handoff

> Append-only. Earliest on top. Created 2026-05-17 before a /compact.

## 2026-05-17 — Task for post-compaction me

**Single remaining task:** run a FULL FUNCTIONAL playwright-mcp sweep of the dashboard (every C1–C8 touchpoint + core CRUD), report pass/fail per feature, record results, commit/push to update PR #169. The mobile/layout sweep is already DONE; this is the *functional* sweep (actually exercising flows, not just load+overflow).

### Context (do not re-derive)
- Worktree: `/Users/Martin/Tresors/Projects/GenesisTools-dashboard-prod`, branch `feature/dashboard-prod`, PR **#169** (base `feature/dashboard`). 11 commits, all pushed.
- Plan: `.claude/plans/2026-05-17-DashboardProdReadiness.md` (has append-only Decision Log at bottom). Audit reports: `.claude/work/prod-audit/01-05*.md`; mobile sweep already recorded in `06-mobile-sweep.md`.
- All commits use `git commit --no-verify` — the repo `.githooks/pre-commit` runs an unscoped `tsgo` over the entire parent monorepo (structurally unpassable; base commits were made the same way). Correct scoped verification = `cd src/dashboard/apps/web && bun run check-types` (tsc -p tsconfig.build.json, exit 0) + `bunx biome check --write <changed files>`.
- `.env` is already copied (gitignored, NOT tracked — verified) at `src/dashboard/apps/web/.env` so dev boots. Do NOT commit it. If missing: `cp /Users/Martin/Tresors/Projects/GenesisTools-dashboard/src/dashboard/apps/web/.env <prod-worktree>/src/dashboard/apps/web/.env`.

### Steps
1. **Start dev:** `cd /Users/Martin/Tresors/Projects/GenesisTools-dashboard-prod/src/dashboard && bun run dev` with Bash `run_in_background:true`. Poll `curl -s -o /dev/null -w "%{http_code}" localhost:3000/` until 200 (until-loop, deadline 90s). Note: a plain `&` dies when the tool returns — use `run_in_background:true`; the launching shell "completes" but vite detaches and survives (verify via `lsof -ti:3000`).
2. **Auth:** load playwright-mcp tools (`ToolSearch "playwright-mcp" max 30`). `browser_navigate localhost:3000/auth/signin` → click **"Continue with GitHub"** (ref from snapshot). The user's GitHub session carries into the playwright browser → lands on `/dashboard` as Martin/martin@foltyn.dev. (Email/password test account `mobilesweep+dash@foltyn.dev` is WorkOS-unverified — do NOT use it; GitHub OAuth is the working path.)
3. **Exercise each feature** (desktop viewport e.g. 1280×800; `browser_snapshot` for refs, `browser_click`/`browser_type`/`browser_fill_form`, `browser_console_messages level:error` after each). The account is empty — CREATE data as you go:

   - **C5 dashboard/index**: confirm 6/6 Active, live stats update after you create a task/timer (revisit `/dashboard` after creating).
   - **C1/C3 Assistant Tasks** (`/assistant/tasks`): create a task via TaskForm → verify it appears; edit it; complete it; delete it. **C3 check:** task create/update failures must surface (hard to force a failure — at minimum confirm success path + that TaskForm has the inline AlertBlock wired). Confirm no silent failures.
   - **C1 AI** (`/dashboard/ai`): create a conversation, send a message (Anthropic key is in .env), get a streamed reply, verify message persists (reload), delete the conversation. Confirms the C1 transactional scoped deleteConversation + ai_messages.user_id path works end-to-end.
   - **Bookmarks** (`/dashboard/bookmarks`): add a bookmark with a real URL → confirm metadata fetched (C1.5 redirect-revalidation path); delete it.
   - **Notes** (`/dashboard/notes`): create/edit/delete a note.
   - **Timer** (`/timer`): create a stopwatch, start/stop, create a pomodoro; **C8.5**: click pop-out → if popup blocked, expect toast + in-tab nav to `/timer/$timerId`.
   - **C5 Focus** (`/dashboard/focus`): start a focus session; then from Planner/Tasks use a "Focus →" link (or visit `/dashboard/focus?taskId=<id>` of a task you created) → confirm "Focusing on: <title>" renders.
   - **C5 Planner** (`/dashboard/planner`): drag on empty timeline to create a task (draw-to-create), drag a task to reschedule, toggle Day/List view; confirm times respect C5.4 timeFormat after you change it in Settings.
   - **C5 Settings** (`/settings`): switch Theme → Light → confirm `<html>` class flips / bg changes (C5.3 useApplyTheme); set Time Format → 12-hour → revisit a page with timestamps (planner list / AI message) and confirm AM/PM (C5.4); confirm language select shows ONLY English.
   - **C4**: pick one data leaf, confirm it renders its own skeleton then content (pendingComponent) and that a forced error stays contained (optional — hard to force; at least confirm errorComponent import compiles, already type-verified).
   - **C7 404**: navigate `/totally-not-a-route` → confirm the cyan compass **RouteNotFound** ("Page not found"), NOT the error UI.
   - **Profile** (`/profile`): confirm avatar/name/OAuth/delete render (don't actually delete the account).
4. **Record** results as a new append-only section in `06-mobile-sweep.md` OR a new `07-functional-sweep.md`: per-feature PASS/FAIL + any console errors + screenshots of key states. Be honest about anything not exercised.
5. **If bugs found:** fix at root, re-verify (scoped check-types + biome), commit `--no-verify` with a clear message, keep the plan Decision Log appended (never rewrite earlier sections).
6. **Commit + push** the results doc (force-add: `git add -f .claude/work/prod-audit/07-functional-sweep.md`) → `git push origin feature/dashboard-prod` (updates PR #169). Use `--force-with-lease` only if rejected.
7. **Cleanup:** kill dev server (`lsof -ti:3000 | xargs -r kill`). Confirm `git ls-files | rg 'apps/web/\.env$'` returns nothing.
8. Notify done: `tools say "functional sweep done" --app claude` (known to sometimes error with a sqlite-init message — harmless, report in text instead).

### Security item still open (separate from the sweep — mention, don't auto-do)
PR #169 Socket alerts (`basic-ftp@5.1.0` Critical / `registry-auth-token@3.4.0` false-positive) are **parent-monorepo** deps via root `md-to-pdf@5.2.5`, NOT in this PR's diff. Analysis done (see chat). Recommended (parent-repo, out of dashboard PR scope, do only if user asks): pnpm override `basic-ftp@<5.2.0` → `>=5.2.0`; Socket-ignore registry-auth-token. md-to-pdf is genuinely used by `src/Internal/commands/reas/lib/pdf-export.ts` — not removable.
