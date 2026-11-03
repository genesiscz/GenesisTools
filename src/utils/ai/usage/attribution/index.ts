import { homedir } from "node:os";
import type { AccountKey } from "@genesiscz/utils/ai/usage/contract";
import { loadSpendAccountsContext } from "@genesiscz/utils/ai/usage/spend/accounts-context";
import { loadPricing } from "@genesiscz/utils/ai/usage/spend/config";
import { AGENT_IDS } from "@genesiscz/utils/ai/usage/spend/drivers";
import { collectSeriesEvents } from "@genesiscz/utils/ai/usage/spend/events-cache";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import { loadSessionAccountLookup } from "./session-account";
import { type AttributedEvent, attributeEvents } from "./spend-share";

export * from "./bar";
export * from "./session-account";
export * from "./spend-share";
export * from "./spikes";

/**
 * Every spend event since `from`, each with its session and account (design 2026-11-01, step U9). It reads the
 * ai-spend events cache, which keeps 90 days and re-reads only transcripts that grew, and the pin journal read-only.
 */
export async function loadAttributedSpend(input: {
    from: Date;
    now: Date;
    directory: readonly AccountKey[];
}): Promise<AttributedEvent[]> {
    const storage = new Storage("ai-spend");
    const pricing = await loadPricing(storage);
    const context = await loadSpendAccountsContext();
    const events = collectSeriesEvents({
        storage,
        pricing,
        home: homedir(),
        sources: AGENT_IDS,
        minMtimeMs: input.from.getTime(),
        accounts: context.accounts,
        now: input.now,
        withFile: true,
    });
    const lookup = await loadSessionAccountLookup(input.directory);
    const attributed = attributeEvents(events, lookup);

    logger.debug(
        { from: input.from.toISOString(), events: events.length, pins: lookup.pins.size },
        "[ai-usage] spend attributed to sessions and accounts"
    );

    return attributed;
}
