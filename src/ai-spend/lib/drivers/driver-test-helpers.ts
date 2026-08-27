import { costOf, DEFAULT_PRICING } from "../pricing";
import type { DriverUsageEvent, MonitorDriver } from "./types";

/**
 * Shared harness for the per-driver fixture tests. Fixture line shapes are
 * copied from the REAL formats on disk with synthetic ids and cwds; no live
 * account name, session id or path ever appears in a fixture.
 */

/** Run `lines` through a fresh parser and collect every event it emits. */
export function collectEvents(
    driver: MonitorDriver,
    lines: string[],
    file = "/tmp/fixture/updates.jsonl"
): DriverUsageEvent[] {
    const parser = driver.createParser({ file, state: undefined });
    const events: DriverUsageEvent[] = [];

    for (const line of lines) {
        parser.parseLine(line, (event) => events.push(event));
    }

    return events;
}

/** What `monitor` would bill for one event: the recorded cost, else catalog rates, else $0. */
export function billedCost(driver: MonitorDriver, event: DriverUsageEvent): number {
    if (event.recordedCostUsd !== undefined) {
        return event.recordedCostUsd;
    }

    for (const candidate of driver.priceCandidates(event.model)) {
        const price = DEFAULT_PRICING[candidate];

        if (price) {
            return costOf(
                {
                    input: event.inputTokens,
                    output: event.outputTokens,
                    cacheWrite: event.cacheCreationTokens,
                    cacheRead: event.cacheReadTokens,
                },
                price
            );
        }
    }

    return 0;
}
