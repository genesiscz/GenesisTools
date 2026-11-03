import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PRICING } from "../pricing";
import { eventCostEstimate } from "../reports/cost";
import type { DriverUsageEvent, MonitorDriver } from "./types";

/**
 * Shared harness for the per-driver fixture tests. Fixture line shapes are
 * copied from the REAL formats on disk with synthetic ids and cwds; no live
 * account name, session id or path ever appears in a fixture.
 */

/** A path that does not have to exist: only the grok driver reads a sibling of it. */
const FIXTURE_FILE = join(tmpdir(), "ai-spend-fixture", "updates.jsonl");

/** Run `lines` through a fresh parser and collect every event it emits. */
export function collectEvents(driver: MonitorDriver, lines: string[], file = FIXTURE_FILE): DriverUsageEvent[] {
    const parser = driver.createParser({ file, state: undefined });
    const events: DriverUsageEvent[] = [];

    for (const line of lines) {
        parser.parseLine(line, (event) => events.push(event));
    }

    return events;
}

/** What `monitor` would bill for one event: the recorded cost, else catalog rates, else $0. */
/** What the monitor bills for one event: the same policy (`eventCostEstimate`) the reports use. */
export function billedCost(driver: MonitorDriver, event: DriverUsageEvent): number {
    return (
        eventCostEstimate({ ...event, source: driver.id }, DEFAULT_PRICING, "auto", driver.priceCandidates(event.model))
            .costUSD ?? 0
    );
}
