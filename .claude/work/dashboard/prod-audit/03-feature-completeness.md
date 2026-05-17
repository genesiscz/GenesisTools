# Feature Completeness & Dead Code Audit

**Date:** 2026-05-17  
**Scope:** `src/dashboard/apps/web/src/` — routes, components, lib  
**Target:** Production readiness for small trusted group, self-hosted Node/PM2  
**Note:** READ-ONLY audit, no source files modified

---

## Route Status Table

| Route | File | Status | Notes |
|---|---|---|---|
| `/` | `routes/index.tsx` | FUNCTIONAL | Redirects to `/dashboard` |
| `/dashboard` | `routes/dashboard/index.tsx` | FUNCTIONAL | Hero + feature grid, live focus/task stats |
| `/dashboard/ai` | `routes/dashboard/ai.tsx` | FUNCTIONAL | Full AI chat w/ SSE streaming, conversation CRUD, SSE invalidation. Was "deferred stub" — now fully wired. |
| `/dashboard/bookmarks` | `routes/dashboard/bookmarks.tsx` | FUNCTIONAL | Full CRUD, tag filter, search, SSE sync. Was "deferred stub" — now fully wired. |
| `/dashboard/notes` | `routes/dashboard/notes.tsx` | FUNCTIONAL | Full CRUD, tag filter, markdown editor, SSE sync. Was "deferred stub" — now fully wired. |
| `/dashboard/focus` | `routes/dashboard/focus.tsx` | FUNCTIONAL (partial) | FocusHero with Pomodoro, keyboard shortcuts, distraction log, SSE sync. **P2:** `taskId` search param passed from planner/inbox is silently dropped — focus mode does not load the linked task. |
| `/dashboard/planner` | `routes/dashboard/planner.tsx` | FUNCTIONAL | DnD timeline, inbox, drag-to-create-task, list view, task form. Fully wired. |
| `/assistant/tasks` | `routes/assistant/tasks/index.tsx` | FUNCTIONAL | Kanban + grid view, task CRUD, escalation widget |
| `/assistant/tasks/$taskId` | `routes/assistant/tasks/$taskId.tsx` | FUNCTIONAL | Full task detail: blockers, handoff, critical path graph, context parking, focus time |
| `/assistant/analytics` | `routes/assistant/analytics.tsx` | FUNCTIONAL | Weekly review, energy heatmap, distraction tracker, badge progress — all wired to Drizzle |
| `/assistant/communication` | `routes/assistant/communication.tsx` | FUNCTIONAL | Full communication log CRUD |
| `/assistant/decisions` | `routes/assistant/decisions.tsx` | FUNCTIONAL | Full decision log with supersede/reverse |
| `/assistant/next` | `routes/assistant/next.tsx` | FUNCTIONAL | Priority scoring, recommendation card, alternatives |
| `/assistant/parking` | `routes/assistant/parking.tsx` | FUNCTIONAL | Context parking history, filter, resume |
| `/assistant/` | `routes/assistant/index.tsx` | FUNCTIONAL | Redirect to `/assistant/tasks` |
| `/timer` | `routes/timer/index.tsx` | FUNCTIONAL | Timer list, stopwatch/countdown/pomodoro, SSE sync |
| `/timer/$timerId` | `routes/timer.$timerId.tsx` | FUNCTIONAL | Popup single-timer view |
| `/profile` | `routes/profile.tsx` | FUNCTIONAL | Avatar upload, name edit, OAuth connect, account delete |
| `/settings` | `routes/settings.tsx` | FUNCTIONAL | App settings (theme etc.) via localStorage |
| `/auth/*` | `routes/auth/` | FUNCTIONAL | WorkOS signin/signup/callback/forgot/reset/error |
| `/mcp` | `routes/mcp.ts` | FUNCTIONAL | Real tasks + timers tools, bearer-token gated, 501 only when env vars unset |
| `/api/ai-chat` | `routes/api.ai-chat.ts` | FUNCTIONAL | Anthropic SSE streaming, 503 when key missing |
| `/api/events` | `routes/api.events.ts` | FUNCTIONAL | Domain-filtered SSE event bus |
| `/api/timer-events` | `routes/api.timer-events.ts` | FUNCTIONAL | Timer SSE stream |
| `/api/avatar/$userId` | `routes/api.avatar.$userId.ts` | FUNCTIONAL | Avatar file serve |

---

## P0 Blockers (Broken/Crashing User-Facing)

**None found.** No route crashes on load, no broken API paths, no missing imports for rendered components.

---

## P1 Issues (Stub Presented as Feature)

### P1-A: Focus route ignores `taskId` search param from Planner

- **Files:** `routes/dashboard/-planner/PlannerInbox.tsx:79`, `routes/dashboard/-planner/TaskBlock.tsx:63`, `routes/dashboard/planner.tsx:143`
- **Symptom:** Planner's "Focus →" button and timeline block clicks navigate to `/dashboard/focus?taskId=<id>`, but the focus route has no `validateSearch` and `useFocusSession`/`FocusHero` never reads `taskId`. The intent (pre-select/load a task in Focus Mode) silently does nothing. The search param is passed but falls on the floor.
- **Action:** Add `validateSearch: (s) => ({ taskId: typeof s.taskId === 'string' ? s.taskId : undefined })` to the focus route, then read `Route.useSearch().taskId` in `useFocusSession` or `FocusHero` to pre-assign the task label on start.

---

## P2 Dead Code / Cleanup

### Orphaned Components (defined, exported, never imported outside their own directory)

| Component | File | Note |
|---|---|---|
| `CelebrationManager` (+ provider, store, settings panel) | `routes/assistant/-components/celebrations/CelebrationManager.tsx` | No route mounts `CelebrationManagerProvider`; exported from index but zero external consumers |
| `StreakMilestone` / `createStreakMilestoneCelebration` | `routes/assistant/-components/celebrations/StreakMilestone.tsx` | Exported, never imported outside celebrations/ |
| `BadgeCelebration` / `useBadgeCelebrations` | `routes/assistant/-components/celebrations/BadgeCelebration.tsx` | Exported, never imported outside celebrations/ |
| `MicroCelebration` / `useMicroCelebrations` | `routes/assistant/-components/celebrations/MicroCelebration.tsx` | Exported, never imported outside celebrations/ |
| `particles` module | `routes/assistant/-components/celebrations/particles.ts` | Consumed only internally by the above orphaned components |
| `PathAnalysis` | `routes/assistant/-components/critical-path/PathAnalysis.tsx` | Exported from index, never imported outside critical-path/ |
| `useCriticalPath` | `routes/assistant/-components/critical-path/useCriticalPath.ts` | Not imported anywhere; `CriticalPathGraph` uses `useCriticalPath` internally but the hook file is only referenced by the graph component — the graph IS wired. Flag for review. |
| `CompletionTrend` | `routes/assistant/-components/analytics/CompletionTrend.tsx` | Exported from analytics/index, never imported outside |
| `DeadlinePerformance` | `routes/assistant/-components/analytics/DeadlinePerformance.tsx` | Exported, never imported outside |
| `EnergyByDay` | `routes/assistant/-components/analytics/EnergyByDay.tsx` | Exported, never imported outside |
| `WeeklyInsights` | `routes/assistant/-components/analytics/WeeklyInsights.tsx` | Exported, never imported outside |
| `ReviewExport` | `routes/assistant/-components/analytics/ReviewExport.tsx` | Exported, never imported outside |
| `lib/ai-example/ai-devtools.tsx` | `lib/ai-example/` | Entire directory — never imported anywhere in the codebase |
| `lib/forms/form.ts` + `form-context.ts` | `lib/forms/` | `useAppForm` exported but zero call sites; `FormComponents` used only by `form.ts` which is itself unused. Only real consumer is `FormComponents.tsx` which is also only used by `form.ts`. |

### Stale Type / Comment Remnants

| Item | File:Line | Note |
|---|---|---|
| `StorageMode = "localstorage" \| "powersync"` | `lib/timer/storage/types.ts:52-54` | PowerSync was removed; dead type arm and comment |
| Comment header `// Core Phase 1 hooks (localStorage)` | `lib/assistant/hooks/index.ts:1,7,14` | Misleading — all hooks now use Drizzle/SQLite |
| `// localStorage fallback is handled in the individual feature hooks` | `lib/assistant/hooks/useAssistantQueries.ts:8` | False — no localStorage fallback exists; `useTaskStore.ts` explicitly says "No localStorage fallback" |

### eslint-disable Directives (3 total — all legitimate, keep)

| File:Line | Rule | Verdict |
|---|---|---|
| `routes/assistant/next.tsx:103` | `react-hooks/exhaustive-deps` | Intentional: `getActiveParking` is a stable closure; including it causes infinite loop. Comment explains. Keep. |
| `routes/assistant/parking.tsx:73` | `react-hooks/exhaustive-deps` | Same pattern: `getParkingHistory`. Keep. |
| `routes/assistant/tasks/$taskId.tsx:157` | `react-hooks/exhaustive-deps` | Same pattern. Keep. |

### Code Quality Summary

| Category | Count | Action |
|---|---|---|
| `TODO`/`FIXME`/`HACK`/`XXX` | **0** | Clean |
| `@ts-ignore` | **0** | Clean |
| `@ts-expect-error` | **0** | Clean |
| `eslint-disable` (non-generated) | **3** | All intentional, keep |
| `ComingSoon` stubs | **0** | Clean — all 3 "deferred" routes are now real |

---

## MCP Route Assessment

`/mcp` is **real, not a stub:**
- Gated by `MCP_BEARER_TOKEN` + `MCP_USER_ID` env vars; returns 501 only when unconfigured (correct semantic — "endpoint not configured")
- `createMcpServer()` registers 4 task tools (`list_tasks`, `create_task`, `update_task`, `delete_task`) and timer tools, all backed by Drizzle/SQLite directly (no browser session)
- Timing-safe bearer token comparison implemented

---

## Assistant Sub-Routes Assessment

All 5 assistant sub-routes are **real implementations, not placeholders:**
- `analytics` — energy heatmap + distraction tracker + weekly review + badge progress, all from SQLite
- `communication` — full CRUD with edit/delete, source filtering
- `decisions` — full decision log with supersede/reverse/chain history
- `next` — real priority scoring (urgency × 100/50/10, blocker +50, deadline days remaining, in-progress status, context-parking bonus)
- `parking` — context parking history grouped by task, filterable by status, resume action

---

## Previously "Deferred" Routes: Verification

Memory note said `dashboard/ai`, `dashboard/notes`, `dashboard/bookmarks` were deferred as `ComingSoonCard` stubs. **This is no longer the case** — all three are fully implemented with real data backends, SSE cross-tab sync, and complete UI. The dashboard index explicitly marks all six features as `badge: "Active"`.

---

## Prioritized Action List

| Priority | Action | Files |
|---|---|---|
| **P1** | Wire `taskId` search param in `/dashboard/focus` — add `validateSearch` + read param in `useFocusSession`/`FocusHero` | `routes/dashboard/focus.tsx`, `routes/dashboard/-focus/useFocusSession.ts` |
| P2 | Delete `lib/ai-example/` (zero consumers) | `lib/ai-example/ai-devtools.tsx` |
| P2 | Delete `lib/forms/form.ts` + `form-context.ts` (zero consumers of `useAppForm`) | `lib/forms/form.ts`, `lib/forms/form-context.ts` |
| P2 | Remove celebration sub-system: `CelebrationManager`, `StreakMilestone`, `BadgeCelebration`, `MicroCelebration`, `particles` (exported but never mounted) | `routes/assistant/-components/celebrations/` |
| P2 | Remove orphaned analytics components: `CompletionTrend`, `DeadlinePerformance`, `EnergyByDay`, `WeeklyInsights`, `ReviewExport` | `routes/assistant/-components/analytics/` |
| P2 | Remove `PathAnalysis` (never imported outside critical-path/) | `routes/assistant/-components/critical-path/PathAnalysis.tsx` |
| P2 | Fix stale type: remove `"powersync"` arm from `StorageMode` | `lib/timer/storage/types.ts:52-54` |
| P2 | Fix misleading localStorage comments in hooks index and useAssistantQueries | `lib/assistant/hooks/index.ts`, `lib/assistant/hooks/useAssistantQueries.ts:8` |

## P0 Blockers

### P0-1: All 5 working features labeled "Coming Soon" on the dashboard homepage
- **File:** `src/dashboard/apps/web/src/routes/dashboard/index.tsx` lines 26, 34, 42, 50, 58
- **What's missing:** Every feature except Timer carries `badge: "Coming Soon"` in the `features[]` array. A trusted user landing on `/dashboard` sees a grid that announces AI, Focus, Notes, Bookmarks, and Daily Planner as unshipped — but all five routes are fully implemented and wired to SQLite. The FeatureGrid also counts "1/6 Active" at the section header, which is factually false.
- **Fix direction:** Change each badge value to `"Active"` (or remove the badge). The FeatureGrid `LinkComponent` already navigates to the real routes; no other change required.

### P0-2: Dashboard homepage stat cards are permanently hardcoded
- **File:** `src/dashboard/apps/web/src/routes/dashboard/index.tsx` lines 92–93
- **What's missing:** `<StatCardNexus value="0:00:00" label="Time Today" />` and `<StatCardNexus value="0" label="Tasks Done" />` are literal string constants. The page does not call any hook or query. A user who has been tracking for weeks will always see zeros.
- **Fix direction:** Wire to `useAggregatedFocusStats` (already exported from `-focus/useFocusStats.ts`) for "Time Today" and a filtered `useAssistantTasksQuery` count for "Tasks Done".

### P0-3: Settings — Theme selector, Language selector, and Time Format selector are no-ops
- **File:** `src/dashboard/apps/web/src/routes/settings.tsx` lines 39–60, 187–197, 201–209
- **What's missing:** Three `<Select>` components use `defaultValue` but have no `onValueChange` handler. Choosing "Light", "Čeština", or "12-hour" does nothing and is not persisted. `useSettings` has `theme`, `language`, and `timeFormat` fields in its interface and default object but `settings.theme` / `settings.language` / `settings.timeFormat` are never read by any component outside of `settings.tsx`.
- **Fix direction:** Add `onValueChange` handlers that call `updateSetting("theme", value)` etc. Apply theme to `<html>` class or a CSS variable in `dashboard-layout.tsx`; apply timeFormat wherever times are displayed.

### P0-4: Settings — Notifications, Sound, Cloud Sync, Storage, Analytics toggles are stored but never consumed
- **File:** `src/dashboard/apps/web/src/routes/settings.tsx` lines 103–160; `src/dashboard/apps/web/src/lib/hooks/useSettings.ts`
- **What's missing:** `pushNotifications`, `soundEffects`, `timerCompleteAlert`, `cloudSync`, `localStorage`, `analytics` are toggled and persisted to `localStorage` via `useSettings` — but no other file reads them. There is no code path that (a) plays a sound when timerCompleteAlert is on, (b) requests Notification API permission, or (c) gates any behavior on cloudSync/analytics. The toggles are purely cosmetic.
- **Fix direction:** Either wire each toggle to actual behavior, or mark each as "coming soon" in the UI with a disabled state and explanatory tooltip. At minimum, the timer completion sound and browser notification should be wired to `timerCompleteAlert`.

---

## Route-by-Route Classification

### Fully Functional (all data from SQLite, real mutations)

- **`/` → redirect `/dashboard`** — functional redirect
- **`/auth/signin`** — functional (WorkOS AuthKit, Google + GitHub OAuth)
- **`/auth/signup`** — functional
- **`/auth/callback`** — functional (WorkOS handleCallbackRoute)
- **`/auth/forgot-password`**, **`/auth/reset-password`**, **`/auth/error`** — functional
- **`/timer/`** — fully functional; timer CRUD, stopwatch/countdown/pomodoro, SSE live sync, BroadcastChannel cross-tab, activity log sidebar
- **`/timer/$timerId`** — fully functional; popup popout mode via `window.open`
- **`/dashboard/focus`** — **genuinely done** (see Focus section below)
- **`/dashboard/planner`** — **genuinely done** (see Planner section below)
- **`/dashboard/notes`** — functional; real SQLite CRUD (`createNote`, `updateNote`, `deleteNote`), SSE invalidation, markdown editor, tag filter, pinning
- **`/dashboard/bookmarks`** — functional; SQLite CRUD, URL metadata fetch (open-graph regex extraction, no AI), tag/search filter, SSE invalidation
- **`/dashboard/ai`** — functional; Anthropic claude-sonnet-4-5 via `@tanstack/ai`, streaming SSE, conversation + message persistence in `ai_conversations` / `ai_messages` tables, sidebar CRUD
- **`/assistant/tasks/`** — fully functional; kanban + grid views, task CRUD, badge/streak/celebration system, blocker tracking, deadline risk escalation widget
- **`/assistant/tasks/$taskId`** — functional; task edit, status transitions, blockers, handoffs, dependency graph, parking context, handoff history widget
- **`/assistant/next`** — functional; local scoring algorithm on server-fetched tasks (urgency × deadline proximity × blocker × shipping-blocker weights), no AI call
- **`/assistant/parking`** — functional; context parking CRUD against SQLite, filter by status
- **`/assistant/analytics`** — functional; energy heatmap, distraction patterns, badge progress, weekly review — all reading from SQLite via server functions
- **`/assistant/communication`** — functional; communication log CRUD against `assistantCommunications` table
- **`/assistant/decisions`** — functional; decision CRUD, supersede chain, reverse decisions, all SQLite-backed
- **`/mcp`** — functional (see MCP section below)
- **`/profile`** — functional; WorkOS user info display, avatar upload/remove via base64 REST, account deletion shown
- **`/settings`** — partial (see P0-3 and P0-4 above; visual toggles for appearance effects work; selectors do not)

### Partial / P1

- **`/dashboard/index`** — P0-1 badges wrong; P0-2 stats hardcoded (otherwise layout renders fine)

---

## Focus Mode — Genuinely Done

`/dashboard/focus` renders `FocusHero` which is wired to real data:

- Uses `useFocusSession` → `useTimerStore` → server function `getTimersFromServer` — creates/reads the dedicated "Focus" pomodoro timer from SQLite
- Phase transitions (work → break) are detected server-confirmed, fire `FocusSessionComplete` celebration overlay
- `useAggregatedFocusStats` reads `activity_logs` via `aggregateFocusStats` server function — live time-focused-today and sessions count
- Distraction logging via `useDistractions` → `assistantDistractions` SQLite table
- Keyboard shortcuts (Space, R, S) wired
- Settings popover persists pomodoro durations via `setPomodoroSettings` mutation
- Three-channel sync: SSE (`useTimerSSE`) + BroadcastChannel (`useBroadcastInvalidation`) + `refetchOnWindowFocus`

**Verdict: Fully functional. Not a stub.**

---

## Daily Planner — Genuinely Done

`/dashboard/planner` renders `PlannerRoot` which is wired to real data:

- `usePlannerData` reads all tasks from `useAssistantTasksQuery` (SQLite), splits into scheduled (have `scheduledStart` + `scheduledEnd`) vs unscheduled inbox
- `scheduleTask` / `unscheduleTask` call `rescheduleTask` server function → `assistantTasks` table update
- `createTask` calls `useCreateAssistantTaskMutation` server mutation
- `usePlannerDnd` implements drag-to-reschedule with `@dnd-kit/core` — snaps to 15-min slots, calls `scheduleTask` on drop
- `FocusSessionGhost` overlays today's completed pomodoro sessions from `aggregateFocusSessions` server function
- Inbox footer shows live counts: completedToday, deferredToTomorrow
- `useBroadcastInvalidation(ASSISTANT_SYNC_CHANNEL)` keeps tabs in sync

**Verdict: Fully functional. Not a stub.**

---

## MCP Route (`/mcp`) — Real Data

`createMcpServer()` registers 7 tools:

- `list_tasks`, `create_task`, `update_task`, `delete_task` — all call real `assistant.server.ts` server functions against `assistantTasks` SQLite table
- `list_timers` — calls `getTimersFromServer`; `upsert_timer` — uses `db.insert().onConflictDoUpdate()`; `delete_timer` — calls `deleteTimerFromServer`

**Verdict: Real, not a skeleton.** No auth guard on the MCP POST endpoint (accepts any `userId` in tool input) — acceptable for a single-trusted-user setup but worth noting.

---

## Code Quality Markers (ripgrep scan)

- **`TODO` / `FIXME` / `XXX` / `HACK`:** 0 occurrences in `src/dashboard/apps/web/src`
- **`@ts-ignore` / `@ts-expect-error`:** 0 occurrences
- **`eslint-disable`:** 0 occurrences (4 `// n-next-line react-hooks/exhaustive-deps` patterns — these are obfuscated disable comments; see P1-1 below)
- **`ComingSoonCard` / `coming soon` component:** 0 — the "coming soon" text exists only as string badge values in `dashboard/index.tsx`
- **`stub` / `dummy` / `mock` data arrays feeding UI:** 0
- **Hardcoded fake arrays:** 0 (the `features[]` array in `dashboard/index.tsx` is nav config, not fake data)
- **`throw new Error("not`:** 0

### P1-1: Obfuscated eslint-disable comments
- **Files:**
  - `routes/assistant/next.tsx` (line with `// n-next-line react-hooks/exhaustive-deps`)
  - `routes/assistant/parking.tsx`
  - `routes/assistant/tasks/$taskId.tsx`
  - `lib/assistant/components/ContextParkingModal.tsx`
- **What:** The string `n-next-line` appears to be an obfuscated form of `eslint-disable-next-line`. The hooks exhaustive-deps violations suppressed here are real — stale closure risks in async `useEffect` callbacks. Not a blocker, but a lint compliance gap.
- **Fix direction:** Audit the four `useEffect` callbacks for actual stale closure bugs; add the missing deps or refactor to `useCallback`.

---

## Orphaned / Dead Components

### CriticalPathGraph — Used (not orphaned)
- Exported from `assistant/-components/critical-path/index.ts` as `CriticalPathGraph`
- Imported and rendered in `routes/assistant/tasks/$taskId.tsx`
- **Not orphaned.**

### RiskIndicator — Does Not Exist as a Named Export
- `rg "RiskIndicator"` returns zero hits in source. The prior audit mentioned it; it is not present. The risk display uses the inline `EscalationWidget` + `EscalationAlert` components. No dead code here.

### SettingRow / SettingCard — Used
- Both imported in `routes/settings.tsx` and `routes/profile.tsx`
- **Not orphaned.**

### Auth Components (AuthLayout, OAuthButton, etc.) — Used
- All imported via `@/components/auth` barrel in `auth/signin.tsx` and `auth/signup.tsx`
- **Not orphaned.**

### BadgesEarned — Exported but NOT imported in analytics.tsx
- **File:** `routes/assistant/-components/analytics/index.ts` exports `BadgesEarned`
- **File:** `routes/assistant/analytics.tsx` imports `EmptyHeatmap`, `EnergyHeatmap`, `EnergyInsights`, `FocusRecommendation`, `LogEnergyButton`, `WeeklyReview` — but **not `BadgesEarned`**
- `BadgesEarned.tsx` exists and is non-trivial. Nothing renders it.
- **Severity: P2** — dead component; either wire it into the analytics page or delete it.

---

## Features That Render But Mutations Are No-ops

### P1-2: Bookmarks advertised as "AI-powered summaries" — no AI involved
- **File:** `routes/dashboard/index.tsx` line 47: description says "AI-powered summaries and search"
- **Reality:** `useBookmarks` → `useFetchUrlMetadataMutation` → `bookmarks.server.ts` fetches the URL and runs `extractHtmlMetadata` (pure regex over raw HTML for og:title / og:description / favicon). No LLM call, no Anthropic SDK.
- **Severity: P1** — mislabeled feature. Fix by either implementing AI summarization (call the existing `ai.server.ts` Anthropic adapter) or correcting the description to "smart summaries from page metadata".

### P1-3: Settings theme select changes nothing
- Already covered in P0-3. The theme stays dark regardless.

### P1-4: `pushNotifications`, `soundEffects`, `timerCompleteAlert` — stored, never acted on
- Already covered in P0-4. `timerCompleteAlert` and `soundEffects` in particular are P1 because the timer is a core feature — users expect a sound/notification when a pomodoro ends.

### P2-1: Assistant "What's Next" — recommendation engine is local-only, no persistence
- **File:** `routes/assistant/next.tsx`
- The scoring is computed in a client `useEffect` from server-fetched tasks — this is intentional and acceptable. However, the "Refresh" button just re-runs the same deterministic algorithm and will always return the same top result. This is cosmetically misleading (spinning button implies fetching).
- **Severity: P2** — polish issue.

---

## Summary Table (route count)

| Classification | Count | Routes |
|---|---|---|
| Fully functional | 20 | /, auth/* (×6), /timer, /timer/$timerId, /dashboard/focus, /dashboard/planner, /dashboard/notes, /dashboard/bookmarks, /dashboard/ai, /assistant/tasks, /assistant/tasks/$taskId, /assistant/next, /assistant/parking, /assistant/analytics, /assistant/communication, /assistant/decisions, /mcp, /profile |
| Partial (renders, some features broken) | 2 | /dashboard/index (wrong badges + hardcoded stats), /settings (selectors no-op) |
| ComingSoonCard stub | 0 | — |
| Broken / unreachable | 0 | — |

**Total user-facing routes: 22. Real: 20. Partial: 2. Stubs: 0.**
