import { logger } from "@genesiscz/utils/logger";
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

    if (wanted.has("claude")) {
        appendAll(events, loadClaudeEvents(options.home, minMtimeMs));
    }

    if (wanted.has("codex")) {
        appendAll(events, loadCodexEvents(options.home, minMtimeMs));
    }

    if (wanted.has("grok")) {
        appendAll(events, loadGrokEvents(options.home, minMtimeMs));
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

export function filterEvents(
    events: SpendEvent[],
    options: { timezone: string; sinceDay?: string; untilDay?: string; sessionId?: string }
): SpendEvent[] {
    return events.filter((event) => {
        if (options.sessionId && event.sessionId !== options.sessionId) {
            return false;
        }

        const day = zonedDay(event.timestamp, options.timezone);
        return inDayWindow(day, options.sinceDay, options.untilDay);
    });
}
