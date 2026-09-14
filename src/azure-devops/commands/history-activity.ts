/**
 * Azure DevOps CLI - History Activity Command
 *
 * Reconstructs a user's activity timeline from cached work item data.
 * Scans workitem-*.json → filters updates by revisedBy → groups by day.
 * Also reads cached comments and filters by author.
 * Supports --discover to find + sync items not yet in cache via WIQL.
 */

import { Api } from "@app/azure-devops/api";
import {
    formatJSON,
    isCommentsFresh,
    loadWorkItemCache,
    migrateHistoryCache,
    storage,
    updateWorkItemCacheSection,
} from "@app/azure-devops/cache";
import { buildWorkItemHistory, userMatches } from "@app/azure-devops/history";
import {
    groupEventsByDay,
    isInvertedWindow,
    localDay,
    parseDayBoundary,
    realDayCount,
    resolveUpdateDate,
    UNDATED_DAY,
    withinDayWindow,
} from "@app/azure-devops/lib/activity-days";
import { type RequestedUser, resolveRequestedUser } from "@app/azure-devops/lib/current-user";
import { stripCommentHtml } from "@app/azure-devops/lib/mentions";
import type { Comment, IdentityRef, WorkItemUpdate } from "@app/azure-devops/types";
import { requireConfig } from "@app/azure-devops/utils";
import { escapeWiqlValue } from "@app/azure-devops/wiql-builder";
import * as p from "@clack/prompts";
import { suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";

// ============= Types =============

export interface ActivityOptions {
    user?: string;
    from?: string;
    to?: string;
    format: "timeline" | "json" | "summary";
    includeComments?: boolean;
    discover?: boolean;
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
    "System.Rev",
    "System.AuthorizedDate",
    "System.RevisedDate",
    "System.ChangedDate",
    "System.ChangedBy",
    "System.AuthorizedAs",
    "System.PersonId",
    "System.Watermark",
]);

/** Convert a WorkItemUpdate into ActivityEvent(s) */
function extractEventsFromUpdate(update: WorkItemUpdate, workItemId: number, title: string): ActivityEvent[] {
    const events: ActivityEvent[] = [];
    const fields = update.fields ?? {};
    const date = resolveUpdateDate(update);

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
                date,
                workItemId,
                title,
                type: "state_change",
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
    // Stripping tags without leaving a space turned `<td>A</td><td>B</td>` into `AB`.
    // `stripCommentHtml` is the one that knows a block boundary is also a word boundary, and it
    // decodes the remaining entities on the way.
    const plainText = stripCommentHtml(comment.text);
    const preview = plainText.length > 80 ? `${plainText.slice(0, 77)}...` : plainText;
    return { date: comment.date, workItemId, title, type: "comment", description: preview };
}

// ============= Cache Scanner =============

/** Scan all workitem cache files and extract events for the target user */
async function scanCachedActivity(
    userName: string,
    fromDate?: Date,
    toDate?: Date,
    includeComments = true
): Promise<{
    events: ActivityEvent[];
    scannedCount: number;
    totalCached: number;
    withoutHistory: number;
    matchedItems: Set<number>;
}> {
    const cacheFiles = await storage.listCacheFiles(false);
    const workitemFiles = cacheFiles.filter((f) => f.startsWith("workitem-") && f.endsWith(".json"));

    const events: ActivityEvent[] = [];
    const matchedItems = new Set<number>();
    let scannedCount = 0;
    let withoutHistory = 0;

    for (const file of workitemFiles) {
        const idMatch = file.match(/^workitem-(\d+)\.json$/);
        if (!idMatch) {
            continue;
        }

        const id = parseInt(idMatch[1], 10);
        const cached = await loadWorkItemCache(id);
        if (!cached) {
            continue;
        }

        const title = cached.title || `#${id}`;
        const updates = cached.history?.updates ?? [];

        if (!cached.history) {
            withoutHistory++;
        }

        if (updates.length === 0 && (!includeComments || !cached.comments?.length)) {
            continue;
        }
        scannedCount++;

        // Scan updates
        for (const update of updates) {
            const revisedByName =
                typeof update.revisedBy === "string" ? update.revisedBy : update.revisedBy?.displayName;
            if (!revisedByName || !userMatches(revisedByName, userName)) {
                continue;
            }

            // The same sentinel that used to become a `9999-01-01` day row also sailed through
            // this window: year 9999 is never before --from, so every latest revision matched
            // whatever window was asked for. An update whose moment cannot be recovered at all
            // does the same thing through Invalid Date, so the window check owns both cases.
            if (!withinDayWindow(resolveUpdateDate(update), fromDate, toDate)) {
                continue;
            }

            const extracted = extractEventsFromUpdate(update, id, title);
            if (extracted.length > 0) {
                events.push(...extracted);
                matchedItems.add(id);
            }
        }

        // Scan cached comments (flat array in WorkItemCache.comments)
        if (includeComments && cached.comments) {
            for (const comment of cached.comments) {
                if (!comment.author || !userMatches(comment.author, userName)) {
                    continue;
                }

                if (!withinDayWindow(comment.date, fromDate, toDate)) {
                    continue;
                }

                events.push(commentToEvent(comment, id, title));
                matchedItems.add(id);
            }
        }
    }

    return { events, scannedCount, totalCached: workitemFiles.length, withoutHistory, matchedItems };
}

// ============= Discovery =============

/** Discover work items changed by user but not in cache, sync their history + comments */
async function discoverAndSync(api: Api, userName: string, fromDate?: Date, toDate?: Date): Promise<number[]> {
    // Find existing cached IDs
    const cacheFiles = await storage.listCacheFiles(false);
    const cachedIds = new Set<number>();
    for (const f of cacheFiles) {
        const m = f.match(/^workitem-(\d+)\.json$/);
        if (m) {
            cachedIds.add(parseInt(m[1], 10));
        }
    }

    // WIQL: items changed by user in date range
    const isMeMacro = userName.toLowerCase() === "@me";
    const userValue = isMeMacro ? "@Me" : `'${escapeWiqlValue(userName)}'`;

    let wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.ChangedBy] = ${userValue}`;
    // The bounds carry their time, for the reason `findMentions` names: a bare `YYYY-MM-DD` means
    // MIDNIGHT to WIQL, so `<= '<to>'` dropped everything changed on the --to day. The day part
    // alone was also the wrong day, because these bounds are local moments and `toISOString()`
    // reports them in UTC.
    if (fromDate) {
        wiql += ` AND [System.ChangedDate] >= '${fromDate.toISOString()}'`;
    }
    if (toDate) {
        wiql += ` AND [System.ChangedDate] <= '${toDate.toISOString()}'`;
    }
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
        if (!cached?.history) {
            needSync.push(id);
        }
    }

    if (needSync.length === 0) {
        return [];
    }

    // Sync history for discovered items
    for (const id of needSync) {
        const updates = await api.getWorkItemUpdates(id);
        const built = buildWorkItemHistory(updates);
        await updateWorkItemCacheSection(id, {
            history: {
                updates: built.updates,
                assignmentPeriods: built.assignmentPeriods,
                statePeriods: built.statePeriods,
            },
        });
    }

    // Also fetch comments for all discovered items
    const comments = await api.batchGetComments(needSync, 5);
    for (const [id, itemComments] of comments) {
        await updateWorkItemCacheSection(id, { comments: itemComments });
    }
    // An id missing from the map means its fetch FAILED: a work item with no comments still lands
    // there, carrying an empty array. Writing `comments: []` for a failure stamped
    // `commentsFetchedAt` with it, so one 403 on a restricted item was cached as "this item has no
    // comments" and `isCommentsFresh` suppressed the retry for seven days. `batchGetComments` logs
    // each failure; leaving the section unwritten is what lets the next run try again.

    return needSync;
}

// ============= Fetch Missing Comments =============

/** Fetch comments for items that have history but no cached comments */
async function fetchMissingComments(api: Api, matchedItemIds: number[]): Promise<number> {
    const needComments: number[] = [];
    for (const id of matchedItemIds) {
        const cached = await loadWorkItemCache(id);
        if (cached && !isCommentsFresh(cached)) {
            needComments.push(id);
        }
    }

    if (needComments.length === 0) {
        return 0;
    }

    const comments = await api.batchGetComments(needComments, 5);
    for (const [id, itemComments] of comments) {
        await updateWorkItemCacheSection(id, { comments: itemComments });
    }
    // Same as in `discoverAndSync`: a missing id is a FAILED fetch, never a comment-less item, so
    // caching an empty array for it would hide the item for the whole 7-day TTL.

    // The count is what was actually fetched, not what was asked for, so the caller does not
    // re-scan the cache for comments that never arrived.
    return comments.size;
}

// ============= Output Formatters =============

function formatTime(isoDate: string): string {
    const d = new Date(isoDate);

    if (Number.isNaN(d.getTime())) {
        return "--:--";
    }

    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const TYPE_ICONS: Record<ActivityEvent["type"], string> = {
    created: "[+]",
    state_change: "[S]",
    assignment_change: "[A]",
    field_edit: "[E]",
    comment: "[C]",
};

const TYPE_COLORS: Record<ActivityEvent["type"], (s: string) => string> = {
    created: pc.green,
    state_change: pc.magenta,
    assignment_change: pc.blue,
    field_edit: pc.yellow,
    comment: pc.cyan,
};

function printTimeline(days: ActivityDay[]): void {
    if (days.length === 0) {
        p.log.warn("No activity found for the specified criteria.");
        return;
    }

    for (const day of days) {
        out.println();
        out.println(pc.bold(`${day.date} (${day.dayName})`));
        out.println(pc.dim("-".repeat(60)));

        for (const event of day.events) {
            const time = formatTime(event.date);
            const icon = TYPE_COLORS[event.type](TYPE_ICONS[event.type]);
            const id = pc.dim(`#${event.workItemId}`);
            const shortTitle = event.title;
            out.println(`  ${pc.dim(time)}  ${icon} ${id} ${event.description}`);
            if (event.type !== "field_edit") {
                out.println(`  ${" ".repeat(8)}${pc.dim(shortTitle)}`);
            }
        }
    }
    out.println();
}

function printSummary(days: ActivityDay[]): void {
    if (days.length === 0) {
        p.log.warn("No activity found.");
        return;
    }

    p.log.step(pc.bold("Activity Summary"));
    for (const day of days) {
        const counts: Record<string, number> = {};
        for (const e of day.events) {
            counts[e.type] = (counts[e.type] ?? 0) + 1;
        }

        const parts: string[] = [];
        if (counts.created) {
            parts.push(`${counts.created} created`);
        }
        if (counts.state_change) {
            parts.push(`${counts.state_change} state changes`);
        }
        if (counts.assignment_change) {
            parts.push(`${counts.assignment_change} (re)assignments`);
        }
        if (counts.comment) {
            parts.push(`${counts.comment} comments`);
        }
        if (counts.field_edit) {
            parts.push(`${counts.field_edit} edits`);
        }

        const uniqueItems = new Set(day.events.map((e) => e.workItemId));
        out.println(
            `  ${pc.bold(day.date)} (${day.dayName}): ${day.events.length} actions across ${uniqueItems.size} items — ${parts.join(", ")}`
        );
    }

    const totalEvents = days.reduce((sum, d) => sum + d.events.length, 0);
    const allItems = new Set(days.flatMap((d) => d.events.map((e) => e.workItemId)));
    const dayCount = realDayCount(days);
    const undated = days.find((d) => d.date === UNDATED_DAY)?.events.length ?? 0;
    const undatedNote = undated > 0 ? `, plus ${undated} undated` : "";
    out.println();
    out.println(
        pc.dim(`Total: ${totalEvents} actions across ${allItems.size} work items over ${dayCount} days${undatedNote}`)
    );
}

function printJson(days: ActivityDay[]): void {
    out.println(formatJSON(days));
}

// ============= Main Handler =============

export async function handleHistoryActivity(options: ActivityOptions): Promise<void> {
    const config = requireConfig();
    const api = new Api(config);
    const userName = options.user ?? "@me";
    const isMeRequest = userName.toLowerCase() === "@me";
    const output = options.format ?? "timeline";
    const includeComments = options.includeComments !== false;

    // Migrate old history-*.json if any exist
    const migrated = await migrateHistoryCache();
    if (migrated > 0) {
        p.log.info(`Migrated ${migrated} history files into workitem cache`);
    }

    // Resolve @me to actual user name for local matching
    let requested: RequestedUser;

    try {
        requested = await resolveRequestedUser({ user: userName, teamMembers: () => api.getTeamMembers() });
    } catch (err) {
        p.log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }

    const resolvedUserName = requested.name;
    p.log.info(`User: ${pc.bold(resolvedUserName)}`);

    // Parse date range
    const fromDate = options.from ? parseDayBoundary(options.from) : undefined;
    const toDate = options.to ? parseDayBoundary(options.to, { endOfDay: true }) : undefined;

    // `dateRangeStr` below calls `toISOString()`, which THROWS a RangeError on an Invalid Date, so
    // an unparseable bound has to be reported here or it surfaces as a stack trace. `history
    // mentions` already guarded this; this command never did.
    if (fromDate && Number.isNaN(fromDate.getTime())) {
        p.log.error(`Invalid --from '${options.from}': expected a date such as 2026-09-07`);
        process.exit(1);
    }

    if (toDate && Number.isNaN(toDate.getTime())) {
        p.log.error(`Invalid --to '${options.to}': expected a date such as 2026-09-14`);
        process.exit(1);
    }

    if (isInvertedWindow(fromDate, toDate)) {
        p.log.error(`--to '${options.to}' is before --from '${options.from}', so the window matches nothing.`);
        process.exit(1);
    }

    // Not `toISOString()`: these are LOCAL moments, so its UTC day is the day either side of the
    // one that was typed. Verified under TZ=Europe/Prague (--from read a day early) and
    // TZ=America/Chicago (--to read a day late).
    const dateRangeStr = [fromDate ? localDay(fromDate) : "beginning", toDate ? localDay(toDate) : "now"].join(" → ");
    p.log.info(`Date range: ${pc.bold(dateRangeStr)}`);

    // Step 1: Discover uncached items (optional, requires --from)
    if (options.discover) {
        if (!fromDate) {
            p.log.error("--discover requires --from to limit the WIQL query scope. Add e.g. --from 2026-01-01");
            process.exit(1);
        }
        if (!requested.verified) {
            // The local scan below matches fuzzily and is unaffected. This query does not:
            // `[System.ChangedBy]` is an exact identity, so an unconfirmed spelling returns
            // nothing and would read as "you changed nothing that month".
            p.log.warn(
                `The team roster did not confirm '${resolvedUserName}', and --discover matches ` +
                    `[System.ChangedBy] exactly, so a different spelling returns nothing.`
            );
        }

        const spinner = p.spinner();
        spinner.start("Discovering work items changed by user...");
        // The WIQL matches on the NAME, so discovery needs the same spelling the local scan uses:
        // the one the roster returned. `@me` is the exception, because it becomes the `@Me` macro
        // rather than a name. Passing the raw `--user` searched Azure DevOps for a spelling the
        // roster had already corrected, so `--discover` found nothing while the scan found plenty.
        const newIds = await discoverAndSync(api, isMeRequest ? userName : resolvedUserName, fromDate, toDate);
        spinner.stop(
            newIds.length > 0
                ? `Discovered and synced ${newIds.length} new work items`
                : "No new work items to discover"
        );
    }

    // Step 2: Scan cached data (updates + cached comments)
    const spinner = p.spinner();
    spinner.start("Scanning cached work items...");
    const { events, scannedCount, totalCached, withoutHistory, matchedItems } = await scanCachedActivity(
        resolvedUserName,
        fromDate,
        toDate,
        includeComments
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
            const makeKey = (e: ActivityEvent) =>
                `${e.date}-${e.workItemId}-${e.type}${e.type === "comment" ? `-${e.description}` : ""}`;
            const existingKeys = new Set(events.map(makeKey));
            for (const e of rescan.events) {
                const key = makeKey(e);
                if (e.type === "comment" && !existingKeys.has(key)) {
                    events.push(e);
                }
            }
        } else {
            commentSpinner.stop("All comments up to date");
        }
    }

    // Step 4: Group and output
    const days = groupEventsByDay(events);

    switch (output) {
        case "timeline":
            printTimeline(days);
            break;
        case "summary":
            printSummary(days);
            break;
        case "json":
            printJson(days);
            break;
    }

    // Suggest --discover if not used
    if (!options.discover) {
        const stats = [`${totalCached} cached items`];
        if (withoutHistory > 0) {
            stats.push(`${withoutHistory} without history`);
        }
        stats.push(`${scannedCount} with activity data`);

        const cmd = suggestCommand("tools azure-devops", {
            add: ["--discover", ...(fromDate ? [] : ["--from", "2026-01-01"])],
        });
        p.log.message(
            pc.dim(
                `Only locally cached items were scanned (${stats.join(", ")}). To query Azure DevOps for all items you changed:`
            ) +
                "\n" +
                pc.cyan(`  ${cmd}`)
        );
    }
}
