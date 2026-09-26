import { createCodexAdapter } from "@genesiscz/utils/agent-sessions/codex-sessions";
import { createGrokAdapter } from "@genesiscz/utils/agent-sessions/grok-sessions";
import { createClaudeAdapter } from "@genesiscz/utils/agent-sessions/native-adapter";
import type {
    AgentSearchFilters,
    AgentSearchHit,
    AgentSessionAdapter,
    NativeHistoryEntry,
} from "@genesiscz/utils/agent-sessions/types";
import { logger } from "@genesiscz/utils/logger";

// `tools hub search`: one query over every provider's indexed sessions. There is no second index:
// each provider's own `AgentSessionAdapter.search` (the one behind `tools <provider> history`) runs
// with the filters pushed into it, side by side, and the hits are merged and grouped by session.

const log = logger.child({ component: "hub/search" });

export const SEARCH_PROVIDERS = ["claude", "codex", "grok"] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

export const SEARCH_LIMITS = { default: 30, max: 200, snippets: 3, snippetChars: 180 };

export interface SessionSearchOptions {
    query: string;
    providers?: readonly SearchProvider[];
    /** Project leaf name, as `tools <provider> history --project` reads it. */
    project?: string;
    since?: Date;
    until?: Date;
    /** Sessions per provider; the merged list is cut to the same number. */
    limit?: number;
    signal?: AbortSignal;
}

export interface SearchSnippet {
    role: NativeHistoryEntry["role"];
    /** The matching entry's text cut around the first occurrence of the query. */
    text: string;
    /** The entry's line in the session file. */
    line: number;
    timestamp: string | null;
    tool: string | null;
}

export interface SessionSearchHit {
    provider: string;
    sessionId: string;
    title: string;
    project: string | null;
    cwd: string;
    gitBranch: string | null;
    mtime: string;
    account: string | null;
    filePath: string;
    matchCount: number;
    relevance: number | null;
    snippets: SearchSnippet[];
}

export interface ProviderSearchReport {
    hits: number;
    ms: number;
    error: string | null;
}

export interface SessionSearchResult {
    query: string;
    filters: { providers: string[]; project: string | null; since: string | null; until: string | null; limit: number };
    results: SessionSearchHit[];
    providers: Record<string, ProviderSearchReport>;
    elapsedMs: number;
}

export type SearchAdapters = Partial<Record<SearchProvider, () => AgentSessionAdapter<string>>>;

export const realSearchAdapters: SearchAdapters = {
    claude: () => createClaudeAdapter(),
    codex: () => createCodexAdapter(),
    grok: () => createGrokAdapter(),
};

export function isSearchProvider(value: string): value is SearchProvider {
    return (SEARCH_PROVIDERS as readonly string[]).includes(value);
}

function collapse(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/** `text` cut to `max` characters around the first case-insensitive occurrence of a query word. */
export function snippetAround(text: string, query: string, max = SEARCH_LIMITS.snippetChars): string {
    const flat = collapse(text);

    if (flat.length <= max) {
        return flat;
    }

    const lower = flat.toLowerCase();
    const needles = [query, ...query.split(/\s+/)].map((word) => word.trim().toLowerCase()).filter(Boolean);
    const at = needles.map((needle) => lower.indexOf(needle)).find((index) => index >= 0) ?? 0;
    const start = Math.max(0, Math.min(at - Math.floor(max / 3), flat.length - max));
    const end = Math.min(flat.length, start + max);

    return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

function snippetsOf(hit: AgentSearchHit<string>, query: string): SearchSnippet[] {
    const entries = hit.matchedEntries ?? [];
    const snippets = entries
        .filter((entry) => entry.text.trim().length > 0)
        .slice(0, SEARCH_LIMITS.snippets)
        .map((entry) => ({
            role: entry.role,
            text: snippetAround(entry.text, query),
            line: entry.line,
            timestamp: entry.timestamp ?? null,
            tool: entry.tool ?? null,
        }));

    if (snippets.length === 0 && hit.matchedText) {
        // A metadata hit (title, summary, first prompt) carries text but no entry.
        snippets.push({
            role: "user",
            text: snippetAround(hit.matchedText, query),
            line: 0,
            timestamp: null,
            tool: null,
        });
    }

    return snippets;
}

export function toSearchHit(hit: AgentSearchHit<string>, query: string): SessionSearchHit {
    return {
        provider: hit.kind,
        sessionId: hit.sessionId,
        title: hit.title,
        project: hit.project ?? null,
        cwd: hit.cwd,
        gitBranch: hit.gitBranch ?? null,
        mtime: hit.mtime.toISOString(),
        account: hit.account ?? null,
        filePath: hit.filePath,
        matchCount: Math.max(hit.matchedEntries?.length ?? 0, hit.matchedText ? 1 : 0),
        relevance: hit.relevanceScore ?? null,
        snippets: snippetsOf(hit, query),
    };
}

/** The filters one adapter receives: every scope the caller named goes into its query. */
export function adapterFilters(options: SessionSearchOptions, limit: number): AgentSearchFilters {
    return {
        query: options.query,
        all: !options.project,
        ...(options.project ? { project: options.project } : {}),
        ...(options.since ? { since: options.since } : {}),
        ...(options.until ? { until: options.until } : {}),
        limit,
        context: 0,
        excludeAgents: true,
        ...(options.signal ? { signal: options.signal } : {}),
    };
}

export async function searchSessions(
    options: SessionSearchOptions,
    adapters: SearchAdapters = realSearchAdapters
): Promise<SessionSearchResult> {
    const started = performance.now();
    const query = options.query.trim();

    if (!query) {
        throw new Error("the search query is empty");
    }

    const limit = Math.min(SEARCH_LIMITS.max, Math.max(1, Math.floor(options.limit ?? SEARCH_LIMITS.default)));
    const providers = (options.providers?.length ? options.providers : SEARCH_PROVIDERS).filter((provider) =>
        Boolean(adapters[provider])
    );
    const filters = adapterFilters({ ...options, query }, limit);
    const reports: Record<string, ProviderSearchReport> = {};

    const perProvider = await Promise.all(
        providers.map(async (provider) => {
            const providerStarted = performance.now();

            try {
                const adapter = adapters[provider]!();
                const hits = await adapter.search(filters);
                reports[provider] = {
                    hits: hits.length,
                    ms: Math.round(performance.now() - providerStarted),
                    error: null,
                };
                return hits.map((hit) => toSearchHit(hit, query));
            } catch (error) {
                // One provider's unreadable index must not blank the other two.
                const message = error instanceof Error ? error.message : String(error);
                log.warn({ error, provider }, "hub search: a provider's search failed");
                reports[provider] = { hits: 0, ms: Math.round(performance.now() - providerStarted), error: message };
                return [];
            }
        })
    );

    const seen = new Set<string>();
    const results = perProvider
        .flat()
        .sort((left, right) => right.mtime.localeCompare(left.mtime))
        .filter((hit) => {
            const key = `${hit.provider}:${hit.sessionId}`;

            if (seen.has(key)) {
                return false;
            }

            seen.add(key);
            return true;
        })
        .slice(0, limit);

    const elapsedMs = Math.round(performance.now() - started);
    log.debug({ query: query.length, providers, results: results.length, reports, elapsedMs }, "hub search done");

    return {
        query,
        filters: {
            providers: [...providers],
            project: options.project ?? null,
            since: options.since?.toISOString() ?? null,
            until: options.until?.toISOString() ?? null,
            limit,
        },
        results,
        providers: reports,
        elapsedMs,
    };
}
