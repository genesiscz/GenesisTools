import { existsSync, realpathSync } from "node:fs";
import { basename, sep } from "node:path";
import { type AgentSessionRow, listAgentSessionRows } from "@app/ai/lib/sessions/agent-session-rows";
import { getSessionListing } from "@app/claude/lib/history/search";
import { catalogHistory } from "@genesiscz/utils/agent-sessions/open-service";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import { logger } from "@genesiscz/utils/logger";
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
export type WidgetRosterScope = "all" | "claude" | "claude-agents" | "codex" | "grok";

export const WIDGET_ROSTER_PROVIDERS = ["claude", "codex", "grok"] as const;
export type WidgetRosterProvider = (typeof WIDGET_ROSTER_PROVIDERS)[number];

export interface WidgetRoster {
    rows: AgentSessionRow[];
    agents: AgentsTree;
}

/** The roster the Widget shows: the indexed sessions and the agents tree, read from the index as it is. */
export async function readWidgetRoster(): Promise<WidgetRoster> {
    const [rows, agents] = await Promise.all([
        listAgentSessionRows({ hours: WIDGET_ROSTER_HOURS, withUsage: false, refresh: false, failClosed: true }),
        hubAgents({ hours: WIDGET_ROSTER_HOURS, limit: WIDGET_ROSTER_LIMIT, refresh: false }),
    ]);
    return { rows, agents };
}

/**
 * Brings the given parts of the shared index up to date, in this process. `all` is the full discovery; a provider
 * scope refreshes only that listing, which is what a change under that provider's session root can affect.
 * A provider scope never reuses another process's recent refresh: it runs because a file just changed.
 *
 * Returns whether any index row was written or removed; a full refresh always counts as a change.
 */
export async function refreshWidgetIndex(
    scopes: ReadonlySet<WidgetRosterScope>,
    { now = Date.now() }: { now?: number } = {}
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

    const since = now - WIDGET_ROSTER_HOURS * 3_600_000;
    const tasks: Promise<number>[] = [];
    const claude = (filters: { excludeSubagents?: boolean; subagentsOnly?: boolean }) =>
        getSessionListing({ ...filters, mtimeFrom: since, refresh: true }).then(
            (listing) => listing.indexed + listing.staleRemoved
        );
    const native = (provider: "codex" | "grok", filters: { excludeAgents?: boolean; agentsOnly?: boolean }) =>
        catalogHistory({ provider, refresh: true, filters: { ...filters, mtimeFrom: since } }).then(
            ({ report }) => report.parsed + report.removed
        );
    if (scopes.has("claude")) {
        tasks.push(claude({ excludeSubagents: true }));
    }

    if (scopes.has("claude-agents")) {
        tasks.push(claude({ subagentsOnly: true }));
    }

    if (scopes.has("codex")) {
        tasks.push(native("codex", { excludeAgents: true }), native("codex", { agentsOnly: true }));
    }

    if (scopes.has("grok")) {
        tasks.push(native("grok", { excludeAgents: true }));
    }

    const written = await Promise.all(tasks);
    return written.some((count) => count > 0);
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
    return { claude: providerRoots("claude"), codex: providerRoots("codex"), grok: providerRoots("grok") };
}

const GROK_SOURCE_FILES = new Set(["chat_history.jsonl", "chatHistory.jsonl", "summary.json"]);

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
        if (parts.length === 2 && parts[1].endsWith(".jsonl")) {
            return "claude";
        }

        if (parts.length === 4 && parts[2] === "subagents" && /\.(jsonl|json)$/.test(parts[3])) {
            return listedParent(parts[1]) ? "read" : "claude-agents";
        }

        return undefined;
    }

    for (const root of roots.codex) {
        if (under(root, path) !== undefined) {
            const name = basename(path);
            return name.startsWith("rollout-") && name.endsWith(".jsonl") ? "codex" : undefined;
        }
    }

    for (const root of roots.grok) {
        if (under(root, path) !== undefined) {
            // The files the grok reader indexes; its event, signal and rewind files change constantly and index nothing.
            return GROK_SOURCE_FILES.has(basename(path)) ? "grok" : undefined;
        }
    }

    return undefined;
}
