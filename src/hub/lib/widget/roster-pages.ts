import type { AgentSessionRow } from "@app/ai/lib/sessions/agent-session-rows";
import { listAgentSessionRows } from "@app/ai/lib/sessions/agent-session-rows";
import { openHistoryReadOnly } from "@genesiscz/utils/agent-sessions/database";
import { historyPathUnderRoot } from "@genesiscz/utils/agent-sessions/project-scope";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import { HistoryRepository } from "@genesiscz/utils/agent-sessions/repository";
import { cpuMeta, profiler } from "@genesiscz/utils/profile";
import { type AgentsTree, rankedParents } from "../agents";
import {
    newestRosterRows,
    readWidgetParents,
    WIDGET_ROSTER_HOURS,
    WIDGET_ROSTER_LIMIT,
    WIDGET_ROSTER_PROVIDERS,
    type WidgetRoster,
    widgetSessionRoots,
} from "./roster-index";

/** Position in one worker run's frozen list of paths. Empty hydrated pages still advance it. */
export interface RosterPage {
    offset: number;
    next: number;
    rows: AgentSessionRow[];
    /** A replacement prefix of the ranked tree; workers are assigned to orphans on completion. */
    agents?: AgentsTree;
}

const prof = profiler.scope("widget");
type Entry = Pick<AgentSessionRow, "filePath" | "mtime">;

/** Read only membership and order in a single SQLite snapshot. Hydration can then release the DB between pages. */
function rosterEntries(now: number): Entry[] {
    const db = openHistoryReadOnly();
    if (!db) {
        return [];
    }
    try {
        if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_metadata'").get()) {
            return [];
        }
        const repository = new HistoryRepository(db);
        const roots = widgetSessionRoots();
        const since = now - WIDGET_ROSTER_HOURS * 3_600_000;
        return db.transaction(() =>
            WIDGET_ROSTER_PROVIDERS.flatMap((provider) =>
                repository
                    .listScopeFacts({
                        providerId: resolveHistoryProvider(provider).id,
                        mtimeFrom: since,
                        excludeAgents: true,
                    })
                    .filter((row) =>
                        roots[provider].some((root) => root === row.root || historyPathUnderRoot(row.filePath, root))
                    )
                    .map(({ filePath, mtime }) => ({ filePath, mtime }))
            )
        )();
    } finally {
        db.close();
    }
}

export function newestPaths(entries: Entry[]): string[] {
    return [...new Set(newestRosterRows(entries).map((entry) => entry.filePath))];
}

export function readRosterRows(filePaths: string[], now: number): Promise<AgentSessionRow[]> {
    return prof.measureAsync(
        "roster session rows",
        () =>
            listAgentSessionRows({
                filePaths,
                now,
                hours: WIDGET_ROSTER_HOURS,
                withUsage: false,
                refresh: false,
                failClosed: true,
            }),
        cpuMeta()
    );
}

/** The next page always starts at the preceding page's next cursor. A retry uses the same manifest and offset. */
export async function* rosterRowPages(
    paths: readonly string[],
    read: (paths: string[]) => Promise<AgentSessionRow[]>,
    offset = 0
): AsyncGenerator<RosterPage> {
    while (offset < paths.length) {
        const next = Math.min(paths.length, offset + Math.min(512, Math.max(32, offset * 2)));
        const rows = await read(paths.slice(offset, next));
        yield { offset, next, rows };
        offset = next;
    }
}

export function coldRosterPages(now: number): AsyncGenerator<RosterPage> {
    const paths = prof.measure("roster manifest", () => newestPaths(rosterEntries(now)), cpuMeta());
    return rosterRowPages(paths, (files) => readRosterRows(files, now));
}

/** A scoped refresh of known parents. Changing membership, children without a known owner, or an external index
 * write falls back to reconciliation. A clock tick also reconciles journals and workers that have no file event. */
export async function updateRosterPaths(
    roster: WidgetRoster,
    paths: string[],
    now: number,
    readRows = readRosterRows,
    tree = readWidgetParents
): Promise<WidgetRoster | undefined> {
    const changed = new Set(paths);
    if (!changed.size) {
        return undefined;
    }
    const rows = await readRows([...changed], now);
    if (rows.some((row) => !changed.has(row.filePath))) {
        // A logical path may belong to another indexed root after resolving symlinks.
        return undefined;
    }
    const since = now - WIDGET_ROSTER_HOURS * 3_600_000;
    const merged = newestRosterRows([
        ...roster.rows.filter((row) => !changed.has(row.filePath) && row.mtime >= since),
        ...rows,
    ]);
    const parents = roster.agents.parents.filter((parent) => changed.has(parent.filePath));
    if (
        parents.length === changed.size &&
        rows.length === parents.length &&
        parents.every((parent) =>
            rows.some((row) => row.filePath === parent.filePath && row.sessionId === parent.sessionId)
        )
    ) {
        const updated = await tree(rows, now, true);
        if (updated.parents.length === parents.length) {
            return {
                rows: merged,
                agents: {
                    ...roster.agents,
                    generatedAt: updated.generatedAt,
                    parents: rankedParents(
                        [
                            ...roster.agents.parents.filter((parent) => !changed.has(parent.filePath)),
                            ...updated.parents,
                        ],
                        WIDGET_ROSTER_LIMIT
                    ),
                },
            };
        }
    }
    return { rows: merged, agents: await tree(merged.slice(0, WIDGET_ROSTER_LIMIT), now, false) };
}

export async function streamWidgetRoster(publish?: (page: RosterPage) => void | Promise<void>): Promise<WidgetRoster> {
    const now = Date.now();
    const rows: AgentSessionRow[] = [];
    let offset = 0;
    for await (const page of coldRosterPages(now)) {
        rows.push(...page.rows);
        offset = page.next;
        await publish?.(page);
    }
    newestRosterRows(rows);
    const agents = await readWidgetParents(
        rows.slice(0, WIDGET_ROSTER_LIMIT),
        now,
        false,
        publish && ((agents) => publish({ rows: [], offset, next: offset, agents }))
    );
    return { rows, agents };
}
