import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { DiscoveredHome } from "@genesiscz/utils/ai/providers/account-features";
import { CLAUDE_ALL_ACCOUNT_ID, UNBOUND_ACCOUNT_ID } from "@genesiscz/utils/ai/usage";
import { logger } from "@genesiscz/utils/logger";
import type { AgentId } from "../drivers";
import type { PricingTable } from "../types";
import { priceCandidates as defaultCandidates, eventCost } from "./cost";
import { inDayWindow, zonedDay } from "./dates";
import {
    type LoadNativeOptions,
    loadClaudeEvents,
    loadCodexEvents,
    loadGrokEvents,
    loadNativeSessionEvents,
    type NativeSourceId,
    nativePriceCandidates,
} from "./native";
import { loadExtraSource } from "./sources";
import type { CostMode, SourceId, SpendEvent } from "./types";
import { SOURCE_IDS } from "./types";

export interface LoadOptions {
    home: string;
    sources?: readonly SourceId[];
    /** Skip transcripts whose mtime is before this instant (append-only files). */
    minMtimeMs?: number;
    /** Enabled accounts, so native events carry the account whose home they sat in. */
    accounts?: readonly AccountEntry[];
    /** Homes from `--all-homes`; the caller already awaited `discoverHomes()`. */
    discoveredHomes?: Partial<Record<AgentId, readonly DiscoveredHome[]>>;
    /**
     * Only this session's events are wanted (`session --id`). Every source that
     * names its files after the session reads only those; the rest load whole.
     * The caller still filters the result by id.
     */
    sessionId?: string;
}

function appendAll(into: SpendEvent[], extra: SpendEvent[]): void {
    for (const event of extra) {
        into.push(event);
    }
}

export function loadEvents(options: LoadOptions): SpendEvent[] {
    const wanted = new Set(options.sources ?? SOURCE_IDS);
    const minMtimeMs = options.minMtimeMs ?? 0;

    const native = (agent: AgentId) => ({
        home: options.home,
        minMtimeMs,
        accounts: options.accounts,
        discoveredHomes: options.discoveredHomes?.[agent],
    });

    // Empty is no filter, exactly as `filterEvents` reads it.
    if (options.sessionId) {
        return dedupEvents(loadSessionEvents({ wanted, native, home: options.home, sessionId: options.sessionId }));
    }

    const events: SpendEvent[] = [];

    if (wanted.has("claude")) {
        appendAll(events, loadClaudeEvents(native("claude")));
    }

    if (wanted.has("codex")) {
        appendAll(events, loadCodexEvents(native("codex")));
    }

    if (wanted.has("grok")) {
        appendAll(events, loadGrokEvents(native("grok")));
    }

    appendAll(events, loadExtraSources(wanted, options.home));

    return dedupEvents(events);
}

function loadExtraSources(wanted: ReadonlySet<SourceId>, home: string, onlySession?: string): SpendEvent[] {
    const events: SpendEvent[] = [];

    for (const source of SOURCE_IDS) {
        if (source === "claude" || source === "codex" || source === "grok" || !wanted.has(source)) {
            continue;
        }

        try {
            appendAll(events, loadExtraSource(source, home, onlySession));
        } catch (err) {
            logger.debug({ err, source }, "ai-spend: extra source failed");
        }
    }

    return events;
}

const NATIVE_SOURCES: readonly NativeSourceId[] = ["claude", "codex", "grok"];

interface SessionLoadOptions {
    wanted: ReadonlySet<SourceId>;
    native: (agent: AgentId) => LoadNativeOptions;
    home: string;
    sessionId: string;
}

/**
 * One session's events, read from the files named after it.
 *
 * Every native agent names a session's files after its id, so the first agent
 * whose layout holds the id owns it and the rest are never searched: a Claude
 * UUID is not also a Codex rollout name or a Grok session directory. Only when
 * none does are the extra sources loaded (narrowed to the id where their
 * files are named after it).
 *
 * Claude is the one agent whose id comes from the file's CONTENT, so an id no
 * layout holds (a workflow run id) can still sit inside another Claude
 * transcript. That last case falls back to the full walk, which still skips
 * the parse of every file that never mentions the id.
 */
function loadSessionEvents(options: SessionLoadOptions): SpendEvent[] {
    const { wanted, native, home, sessionId } = options;

    for (const agent of NATIVE_SOURCES) {
        if (!wanted.has(agent)) {
            continue;
        }

        const events = loadNativeSessionEvents(agent, { ...native(agent), sessionId });

        if (events !== undefined) {
            logger.debug({ agent, sessionId, events: events.length }, "ai-spend: session found by file name");
            return events;
        }
    }

    const extras = loadExtraSources(wanted, home, sessionId);

    if (!wanted.has("claude") || extras.some((event) => event.sessionId === sessionId)) {
        return extras;
    }

    logger.debug({ sessionId }, "ai-spend: no file is named after the session, scanning every Claude transcript");
    const events = loadClaudeEvents({ ...native("claude"), sessionId });
    appendAll(events, extras);

    return events;
}

function dedupEvents(events: SpendEvent[]): SpendEvent[] {
    const byId = new Map<string, SpendEvent>();

    for (const event of events) {
        const key = `${event.source}:${event.id}`;
        const existing = byId.get(key);

        if (!existing) {
            byId.set(key, event);
            continue;
        }

        if (existing.isSidechain && !event.isSidechain) {
            byId.set(key, event);
        }
    }

    return [...byId.values()];
}

export function candidatesFor(event: SpendEvent): string[] {
    if (event.source === "claude" || event.source === "codex" || event.source === "grok") {
        return nativePriceCandidates(event.source, event.model);
    }

    return defaultCandidates(event.model);
}

export function pricedEventCost(event: SpendEvent, pricing: PricingTable, mode: CostMode): number {
    return eventCost(event, pricing, mode, candidatesFor(event));
}

/**
 * The account row an event reports under, in the same vocabulary the monitor
 * and the series use: every Claude transcript is `claude-all` (decision D6), and
 * anything no account claims is `(unbound)` rather than being dropped.
 */
export function spendEventAccountId(event: SpendEvent): string {
    if (event.source === "claude") {
        return CLAUDE_ALL_ACCOUNT_ID;
    }

    return event.accountId ?? UNBOUND_ACCOUNT_ID;
}

export function filterEvents(
    events: SpendEvent[],
    options: {
        timezone: string;
        sinceDay?: string;
        untilDay?: string;
        sessionId?: string;
        /** `"(unbound)"` and `"claude-all"` are valid entries. */
        accountIds?: readonly string[];
    }
): SpendEvent[] {
    const wantedAccounts = options.accountIds ? new Set(options.accountIds) : undefined;

    return events.filter((event) => {
        if (options.sessionId && event.sessionId !== options.sessionId) {
            return false;
        }

        if (wantedAccounts && !wantedAccounts.has(spendEventAccountId(event))) {
            return false;
        }

        const day = zonedDay(event.timestamp, options.timezone);
        return inDayWindow(day, options.sinceDay, options.untilDay);
    });
}
