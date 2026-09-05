import { buildSpendSeries, type SpendSeriesResult, type TranscriptGrain } from "@app/ai-spend/lib/series";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";

export interface TranscriptScanInput {
    from: string;
    to: string;
    grain: TranscriptGrain;
    accountIds?: string[];
    /**
     * Read on the main thread and cloned in, so the worker never opens the config
     * store. Credentials inside are `SecureRef`s, which are paths, not secrets.
     */
    accounts: AccountEntry[];
}

export type TranscriptScanOutput = { ok: true; result: SpendSeriesResult } | { ok: false; error: string };

declare const self: Worker;

/**
 * The transcript half of a spend query, off the request thread.
 *
 * `buildSpendSeries` walks every session log with synchronous file calls and
 * takes tens of seconds over a month. On the request thread that stalls every
 * other endpoint; here it stalls only this worker.
 */
self.onmessage = async (event: MessageEvent<TranscriptScanInput>) => {
    const { accounts, accountIds, ...query } = event.data;

    try {
        const result = await buildSpendSeries(
            {
                ...query,
                byModel: true,
                ...(accountIds?.length ? { accountIds } : {}),
            },
            { accounts }
        );

        self.postMessage({ ok: true, result } satisfies TranscriptScanOutput);
    } catch (err) {
        // The message, not the Error: what survives a structured clone is not the
        // same across runtimes, and a dropped rejection here would hang the caller
        // until its timeout.
        const error = err instanceof Error ? err.message : String(err);
        self.postMessage({ ok: false, error } satisfies TranscriptScanOutput);
    }
};
