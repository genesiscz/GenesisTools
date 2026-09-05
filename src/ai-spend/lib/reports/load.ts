import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { DiscoveredHome } from "@genesiscz/utils/ai/providers/account-features";
import { CLAUDE_ALL_ACCOUNT_ID, UNBOUND_ACCOUNT_ID } from "@genesiscz/utils/ai/usage";
import { logger } from "@genesiscz/utils/logger";
import type { AgentId } from "../drivers";
import type { PricingTable } from "../types";
import { priceCandidates as defaultCandidates, eventCost } from "./cost";
import { inDayWindow, zonedDay } from "./dates";
import { loadClaudeEvents, loadCodexEvents, loadGrokEvents, nativePriceCandidates } from "./native";
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
}

function appendAll(into: SpendEvent[], extra: SpendEvent[]): void {
    for (const event of extra) {
        into.push(event);
    }
}

export function loadEvents(options: LoadOptions): SpendEvent[] {
    const wanted = new Set(options.sources ?? SOURCE_IDS);
    const events: SpendEvent[] = [];

    const minMtimeMs = options.minMtimeMs ?? 0;

    const native = (agent: AgentId) => ({
        home: options.home,
        minMtimeMs,
        accounts: options.accounts,
        discoveredHomes: options.discoveredHomes?.[agent],
    });

    if (wanted.has("claude")) {
        appendAll(events, loadClaudeEvents(native("claude")));
    }

    if (wanted.has("codex")) {
        appendAll(events, loadCodexEvents(native("codex")));
    }

    if (wanted.has("grok")) {
        appendAll(events, loadGrokEvents(native("grok")));
    }

    for (const source of SOURCE_IDS) {
        if (source === "claude" || source === "codex" || source === "grok" || !wanted.has(source)) {
            continue;
        }

        try {
            appendAll(events, loadExtraSource(source, options.home));
        } catch (err) {
            logger.debug({ err, source }, "ai-spend: extra source failed");
        }
    }

    return dedupEvents(events);
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
