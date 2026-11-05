import { findCacheLosses } from "@genesiscz/utils/ai/usage/cache-stats";
import { costOf } from "@genesiscz/utils/ai/usage/spend/pricing";
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

/**
 * The waste items of one transcript's own cache: a lead's main loop (the sub-agent calls inside it are another cache
 * and are not paired with it), or a sub-agent's own transcript, whose calls are all sidechain calls.
 */
export function sessionWaste(calls: readonly SessionCall[], compactions: readonly SessionCompaction[]): WasteItem[] {
    const ownTranscript = calls.length > 0 && calls.every((call) => call.sidechain);
    // An aggregate row sums several requests, so its cache read follows how many it made: a drop is no lost cache.
    const main = calls.filter((call) => (ownTranscript || !call.sidechain) && !call.aggregate);
    const items: WasteItem[] = [];

    for (const loss of findCacheLosses(cacheCallsOf(main, compactions))) {
        const call = main[loss.call];
        const price = call ? priceOfCall(call) : null;

        if (!call || !price) {
            continue;
        }

        // The drop in reads only detects the loss; the call rebuilt at most what it wrote and sent uncached (a
        // compaction falls to a short summary, a truncation rebuilds nothing it dropped).
        const tokens = Math.min(Math.max(0, loss.before - loss.after), call.cacheWrite + call.input);
        const rebuilt = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: tokens,
            cacheWrite1h: Math.min(tokens, call.cacheWrite1h ?? 0),
        };
        const cached = { ...rebuilt, cacheRead: tokens, cacheWrite: 0, cacheWrite1h: 0 };
        items.push({
            kind: KIND_OF_CAUSE[loss.cause] ?? "cache-rebuild-other",
            t: call.t,
            model: call.model,
            tokens,
            usd: Math.max(0, costOf(rebuilt, price) - costOf(cached, price)),
            evidence: `${loss.reason}; read ${loss.before} then ${loss.after} after ${loss.gapMin} min`,
        });
    }

    return items;
}
