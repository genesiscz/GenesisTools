import { spendBucketKey } from "@genesiscz/utils/ai/usage/series-keys";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { logger } from "@genesiscz/utils/logger";
import { type UsageEventInput, UsageEventsStore } from "./store";

/**
 * The one writer of usage events (design 2026-11-01, step U6). It sits where each event happens (the usage client,
 * the proxy, the probe budget, the poll gate), so like `recordUsage` it NEVER throws: a failed write is a debug line,
 * never a failed request or poll.
 *
 * The store is opened once per process, on the first event, through `UsageLimitsDb` (which applies the
 * `usage_limits` migrations). A test hands its own store to `useUsageEventsStoreForTests`.
 */

let store: UsageEventsStore | null = null;

function eventsStore(): UsageEventsStore {
    if (!store) {
        store = new UsageEventsStore(new UsageLimitsDb().connection());
    }

    return store;
}

/** Points the writer at a test store; `null` goes back to the shared one. */
export function useUsageEventsStoreForTests(next: UsageEventsStore | null): void {
    store = next;
}

export function recordUsageEvent(event: UsageEventInput): void {
    try {
        eventsStore().insert(event);
    } catch (err) {
        logger.debug({ err, kind: event.kind, provider: event.provider }, "[usage-events] event not recorded");
    }
}

/**
 * Counts quota probes per account, model and local day, so the probe history outlives the 7-day budget file. One
 * row per day, its `count` raised by each probe.
 */
export function recordProbeCount(event: Omit<UsageEventInput, "kind"> & { by?: number }): void {
    const at = event.at ?? new Date();

    try {
        eventsStore().bumpDaily({ ...event, kind: "probe", at, day: spendBucketKey(at.toISOString(), "day") });
    } catch (err) {
        logger.debug({ err, provider: event.provider }, "[usage-events] probe count not recorded");
    }
}

/**
 * Counts refused quota probes per account, model and local day. A spent budget does not back the poller off, so it
 * refuses a probe on every poll; one row per refusal would be up to 43,200 rows per account and model in 30 days.
 * The day row keeps the latest refusal's detail (which budget is spent), which the health alert prints, and its `ts`
 * moves to the latest refusal, so the alert still sees a refusal after its previous pass.
 */
export function recordProbeRefusal(event: Omit<UsageEventInput, "kind">): void {
    const at = event.at ?? new Date();

    try {
        eventsStore().bumpDaily({ ...event, kind: "probe-refused", at, day: spendBucketKey(at.toISOString(), "day") });
    } catch (err) {
        logger.debug({ err, provider: event.provider }, "[usage-events] probe refusal not recorded");
    }
}
