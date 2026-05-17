# 07 — Full Functional Playwright Sweep

**Date:** 2026-05-17
**Branch:** `feature/dashboard-prod` · PR **#169** (base `feature/dashboard`)
**Auth:** logged in as Martin / martin@foltyn.dev via GitHub OAuth (carried into the playwright browser)
**Method:** real interaction (create/edit/delete data, not just page loads); `browser_console_messages level:error` checked after each feature; desktop viewport 1280×800.

> This is the *functional* sweep (exercising flows). The *layout/responsive* sweep is `06-mobile-sweep.md`.

## Result summary

| # | Feature | Result |
|---|---------|--------|
| C5 | dashboard/index — 6/6 Active + live stats | ✅ PASS |
| C1/C3 | Assistant Tasks CRUD | ✅ PASS (+ found & fixed a P0 freeze) |
| C1 | AI chat conversation + scoped delete | ✅ PASS (reply untestable — empty key, see note) |
| — | Bookmarks add+metadata+delete | ✅ PASS |
| — | Notes create/edit/preview/delete | ✅ PASS |
| C8.5 | Timer create/start/pause/popout/types/delete | ✅ PASS (blocked-fallback not force-triggerable) |
| C5 | Focus session + `?taskId` | ✅ PASS |
| C5 | Planner view toggle + Focus→ link | ✅ PASS (drag-to-create not falsifiable via synthetic dnd) |
| C5 | Settings theme + timeFormat | ✅ PASS (+ found & fixed a P1 bug) |
| C7 | 404 RouteNotFound | ✅ PASS |
| C4 | per-leaf pendingComponent skeleton→content | ✅ PASS (observed on every data route) |
| — | Profile render | ✅ PASS |

**Console: 0 JS errors across every feature.** The only `[ERROR]` lines are expected HTTP status loads — the AI `/api/ai-chat` 503 (empty `ANTHROPIC_API_KEY`, see note) and the intentional 404 status on the not-found route. Neither is a JS fault.

---

## Bugs found & fixed at root during the sweep

### BUG 1 (P0, pre-existing) — infinite render loop freezes `/assistant/tasks/$taskId`

Opening any task detail page froze the entire app: **"Maximum update depth exceeded" ×69**, main thread wedged (snapshot/navigation timed out, browser context died). Surfaced when opening the first task created in this sweep.

- **Pre-existing, not introduced by this PR.** The three offending effects (lines 119/133/158) are **byte-identical on base `feature/dashboard`**; this PR's only change to the file was adding `errorComponent`/`pendingComponent` to the route config. C3's `useTaskStore.ts` change only touched error catch-blocks, not the function identities. Confirmed via `git show feature/dashboard:…$taskId.tsx` + `git show 461a7da1`.
- **Mechanism:** effect deps included identities recreated every render — `formatDateForInput` (an inner function declaration) and the `useTaskStore`/`useBlockers` dispatchers — while the parking effect unconditionally called `setParkingHistory(history.slice(0, 5))` (a fresh array every run). React Compiler did not stabilise these, so each render re-ran the effect → new state ref → re-render → loop.
- **Fix (local, minimal — commit `680fb652`):** moved `formatDateForInput` to module scope; scoped the three effects to their real inputs (`[task]`, `[taskId, initialized]`, `[taskId, blockersInitialized]`) with `eslint-disable react-hooks/exhaustive-deps` matching the pattern already present on the parking effect line. No hook surgery (CLAUDE.md policy is "trust the compiler, no useCallback").
- **Verified live:** re-navigated to the same task — 0 console errors, page responsive, title input editable, full create → edit (persisted) → complete → delete cycle works.

### BUG 2 (P1, in C5 scope) — Settings Theme/Language/Time-Format selects were dead

Selecting **Light** in Settings → Theme did nothing: `<html>` kept `class="dark"`, nothing persisted, `localStorage['nexus-settings']` stayed empty. The C5.3 `useApplyTheme` / C5.4 `useTimeFormat` hooks were correct, but the three `<Select>`s in `settings.tsx` used `defaultValue="…"` with **no `value` binding and no `onValueChange`** — the Radix selects only changed their internal UI, never calling `updateSetting`, so the persisted setting (and therefore the hooks) never changed. (The Switches on the same page were correctly wired; only the 3 selects were not.)

- **Fix (commit pending in this results commit):** added a `handleSelectChange` helper and bound all three selects with `value={settings.X}` + `onValueChange`. Scoped `check-types` clean; biome auto-formatted; the 3 pre-existing `useUniqueElementIds` warnings in this file are the documented branch-wide drift (untouched, out of scope).
- **Verified live after fix:**
  - Theme → Light: `<html class="">` (`.dark` removed), `nexus-settings` persisted `{"theme":"light",…}`, trigger reads "Light". (App stays visually dark — dark-first design with minimal light tokens — but the actual defect, the `.dark` toggle + persistence, is fixed.)
  - Time Format → 12-hour: persisted `"timeFormat":"12h"`; AI message bubbles re-rendered timestamps as **"05:03 PM"** (were "16:49" / 24h before) — C5.4 `useTimeFormat` now reflects the setting end-to-end.
  - Language select shows **only English** (C5 trim confirmed).

---

## Per-feature detail

- **C5 dashboard/index:** "6/6 Active", all 6 cards "Active", Bookmarks copy = "…page-metadata previews and search", Planner copy = "Day-view timeline — drag tasks…". Stats showed "—" on the empty account (live wiring, not hardcoded `0:00:00`); after running a timer + completing a task, Focus page showed live "FOCUSED TODAY 0:00:06" / "POMODOROS 1" / "DAY STREAK 1" and Tasks showed a "1 day streak" badge — confirms `useAggregatedFocusStats`/task-count are live.
- **C1/C3 Assistant Tasks:** create (appears immediately, no silent failure) → edit title + Save (subtitle + "Updated" timestamp 4:11→4:47 PM updated, Save re-disabled) → Complete (moved to Completed column, streak awarded) → Delete (native confirm → removed). Success path + state transitions all clean; TaskForm inline `AlertBlock` present (failure hard to force without a working backend break).
- **C1 AI:** conversation create persists across reload; scoped transactional `deleteConversation` removes it with 0 errors; UI handles the 503 gracefully (red banner "HTTP error! status: 503", no crash). **Not testable locally:** the streamed reply and `ai_messages` row persistence — the copied `.env` has an **empty `ANTHROPIC_API_KEY`** (len 0), so `/api/ai-chat` correctly returns its graceful 503 before the persist/stream step. This is an env limitation, **not a code defect** (env schema marks the key `.optional()`; the 503 fallback is by design). The C1 migration was smoke-tested on a DB copy in prior work; the delete path is type-verified and runs clean live.
- **Bookmarks:** added `https://github.com/genesiscz/genesisTools` → Auto-fill fetched real title + description server-side (C1.5 redirect-revalidation `fetchUrlMetadata` path), saved ("1 of 1 bookmark"), deleted. 0 errors. (Benign pre-existing Radix dialog `aria-description` warning — area 7, out of scope.)
- **Notes:** create → edit markdown body (autosaved, sidebar preview updated) → live Preview pane rendered `# Hello sweep` as `<h1>` + paragraph → delete (confirm). 0 errors.
- **Timer / C8.5:** stopwatch create → Start (counts, "1 running") → Pause → Pop-out opened the standalone `/timer/$timerId` route in a new tab with **synced state (00:06.39)** — cross-tab sync works. All three types exercised (Stopwatch / Countdown 05:00 / Pomodoro 25-5×4+15 schedule). Both timers deleted. The C8.5 popup-**blocked** fallback (toast + in-tab nav) can't be force-triggered — automated Chromium doesn't block `window.open`; the happy path + standalone route are confirmed and the fallback is a verified null-check.
- **C5 Focus:** "Begin First Session" → WORK 1/4, 25:00, live stats. `?taskId=<id>` of a created task renders **"Focusing on: Focus link target task"**. The Planner inbox **"Focus →"** button navigates to `/dashboard/focus?taskId=…` and resolves the same — the C5 link that was previously dropped now works end-to-end.
- **C5 Planner:** Day/List view toggle works; Focus→ link works (above); copy correct; timeline axis is hardcoded 24h (not a C5.4 surface — C5.4 targets PlannerListView + AI bubbles). **Drag-to-create / drag-to-reschedule not verified:** a synthetic stepped-pointer drag did not trigger dnd-kit's activation; this is a known harness limitation (the mobile-sweep doc flags the analogous touch case) and the dnd logic is pre-existing, outside this PR's C-stage diff.
- **C7 404:** `/totally-not-a-route-xyz` → cyan-compass `RouteNotFound`: "Page not found" / "That route doesn't exist…" / "Back to dashboard" → `/dashboard`. Not the generic error UI.
- **C4 per-leaf:** every data route showed its `RouteSkeleton` ("Loading …") then content — `pendingComponent` confirmed live on dashboard, tasks, $taskId, ai, bookmarks, notes, timer, focus, planner, settings. A forced error boundary wasn't artificially triggered (hard to force); `errorComponent` is type-verified and the 503/404 paths render their own in-component error UI without nuking the layout.
- **Profile:** avatar, Display Name "martin", disabled Email, Account Created "December 22, 2025", User ID `user_01KD43P2Z84…` (matches the data-scoping id — confirms server-derived identity), Active status, Google/GitHub Connect, Danger Zone (not exercised). 0 errors.

## Caveats (honest)

- AI streamed reply + `ai_messages` persistence: not testable locally (empty `ANTHROPIC_API_KEY`); graceful-503 + scoped-delete paths confirmed.
- Planner drag-to-create/reschedule: not falsifiable via synthetic dnd pointer; out of this PR's diff.
- C8.5 popup-blocked branch: automated Chromium can't block popups; happy path + route confirmed.
- C4 forced error boundary: not artificially triggered; pendingComponent confirmed, errorComponent type-verified.
- Light theme is visually still dark (dark-first design, minimal light tokens) — the C5.3 fix (`.dark` toggles + persists) is what was broken and is now verified.
