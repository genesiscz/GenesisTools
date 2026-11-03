import { callCostUsd, coldRebuildUsd } from "@genesiscz/utils/agent-sessions/analysis/cost";
import { factsOf } from "@genesiscz/utils/agent-sessions/analysis-types";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import { concurrentMap } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import type { AgentSessionRow } from "./agent-session-rows";

/** The live session meter's numbers (design 2026-11-01, step U11, proposal 11). Each is null when no rate is known. */
export interface SessionCostFields {
    /** List-price dollars of the session's calls so far. */
    spentUsd: number | null;
    /** Dollars of its calls in the last hour. */
    usdPerHour: number | null;
    /** The extra price of the next prompt if the cache expires first: the context written again instead of read. */
    coldRebuildUsd: number | null;
}

const HOUR_MS = 3_600_000;

async function costOf(row: AgentSessionRow, now: number): Promise<SessionCostFields> {
    const trace = await resolveHistoryProvider(row.provider).reader.analysis.callTrace(row.filePath);
    const calls = factsOf(trace);
    let spent = 0;
    let lastHour = 0;
    let priced = 0;

    for (const call of calls) {
        const usd = callCostUsd(call);

        if (usd === null) {
            continue;
        }

        priced += 1;
        spent += usd;

        if (Date.parse(call.t) >= now - HOUR_MS) {
            lastHour += usd;
        }
    }

    const last = calls.at(-1);
    const context = row.contextTokens ?? (last ? last.input + last.cacheRead + last.cacheWrite : 0);

    return {
        spentUsd: priced > 0 ? spent : null,
        usdPerHour: priced > 0 ? lastHour : null,
        coldRebuildUsd:
            last && context > 0
                ? coldRebuildUsd({
                      model: last.model,
                      contextTokens: context,
                      oneHour: (row.cacheLifetimeSec ?? 0) >= 3600,
                      at: new Date(now),
                  })
                : null,
    };
}

/**
 * The rows with their cost fields, for `tools ai usage sessions --cost`. Each transcript is read once through its
 * reader's `analysis.callTrace`; a row whose transcript cannot be read keeps null fields.
 */
export async function withSessionCost(
    rows: readonly AgentSessionRow[],
    now = Date.now()
): Promise<Array<AgentSessionRow & SessionCostFields>> {
    const costs = await concurrentMap({
        items: [...rows],
        fn: (row) => costOf(row, now),
        concurrency: 4,
        onError: (row, err) => logger.debug({ err, file: row.filePath }, "[ai-usage] session cost unreadable"),
    });

    return rows.map((row) => ({
        ...row,
        ...(costs.get(row) ?? { spentUsd: null, usdPerHour: null, coldRebuildUsd: null }),
    }));
}
