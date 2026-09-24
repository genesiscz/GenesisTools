import { loadPins } from "@app/claude/lib/cmux/pins";
import { cleanPromptText } from "@app/claude/lib/cmux/sessions";
import type { SessionPin } from "@app/claude/lib/cmux/types";
import {
    type CacheStatus,
    CODEX_CACHE_TTL_MS,
    computeCacheStatus,
    GROK_CACHE_TTL_MS,
    listSessionRows,
    type SessionCmuxLocation,
} from "@app/claude/lib/usage/session-rows";
import { openHistoryService } from "@genesiscz/utils/agent-sessions/open-service";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/aliases";
import { PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/aliases";
import { grokAccountNameLookup } from "@genesiscz/utils/ai/providers/plugins/grok-sub/discover";
import { logger } from "@genesiscz/utils/logger";
import { collapsePath } from "@genesiscz/utils/paths";

/**
 * One session row for ANY coding agent, so a reader does not need a client per provider.
 *
 * `tools claude usage sessions --json` is the rich Claude-only surface and stays that way.
 * This adds Codex and Grok beside it, with the fields those providers genuinely have. Cache
 * fields are present for Claude (1 h), Codex (30 min) and Grok (30 min warning clock;
 * xAI publishes no TTL). Never zero-fill a provider that still has no clock.
 */
export interface AgentSessionRow {
    /** `claude` | `codex` | `grok`. Which fields are present follows from this. */
    provider: AccountProviderAlias;
    sessionId: string;
    title: string | null;
    cwd: string;
    cwdShort: string;
    project: string | null;
    mtime: number;
    model: string | null;
    /**
     * The account this session bills, when it can be known.
     *
     * Claude and Codex: the SessionStart pin journal, which every agent's hook now writes.
     * Grok: the account whose login file the session's home holds.
     *
     * Codex records nothing of its own — every account shares one home, and neither a rollout
     * nor a `threads` row names an account. The pin is the only record, so a Codex session
     * started before the hook learned about Codex, or outside `tools codex run`, stays null.
     */
    account: string | null;
    filePath: string;
    /** Native home this session was read from. The only provenance Codex has. */
    sourceHome?: string;
    archived?: boolean;

    /**
     * Prompt-cache clock. Present for Claude (1 h), Codex (30 min) and Grok (30 min
     * warning clock). Never zero-fill a missing clock. `cacheLifetimeSec` is the full
     * lifetime used to compute status, so a consumer does not have to hardcode 3600.
     */
    lastCacheAt?: number;
    cacheStatus?: CacheStatus;
    cacheTtlSec?: number;
    cacheLifetimeSec?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheCreateTokens?: number;
    contextTokens?: number;
    compacted?: boolean;
    lastUserAt?: number | null;
    modelSwitched?: boolean;
    cmux?: SessionCmuxLocation | null;
}

export interface AgentSessionRowsOptions {
    /** Aliases to include. Omitted = all three. */
    providers?: readonly AccountProviderAlias[];
    /** Keep rows with mtime within this many hours. Omitted = no time filter. */
    hours?: number;
    /**
     * If the hours window has fewer rows, append older sessions by mtime.
     *
     * ⚠️ Claude only. `nativeRows()` never receives it, so Codex and Grok ignore it silently.
     * The CLI help says so; a programmatic caller reads this instead.
     */
    minRows?: number;
    limit?: number;
    now?: number;
}

const ALL: readonly AccountProviderAlias[] = ["claude", "codex", "grok"];

function titleOf(record: {
    customTitle: string | null;
    summary: string | null;
    firstPrompt: string | null;
}): string | null {
    const prompt = record.firstPrompt ? cleanPromptText(record.firstPrompt) : null;

    return record.customTitle ?? record.summary ?? (prompt && prompt.length > 0 ? prompt : null);
}

/** Grok names a login by its home; a home with no account simply has none. */
function grokAccount(lookup: (home: string) => string | undefined, home: string): string | null {
    try {
        return lookup(home) ?? null;
    } catch (err) {
        // An unreadable auth file or an unparseable ai/config.json is a REASON, and silence made
        // it indistinguishable from "this home has no account" with nothing in the log.
        logger.debug({ err, home }, "[ai] grok account for home unavailable");
        return null;
    }
}

/**
 * Grok can answer from the session's own home. Codex cannot answer at all on its own, so it
 * falls back to the SessionStart pin its launcher's `TOOLS_CODEX_ACCOUNT` produced.
 *
 * `grokLookup` is resolved ONCE per listing, outside the per-row loop: `AiConfigStore.readOnly()`
 * has no cache the way `load()`'s process singleton does, and a listing calls this once per grok
 * row — thousands on this machine, all resolving the same handful of homes.
 */
function lastCacheAtMs(record: { lastTimestamp?: string | null; mtime: number }): number {
    if (record.lastTimestamp) {
        const parsed = Date.parse(record.lastTimestamp);

        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return record.mtime;
}

function accountOf(
    alias: Exclude<AccountProviderAlias, "claude">,
    record: { sessionId: string | null; sourceHome?: string | null },
    pins: Map<string, SessionPin>,
    grokLookup: (home: string) => string | undefined
): string | null {
    if (alias === "grok") {
        return record.sourceHome ? grokAccount(grokLookup, record.sourceHome) : null;
    }

    return (record.sessionId ? pins.get(record.sessionId)?.account : null) ?? null;
}

/**
 * Codex and Grok rows, straight off the shared history index.
 *
 * `PR #370` made `openHistoryService` provider-generic; only `getSessionListing` in the Claude
 * tool stayed pinned to one provider, which is why nothing downstream of it had a Codex or
 * Grok equivalent.
 */
async function nativeRows(
    alias: Exclude<AccountProviderAlias, "claude">,
    options: AgentSessionRowsOptions
): Promise<AgentSessionRow[]> {
    // Read-only: a session listing is a diagnostic and must not rewrite the journal, and a
    // provider-filtered load must never compact it (see `loadPins`).
    const pins = await loadPins({ readOnly: true, provider: alias });
    const service = openHistoryService({ provider: PROVIDER_ALIASES[alias] });
    const now = options.now ?? Date.now();
    const cutoff = options.hours === undefined ? undefined : now - options.hours * 3_600_000;
    const { metadata } = await service.catalog({
        excludeAgents: true,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(cutoff === undefined ? {} : { mtimeFrom: cutoff }),
    });
    // One config read for the whole listing, not one per grok row.
    const grokLookup = alias === "grok" ? await grokAccountNameLookup() : () => undefined;
    const rows: AgentSessionRow[] = [];

    for (const record of metadata) {
        // 🛑 `catalog({ excludeAgents: true })` does NOT exclude them: it uses the flag for the
        // refresh scope and then hard-overrides it to false before filtering what it returns.
        // Grok marks its worker sessions as subagents, so without this they were listed beside
        // real ones. Filtered here rather than in `catalog`, which other callers depend on.
        if (!record.sessionId || record.isSubagent || (cutoff !== undefined && record.mtime < cutoff)) {
            continue;
        }

        const cwd = record.cwd ?? "";
        const lastCacheAt = lastCacheAtMs(record);
        const cache: Partial<AgentSessionRow> = {};
        const ttlMs = alias === "codex" ? CODEX_CACHE_TTL_MS : alias === "grok" ? GROK_CACHE_TTL_MS : undefined;

        if (ttlMs !== undefined) {
            const { status, ttlSec } = computeCacheStatus(lastCacheAt, now, ttlMs);
            cache.lastCacheAt = lastCacheAt;
            cache.cacheStatus = status;
            cache.cacheTtlSec = ttlSec;
            cache.cacheLifetimeSec = Math.ceil(ttlMs / 1000);
        }

        rows.push({
            provider: alias,
            sessionId: record.sessionId,
            title: titleOf(record),
            cwd,
            cwdShort: cwd ? collapsePath(cwd) : "",
            project: record.project,
            mtime: record.mtime,
            model: null,
            account: accountOf(alias, record, pins, grokLookup),
            filePath: record.filePath,
            ...(record.sourceHome ? { sourceHome: record.sourceHome } : {}),
            archived: record.archived,
            ...cache,
        });
    }

    if (options.limit === undefined) {
        return rows;
    }

    // `catalog`'s own `limit` bounds which sources get their metadata REFRESHED; the list it
    // returns is every indexed session for the provider, so the cap has to be applied here. After
    // the subagent filter, not before it: passing `limit` down and letting the filter eat rows out
    // of it is how a provider whose newest sessions are all workers contributed nothing.
    return rows.sort((left, right) => right.mtime - left.mtime).slice(0, options.limit);
}

/** Every provider's sessions in one list, newest first. */
export async function listAgentSessionRows(options: AgentSessionRowsOptions = {}): Promise<AgentSessionRow[]> {
    const wanted = options.providers ?? ALL;
    const rows: AgentSessionRow[] = [];

    for (const alias of wanted) {
        try {
            if (alias === "claude") {
                const claude = await listSessionRows({
                    ...(options.hours === undefined ? {} : { hours: options.hours }),
                    ...(options.minRows === undefined ? {} : { minRows: options.minRows }),
                    ...(options.now === undefined ? {} : { now: options.now }),
                });

                rows.push(...claude.map((row) => ({ ...row, provider: "claude" as const })));
                continue;
            }

            rows.push(...(await nativeRows(alias, options)));
        } catch (error) {
            // One provider's index being unreadable must not blank the other two.
            logger.warn({ error, provider: alias }, "[ai] could not list this provider's sessions");
        }
    }

    rows.sort((a, b) => b.mtime - a.mtime);

    // Also after the merge: each provider caps its own list, but three capped lists still add up
    // to three times the cap, and the flag promises a row count. A provider whose sessions are
    // all older than the cut therefore contributes nothing, which is the flag working, not a bug.
    return options.limit === undefined ? rows : rows.slice(0, options.limit);
}
