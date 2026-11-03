import { findCacheLosses } from "@genesiscz/utils/ai/usage/cache-stats";
import type { SessionCall, SessionCompaction } from "../analysis-types";
import { priceOfCall } from "./cost";
import { cacheCallsOf } from "./report";

/**
 * Avoidable spend in one session (design 2026-11-01, proposal 12): each cache rebuild, priced as the context written
 * again at the cache-write rate instead of read at the cache-read rate, with its cause from the cache-loss scan.
 */
export type WasteKind =
    | "cache-rebuild-idle"
    | "cache-rebuild-compaction"
    | "cache-rebuild-model"
    | "cache-rebuild-other";

export const WASTE_KINDS: readonly WasteKind[] = [
    "cache-rebuild-idle",
    "cache-rebuild-compaction",
    "cache-rebuild-model",
    "cache-rebuild-other",
];

export interface WasteItem {
    kind: WasteKind;
    /** ISO UTC of the call that paid for it. */
    t: string;
    model: string;
    /** The tokens written again. */
    tokens: number;
    usd: number;
    /** What the scan saw: the gap, the read before and after. */
    evidence: string;
}

const KIND_OF_CAUSE: Record<string, WasteKind> = {
    idle: "cache-rebuild-idle",
    compaction: "cache-rebuild-compaction",
    "model changed": "cache-rebuild-model",
};

/** The waste items of one session's main loop (sub-agent calls are another cache and are not paired with it). */
export function sessionWaste(calls: readonly SessionCall[], compactions: readonly SessionCompaction[]): WasteItem[] {
    const main = calls.filter((call) => !call.sidechain);
    const items: WasteItem[] = [];

    for (const loss of findCacheLosses(cacheCallsOf(main, compactions))) {
        const call = main[loss.call];
        const price = call ? priceOfCall(call) : null;

        if (!call || !price) {
            continue;
        }

        const tokens = Math.max(0, loss.before - loss.after);
        items.push({
            kind: KIND_OF_CAUSE[loss.cause] ?? "cache-rebuild-other",
            t: call.t,
            model: call.model,
            tokens,
            usd: (tokens * Math.max(0, price.cacheWrite - price.cacheRead)) / 1e6,
            evidence: `${loss.reason}; read ${loss.before} then ${loss.after} after ${loss.gapMin} min`,
        });
    }

    return items;
}
