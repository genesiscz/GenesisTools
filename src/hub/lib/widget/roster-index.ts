import { existsSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import { type AgentSessionRow, listAgentSessionRows } from "@app/ai/lib/sessions/agent-session-rows";
import { getSessionListing } from "@app/claude/lib/history/search";
import { HistoryDatabase } from "@genesiscz/utils/agent-sessions/database";
import { catalogHistory } from "@genesiscz/utils/agent-sessions/open-service";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import { ACCOUNT_PROVIDER_ALIASES, byHarness, isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import type { HarnessId } from "@genesiscz/utils/harness/types";
import { logger } from "@genesiscz/utils/logger";
import { readDataVersion } from "@genesiscz/utils/workers/sqlite-wake";
import { hubAgents } from "../agents";
import type { AgentsTree } from "../agents/types";

/** The window and parent cap every Widget roster read and refresh uses. */
export const WIDGET_ROSTER_HOURS = 168;
export const WIDGET_ROSTER_LIMIT = 150;
/** The session listing a snapshot or discovery may reuse when another process refreshed it this recently. */
export const WIDGET_DISCOVERY_REUSE_MS = 15_000;

/**
 * One part of the shared history index the Widget roster reads.
 *
 * - `all`: the whole catalog, exactly what `tools hub widget discover` refreshes.
 * - `claude`, `codex`, `grok`: that provider's session listing in the roster window (codex also its sub-agents,
 *   which are rollouts in the same tree).
 * - `claude-agents`: the Claude sub-agent listing, which only finds lead sessions outside the parents listing.
 */
export type WidgetRosterScope = "all" | "claude-agents" | HarnessId;

export const WIDGET_ROSTER_PROVIDERS = ACCOUNT_PROVIDER_ALIASES;
export type WidgetRosterProvider = (typeof WIDGET_ROSTER_PROVIDERS)[number];

export interface WidgetRoster {
    rows: AgentSessionRow[];
    agents: AgentsTree;
}

/**
 * Whether a refresh that wrote no index row still needs a roster read. The index is shared: another process may
 * have indexed a transcript after this worker's last read, and this refresh then finds nothing left to write.
 * `PRAGMA data_version` moves on every other connection's commit and never on this connection's own, so a value
 * that differs from the one taken at the last read says another process wrote since.
 */
export class WidgetRosterReads {
    private lastRead: number | null | undefined;

    constructor(
        private readonly version: () => number | null = () => readDataVersion(HistoryDatabase.getInstance().getDb())
    ) {}

    needed(changed: boolean): boolean {
        if (changed || this.lastRead === undefined) {
            return true;
        }

        const now = this.version();
        return now === null || now !== this.lastRead;
    }

    /** Before every roster read: a commit that lands during the read moves the version, so the next request reads. */
    reading(): void {
        this.lastRead = this.version();
    }
}

/** The roster the Widget shows: the indexed sessions and the agents tree, read from the index as it is. */
export async function readWidgetRoster(): Promise<WidgetRoster> {
    const [rows, agents] = await Promise.all([
        listAgentSessionRows({ hours: WIDGET_ROSTER_HOURS, withUsage: false, refresh: false, failClosed: true }),
        hubAgents({ hours: WIDGET_ROSTER_HOURS, limit: WIDGET_ROSTER_LIMIT, refresh: false }),
    ]);
    return { rows, agents };
}

/** The transcripts that changed, by the scope they ask for; a scope without an entry refreshes its whole listing. */
export type WidgetRosterPaths = ReadonlyMap<WidgetRosterScope, readonly string[]>;

/** Above this many changed transcripts in one scope, the scope's own listing costs less than the exact refresh. */
export const WIDGET_EXACT_PATHS_LIMIT = 64;

type ProviderScope = Exclude<WidgetRosterScope, "all">;

/** The provider whose index a provider scope refreshes: a harness scope its own, the sub-agent listing Claude's. */
function scopeProvider(scope: ProviderScope): HarnessId {
    return scope === "claude-agents" ? "claude" : scope;
}

function isProviderScope(key: string): key is ProviderScope {
    return key === "claude-agents" || isAccountProviderAlias(key);
}

/** The changed transcripts a roster request carries (a plain object, as a worker message holds it), as a map. */
export function widgetRosterPaths(paths: Partial<Record<WidgetRosterScope, string[]>>): WidgetRosterPaths {
    const map = new Map<WidgetRosterScope, string[]>();
    for (const [scope, files] of Object.entries(paths)) {
        if (isProviderScope(scope) && files) {
            map.set(scope, files);
        }
    }

    return map;
}

function canonical(path: string): string | undefined {
    try {
        return realpathSync(path);
    } catch (error) {
        logger.trace({ error, path }, "Widget exact refresh: the changed file is gone");
        return undefined;
    }
}

/**
 * The scopes with a changed file that still exists (`canonical` names it) and is no index row: the exact refresh
 * could not place that change, so the scope's whole listing must look.
 */
export function unplacedScopes({
    changes,
    rows,
    canonical,
}: {
    changes: Array<{ scope: WidgetRosterScope; paths: readonly string[] }>;
    rows: ReadonlySet<string>;
    canonical: (path: string) => string | undefined;
}): WidgetRosterScope[] {
    return changes
        .filter((change) =>
            change.paths.some((path) => {
                const file = canonical(path);
                return file !== undefined && !rows.has(file);
            })
        )
        .map((change) => change.scope);
}

/**
 * Refreshes exactly the changed transcripts of one provider (one stat and one metadata read each, no walk), and
 * returns how many rows it wrote or removed, plus the scopes whose change it could not place: a changed file that
 * still exists and is not a transcript row afterwards (a Claude sub-agent's `.meta.json`, a Grok `summary.json`,
 * a transcript with no record yet). Those scopes refresh their whole listing, as before.
 */
async function refreshExact(
    provider: HarnessId,
    changes: Array<{ scope: WidgetRosterScope; paths: readonly string[] }>
): Promise<{ written: number; unplaced: WidgetRosterScope[] }> {
    const filePaths = [...new Set(changes.flatMap((change) => change.paths))];
    const { metadata, report } = await catalogHistory({ provider, refresh: true, filters: { filePaths } });
    const unplaced = unplacedScopes({ changes, rows: new Set(metadata.map((row) => row.filePath)), canonical });
    if (unplaced.length > 0) {
        logger.debug({ provider, unplaced, paths: filePaths.length }, "Widget exact refresh left a change unplaced");
    }

    return { written: report.parsed + report.removed, unplaced };
}

/**
 * Brings the given parts of the shared index up to date, in this process. `all` is the full discovery; a provider
 * scope refreshes only that listing, which is what a change under that provider's session root can affect, and a
 * scope with `paths` refreshes only those transcripts. A provider scope never reuses another process's recent
 * refresh: it runs because a file just changed.
 *
 * A scope's whole listing walks its roots and stats every transcript in the window: 63 ms of CPU for the Claude
 * listing and 108 ms for the Claude sub-agents on 2026-10-30 (3,734 and 12,456 files), at every write of a live
 * session. The exact refresh is what a change of a known transcript costs.
 *
 * Returns whether any index row was written or removed; a full refresh always counts as a change.
 */
export async function refreshWidgetIndex(
    scopes: ReadonlySet<WidgetRosterScope>,
    { now = Date.now(), paths = new Map() }: { now?: number; paths?: WidgetRosterPaths } = {}
): Promise<boolean> {
    if (scopes.has("all")) {
        await Promise.all([
            listAgentSessionRows({
                hours: WIDGET_ROSTER_HOURS,
                withUsage: false,
                refresh: true,
                maxDiscoveryAgeMs: WIDGET_DISCOVERY_REUSE_MS,
                failClosed: true,
            }),
            hubAgents({ hours: WIDGET_ROSTER_HOURS, limit: WIDGET_ROSTER_LIMIT, refresh: true }),
        ]);
        return true;
    }

    const whole = new Set<Exclude<WidgetRosterScope, "all">>();
    const exact = new Map<HarnessId, Array<{ scope: WidgetRosterScope; paths: readonly string[] }>>();
    for (const scope of scopes) {
        if (scope === "all") {
            continue;
        }

        const changed = paths.get(scope);
        if (changed && changed.length > 0 && changed.length <= WIDGET_EXACT_PATHS_LIMIT) {
            const provider = scopeProvider(scope);
            exact.set(provider, [...(exact.get(provider) ?? []), { scope, paths: changed }]);
        } else {
            whole.add(scope);
        }
    }

    // One exact refresh per provider: a Claude transcript and a sub-agent's in one tick share it.
    let written = 0;
    for (const result of await Promise.all([...exact].map(([provider, changes]) => refreshExact(provider, changes)))) {
        written += result.written;
        for (const scope of result.unplaced) {
            if (scope !== "all") {
                whole.add(scope);
            }
        }
    }

    const since = now - WIDGET_ROSTER_HOURS * 3_600_000;
    const tasks: Promise<number>[] = [];
    const claude = (filters: { excludeSubagents?: boolean; subagentsOnly?: boolean }) =>
        getSessionListing({ ...filters, mtimeFrom: since, refresh: true }).then(
            (listing) => listing.indexed + listing.staleRemoved
        );
    const native = (
        provider: Exclude<HarnessId, "claude">,
        filters: { excludeAgents?: boolean; agentsOnly?: boolean }
    ) =>
        catalogHistory({ provider, refresh: true, filters: { ...filters, mtimeFrom: since } }).then(
            ({ report }) => report.parsed + report.removed
        );
    if (whole.has("claude")) {
        tasks.push(claude({ excludeSubagents: true }));
    }

    if (whole.has("claude-agents")) {
        tasks.push(claude({ subagentsOnly: true }));
    }

    if (whole.has("codex")) {
        tasks.push(native("codex", { excludeAgents: true }), native("codex", { agentsOnly: true }));
    }

    if (whole.has("grok")) {
        tasks.push(native("grok", { excludeAgents: true }));
    }

    const counts = await Promise.all(tasks);
    return written > 0 || counts.some((count) => count > 0);
}

/** One provider's native session roots, as its history reader walks them; canonical, as file events name them. */
function providerRoots(provider: WidgetRosterProvider): string[] {
    try {
        return resolveHistoryProvider(provider)
            .reader.roots()
            .map((root) => (existsSync(root) ? realpathSync(root) : root));
    } catch (error) {
        logger.warn(
            { error, provider },
            "Widget cannot name this provider's session roots; its safety refresh covers it"
        );
        return [];
    }
}

export function widgetSessionRoots(): Record<WidgetRosterProvider, string[]> {
    return byHarness(providerRoots);
}

function under(root: string, path: string): string | undefined {
    const prefix = root.endsWith(sep) ? root : root + sep;
    return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

/**
 * What a changed file under a session root asks of the roster, or undefined when it cannot affect it.
 *
 * - `<claude root>/<project>/<session>.jsonl`: the Claude listing (title, activity time).
 * - `<claude root>/<project>/<lead>/subagents/<file>`: a read only, because the agents tree reads a listed lead's
 *   `subagents/` folder directly; the sub-agent listing only when the lead is not a listed parent.
 * - A transcript deeper under `subagents/` (a workflow's agents): the sub-agent listing, which walks the whole folder,
 *   while the agents tree reads only the files directly in it. A workflow's `journal.jsonl` is not indexed.
 * - A rollout under a codex root, or a chat history or summary under a grok root: that provider's listing.
 */
export function widgetRosterChange({
    path,
    roots,
    listedParent,
}: {
    path: string;
    roots: Record<WidgetRosterProvider, string[]>;
    listedParent: (sessionId: string) => boolean;
}): WidgetRosterScope | "read" | undefined {
    for (const root of roots.claude) {
        const relative = under(root, path);
        if (relative === undefined) {
            continue;
        }

        const parts = relative.split(sep);
        if (parts.length === 2 && resolveHistoryProvider("claude").reader.indexesFile(path)) {
            return "claude";
        }

        if (parts.length === 4 && parts[2] === "subagents" && /\.(jsonl|json)$/.test(parts[3])) {
            return listedParent(parts[1]) ? "read" : "claude-agents";
        }

        const name = parts[parts.length - 1];
        if (
            parts.length > 4 &&
            parts[2] === "subagents" &&
            name.endsWith(".jsonl") &&
            !(name === "journal.jsonl" && parts.includes("workflows"))
        ) {
            return "claude-agents";
        }

        return undefined;
    }

    for (const root of roots.codex) {
        if (under(root, path) !== undefined) {
            // A rollout, plain or compressed (Codex 0.164 renames a closed one to `.jsonl.zst`): the index changes too.
            return resolveHistoryProvider("codex").reader.indexesFile(path) ? "codex" : undefined;
        }
    }

    for (const root of roots.grok) {
        if (under(root, path) !== undefined) {
            // The files the grok reader indexes; its event, signal and rewind files change constantly and index nothing.
            return resolveHistoryProvider("grok").reader.indexesFile(path) ? "grok" : undefined;
        }
    }

    return undefined;
}
