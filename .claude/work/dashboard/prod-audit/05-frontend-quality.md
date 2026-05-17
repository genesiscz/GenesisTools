# Frontend Quality Audit — Dashboard
*Date: 2026-05-17 | Auditor: Claude Sonnet 4.6*

---

## P0 Blockers

### P0-1 — SSR Landmine: umbrella `"radix-ui"` imports
**Status: CLEAN** — no `from "radix-ui"` umbrella imports found in any `.tsx`/`.ts` file across
`src/`, `packages/ui/`, or `packages/` subdirectories. All Radix imports use the scoped
`@radix-ui/*` packages. The previously documented `profile.tsx` Avatar fix (wrapping in
`<ClientOnly>`) is in place. No new landmines detected.

### P0-2 — `window.matchMedia` called in render body (hydration mismatch + SSR guard missing in one component)
**File:** `src/dashboard/apps/web/src/routes/assistant/-components/celebrations/MicroCelebration.tsx:63–64`

```tsx
const prefersReducedMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
```

This executes at the **top of the render function**, not inside an effect. The `typeof window`
guard prevents an outright crash on Node.js, but the value is always `false` server-side and may
differ client-side, causing a **hydration mismatch** for users with reduced-motion enabled.
React will log a warning and the UI may flicker on mount.

All other `window.matchMedia` accesses in `CelebrationModal.tsx` and `BadgeCelebration.tsx` are
safely inside `useEffect`, so they are not affected.

**Fix:** Extract into a `usePrefersReducedMotion()` hook that SSR-initialises to `false`:

```tsx
// src/lib/hooks/usePrefersReducedMotion.ts
export function usePrefersReducedMotion(): boolean {
    const [pref, setPref] = useState(false);
    useEffect(() => {
        const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
        setPref(mq.matches);
        const handler = (e: MediaQueryListEvent) => setPref(e.matches);
        mq.addEventListener("change", handler);
        return () => mq.removeEventListener("change", handler);
    }, []);
    return pref;
}
```

Apply this hook in `MicroCelebration.tsx` in place of the inline render-time check.

---

## SSR Browser-Global Sweep (all `window.` / `document.` / `localStorage` usages)

Files with browser-global access and their safety status:

| File | Access | Safe? |
|------|--------|-------|
| `lib/hooks/useSettings.ts:41,57` | `localStorage` in helper fns | Safe — guarded by `typeof window === "undefined"` |
| `lib/hooks/useSettings.ts:70–72` | Module-scope `let globalSettings` etc. | Safe — plain values, no DOM |
| `routes/__root.tsx:56` | `window.addEventListener` | Safe — inside `useEffect` |
| `components/dashboard/dashboard-layout.tsx:20,28` | `document.documentElement`, `window.matchMedia` | Safe — inside `useEffect` with `typeof document` guard |
| `routes/timer/index.tsx:79–82` | `window.screen`, `window.open` | Safe — click handler only |
| `routes/auth/signin.tsx:103–104` | `window.location.href` | Safe — async OAuth handler |
| `routes/auth/signup.tsx:102–103` | `window.location.href` | Safe — async OAuth handler |
| `lib/timer/hooks/useCrossTabSync.ts:79` | `window.addEventListener("beforeunload")` | Safe — inside `useEffect` |
| `lib/assistant/hooks/useContextParking.ts` | `window.addEventListener` keydown | Safe — inside `useEffect` |
| `lib/assistant/components/CelebrationModal.tsx:29,40–41` | `window.matchMedia`, `window.innerWidth/Height` | Safe — inside `useEffect` |
| `routes/assistant/-components/celebrations/BadgeCelebration.tsx:118–130` | `window.matchMedia`, `window.innerWidth/Height` | Safe — inside `useEffect` |
| **`routes/assistant/-components/celebrations/MicroCelebration.tsx:63–64`** | `window.matchMedia` | **P0 — render body** |
| `routes/dashboard/-focus/FocusHero.tsx:58–59` | `window.addEventListener` keydown | Safe — inside `useEffect` |

---

## P1 — Bad Failure UX / No Error Surfacing

### P1-1 — Task create/update failures are silent in `/assistant/tasks`
**Files:** `routes/assistant/tasks/index.tsx:132–137`, `lib/assistant/components/TaskForm.tsx:112–135`

`handleCreateTask` calls `createTask()` from `useTaskStore` which catches the error internally,
stores it in `taskStore.error`, and returns `null`. The caller never reads `taskStore.error` and
shows no `toast`. The user sees the form close (or stay open) with zero feedback.

`TaskForm.handleSubmit` also has a bare `finally` with no `catch`:
```tsx
try {
    await onSubmit({ ... });
    onOpenChange(false);
} finally {
    setIsSubmitting(false);
}
```
On failure, `isSubmitting` resets, button re-enables — but no message is shown.

**Same silent pattern in:**
- `handleCompleteTask` — awaits `completeTask()` with no catch
- `handleStatusChange` — calls `updateTask()` with no catch
- `handleParkContext` — calls `parkContext()` with no catch

**Fix:** Add `catch (err) { toast.error(err instanceof Error ? err.message : "Failed to create task"); }` in `TaskForm.handleSubmit`; propagate thrown errors from `handleCreateTask` upward.

### P1-2 — Zero `onError` callbacks on 26+ assistant mutations
**File:** `lib/assistant/hooks/useAssistantQueries.ts` — all `useMutation` definitions (lines 194–755)

None of the assistant mutations (create task, update task, delete task, complete task, create
context parking, create badge, create communication entry, create decision, log distraction…)
have an `onError` callback. TanStack Query retries 3 times then silently fails; callers that use
`mutate()` (fire-and-forget) rather than `mutateAsync()` never see the rejection.

**Fix:** Add a global `QueryClient.defaultOptions.mutations.onError` that calls `toast.error(...)`,
or add per-mutation `onError` with meaningful messages.

### P1-3 — QueryClient created with no `defaultOptions`
**File:** `src/dashboard/apps/web/src/integrations/tanstack-query/root-provider.tsx:4`

```tsx
const queryClient = new QueryClient(); // bare — no staleTime, no retry config, no mutation onError
```

TanStack Query v5 defaults: `retry: 3`, `staleTime: 0`, `refetchOnWindowFocus: true`. For a
self-hosted tool with a local SQLite server, this means every tab-focus triggers a full
refetch of all active queries, and failed mutations retry silently 3 times before giving up.

**Fix:**
```tsx
const queryClient = new QueryClient({
    defaultOptions: {
        queries: { staleTime: 10_000, retry: 1 },
        mutations: {
            onError: (err) => toast.error(err instanceof Error ? err.message : "Action failed"),
        },
    },
});
```
(Individual queries already set per-query `staleTime` values; global default is a floor.)

### P1-4 — PII in `console.log` in auth callback
**File:** `src/dashboard/apps/web/src/routes/auth/callback.tsx`

```
Authentication successful: user@example.com, authenticationMethod
```

User email is logged to the browser console on every login. Remove or replace with a server-side
structured log.

### P1-5 — No `errorComponent` / `pendingComponent` on leaf routes
**Present on:** `__root.tsx`, `/dashboard` layout route, `/assistant` layout route.
**Absent on:** `/dashboard/focus`, `/dashboard/notes`, `/dashboard/bookmarks`, `/dashboard/ai`,
`/dashboard/planner`, `/timer/`, `/timer/$timerId`, `/profile`, `/settings`,
`/assistant/tasks/`, `/assistant/tasks/$taskId`, `/assistant/analytics`, `/assistant/communication`,
`/assistant/decisions`, `/assistant/parking`, `/assistant/next`, etc.

When a leaf route's component throws (SQLite error, malformed data), the error bubbles to the
nearest ancestor `errorComponent` — the `/dashboard` or `/assistant` layout. The entire layout
re-renders as the error page: sidebar disappears and the user must navigate back to recover.

**Fix:** Add `errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />`
(and `pendingComponent`) to each `createFileRoute()` that has data dependencies or heavy
rendering.

---

## P2 — Polish

### P2-1 — `prefers-reduced-motion` CSS override only applies to timer pages
**File:** `src/dashboard/apps/web/src/components/auth/cyberpunk.css:329–336`

The global CSS rule:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```
is defined in `cyberpunk.css`, which is **only imported in** `routes/timer/index.tsx` and
`routes/timer.$timerId.tsx`. This override does NOT apply on dashboard, assistant, auth, or
planner pages. The animations in `AuthLayout.tsx` (`animate-ripple`, `animate-fade-in-up`,
`animate-pulse`), `CelebrationModal.tsx`, and `BlockerCard.tsx` run unconditionally for users
with reduced-motion outside the timer routes.

**Fix:** Move the `@media (prefers-reduced-motion)` block from `cyberpunk.css` to the top-level
`styles.css` so it applies globally.

### P2-2 — `notFoundComponent` shows error UI for 404
**File:** `routes/__root.tsx:42`

```tsx
notFoundComponent: () => <RouteError error={new Error("Page not found")} />,
```

`RouteError` renders "Something went wrong", an `AlertTriangle` icon, and a "Try again" button
(which calls `reset()` — but `reset` is not passed here so the button does not render). For a
404, the correct UX is a distinct component: "Page not found", compass/search icon, link to
dashboard — no "Try again".

**Fix:** Create `components/RouteNotFound.tsx` and use it for `notFoundComponent`.

### P2-3 — Dashboard index stat cards have no loading / error state
**File:** `routes/dashboard/index.tsx:76–79`

```tsx
const focusStats = useAggregatedFocusStats(userId);
const tasksQuery = useAssistantTasksQuery(userId);
const completedTaskCount = tasksQuery.data?.filter(...).length ?? 0;
```

Both queries show `—` while loading (via `userId ? value : "—"`), which is indistinguishable
from "the user actually has zero tasks". No skeleton, no spinner, no error state.

**Fix:** Use `tasksQuery.isLoading` to show a skeleton or greyed stat card; use `tasksQuery.isError`
to show an error indicator in the stat card.

### P2-4 — `DEV_USER_ID = "dev-user"` constant duplicated in 9 files
**Files:** `routes/timer/index.tsx:20`, `routes/timer.$timerId.tsx`, `routes/dashboard/bookmarks.tsx`,
`routes/dashboard/ai.tsx`, `routes/dashboard/notes.tsx`, `routes/dashboard/-planner/usePlannerData.ts`,
`lib/timer/hooks/useTimer.ts`, `lib/timer/hooks/useTimerStore.ts`, `routes/dashboard/-focus/useFocusSession.ts`

`import.meta.env.DEV` is replaced with `false` in production builds so the string never reaches
prod. But the pattern is copy-pasted across 9 files — centralise as `lib/auth/devUserId.ts`.

### P2-5 — `console.error` in `useSettings` leaks to production browser console
**File:** `lib/hooks/useSettings.ts:51,64`

```tsx
console.error("Failed to load settings:", e);
console.error("Failed to save settings:", e);
```

Settings failures are non-fatal; they should be `console.warn` at most, or suppressed in
production. The current `console.error` appears red in user DevTools.

### P2-6 — `TaskForm` shows no inline error on submission failure
**File:** `lib/assistant/components/TaskForm.tsx:112–135`

The form has no `<error>` state variable. Add a local `error: string | null` state displayed
as an `<AuthAlertBanner variant="error">` above the submit button when `onSubmit` rejects.

### P2-7 — Timer popout `window.open` fails silently when blocked
**File:** `routes/timer/index.tsx:76–85`

`window.open(...)` returns `null` when blocked by the browser's popup blocker. No fallback or
user message is shown. Add:
```tsx
const popup = window.open(...);
if (!popup) {
    toast.info("Popup blocked — opening in same tab");
    navigate({ to: "/timer/$timerId", params: { timerId: id } });
}
```

### P2-8 — Planner timeline `touchAction: "none"` blocks mobile scroll
**File:** `routes/dashboard/-planner/PlannerTimeline.tsx:122`

The `DroppableTimeline` div has `style={{ height: 1440, touchAction: "none" }}`. On mobile,
`touchAction: "none"` is required for dnd-kit pointer capture, but it means users cannot
scroll the 1440px-tall timeline on touch devices unless dnd-kit is actively dragging. A
"scroll-to-now" button or a split-pane approach (narrower scroll wrapper + drag layer) is needed
for mobile usability.

### P2-9 — Kanban card has nested interactive elements (`<Link>` inside `role="button"` div)
**File:** `routes/assistant/-components/kanban/KanbanCard.tsx:104–128`

dnd-kit's `{...attributes}` injects `role="button"` on the card `<div>`. The card also contains
a `<Link>` child, creating an interactive element nested inside a `role="button"`. This is
invalid ARIA and confuses screen readers and keyboard users (Tab will focus both).

**Fix:** Move `{...listeners}` to the drag-handle `<GripVertical>` child only; keep `{...attributes}`
(including `role="button"`) on the card `<div>` or remove it and handle keyboard activation
separately.

### P2-10 — Signup legal links point to `/` (homepage/redirect)
**File:** `routes/auth/signup.tsx:211–215`

"Terms of Service" and "Privacy Policy" both link to `/`. For a small trusted group this is low
priority, but the `<Link to="/">` navigates to a redirect chain (`/` → `/dashboard`) rather
than any legal document. At minimum point to `#` or remove the links until docs exist.

### P2-11 — Reset password has no confirm-match inline validation
**File:** `routes/auth/reset-password.tsx:65–68`

Password mismatch is validated only on submit. Add an `onBlur` handler on the confirm field that
sets an inline error message if the passwords do not match.

### P2-12 — `animate-bounce-slow` and `animate-pulse` in CelebrationModal not covered by reduced-motion CSS
**File:** `lib/assistant/components/CelebrationModal.tsx:192–196`

The trophy icon uses `animate-bounce-slow` and the Sparkles use `animate-pulse`. These are
Tailwind CSS animations, not custom CSS. The `cyberpunk.css` `@media (prefers-reduced-motion)`
block does not cover Tailwind's built-in animation utilities, and it is not imported on the
assistant route. **Fix:** After moving the CSS override to `styles.css` (P2-1 fix), Tailwind's
animations will also be suppressed via `animation-duration: 0.01ms !important`.

---

## Summary Table

| ID | Severity | File(s) | Problem |
|----|----------|---------|---------|
| P0-2 | P0 | `MicroCelebration.tsx:63` | `window.matchMedia` in render → hydration mismatch |
| P1-1 | P1 | `tasks/index.tsx`, `TaskForm.tsx` | Task create/update failures are silent |
| P1-2 | P1 | `useAssistantQueries.ts` (26+ mutations) | No `onError` callbacks on any assistant mutation |
| P1-3 | P1 | `root-provider.tsx:4` | `QueryClient` has no defaults (staleTime, retry, mutation error) |
| P1-4 | P1 | `auth/callback.tsx` | PII (email) logged to `console.log` on every sign-in |
| P1-5 | P1 | All leaf routes | No per-leaf `errorComponent` — layout nuked on any throw |
| P2-1 | P2 | `cyberpunk.css`, `styles.css` | Reduced-motion CSS only applied on timer pages |
| P2-2 | P2 | `__root.tsx:42` | 404 page shows error UI instead of "not found" UI |
| P2-3 | P2 | `dashboard/index.tsx` | Stat cards have no loading/error state |
| P2-4 | P2 | 9 files | `DEV_USER_ID` constant duplicated |
| P2-5 | P2 | `useSettings.ts:51,64` | `console.error` on settings load/save failures |
| P2-6 | P2 | `TaskForm.tsx` | No inline error shown on submit failure |
| P2-7 | P2 | `timer/index.tsx:76` | Popup blocked silently — no fallback |
| P2-8 | P2 | `PlannerTimeline.tsx:122` | `touchAction: none` blocks mobile scroll in 1440px timeline |
| P2-9 | P2 | `KanbanCard.tsx:104` | `<Link>` nested inside `role="button"` — invalid ARIA |
| P2-10 | P2 | `signup.tsx:211` | Legal links point to `/` redirect |
| P2-11 | P2 | `reset-password.tsx:65` | No inline validation on password confirm field |
| P2-12 | P2 | `CelebrationModal.tsx:192` | `animate-bounce-slow`/`animate-pulse` bypass reduced-motion CSS |

## P0 Blockers

- **No global error boundary anywhere.**
  `src/dashboard/apps/web/src/routes/__root.tsx` does NOT define `errorComponent`, `notFoundComponent`, or a React `ErrorBoundary` wrapper. No route file defines `errorComponent` or `pendingComponent`. When any loader throws (server down, SQLite locked, WorkOS auth failure) the user sees a white screen with a raw React stack trace in the console. TanStack Router's default error behaviour in production is a blank page.
  *Fix:* Add `errorComponent` to the root route (catch-all generic "Something went wrong" page). Add per-route `errorComponent` on data-heavy routes (timer, assistant/tasks, planner, notes, bookmarks, analytics).

- **`useSettings` calls `localStorage` at module scope (line 69) — SSR crash risk.**
  `src/dashboard/apps/web/src/lib/hooks/useSettings.ts:69` — `let globalSettings = loadSettings();` runs at module evaluation time. `loadSettings()` guards with `typeof window === "undefined"` so it returns `DEFAULT_SETTINGS` on the server, but the singleton is initialised once and never re-evaluated on the client. On a cold SSR + hydration, the Switch components in `settings.tsx` render `checked={settings.scanLinesEffect}` from a server-computed value that differs from localStorage, causing a React hydration mismatch warning (and potential flicker / double-render). Not a crash today but fragile.
  *Fix:* Move the singleton initialisation inside a `useEffect` or use `useSyncExternalStore` with `getServerSnapshot` returning defaults.

- **`CelebrationManagerProvider` store initialises `loadSettings()` at module scope (line 80).**
  `src/dashboard/apps/web/src/routes/assistant/-components/celebrations/CelebrationManager.tsx:80` — `new Store<CelebrationManagerState>({ settings: loadSettings(), ... })` is evaluated when the module is first imported, i.e. during SSR. Same guard exists (`typeof window === "undefined"`) so it won't crash, but the store state is shared across all SSR requests and will use DEFAULT values, then hydrate with localStorage values → hydration mismatch risk.
  *Fix:* Lazy-initialise store inside a `useEffect` or defer to `ClientOnly`.

- **`profile.tsx` "Save Changes" button is a no-op.**
  `src/dashboard/apps/web/src/routes/profile.tsx:262` — The "Save Changes" button has no `onClick`, no form submission, and no mutation. The display name input also uses `defaultValue` (uncontrolled) so its value is never read. A user editing their display name and clicking "Save" gets silent data loss.
  *Fix:* Either wire up a `updateProfile` server function, or clearly mark the field as read-only (disabled) like the email field is.

- **Profile page: "Connect" OAuth buttons are no-ops.**
  `src/dashboard/apps/web/src/routes/profile.tsx:333,360` — Both "Connect" buttons (Google, GitHub) have no `onClick` handler. Clicking them silently does nothing. For a small trusted-group app this is at minimum confusing UX; it may mislead users into thinking they've linked an account.
  *Fix:* Either wire them to `getOAuthUrlFn` or disable + tooltip "Coming soon".

- **Delete Account button is a no-op.**
  `src/dashboard/apps/web/src/routes/profile.tsx:378` — The button renders with no `onClick`, no confirmation, no mutation. The "Warning: this action cannot be undone" copy adds urgency without any function. A user clicking it expects a confirmation dialog; nothing happens.

- **`window.confirm()` used for destructive actions (SSR risk + bad UX).**
  - `src/dashboard/apps/web/src/routes/dashboard/-notes/NoteEditor.tsx` — `confirm("Delete …?")` 
  - `src/dashboard/apps/web/src/routes/assistant/tasks/$taskId.tsx:214` — `confirm("Are you sure …?")`
  - `src/dashboard/apps/web/src/lib/timer/components/ActivityLogSidebar.tsx` — `window.confirm("Clear all …?")`
  `window.confirm` is synchronous and blocks the JS thread; it's also fully unstyled and unmatchable to the cyberpunk aesthetic, and it's unavailable during SSR (will throw if called outside a browser event handler on an SSR render).
  *Fix:* Replace with an `AlertDialog` from shadcn (already available via `@ui/components`).

---

## P1 — Rough But Usable

### Error Handling / Error States

- **TanStack Query `isError` not surfaced in `dashboard/ai.tsx` conversation list.**
  `src/dashboard/apps/web/src/routes/dashboard/ai.tsx:43` — `useConversations` returns `isLoading` only; if the query errors, `conversations` stays `[]` and the sidebar shows "no conversations" with no error copy. The user has no feedback that something went wrong.
  *Fix:* Destructure `isError, error` from the hook and render a banner.

- **`usePlannerData` query errors are not propagated to the UI clearly.**
  `src/dashboard/apps/web/src/routes/dashboard/-planner/usePlannerData.ts` — the `focusSessionsQuery.error` is never returned; the planner page checks `error` from `tasksQuery` only, so a focus-sessions fetch failure silently gives an empty timeline with no ghost blocks.

- **`analytics.tsx` — error branches missing for energy/distraction hooks.**
  `src/dashboard/apps/web/src/routes/assistant/analytics.tsx` — `loadHeatmap` and `loadDistractionStats` `finally` blocks clear `loading`, but `catch` is empty (errors are swallowed silently). The page renders empty charts with no indication of failure.
  *Fix:* Store error state and render an `AlertBlock` when present.

### Auth Forms

- **`signin.tsx` — no client-side validation before submitting.**
  There is no validation beyond `required` HTML attributes. An empty password will be submitted to the server. `required` is skipped if JavaScript disables default validation. Inline field-level errors are not supported (the `AuthInputField` component has an `error` prop that is never used in auth routes).
  *Fix:* Add minimal JS validation (non-empty check) before calling `signInFn`, or pass `error` prop to `AuthInputField`.

- **`signup.tsx` — password strength not validated beyond `minLength={8}`.**
  The description says "Must be at least 8 characters with letters and numbers" but there is no actual alphanumeric validation. A password like `12345678` passes.
  *Fix:* Add regex validation and show field-level error via `AuthInputField`'s `error` prop.

- **`reset-password.tsx` — no `navigate` `await` guard on redirect (`navigate` call not awaited at line 81).**
  The call `navigate({ to: "/auth/signin", search: { reset: true } })` is not awaited. In TanStack Router this is technically fine (navigate is fire-and-forget) but if the `finally` block runs and sets `isLoading(false)` before navigation completes, a re-render of the now-unmounted form could flash.

### Loading & Empty States

- **`dashboard/ai.tsx` — no loading state for conversation list.**
  `convsLoading` is destructured but the sidebar component (`ConversationSidebar`) receives it as a prop — unclear if it renders a skeleton. Reading `ConversationSidebar.tsx` is needed to confirm; if not, the sidebar flashes empty then fills.

- **`dashboard/focus.tsx` — entire page has no route-level `pendingComponent`.**
  `FocusHero` shows its own `PageLoadingSpinner` after it mounts (clientside), but SSR will render an empty page until the client-side timer query resolves.

- **`analytics.tsx` — badge progress section has no loading skeleton.**
  `badgeProgressHook.loading` is checked inside the child components but the section header renders immediately, causing layout shift.

- **Notes search input has no `aria-label`.**
  `src/dashboard/apps/web/src/routes/dashboard/notes.tsx:77` — `<input type="text" placeholder="Search notes…">` has no associated `<label>` or `aria-label`. Screen readers have no context.

### TanStack Query Unhandled Rejection Risk

- **`useTimerStore` mutation `mutateAsync` is not wrapped in try/catch at call sites.**
  `src/dashboard/apps/web/src/routes/timer/index.tsx:62-66` — `handleAddTimer` calls `createTimer()` which calls `createMutation.mutateAsync(...)` without try/catch. If the server function fails, an unhandled promise rejection is thrown and TanStack Query will surface it as an error in the devtools but the UI shows no feedback.
  *Fix:* Wrap in try/catch, show a toast error via `sonner`.

- **`planner.tsx` — `scheduleTask` / `createTask` mutations have no error handling in the UI.**
  Drag-and-drop schedule failures are silent; the card snaps back (optimistic update was not used) but no error toast fires.

---

## P2 — Polish

### SSR Landmine Sweep

- **No unguarded `from "radix-ui"` (umbrella) imports found** — confirmed via `rg`. All Radix imports use the scoped `@radix-ui/*` packages. The Avatar in `profile.tsx` is correctly wrapped in `<ClientOnly>` (the known landmine is fixed).

- **`MicroCelebration` uses `createPortal(content, document.body)` with a guard at line 178 but no `ClientOnly`.**
  `src/dashboard/apps/web/src/routes/assistant/-components/celebrations/MicroCelebration.tsx:178` — `if (typeof document === "undefined") return null` prevents an SSR crash, but `useState`, `useEffect` are run on SSR. Because this component is only mounted as a child of `CelebrationManagerProvider` which itself is only rendered inside client-driven task action handlers, in practice it's fine — but the guard should be noted.

- **`BadgeCelebration` has the same `typeof document === "undefined"` pattern (line 350).**
  Same analysis as above — functionally safe but relying on call-site discipline.

- **`FocusHero` ambient orbs and scanlines ignore `prefers-reduced-motion`.**
  `src/dashboard/apps/web/src/routes/dashboard/-focus/FocusHero.tsx:97-107` — The two `w-[40rem]` ambient orb divs and the scanlines div use `transition-colors duration-1000` and dynamic `opacity` via inline style. None of these honour `prefers-reduced-motion`. The `useSettings` hook has a `reducedMotion` setting, but it is not consumed here.
  *Fix:* Add `motion-reduce:transition-none motion-reduce:opacity-0` Tailwind classes, or read `settings.reducedMotion` and skip orb rendering.

- **`cyberpunk.css` — all `@keyframes` animations lack `@media (prefers-reduced-motion: reduce)` wrappers.**
  `src/dashboard/apps/web/src/components/auth/cyberpunk.css` — `.animate-ripple`, `.animate-ripple-delayed`, `.animate-ripple-delayed-2`, `.animate-pulse-glow`, `.animate-flash`, `.glitch-effect`, `.animate-fade-in-up` etc. all run permanently without checking `prefers-reduced-motion`. `CelebrationModal` correctly checks via JS, but the CSS animations bypass that.
  *Fix:* Add at the end of the file:
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
  ```

- **`MicroCelebration` progress bar uses inline `@keyframes shrink-width` injected via `<style>` tag at line 168.**
  This duplicates the keyframe definition in every toast rendered simultaneously. Not a crash but adds unnecessary style elements to `<head>` repeatedly.

- **`BadgeCelebration` particle canvas always starts at full `window.innerWidth × innerHeight`.**
  No `prefers-reduced-motion` guard before `createParticles` — `CelebrationModal` confetti does respect it, but `BadgeCelebration` particles do not check.
  *Fix:* Check `window.matchMedia("(prefers-reduced-motion: reduce)").matches` before animating, same as `CelebrationModal`.

### Accessibility

- **`CelebrationSettingsPanel` mode buttons have no `type="button"` and the particle checkbox has no `aria-label`.**
  `src/dashboard/apps/web/src/routes/assistant/-components/celebrations/CelebrationManager.tsx:516` — `<button onClick={...}>` without `type="button"` inside a potential ancestor form (e.g. if rendered inside `TaskForm`). The inline `<input type="checkbox">` at line 534 has no `<label>`.

- **Handoff History modal close button has no visible text and relies on `sr-only` span, but the span text is correct — P2 OK.**
  `src/dashboard/apps/web/src/routes/assistant/tasks/$taskId.tsx:842` — `<span className="sr-only">Close</span>` is present. Good.

- **`UrgencyButton` components in `$taskId.tsx` have no keyboard indicator of selected state beyond ring — needs `aria-pressed`.**
  `src/dashboard/apps/web/src/routes/assistant/tasks/$taskId.tsx:904` — `<button type="button">` with no `aria-pressed` attribute. Screen readers can't tell which urgency level is currently selected.

- **`StatusButton` in `$taskId.tsx` (line 917) same issue — no `aria-pressed`.**

- **`PlannerListView` "Focus →" button is opacity-0 by default (`opacity-0 group-hover:opacity-100`).**
  `src/dashboard/apps/web/src/routes/dashboard/planner.tsx:188` — keyboard users navigating via Tab will focus an invisible button with no visible focus ring feedback. On reduced motion, hover-triggered visibility never appears.
  *Fix:* Use `focus-within:opacity-100` on the row container to show the button on keyboard focus.

### Mobile Responsiveness

- **Planner timeline uses `style={{ minHeight: "calc(100vh - 220px)" }}` as a fixed layout.**
  `src/dashboard/apps/web/src/routes/dashboard/planner.tsx:104` — The `flex gap-3` container with `PlannerTimeline` and `PlannerInbox` side by side has no responsive breakpoint. On narrow viewports (< 640px), the two panels overflow horizontally with no horizontal scroll or stacking.
  *Fix:* Wrap in `flex-col md:flex-row` and remove the fixed `minHeight` on mobile.

- **`dashboard/ai.tsx` fixed height container.**
  `src/dashboard/apps/web/src/routes/dashboard/ai.tsx:117` — `h-[calc(100vh-8rem)]` may clip on mobile viewports where the browser chrome/navigation bar reduces available height, or when a virtual keyboard is open.

- **`assistant/tasks/$taskId.tsx` sidebar grid is `lg:grid-cols-3` with no fallback on mobile.**
  `src/dashboard/apps/web/src/routes/assistant/tasks/$taskId.tsx:368` — `grid gap-6 lg:grid-cols-3` — below `lg` breakpoint (1024px), both columns collapse to single-column stacking. This is actually fine for mobile. No issue.

### Console Error Sources

- **Settings page `<Select>` for Theme uses `defaultValue="dark"` (uncontrolled).**
  `src/dashboard/apps/web/src/routes/settings.tsx:39` — The `Select` for Theme and Language/Time Format use `defaultValue` rather than `value + onChange`. The `useSettings` hook has a `theme` field, but it's never applied to these dropdowns. Changes made in the dropdowns are not persisted and not reflected in `useSettings`. On re-render, `defaultValue` doesn't update, causing stale values.
  *Fix:* Bind `value={settings.theme}` and `onValueChange={(v) => handleSettingChange("theme", v as "dark"|"light"|"system", "Theme")}`.

- **`analytics.tsx` — `selectedBadge` state is set but never read (line 163 `void selectedBadge`).**
  `src/dashboard/apps/web/src/routes/assistant/analytics.tsx:163` — This state is entirely dead — set via `handleBadgeClick` but suppressed with `void`. The badge click shows the unlock animation via `badgeUnlock.showUnlock(badge)`, but `selectedBadge` serves no purpose.
  *Fix:* Remove the state, or use it to show a detail panel.

- **`$taskId.tsx` `formatDateForInput` is declared inside the component and used in a `useEffect` dependency array.**
  `src/dashboard/apps/web/src/routes/assistant/tasks/$taskId.tsx:126` — `[task, formatDateForInput]` — `formatDateForInput` is a new function reference on every render, so the effect runs every render when `task` is present. This suppresses the actual re-run intent and may cause a subtle loop if `task` is updated inside the effect (it isn't, but it's a dangerous pattern).
  *Fix:* Move `formatDateForInput` outside the component or wrap in `useCallback` (React Compiler should handle this, but the eslint-disable comment suggests the dep array is intentionally incomplete).

- **`signup.tsx` OAuth handler calls `window.location.href = url` without a `typeof window !== "undefined"` guard (line 83).**
  Unlike `signin.tsx` which wraps with `if (typeof window !== "undefined")`, `signup.tsx` calls `window.location.href` directly. If this function were somehow called during SSR (e.g. a server function accidentally), it would throw. Low risk but inconsistent.

---

## Summary Table

| Area | P0 | P1 | P2 |
|---|---|---|---|
| Error boundaries | 1 (none globally, none per-route) | — | — |
| Profile dead buttons | 3 (Save, Connect ×2, Delete) | — | — |
| SSR hydration risk | 2 (useSettings, CelebrationManagerStore) | — | — |
| Auth forms | — | 2 (validation gaps) | — |
| TanStack Query error handling | — | 3 routes | — |
| Accessibility | — | — | 4 missing aria-pressed/labels |
| Reduced motion | — | — | 2 (CSS animations, BadgeCelebration particles) |
| Mobile layout | — | — | 2 (Planner, AI) |
| Dead state / no-op UI | — | — | 2 (Settings selects, selectedBadge) |
| native confirm() | 1 | — | — |

---

## Unguarded SSR Landmines (from "radix-ui" umbrella)

**Count: 0.** No files import from the umbrella `"radix-ui"` package. All Radix usage goes through `@radix-ui/*` scoped packages. The known `profile.tsx` Avatar landmine is already guarded with `<ClientOnly>`. No new landmines found.

The `loadSettings()` singleton at module scope in `useSettings.ts` and `CelebrationManager.tsx` are SSR hydration risks (not crashes, but cause mismatch warnings).
