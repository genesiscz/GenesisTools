# TanStack Start Dashboard Migration Plan

> **Detailed plans:**
> - Phase 1+2 (Shared Base + Claude History Dashboard): `.claude/plans/2026-03-07-DashboardsBase.md`
> - Phase 3 (Clarity Migration): `.claude/plans/2026-03-07-DashboardsClarity.md`

## Context

Multiple dashboard apps (`claude-history-dashboard`, `clarity`) share a base UI layer at `src/utils/ui/`. The architecture is inconsistent:
- `src/utils/ui/` only provides client-side React scaffolding (no TanStack Start awareness)
- `claude-history-dashboard` bolted on TanStack Start independently with ugly `/_serverFn/eyJ...` URLs
- `clarity` rolled its own API middleware via a custom Vite plugin + manual dispatch map

**Goal:** Unify both apps on proper TanStack Start with:
1. Shared base config that includes `tanstackStart()`
2. Clean REST API endpoints via TanStack Start server routes (`/api/conversations`, not `/_serverFn/eyJ...`)
3. Clarity fully ported to TanStack Start (file-based routing + SSR + server routes)

## Decisions

- **Separate apps** — each app keeps its own vite.config + routes dir + port, extending from shared `createDashboardViteConfig()`
- **Both serverFn + server routes** — keep `createServerFn()` for route loaders (type-safe, integrated with TanStack Router's defer/loader), add server routes for clean REST API
- **Full TanStack Start for Clarity** — migrate from hash routing to file-based TanStack Start with SSR
- **Clarity keeps fetch() + React Query** — components continue using `fetch('/api/...')`, server routes replace the Vite middleware hack

---

## Phase 1: Shared Base (`src/utils/ui/`)

### 1.1 Update `src/utils/ui/vite.base.ts`

Add `tanstackStart()` to `createDashboardViteConfig()` plugin chain.

**New interface fields:**
```typescript
export interface DashboardViteConfig {
    // ... existing fields ...
    /** TanStack Start plugin options. Pass `false` to disable for non-Start apps. Default: enabled */
    tanstackStartOptions?: Parameters<typeof tanstackStart>[0] | false;
    /** Options passed to @vitejs/plugin-react (e.g., babel plugins) */
    reactOptions?: Parameters<typeof viteReact>[0];
}
```

**Plugin order** (per TanStack Start docs: react MUST come AFTER start):
1. `resolveSharedDeps(root)` (enforce: "pre")
2. `tailwindcss()`
3. `tanstackStart(options)` (unless `tanstackStartOptions === false`)
4. `viteReact(reactOptions)` (must come after tanstackStart)
5. `...extraPlugins`

**Import resolution:** `vite.base.ts` statically imports `tanstackStart` from `@tanstack/react-start/plugin/vite`. This resolves at runtime because each app's vite process runs from the app dir, which has `@tanstack/react-start` in its `node_modules`. Both current consumers (claude-history-dashboard, clarity) have/will have it installed.

### 1.2 No Changes to `create-app.tsx`

`createDashboardApp()` stays as a client-only utility. TanStack Start apps use `hydrateRoot(document, <StartClient />)` instead.

**Files modified:** `src/utils/ui/vite.base.ts` only

---

## Phase 2: Claude History Dashboard

### 2.1 Simplify `vite.config.ts` to use shared factory

```typescript
import { devtools } from "@tanstack/devtools-vite";
import { resolve } from "node:path";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { createDashboardViteConfig } from "../utils/ui/vite.base";

export default createDashboardViteConfig({
    root: __dirname,
    port: 3069,
    plugins: [
        devtools(),
        viteTsConfigPaths({ projects: ["./tsconfig.json"] }),
    ],
    reactOptions: {
        babel: { plugins: ["babel-plugin-react-compiler"] },
    },
    aliases: {
        "@app": resolve(__dirname, ".."),
    },
});
```

- `devtools()` + `viteTsConfigPaths()` stay as app-specific extra plugins
- `babel-plugin-react-compiler` passes through `reactOptions` to `viteReact()`
- `@app` overrides default (`resolve(root, "src")`) to point one level up

### 2.2 Extract Serializers

Move serialization types & helpers from `src/server/conversations.ts` → new `src/server/serializers.ts`. Both serverFn handlers and server route handlers reuse them.

### 2.3 Add REST API Server Routes

New files in `src/claude-history-dashboard/src/routes/api/`:

| File | Route | Method | Backend Function |
|------|-------|--------|-----------------|
| `conversations.ts` | `/api/conversations` | GET | `getAllConversations`, `searchConversations` |
| `conversations.$id.ts` | `/api/conversations/$id` | GET | `getConversationBySessionId` |
| `stats.ts` | `/api/stats` | GET | `getQuickStatsFromCache` |
| `stats.full.ts` | `/api/stats/full` | GET | `getConversationStatsWithCache`, `getStatsForDateRange` |
| `projects.ts` | `/api/projects` | GET | `getAvailableProjects` |

**No changes** to existing routes, serverFn, main.tsx, router.tsx, __root.tsx. Server routes are purely additive.

---

## Phase 3: Clarity UI — Full TanStack Start Migration

### 3.1 Add Dependencies

Add `@tanstack/react-start`, `@tanstack/router-plugin` to `src/clarity/ui/package.json`

### 3.2 Rewrite `vite.config.ts`

Remove `lazyApiPlugin()`, use `createDashboardViteConfig()` (TanStack Start handles API routes natively)

### 3.3 Create `router.tsx`

Router factory with `routeTree.gen` + type registration

### 3.4 Rewrite `main.tsx`

Replace `createDashboardApp()` → `hydrateRoot(document, <StartClient />)`

### 3.5 Create `routes/__root.tsx`

SSR document shell migrating from `App.tsx`:
- `RootDocument` — `<html>/<head>/<body>` with `<HeadContent>` + `<Scripts>`
- `RootComponent` — `QueryClientProvider` + `AppProvider` + `Toaster`
- `ClarityLayout` — `DashboardLayout` with nav links, uses `useRouter()` for navigation

### 3.6 Convert 5 Page Routes

Add `createFileRoute` wrapper to each: `index.tsx`, `mappings.tsx`, `export.tsx`, `import.tsx`, `settings.tsx`. Component internals completely unchanged — all `fetch('/api/...')` + `useQuery` + `useAppContext()` stay as-is.

### 3.7 Create 14 Server Route Files

Replace `api-handler.ts` dispatch map with individual server route files in `routes/api/`:

| Server Route File | Methods | Replaces |
|---|---|---|
| `mappings.ts` | GET, POST, DELETE | `GET/POST/DELETE /api/mappings` |
| `move-mapping.ts` | POST | `POST /api/move-mapping` |
| `export.ts` | POST | `POST /api/export` |
| `fill.preview.ts` | POST | `POST /api/fill/preview` |
| `fill.execute.ts` | POST | `POST /api/fill/execute` |
| `clarity-weeks.ts` | POST | `POST /api/clarity-weeks` |
| `clarity-tasks.ts` | POST | `POST /api/clarity-tasks` |
| `ado-config.ts` | GET | `GET /api/ado-config` |
| `ado-workitems.ts` | POST | `POST /api/ado-workitems` |
| `status.ts` | GET | `GET /api/status` |
| `test-connection.ts` | POST | `POST /api/test-connection` |
| `update-auth.ts` | POST | `POST /api/update-auth` |
| `workitem-type-colors.ts` | GET | `GET /api/workitem-type-colors` |
| `timelog-entries.ts` | POST | `POST /api/timelog-entries` |

Dot convention for nested paths: `fill.preview.ts` → `/api/fill/preview`

Existing server modules (`server/export.ts`, `server/fill.ts`, `server/mappings.ts`, `server/settings.ts`) stay untouched.

### 3.8 Delete Obsolete Files

- `src/clarity/ui/src/App.tsx` — replaced by `__root.tsx` + file-based routes
- `src/clarity/ui/src/server/api-handler.ts` — replaced by server route files
- `src/clarity/ui/index.html` — replaced by TanStack Start SSR shell

### 3.9 AppContext

`AppProvider` moves from `App.tsx` into `__root.tsx`'s `RootComponent`. All `useAppContext()` calls unchanged.

---

## Edge Cases & Risks

| Risk | Mitigation |
|------|-----------|
| `tanstackStart()` + `viteReact()` conflict | Per TanStack docs, both are required; react MUST come after start. No conflict. |
| Route tree generation with API-only routes | TanStack Start explicitly supports routes with only `server.handlers` and no `component` |
| Hash → browser history URL change | Local dev tool, no real bookmarks. Can add redirect for `#/` if needed |
| SSR + `useAppContext()` hydration | `new Date()` runs within ms on localhost. No mismatch risk |
| Bun runtime compatibility | claude-history-dashboard already runs TanStack Start on Bun |
| sonner Toaster in SSR | Renders nothing server-side, hydrates on client (standard pattern) |
| `@app` imports in client components | Type-only imports stripped at compile. Pure functions bundle fine |

---

## Implementation Order

1. Update `src/utils/ui/vite.base.ts` (add tanstackStart + reactOptions)
2. Switch claude-history-dashboard's vite.config to shared factory
3. Verify claude-history-dashboard works (`bun --bun vite dev --port 3069`)
4. Extract serializers, create API server route files
5. Verify API routes (`curl http://localhost:3069/api/conversations`)
6. Add TanStack Start deps to clarity's package.json + `bun install`
7. Rewrite clarity's vite.config.ts
8. Create `router.tsx`
9. Rewrite `main.tsx`
10. Create `__root.tsx` (SSR shell + layout + providers)
11. Convert 5 page routes to file-based routes
12. Create 14 server route files under `routes/api/`
13. Delete `App.tsx`, `api-handler.ts`, `index.html`
14. Verify all clarity routes and API endpoints

---

## Verification

### Phase 2
```bash
cd src/claude-history-dashboard && bun --bun vite dev --port 3069
# Pages: /, /stats, /conversation/<id>
# API: curl localhost:3069/api/conversations | tools json
# API: curl localhost:3069/api/stats | tools json
# API: curl localhost:3069/api/projects | tools json
```

### Phase 3
```bash
cd src/clarity/ui && bun install && bun --bun vite dev --port 3071
# Pages: /, /mappings, /export, /import, /settings
# API: curl localhost:3071/api/mappings | tools json
# API: curl localhost:3071/api/status | tools json
# API: curl -X POST localhost:3071/api/clarity-weeks -H 'Content-Type: application/json' -d '{"month":3,"year":2026}' | tools json
```

---

## Files Summary

| File | Action |
|------|--------|
| **Phase 1** | |
| `src/utils/ui/vite.base.ts` | **Modify** — add tanstackStart to plugin chain, add reactOptions |
| **Phase 2** | |
| `src/claude-history-dashboard/vite.config.ts` | **Simplify** — use createDashboardViteConfig |
| `src/claude-history-dashboard/src/server/serializers.ts` | **Create** — extracted types & helpers |
| `src/claude-history-dashboard/src/server/conversations.ts` | **Modify** — import from serializers |
| `src/claude-history-dashboard/src/routes/api/conversations.ts` | **Create** — GET /api/conversations |
| `src/claude-history-dashboard/src/routes/api/conversations.$id.ts` | **Create** — GET /api/conversations/:id |
| `src/claude-history-dashboard/src/routes/api/stats.ts` | **Create** — GET /api/stats |
| `src/claude-history-dashboard/src/routes/api/stats.full.ts` | **Create** — GET /api/stats/full |
| `src/claude-history-dashboard/src/routes/api/projects.ts` | **Create** — GET /api/projects |
| **Phase 3** | |
| `src/clarity/ui/package.json` | **Modify** — add @tanstack/react-start, router-plugin |
| `src/clarity/ui/vite.config.ts` | **Rewrite** — remove lazyApiPlugin, use shared base |
| `src/clarity/ui/src/router.tsx` | **Create** — router factory |
| `src/clarity/ui/src/main.tsx` | **Rewrite** — hydrateRoot + StartClient |
| `src/clarity/ui/src/routes/__root.tsx` | **Create** — SSR shell + layout + providers |
| `src/clarity/ui/src/routes/index.tsx` | **Modify** — add createFileRoute wrapper |
| `src/clarity/ui/src/routes/mappings.tsx` | **Modify** — add createFileRoute wrapper |
| `src/clarity/ui/src/routes/export.tsx` | **Modify** — add createFileRoute wrapper |
| `src/clarity/ui/src/routes/import.tsx` | **Modify** — add createFileRoute wrapper |
| `src/clarity/ui/src/routes/settings.tsx` | **Modify** — add createFileRoute wrapper |
| `src/clarity/ui/src/routes/api/*.ts` (14 files) | **Create** — server routes replacing api-handler |
| `src/clarity/ui/src/App.tsx` | **Delete** |
| `src/clarity/ui/src/server/api-handler.ts` | **Delete** |
| `src/clarity/ui/index.html` | **Delete** |

---

# Clarity UI Fixes — Week Table + Mappings UX

## Context

After completing the TanStack Start migration (above), several UX issues were found on the Import and Mappings pages:

1. **Import page week table** shows Mon-Fri columns regardless of actual period dates — weekends are invisible and hours land in wrong columns
2. **Import page "Clarity Task" column** truncates at fixed 200px instead of using available width
3. **Mappings page** only shows Clarity tasks that have mapped work items — when the last item is moved away, the task group vanishes
4. **No quick-add per task** — to add a work item to an existing Clarity task, you must go through the full 3-step AddMappingForm

---

## Fix 1: Week Table Day Columns

**File:** `src/clarity/ui/src/components/FillWeekCard.tsx`

**Problem:** `getWorkDays(periodStart)` (line 29-45) iterates 7 days from start but filters `dow >= 1 && dow <= 5` (Mon-Fri only). For "2026-02-01 to 2026-02-02" (Sat-Sun), it skips both days and shows Mon 3 through Fri 6 instead.

**Fix:** Rename to `getDaysInPeriod(periodStart, periodFinish)`. Iterate from start to finish (inclusive), include ALL days:

```typescript
function getDaysInPeriod(periodStart: string, periodFinish: string): Array<{ label: string; date: string }> {
    const start = new Date(periodStart);
    const finish = new Date(periodFinish);
    const days: Array<{ label: string; date: string }> = [];
    const current = new Date(start);

    while (current <= finish) {
        const dow = current.getDay();
        const dateStr = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`;
        days.push({ label: `${DAY_NAMES[dow]} ${current.getDate()}`, date: dateStr });
        current.setDate(current.getDate() + 1);
    }

    return days;
}
```

Update call site: `const workDays = getDaysInPeriod(periodStart, periodFinish);`

Date format is consistently `YYYY-MM-DD` throughout the stack — no other changes needed.

## Fix 2: Task Name Truncation

**File:** `src/clarity/ui/src/components/FillWeekCard.tsx` line 102

**Problem:** `<div className="max-w-[200px] truncate">` forces fixed 200px.

**Fix:** Remove `max-w-[200px]`, keep `truncate`. The table cell sizes naturally.

## Fix 3: Show All Clarity Tasks as Groups

**Problem:** `groupMappings()` in `MappingTable.tsx` derives groups purely from mappings. When the last work item moves out, the group disappears.

### MappingsPage changes (`src/clarity/ui/src/routes/mappings.tsx`)

Add queries for clarity-weeks + clarity-tasks (React Query dedupes with AddMappingForm's identical keys):

```typescript
const { data: weeksData } = useQuery({
    queryKey: ["clarity-weeks", month, year],
    queryFn: () => fetchWeeks(month, year),
});

const firstTimesheetId = weeksData?.weeks[0]?.timesheetId;
const { data: tasksData } = useQuery({
    queryKey: ["clarity-tasks", firstTimesheetId],
    queryFn: () => fetchClarityTasks(firstTimesheetId!),
    enabled: !!firstTimesheetId,
});
```

Pass `allTasks={tasksData?.tasks ?? []}` to MappingTable.

### MappingTable changes (`src/clarity/ui/src/components/MappingTable.tsx`)

New prop `allTasks`. In `groupMappings`, after building groups from mappings, add empty groups for tasks in `allTasks` not already grouped. Remove the early return for `mappings.length === 0` — groups can now exist from `allTasks` alone.

## Fix 4: "+" Button Per Group with Reusable WorkItemSelector

### Extract WorkItemSelector component

**New file:** `src/clarity/ui/src/components/WorkItemSelector.tsx`

Extract the Step 3 UI from `AddMappingForm.tsx` (the timelog entries list + ADO search + multi-select + submit) into a standalone component.

**Props:**
```typescript
interface WorkItemSelectorProps {
    clarityTask: {
        taskId: number;
        taskName: string;
        taskCode: string;
        investmentName: string;
        investmentCode: string;
    };
    timesheetId?: number;
    month: number;
    year: number;
    onItemsAdded: () => void;
}
```

Includes: timelog entries with filter + "Show mapped" toggle, ADO search input + results, selected count + "Add mappings" button. Handles own state and calls `addMappingApi` on submit.

### Update AddMappingForm (`src/clarity/ui/src/components/AddMappingForm.tsx`)

Replace inline Step 3 with `<WorkItemSelector>`. Remove all Step 3 state/logic that moved into WorkItemSelector (selectedWorkItems, timelogFilter, showMapped, adoQuery, submitProgress, mutations, etc.).

### Add "+" button to MappingTable group headers

New prop `onAdd: (task: ClarityGroup) => void`. Small `<Plus>` button in each group header next to the item count badge.

### Add Dialog to MappingsPage (`src/clarity/ui/src/routes/mappings.tsx`)

State: `addToTask` (null or ClarityGroup). Pass `onAdd={setAddToTask}` to MappingTable.

Dialog uses `@ui/components/dialog` with cyberpunk styling:
```tsx
<Dialog open={!!addToTask} onOpenChange={(open) => !open && setAddToTask(null)}>
    <DialogContent className="sm:max-w-2xl bg-gray-950 border-amber-500/20">
        <DialogHeader>
            <DialogTitle className="font-mono text-sm text-gray-200">
                Add work items to <span className="text-amber-400">{addToTask?.clarityTaskName}</span>
            </DialogTitle>
            <DialogDescription className="font-mono text-xs text-gray-500">
                {addToTask?.clarityTaskCode} · {addToTask?.clarityInvestmentName}
            </DialogDescription>
        </DialogHeader>
        {addToTask && (
            <WorkItemSelector
                clarityTask={addToTask}
                timesheetId={firstTimesheetId}
                month={month}
                year={year}
                onItemsAdded={() => {
                    setAddToTask(null);
                    queryClient.invalidateQueries({ queryKey: ["mappings"] });
                }}
            />
        )}
    </DialogContent>
</Dialog>
```

---

## Shared Types

The `ClarityTask` interface is duplicated in `AddMappingForm.tsx` and `server/mappings.ts`. Export from `server/mappings.ts` (it already defines `ClarityTask` at line 7-14) and import in both components.

---

## Files Summary

| File | Action |
|------|--------|
| `src/clarity/ui/src/components/FillWeekCard.tsx` | Fix `getWorkDays` → `getDaysInPeriod`, fix truncation |
| `src/clarity/ui/src/components/WorkItemSelector.tsx` | **Create** — extracted Step 3 from AddMappingForm |
| `src/clarity/ui/src/components/AddMappingForm.tsx` | Replace inline Step 3 with WorkItemSelector |
| `src/clarity/ui/src/components/MappingTable.tsx` | Add `allTasks` prop, empty groups, "+" button |
| `src/clarity/ui/src/routes/mappings.tsx` | Fetch clarity tasks, pass to MappingTable, add Dialog |

## Verification

1. **Import** (`/import`): "Week: 2026-02-01 to 2026-02-02" shows "Sat 1", "Sun 2" columns. Hours in correct columns. Normal weeks still work. Task names truncate at natural width.
2. **Mappings** (`/mappings`): All Clarity tasks from timesheet visible as groups, even with 0 items. Moving last item keeps group. "+" button opens dialog. Adding items via dialog works. AddMappingForm Step 3 still works via shared WorkItemSelector.
