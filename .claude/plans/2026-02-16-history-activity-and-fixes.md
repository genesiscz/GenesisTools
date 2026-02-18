# Azure DevOps History Activity + Cache Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge history + comments into the unified `workitem-*.json` cache, fix reporting API bugs, and add `tools azure-devops history activity` command for "what did I do this week?" reconstruction.

**Architecture:** Today there are two cache files per work item: `workitem-<id>.json` (lightweight index, 365-day TTL) and `history-<id>.json` (updates + periods, 7-day TTL). This plan merges them into a single `workitem-<id>.json` with optional `history` and `comments` sections, each with their own `fetchedAt` timestamp for per-section freshness checks. The `--download-workitems` feature (saves to `.claude/azure/tasks/`) is unchanged — it's a separate export, not a cache.

**Tech Stack:** TypeScript/Bun, existing `@app/azure-devops/*` modules, `@clack/prompts`, `commander`

---

## Task 1: Fix Reporting API Infinite Loop Bug

**Files:**
- Modify: `src/azure-devops/api.ts:779-801` (the `getReportingRevisions` pagination loop)

**Problem:** The `do...while (continuationToken)` loop never checks `isLastBatch` or detects empty pages. Azure DevOps returns continuation tokens even on the last/empty page, causing infinite requests with no new data.

**Evidence from logs:**
```
Page 4: 3114 revisions scanned, 72/186 items matched  ← last real data
Page 5: 3114 revisions scanned, 72/186 items matched  ← zero new revisions
Page 6+: same counts forever...
```

**Step 1: Add loop termination conditions**

In `src/azure-devops/api.ts`, in the `getReportingRevisions()` method, change the loop. The full loop body stays the same — just add the break condition after `onProgress`:

```typescript
// After this existing line:
options.onProgress?.({ page, matchedItems: revisionsByItem.size, totalRevisions });

// ADD these lines:
// Azure DevOps sometimes returns continuation tokens on final/empty pages.
// Stop if: explicit last batch flag, empty page, or no continuation token.
if (data.isLastBatch || data.values.length === 0) {
    logger.debug(`[api] Reporting API: stopping pagination (isLastBatch=${data.isLastBatch}, pageSize=${data.values.length})`);
    break;
}
```

The existing `} while (continuationToken);` stays as a secondary check.

**Step 2: Verify**

```bash
tools azure-devops history sync --batch --force --since 2026-02-06 --verbose 2>&1 | tail -20
```

Expected: Pagination stops after the last page with real data. No more infinite loop.

**Step 3: Commit**

```bash
git add src/azure-devops/api.ts
git commit -m "fix(azure-devops): stop infinite loop in reporting API pagination

Check isLastBatch flag and empty page count to break the loop.
Azure DevOps returns continuation tokens even on final pages."
```

---

## Task 2: Add POST Body to Verbose Logging

**Files:**
- Modify: `src/azure-devops/api.ts:187-222` (the `request()` method)

**Problem:** When running with `--verbose`, the logs show `[api] POST /url (description)` but never the request body. For debugging reporting API issues, seeing the POST body is essential.

**Step 1: Add body logging to `request()`**

In `src/azure-devops/api.ts`, in the `request()` method, after the existing `logger.debug` line (line ~195):

```typescript
// Existing line:
logger.debug(`[api] ${method} ${shortUrl}${description ? ` (${description})` : ""}`);

// Add after it:
if (body !== undefined) {
    const bodyStr = JSON.stringify(body);
    const truncated = bodyStr.length > 500 ? bodyStr.slice(0, 500) + `... (${bodyStr.length} chars)` : bodyStr;
    logger.debug(`[api] ${method} body: ${truncated}`);
}
```

**Step 2: Verify**

```bash
tools azure-devops history sync --batch --force --since 2026-02-06 --verbose 2>&1 | grep "body:"
```

Expected: Lines like `[api] POST body: {"fields":["System.Id","System.Rev",...}` appear.

**Step 3: Commit**

```bash
git add src/azure-devops/api.ts
git commit -m "feat(azure-devops): log POST body in verbose mode

Truncates at 500 chars to avoid flooding logs with large payloads."
```

---

## Task 3: Merge History + Comments into Unified WorkItem Cache

**Files:**
- Modify: `src/azure-devops/types.ts` — extend `WorkItemCache` type, remove `WorkItemHistory`
- Modify: `src/azure-devops/cache.ts` — replace `loadHistoryCache`/`saveHistoryCache` with section-aware helpers
- Modify: `src/azure-devops/commands/history-sync.ts` — write to workitem cache instead of history cache
- Modify: `src/azure-devops/commands/history.ts` — read from workitem cache
- Modify: `src/azure-devops/commands/history-search.ts` — scan workitem cache
- Modify: `src/azure-devops/commands/workitem.ts` — save comments to cache
- Modify: `src/azure-devops/commands/workitem-cache.ts` — show history/comments status in list

This is the foundation for everything else. After this task, all data lives in `workitem-*.json`.

### Step 1: Update types

In `src/azure-devops/types.ts`:

**Remove** the `WorkItemHistory` interface entirely (lines 199-206).

**Add** new section types and update `WorkItemCache`:

```typescript
// Replace the removed WorkItemHistory with:

/** Current cache format version. Bump when schema changes. */
export const WORKITEM_CACHE_VERSION = "1.0.0";

/** Cache metadata — tracks freshness per section independently */
export interface WorkItemCacheMeta {
    fieldsFetchedAt: string;       // when core fields were last fetched
    historyFetchedAt?: string;     // when history was last synced (undefined = never)
    commentsFetchedAt?: string;    // when comments were last fetched (undefined = never)
}

/** History section stored inside WorkItemCache */
export interface WorkItemHistorySection {
    updates: WorkItemUpdate[];
    assignmentPeriods: AssignmentPeriod[];
    statePeriods: StatePeriod[];
}

/** Unified work item cache — all data for one work item in a single file */
export interface WorkItemCache {
    version: string;

    // Cache metadata — per-section freshness
    cache: WorkItemCacheMeta;

    // Core fields (from workitem fetch)
    id: number;
    rev: number;
    changed: string;
    title: string;
    state: string;
    category?: string;
    taskFolder?: boolean;

    // History section (optional — populated by history sync)
    history?: WorkItemHistorySection;

    // Comments (optional — populated by workitem fetch or history sync)
    comments?: Comment[];
}
```

Note: `commentCount` is removed (derive from `comments?.length ?? 0`). `fetchedAt` is replaced by `cache.fieldsFetchedAt`. Comments are a flat `Comment[]` array (timestamps live in `cache.commentsFetchedAt`).

### Step 2: Update cache helpers

In `src/azure-devops/cache.ts`:

**Remove** `loadHistoryCache()` and `saveHistoryCache()` (lines 84-95).

**Add** new section-aware helpers:

```typescript
import type { WorkItemCache, WorkItemCacheMeta, WorkItemHistorySection, WORKITEM_CACHE_VERSION } from "@app/azure-devops/types";

// ============= Workitem Cache Helpers =============

const SECTION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for history/comments

/**
 * Load a workitem cache entry (uses 365-day file-level TTL).
 */
export async function loadWorkItemCache(id: number): Promise<WorkItemCache | null> {
    await storage.ensureDirs();
    return storage.getCacheFile<WorkItemCache>(`workitem-${id}.json`, CACHE_TTL.workitem);
}

/**
 * Save the full workitem cache entry (always stamps version).
 */
export async function saveWorkItemCache(id: number, data: WorkItemCache): Promise<void> {
    await storage.ensureDirs();
    data.version = WORKITEM_CACHE_VERSION;
    await storage.putCacheFile(`workitem-${id}.json`, data, CACHE_TTL.workitem);
}

/**
 * Atomically update sections of a workitem cache entry.
 * Merges the update into the existing cache without clobbering other sections.
 * Also updates the relevant `cache.*FetchedAt` timestamp.
 */
export async function updateWorkItemCacheSection(
    id: number,
    update: {
        history?: WorkItemHistorySection;
        comments?: Comment[];
    },
): Promise<void> {
    await storage.ensureDirs();
    const now = new Date().toISOString();
    await storage.atomicUpdate<WorkItemCache>(`workitem-${id}.json`, (current) => {
        const base: WorkItemCache = current ?? {
            version: WORKITEM_CACHE_VERSION,
            cache: { fieldsFetchedAt: now },
            id,
            rev: 0,
            changed: "",
            title: `#${id}`,
            state: "Unknown",
        };

        // Ensure version + cache metadata exist (handles pre-migration entries)
        base.version = WORKITEM_CACHE_VERSION;
        base.cache = base.cache ?? { fieldsFetchedAt: base.fetchedAt ?? now };

        if (update.history !== undefined) {
            base.history = update.history;
            base.cache.historyFetchedAt = now;
        }
        if (update.comments !== undefined) {
            base.comments = update.comments;
            base.cache.commentsFetchedAt = now;
        }

        return base;
    });
}

/**
 * Check if a workitem's history section is fresh (within 7-day TTL).
 */
export function isHistoryFresh(cache: WorkItemCache): boolean {
    const fetchedAt = cache.cache?.historyFetchedAt;
    if (!fetchedAt) return false;
    return (Date.now() - new Date(fetchedAt).getTime()) < SECTION_TTL_MS;
}

/**
 * Check if a workitem's comments section is fresh (within 7-day TTL).
 */
export function isCommentsFresh(cache: WorkItemCache): boolean {
    const fetchedAt = cache.cache?.commentsFetchedAt;
    if (!fetchedAt) return false;
    return (Date.now() - new Date(fetchedAt).getTime()) < SECTION_TTL_MS;
}
```

**Update** `CACHE_TTL` — remove the `history` entry (no longer a separate file):

```typescript
export const CACHE_TTL = {
    query: "180 days",
    workitem: "365 days",
    dashboard: "180 days",
    queries: "30 days",
    project: "30 days",
    timetypes: "7 days",
    teamMembers: "30 days",
    // history/comments TTL checked via isHistoryFresh()/isCommentsFresh() on cache.* timestamps
} as const;
```

**Keep** `loadGlobalCache` and `saveGlobalCache` unchanged — they're still used by queries/dashboards. The workitem command will switch to the new helpers.

### Step 3: Update history-sync to write to workitem cache

In `src/azure-devops/commands/history-sync.ts`:

**Replace imports:**
```typescript
// OLD:
import { loadHistoryCache, saveHistoryCache, storage } from "@app/azure-devops/cache";

// NEW:
import { isHistoryFresh, loadWorkItemCache, storage, updateWorkItemCacheSection } from "@app/azure-devops/cache";
```

**Update `getItemsNeedingSync()`** — check workitem cache for history section instead of separate history file:

```typescript
async function getItemsNeedingSync(allItems: CachedWorkItem[], force: boolean): Promise<CachedWorkItem[]> {
    if (force) return allItems;

    const needSync: CachedWorkItem[] = [];
    for (const item of allItems) {
        const cached = await loadWorkItemCache(item.id);
        if (!cached || !isHistoryFresh(cached)) {
            needSync.push(item);
        }
    }
    return needSync;
}
```

**Update save calls** in `handleHistorySync()` — replace `saveHistoryCache(id, history)` with:

```typescript
// In per-item mode (line ~142):
await updateWorkItemCacheSection(id, {
    history: {
        updates: history.updates,
        assignmentPeriods: history.assignmentPeriods,
        statePeriods: history.statePeriods,
    },
});

// In batch mode (line ~180), same pattern:
await updateWorkItemCacheSection(id, {
    history: {
        updates: [],  // reporting revisions don't give us deltas
        assignmentPeriods: history.assignmentPeriods,
        statePeriods: history.statePeriods,
    },
});
```

### Step 4: Update history show command

In `src/azure-devops/commands/history.ts`:

**Replace imports:**
```typescript
// OLD:
import { formatJSON, loadHistoryCache, saveHistoryCache } from "@app/azure-devops/cache";
import type { AssignmentPeriod, StatePeriod, WorkItemHistory } from "@app/azure-devops/types";

// NEW:
import { formatJSON, isHistoryFresh, loadWorkItemCache, updateWorkItemCacheSection } from "@app/azure-devops/cache";
import type { AssignmentPeriod, StatePeriod, WorkItemCache, WorkItemHistorySection } from "@app/azure-devops/types";
```

**Update `handleHistoryShow()`** — use workitem cache:

```typescript
// Replace the cache check block (lines ~280-298):
let history: WorkItemHistorySection | null = null;
if (!options.force) {
    const cached = await loadWorkItemCache(id);
    if (cached && isHistoryFresh(cached) && cached.history) {
        history = cached.history;
        logger.debug(`[history] Loaded from workitem cache for #${id}`);
    }
}

if (!history) {
    const api = new Api(config);
    const spinner = p.spinner();
    spinner.start(`Fetching updates for work item #${id}...`);

    try {
        const updates = await api.getWorkItemUpdates(id);
        const built = buildWorkItemHistory(id, updates);
        history = {
            updates: built.updates,
            assignmentPeriods: built.assignmentPeriods,
            statePeriods: built.statePeriods,
        };
        await updateWorkItemCacheSection(id, { history });
        spinner.stop(`Fetched ${updates.length} updates for work item #${id}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        spinner.stop(pc.red(`Failed to fetch updates: ${message}`));
        process.exit(1);
    }
}
```

**Update the rest of the function** — `filterHistory` and the print functions accept `WorkItemHistorySection` instead of `WorkItemHistory`. The structure is the same (both have `assignmentPeriods` and `statePeriods`), so just update the type annotations. The `calculateTimeInState` function in `history.ts` needs the same type update (accepts `WorkItemHistorySection`).

### Step 5: Update history search (local mode)

In `src/azure-devops/commands/history-search.ts`:

**Replace imports:**
```typescript
// OLD:
import { formatJSON, loadHistoryCache, storage } from "@app/azure-devops/cache";

// NEW:
import { formatJSON, loadWorkItemCache, storage } from "@app/azure-devops/cache";
```

**Update `localSearch()`** — scan `workitem-*.json` instead of `history-*.json`:

```typescript
// Replace the file scanning block (lines ~221-230):
let workitemFiles: string[];
try {
    const cacheFiles = await storage.listCacheFiles(false);
    workitemFiles = cacheFiles.filter((f) => f.startsWith("workitem-") && f.endsWith(".json"));
} catch {
    p.log.warn("No cache found. Run a query first.");
    return;
}

if (workitemFiles.length === 0) {
    p.log.warn("No cached work items found.");
    return;
}

// Replace the inner loop — load from workitem cache instead of history files:
for (const file of workitemFiles) {
    const idMatch = file.match(/^workitem-(\d+)\.json$/);
    if (!idMatch) continue;

    const id = parseInt(idMatch[1], 10);
    const cached = await loadWorkItemCache(id);
    if (!cached?.history) continue;

    scannedCount++;
    const history = cached.history;
    // ... rest of filtering logic uses history.assignmentPeriods, history.statePeriods
    // (same fields, just accessed via cached.history instead of top-level)
```

Also update `deriveTitle()` — it currently reads from `history.updates`:
```typescript
function deriveTitle(cache: WorkItemCache): string {
    // First try the cache title field directly
    if (cache.title) return cache.title;
    // Fallback: scan updates
    for (const update of cache.history?.updates ?? []) {
        const titleChange = update.fields?.["System.Title"];
        if (titleChange?.newValue) return titleChange.newValue as string;
    }
    return `#${cache.id}`;
}
```

### Step 6: Update workitem command to save comments in cache

In `src/azure-devops/commands/workitem.ts`:

The workitem command already saves to cache (line ~380-391). Extend it to also save comments when they're fetched:

```typescript
// After the existing saveGlobalCache call (line ~391), ADD:
// Also cache comments if we fetched them
if (item.comments && item.comments.length > 0) {
    await updateWorkItemCacheSection(id, {
        comments: {
            items: item.comments,
            fetchedAt: new Date().toISOString(),
        },
    });
}
```

Wait — this needs adjustment. The `saveGlobalCache` call writes the entire `WorkItemCache` object, but it currently doesn't include the `history` or `comments` sections. We need to preserve existing sections when updating the core fields.

**Replace** the saveGlobalCache block (lines ~379-391):

```typescript
// Import at top:
import { loadWorkItemCache, updateWorkItemCacheSection } from "@app/azure-devops/cache";

// Replace the save block:
logger.debug(`[workitem] #${id} updating global cache`);
const now = new Date().toISOString();
const existingCache = await loadWorkItemCache(id);
const cacheData: WorkItemCache = {
    version: WORKITEM_CACHE_VERSION,
    cache: {
        fieldsFetchedAt: now,
        // Preserve existing section timestamps
        historyFetchedAt: existingCache?.cache?.historyFetchedAt,
        commentsFetchedAt: item.comments.length > 0 ? now : existingCache?.cache?.commentsFetchedAt,
    },
    // Core fields (always updated)
    id: item.id,
    rev: item.rev,
    changed: item.changed,
    title: item.title,
    state: item.state,
    category: settings.category,
    taskFolder: settings.taskFolder,
    // Preserve existing history section
    history: existingCache?.history,
    // Update comments if we have them, else preserve existing
    comments: item.comments.length > 0 ? item.comments : existingCache?.comments,
};
await saveWorkItemCache(id, cacheData);
```

### Step 7: Update workitem-cache list command

In `src/azure-devops/commands/workitem-cache.ts`, add history/comments status to the table:

```typescript
// Update the items array type to include new fields:
const items: Array<{
    id: number; title: string; state: string; fetchedAt: Date;
    hasTask: boolean; hasHistory: boolean; hasComments: boolean;
}> = [];

// In the loop, add:
items.push({
    id: cache.id,
    title: cache.title,
    state: cache.state,
    fetchedAt: new Date(cache.cache?.fieldsFetchedAt ?? cache.fetchedAt),
    hasTask: taskFile !== null,
    hasHistory: !!cache.cache?.historyFetchedAt,
    hasComments: !!cache.cache?.commentsFetchedAt,
});

// Update the table header:
lines.push("| ID | Title | State | Cached | File | Hist | Cmts |");
lines.push("|-----|-------|-------|--------|------|------|------|");

// Update the row:
lines.push(`| ${item.id} | ${title} | ${item.state} | ${age} | ${item.hasTask ? "✓" : "✗"} | ${item.hasHistory ? "✓" : "✗"} | ${item.hasComments ? "✓" : "✗"} |`);
```

### Step 8: Migration — merge existing history-*.json into workitem cache

Add a one-time migration that runs during `history sync` or `history activity`. Create a helper in `cache.ts`:

```typescript
/**
 * One-time migration: merge existing history-*.json files into workitem-*.json.
 * Safe to run multiple times — skips items already merged.
 * Deletes history-*.json files after successful merge.
 */
export async function migrateHistoryCache(): Promise<number> {
    const cacheDir = storage.getCacheDir();
    let historyFiles: string[];
    try {
        const files = readdirSync(cacheDir);
        historyFiles = files.filter((f) => f.startsWith("history-") && f.endsWith(".json"));
    } catch {
        return 0;
    }

    if (historyFiles.length === 0) return 0;

    let migrated = 0;
    for (const file of historyFiles) {
        const idMatch = file.match(/^history-(\d+)\.json$/);
        if (!idMatch) continue;

        const id = parseInt(idMatch[1], 10);
        try {
            const content = await Bun.file(join(cacheDir, file)).text();
            const oldHistory = JSON.parse(content) as {
                workItemId: number;
                updates: WorkItemUpdate[];
                fetchedAt: string;
                assignmentPeriods: AssignmentPeriod[];
                statePeriods: StatePeriod[];
            };

            // Merge into workitem cache (fetchedAt is stored in cache.historyFetchedAt by updateWorkItemCacheSection)
            await updateWorkItemCacheSection(id, {
                history: {
                    updates: oldHistory.updates,
                    assignmentPeriods: oldHistory.assignmentPeriods,
                    statePeriods: oldHistory.statePeriods,
                },
            });

            // Delete old history file
            unlinkSync(join(cacheDir, file));
            migrated++;
        } catch (error) {
            logger.warn(`[cache] Failed to migrate history-${id}.json: ${error}`);
        }
    }

    return migrated;
}
```

Call it at the start of `handleHistorySync()` and `handleHistoryActivity()`:

```typescript
const migrated = await migrateHistoryCache();
if (migrated > 0) {
    p.log.info(`Migrated ${migrated} history files into workitem cache`);
}
```

### Step 9: Update `history.ts` — fix `buildWorkItemHistory` return type

In `src/azure-devops/history.ts`, the function `buildWorkItemHistory` currently returns `WorkItemHistory`. Update it to return `WorkItemHistorySection`:

```typescript
// OLD:
export function buildWorkItemHistory(workItemId: number, updates: WorkItemUpdate[]): WorkItemHistory {
    return {
        workItemId,
        updates,
        fetchedAt: new Date().toISOString(),
        assignmentPeriods: computeAssignmentPeriods(updates),
        statePeriods: computeStatePeriods(updates),
    };
}

// NEW (fetchedAt removed — stored in cache.historyFetchedAt by updateWorkItemCacheSection):
export function buildWorkItemHistory(workItemId: number, updates: WorkItemUpdate[]): WorkItemHistorySection {
    return {
        updates,
        assignmentPeriods: computeAssignmentPeriods(updates),
        statePeriods: computeStatePeriods(updates),
    };
}
```

Similarly update `buildHistoryFromRevisions` to return `WorkItemHistorySection`.

Update `calculateTimeInState` to accept `WorkItemHistorySection` instead of `WorkItemHistory` (same fields, just different type name).

### Step 10: Verify the refactor

```bash
# 1. Run migration (existing history-*.json → workitem cache)
tools azure-devops history sync --dry-run
# Should show "Migrated N history files into workitem cache"

# 2. Verify history show still works
tools azure-devops history show 124523

# 3. Verify history search still works
tools azure-devops history search --assigned-to @me --wiql

# 4. Verify workitem-cache list shows new columns
tools azure-devops list

# 5. Verify no history-*.json files remain
ls ~/.genesis-tools/azure-devops/cache/history-*.json 2>/dev/null | wc -l
# Expected: 0

# 6. Verify workitem cache has history sections
cat ~/.genesis-tools/azure-devops/cache/workitem-124523.json | python3 -c "
import json, sys; d = json.load(sys.stdin)
print('history:', 'yes' if d.get('history') else 'no')
print('comments:', 'yes' if d.get('comments') else 'no')
print('updates:', len(d.get('history', {}).get('updates', [])))
"
```

### Step 11: Commit

```bash
git add src/azure-devops/types.ts src/azure-devops/cache.ts \
    src/azure-devops/history.ts \
    src/azure-devops/commands/history.ts \
    src/azure-devops/commands/history-sync.ts \
    src/azure-devops/commands/history-search.ts \
    src/azure-devops/commands/workitem.ts \
    src/azure-devops/commands/workitem-cache.ts
git commit -m "refactor(azure-devops): merge history + comments into workitem cache

Unified workitem-*.json now has optional history and comments sections,
each with their own fetchedAt for per-section TTL checks.
Includes one-time migration from old history-*.json files.
Drops WorkItemHistory type in favor of WorkItemHistorySection."
```

---

## Task 4: Create `history activity` Command

**Files:**
- Create: `src/azure-devops/commands/history-activity.ts`
- Modify: `src/azure-devops/commands/history.ts` (register new subcommand)

Now builds on the unified cache from Task 3.

### Step 1: Create the command file

Create `src/azure-devops/commands/history-activity.ts`:

```typescript
/**
 * Azure DevOps CLI - History Activity Command
 *
 * Reconstructs a user's activity timeline from cached work item data.
 * Scans workitem-*.json → filters updates by revisedBy → groups by day.
 * Also reads cached comments and filters by author.
 * Supports --discover to find + sync items not yet in cache via WIQL.
 */

import { readdirSync } from "node:fs";
import { Api } from "@app/azure-devops/api";
import {
    formatJSON,
    isCommentsFresh,
    loadWorkItemCache,
    migrateHistoryCache,
    storage,
    updateWorkItemCacheSection,
} from "@app/azure-devops/cache";
import { buildWorkItemHistory, resolveUser, userMatches } from "@app/azure-devops/history";
import type { Comment, IdentityRef, WorkItemCache, WorkItemUpdate } from "@app/azure-devops/types";
import { requireConfig } from "@app/azure-devops/utils";
import logger from "@app/logger";
import * as p from "@clack/prompts";
import pc from "picocolors";

// ============= Types =============

export interface ActivityOptions {
    user?: string;
    from?: string;
    to?: string;
    output: "timeline" | "json" | "summary";
    includeComments?: boolean;
    discover?: boolean;
    sync?: boolean;
}

/** A single activity event — one thing the user did */
interface ActivityEvent {
    date: string;
    workItemId: number;
    title: string;
    type: "state_change" | "assignment_change" | "field_edit" | "created" | "comment";
    description: string;
    detail?: string;
}

/** Day group for timeline output */
interface ActivityDay {
    date: string;
    dayName: string;
    events: ActivityEvent[];
}

// ============= Event Extraction =============

const NOISE_FIELDS = new Set([
    "System.Rev", "System.AuthorizedDate", "System.RevisedDate",
    "System.ChangedDate", "System.ChangedBy", "System.AuthorizedAs",
    "System.PersonId", "System.Watermark",
]);

/** Convert a WorkItemUpdate into ActivityEvent(s) */
function extractEventsFromUpdate(
    update: WorkItemUpdate,
    workItemId: number,
    title: string,
): ActivityEvent[] {
    const events: ActivityEvent[] = [];
    const fields = update.fields ?? {};
    const date = update.revisedDate;

    // Rev 1 = item creation
    if (update.rev === 1 && fields["System.Id"]) {
        events.push({ date, workItemId, title, type: "created", description: "Created work item", detail: title });
        return events;
    }

    // State change
    if (fields["System.State"]) {
        const oldVal = fields["System.State"].oldValue as string | undefined;
        const newVal = fields["System.State"].newValue as string | undefined;
        if (newVal) {
            events.push({
                date, workItemId, title, type: "state_change",
                description: oldVal ? `${oldVal} → ${newVal}` : `→ ${newVal}`,
            });
        }
    }

    // Assignment change
    if (fields["System.AssignedTo"]) {
        const oldVal = (fields["System.AssignedTo"].oldValue as IdentityRef)?.displayName ?? "(none)";
        const newVal = (fields["System.AssignedTo"].newValue as IdentityRef)?.displayName ?? "(none)";
        events.push({ date, workItemId, title, type: "assignment_change", description: `${oldVal} → ${newVal}` });
    }

    // Generic field edit (if no state/assignment change was found)
    if (events.length === 0) {
        const meaningfulFields = Object.keys(fields).filter((k) => !NOISE_FIELDS.has(k));
        if (meaningfulFields.length > 0) {
            const fieldNames = meaningfulFields.map((k) => k.split(".").pop() ?? k).join(", ");
            events.push({ date, workItemId, title, type: "field_edit", description: `Edited: ${fieldNames}` });
        }
    }

    return events;
}

/** Convert a Comment into an ActivityEvent */
function commentToEvent(comment: Comment, workItemId: number, title: string): ActivityEvent {
    const plainText = comment.text.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
    const preview = plainText.length > 80 ? plainText.slice(0, 77) + "..." : plainText;
    return { date: comment.date, workItemId, title, type: "comment", description: preview };
}

// ============= Cache Scanner =============

/** Scan all workitem cache files and extract events for the target user */
async function scanCachedActivity(
    userName: string,
    fromDate?: Date,
    toDate?: Date,
    includeComments = true,
): Promise<{ events: ActivityEvent[]; scannedCount: number; matchedItems: Set<number> }> {
    const cacheFiles = await storage.listCacheFiles(false);
    const workitemFiles = cacheFiles.filter((f) => f.startsWith("workitem-") && f.endsWith(".json"));

    const events: ActivityEvent[] = [];
    const matchedItems = new Set<number>();
    let scannedCount = 0;

    for (const file of workitemFiles) {
        const idMatch = file.match(/^workitem-(\d+)\.json$/);
        if (!idMatch) continue;

        const id = parseInt(idMatch[1], 10);
        const cached = await loadWorkItemCache(id);
        if (!cached) continue;

        const title = cached.title || `#${id}`;
        const updates = cached.history?.updates ?? [];

        if (updates.length === 0 && (!includeComments || !cached.comments?.length)) continue;
        scannedCount++;

        // Scan updates
        for (const update of updates) {
            const revisedByName = typeof update.revisedBy === "string"
                ? update.revisedBy
                : update.revisedBy?.displayName;
            if (!revisedByName || !userMatches(revisedByName, userName)) continue;

            const updateDate = new Date(update.revisedDate);
            if (fromDate && updateDate < fromDate) continue;
            if (toDate && updateDate > toDate) continue;

            const extracted = extractEventsFromUpdate(update, id, title);
            if (extracted.length > 0) {
                events.push(...extracted);
                matchedItems.add(id);
            }
        }

        // Scan cached comments (flat array in WorkItemCache.comments)
        if (includeComments && cached.comments) {
            for (const comment of cached.comments) {
                if (!comment.author || !userMatches(comment.author, userName)) continue;

                const commentDate = new Date(comment.date);
                if (fromDate && commentDate < fromDate) continue;
                if (toDate && commentDate > toDate) continue;

                events.push(commentToEvent(comment, id, title));
                matchedItems.add(id);
            }
        }
    }

    return { events, scannedCount, matchedItems };
}

// ============= Discovery =============

/** Discover work items changed by user but not in cache, sync their history + comments */
async function discoverAndSync(
    api: Api,
    userName: string,
    fromDate?: Date,
    toDate?: Date,
): Promise<number[]> {
    // Find existing cached IDs
    const cacheFiles = await storage.listCacheFiles(false);
    const cachedIds = new Set<number>();
    for (const f of cacheFiles) {
        const m = f.match(/^workitem-(\d+)\.json$/);
        if (m) cachedIds.add(parseInt(m[1], 10));
    }

    // WIQL: items changed by user in date range
    const isMeMacro = userName.toLowerCase() === "@me";
    const userValue = isMeMacro ? "@Me" : `'${userName}'`;

    let wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.ChangedBy] = ${userValue}`;
    if (fromDate) wiql += ` AND [System.ChangedDate] >= '${fromDate.toISOString().slice(0, 10)}'`;
    if (toDate) wiql += ` AND [System.ChangedDate] <= '${toDate.toISOString().slice(0, 10)}'`;
    wiql += " ORDER BY [System.ChangedDate] DESC";

    const response = await api.runWiql(wiql, { top: 500 });
    const serverIds = response.workItems.map((wi) => wi.id);

    // Find items that need history sync (not cached OR no history section)
    const needSync: number[] = [];
    for (const id of serverIds) {
        if (!cachedIds.has(id)) {
            needSync.push(id);
            continue;
        }
        const cached = await loadWorkItemCache(id);
        if (!cached?.history) needSync.push(id);
    }

    if (needSync.length === 0) return [];

    // Sync history + comments for discovered items
    for (const id of needSync) {
        const updates = await api.getWorkItemUpdates(id);
        const history = buildWorkItemHistory(id, updates);
        await updateWorkItemCacheSection(id, { history });
    }

    // Also fetch comments for all discovered items
    const comments = await api.batchGetComments(needSync, 5);
    for (const [id, itemComments] of comments) {
        if (itemComments.length > 0) {
            await updateWorkItemCacheSection(id, { comments: itemComments });
        }
    }

    return needSync;
}

// ============= Fetch Missing Comments =============

/** Fetch comments for items that have history but no cached comments */
async function fetchMissingComments(
    api: Api,
    matchedItemIds: number[],
): Promise<number> {
    const needComments: number[] = [];
    for (const id of matchedItemIds) {
        const cached = await loadWorkItemCache(id);
        if (cached && !isCommentsFresh(cached)) {
            needComments.push(id);
        }
    }

    if (needComments.length === 0) return 0;

    const comments = await api.batchGetComments(needComments, 5);
    for (const [id, itemComments] of comments) {
        await updateWorkItemCacheSection(id, { comments: itemComments });
    }

    return needComments.length;
}

// ============= Output Formatters =============

function formatTime(isoDate: string): string {
    const d = new Date(isoDate);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function getDayName(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString("en-US", { weekday: "long" });
}

function groupByDay(events: ActivityEvent[]): ActivityDay[] {
    const sorted = [...events].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const dayMap = new Map<string, ActivityEvent[]>();
    for (const event of sorted) {
        const dayKey = event.date.slice(0, 10);
        if (!dayMap.has(dayKey)) dayMap.set(dayKey, []);
        dayMap.get(dayKey)!.push(event);
    }

    return Array.from(dayMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, events]) => ({ date, dayName: getDayName(date), events }));
}

const TYPE_ICONS: Record<ActivityEvent["type"], string> = {
    created: "[+]", state_change: "[S]", assignment_change: "[A]",
    field_edit: "[E]", comment: "[C]",
};

const TYPE_COLORS: Record<ActivityEvent["type"], (s: string) => string> = {
    created: pc.green, state_change: pc.magenta, assignment_change: pc.blue,
    field_edit: pc.yellow, comment: pc.cyan,
};

function printTimeline(days: ActivityDay[]): void {
    if (days.length === 0) {
        p.log.warn("No activity found for the specified criteria.");
        return;
    }

    for (const day of days) {
        console.log();
        console.log(pc.bold(`${day.date} (${day.dayName})`));
        console.log(pc.dim("-".repeat(60)));

        for (const event of day.events) {
            const time = formatTime(event.date);
            const icon = TYPE_COLORS[event.type](TYPE_ICONS[event.type]);
            const id = pc.dim(`#${event.workItemId}`);
            const shortTitle = event.title.length > 35 ? event.title.slice(0, 32) + "..." : event.title;
            console.log(`  ${pc.dim(time)}  ${icon} ${id} ${event.description}`);
            if (event.type !== "field_edit") {
                console.log(`  ${" ".repeat(8)}${pc.dim(shortTitle)}`);
            }
        }
    }
    console.log();
}

function printSummary(days: ActivityDay[]): void {
    if (days.length === 0) { p.log.warn("No activity found."); return; }

    p.log.step(pc.bold("Activity Summary"));
    for (const day of days) {
        const counts: Record<string, number> = {};
        for (const e of day.events) counts[e.type] = (counts[e.type] ?? 0) + 1;

        const parts: string[] = [];
        if (counts.created) parts.push(`${counts.created} created`);
        if (counts.state_change) parts.push(`${counts.state_change} state changes`);
        if (counts.assignment_change) parts.push(`${counts.assignment_change} (re)assignments`);
        if (counts.comment) parts.push(`${counts.comment} comments`);
        if (counts.field_edit) parts.push(`${counts.field_edit} edits`);

        const uniqueItems = new Set(day.events.map((e) => e.workItemId));
        console.log(
            `  ${pc.bold(day.date)} (${day.dayName}): ${day.events.length} actions across ${uniqueItems.size} items — ${parts.join(", ")}`,
        );
    }

    const totalEvents = days.reduce((sum, d) => sum + d.events.length, 0);
    const allItems = new Set(days.flatMap((d) => d.events.map((e) => e.workItemId)));
    console.log();
    console.log(pc.dim(`Total: ${totalEvents} actions across ${allItems.size} work items over ${days.length} days`));
}

function printJson(days: ActivityDay[]): void {
    console.log(formatJSON(days));
}

// ============= Main Handler =============

export async function handleHistoryActivity(options: ActivityOptions): Promise<void> {
    const config = requireConfig();
    const api = new Api(config);
    const userName = options.user ?? "@me";
    const output = options.output ?? "timeline";
    const includeComments = options.includeComments !== false;

    // Migrate old history-*.json if any exist
    const migrated = await migrateHistoryCache();
    if (migrated > 0) p.log.info(`Migrated ${migrated} history files into workitem cache`);

    // Resolve @me to actual user name for local matching
    let resolvedUserName = userName;
    if (userName.toLowerCase() === "@me") {
        const members = await api.getTeamMembers();
        const { $ } = await import("bun");
        const azResult = await $`az account show --query user.name -o tsv`.quiet();
        const azUser = azResult.text().trim();
        const resolved = resolveUser(azUser, members);
        resolvedUserName = resolved?.displayName ?? azUser;
    }
    p.log.info(`User: ${pc.bold(resolvedUserName)}`);

    // Parse date range
    const fromDate = options.from ? new Date(options.from) : undefined;
    const toDate = options.to ? (() => {
        const d = new Date(options.to!);
        if (options.to!.length <= 10) d.setHours(23, 59, 59, 999);
        return d;
    })() : undefined;

    const dateRangeStr = [
        fromDate ? fromDate.toISOString().slice(0, 10) : "beginning",
        toDate ? toDate.toISOString().slice(0, 10) : "now",
    ].join(" → ");
    p.log.info(`Date range: ${pc.bold(dateRangeStr)}`);

    // Step 1: Discover uncached items (optional)
    if (options.discover || options.sync) {
        const spinner = p.spinner();
        spinner.start("Discovering work items changed by user...");
        const newIds = await discoverAndSync(api, userName, fromDate, toDate);
        spinner.stop(newIds.length > 0
            ? `Discovered and synced ${newIds.length} new work items`
            : "No new work items to discover");
    }

    // Step 2: Scan cached data (updates + cached comments)
    const spinner = p.spinner();
    spinner.start("Scanning cached work items...");
    const { events, scannedCount, matchedItems } = await scanCachedActivity(
        resolvedUserName, fromDate, toDate, includeComments,
    );
    spinner.stop(`Scanned ${scannedCount} items, found ${events.length} actions across ${matchedItems.size} items`);

    // Step 3: Fetch missing comments for matched items
    if (includeComments && matchedItems.size > 0) {
        const commentSpinner = p.spinner();
        commentSpinner.start(`Checking comments for ${matchedItems.size} items...`);
        const fetched = await fetchMissingComments(api, Array.from(matchedItems));
        if (fetched > 0) {
            commentSpinner.stop(`Fetched comments for ${fetched} items`);
            // Re-scan to include newly fetched comments
            const rescan = await scanCachedActivity(resolvedUserName, fromDate, toDate, true);
            // Only add NEW comment events (avoid duplicates from first scan)
            const existingKeys = new Set(events.map((e) => `${e.date}-${e.workItemId}-${e.type}`));
            for (const e of rescan.events) {
                const key = `${e.date}-${e.workItemId}-${e.type}`;
                if (e.type === "comment" && !existingKeys.has(key)) {
                    events.push(e);
                }
            }
        } else {
            commentSpinner.stop("All comments up to date");
        }
    }

    // Step 4: Group and output
    const days = groupByDay(events);

    switch (output) {
        case "timeline": printTimeline(days); break;
        case "summary": printSummary(days); break;
        case "json": printJson(days); break;
    }
}
```

### Step 2: Register the command

In `src/azure-devops/commands/history.ts`, add import and registration:

```typescript
// Add import at top:
import { handleHistoryActivity, type ActivityOptions } from "./history-activity";

// Add in registerHistoryCommand(), after the "sync" subcommand:
history
    .command("activity")
    .description("Show user activity timeline across work items")
    .option("--user <name>", "User to show activity for (default: @me)")
    .option("--from <date>", "From date (ISO format, e.g. 2026-02-07)")
    .option("--since <date>", "Alias for --from")
    .option("--to <date>", "To date (ISO format)")
    .option("--until <date>", "Alias for --to")
    .option("-o, --output <format>", "Output format (timeline, summary, json)", "timeline")
    .option("--no-comments", "Skip fetching comments (faster)")
    .option("--discover", "Discover & sync items changed by user but not yet cached")
    .option("--sync", "Alias for --discover")
    .action(async (opts: ActivityOptions & { since?: string; until?: string; comments?: boolean }) => {
        if (opts.since && !opts.from) opts.from = opts.since;
        if (opts.until && !opts.to) opts.to = opts.until;
        opts.includeComments = opts.comments !== false;
        await handleHistoryActivity(opts);
    });
```

### Step 3: Verify

```bash
# Your activity this week
tools azure-devops history activity --from 2026-02-07 --to 2026-02-16

# Another user's activity
tools azure-devops history activity --user "Vlach Patrik" --from 2026-02-07

# With discovery (finds items not yet in cache)
tools azure-devops history activity --from 2026-02-07 --discover

# Summary view
tools azure-devops history activity --from 2026-02-07 -o summary

# JSON for timelog pipeline
tools azure-devops history activity --from 2026-02-07 -o json | tools json

# Fast (skip comment fetch)
tools azure-devops history activity --from 2026-02-07 --no-comments
```

### Step 4: Commit

```bash
git add src/azure-devops/commands/history-activity.ts src/azure-devops/commands/history.ts
git commit -m "feat(azure-devops): add history activity command

Shows day-by-day timeline of user's Azure DevOps activity:
state changes, assignments, comments, item creation, field edits.
Reads from unified workitem cache. Supports --user for any team member,
--discover to find uncached items via WIQL."
```

---

## Task 5: Update Timelog Skill Documentation

**Files:**
- Modify: `plugins/genesis-tools/skills/timelog/SKILL.md`

Add after the "Git Commit Stats for Time Estimation" section:

```markdown
## Azure DevOps Activity (for Gap Filling)

When Timely data is missing or incomplete, use Azure DevOps activity to reconstruct what the user worked on:

\`\`\`bash
# Get activity timeline for a date range (reads from cache)
tools azure-devops history activity --from YYYY-MM-DD --to YYYY-MM-DD -o json 2>/dev/null | tools json

# Discover + sync items not yet cached, then show activity
tools azure-devops history activity --from YYYY-MM-DD --to YYYY-MM-DD --discover -o json 2>/dev/null | tools json
\`\`\`

The output is grouped by day, with events like:
- `state_change` — user moved an item (Active → Resolved)
- `assignment_change` — user (re)assigned an item
- `comment` — user commented on an item
- `created` — user created a new item
- `field_edit` — user edited fields (description, title, etc.)

**Mapping activity to time entries:**
- Multiple actions on the same work item within a short window = single work session
- State changes (especially → Resolved/Closed) indicate focused work
- Comments often indicate code review or investigation
- Item creation = analysis/planning time

**Prerequisite:** Sync history first if cache is empty:
\`\`\`bash
tools azure-devops history sync                              # sync all cached items
tools azure-devops history activity --from YYYY-MM-DD --discover  # discover + sync new items
\`\`\`
```

**Commit:**

```bash
git add plugins/genesis-tools/skills/timelog/SKILL.md
git commit -m "docs(timelog): add Azure DevOps activity as data source for time reconstruction"
```

---

## Execution Checklist

| # | Task | Type | Depends On |
|---|------|------|------------|
| 1 | Fix reporting API infinite loop | Bug fix | — |
| 2 | Add POST body to verbose logging | Enhancement | — |
| 3 | Merge history + comments into workitem cache | Refactor | — |
| 4 | Create `history activity` command | Feature | Task 3 |
| 5 | Update timelog skill docs | Docs | Task 4 |

**Parallelizable:** Tasks 1, 2, and 3 are independent. Tasks 4-5 are sequential after Task 3.
