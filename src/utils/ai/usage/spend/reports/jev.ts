import { jevCalls } from "@genesiscz/utils/ai/evaluation/spend";
import type { SpendEvent } from "./types";

/**
 * Jev calls from the GenesisTools usage ledger (`~/.genesis-tools/ai/usage/`), which every Jev feature
 * books through the shared evaluator. There is no transcript, so `home` is unused. A call's feature
 * label (`grep`, `listen`, ...) is its "session": `tools ai-spend jev session` is the per-feature report.
 * The cost is the ledger's booked price, or the catalog price for rows booked before the catalog knew Jev.
 */
export function loadJevEvents(_home: string, onlySession?: string): SpendEvent[] {
    const events: SpendEvent[] = jevCalls().calls.map((call, index) => ({
        source: "jev",
        id: `jev:${call.at}:${index}`,
        model: call.model,
        timestamp: call.at,
        sessionId: call.label,
        project: call.provider,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        ...(call.costUsd === undefined ? {} : { recordedCostUsd: call.costUsd }),
    }));
    return onlySession ? events.filter((event) => event.sessionId === onlySession) : events;
}
