import { afterEach, describe, expect, test } from "bun:test";
import { checkEvent, MetricsInputError } from "./dims";
import { MetricsStore } from "./store";
import type { StoredEvent } from "./types";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 1, 10, 0, 0);
const stores: MetricsStore[] = [];

afterEach(() => {
    for (const store of stores.splice(0)) {
        store.close();
    }
});

function open(percentiles?: "native" | "window"): MetricsStore {
    const store = MetricsStore.open({ path: ":memory:", ...(percentiles ? { percentiles } : {}) });
    stores.push(store);
    return store;
}

function event(value: number, dims: StoredEvent["dims"], at = T0, context?: unknown): StoredEvent {
    return { project: "shop", metric: "checkout.ms", at, value, dims, ...(context === undefined ? {} : { context }) };
}

/** Ten events: two agents, three tools, two hours, values 1 to 10. */
function seeded(percentiles?: "native" | "window"): MetricsStore {
    const store = open(percentiles);
    store.insert(
        Array.from({ length: 10 }, (_, i) =>
            event(
                i + 1,
                { agent: i < 6 ? "main" : "worker", tool: ["Bash", "Read", "Edit"][i % 3] ?? "Bash", dropped: i === 9 },
                T0 + (i < 4 ? 0 : HOUR) + i,
                { line: i }
            )
        )
    );
    return store;
}

describe("metrics store", () => {
    test("an event for an unknown project and metric creates both", () => {
        const store = seeded();
        const [entry] = store.catalog();
        expect(entry).toMatchObject({ project: "shop", metric: "checkout.ms", count: 10, dims: [], first: T0 });
        expect(store.query({ project: "shop", metric: "nope" })).toMatchObject({ known: false, rows: [] });
    });

    test("define keeps the unit, adds dims, and a declared dim's query reads its index", () => {
        const store = seeded();
        store.define({ project: "shop", metric: "checkout.ms", unit: "ms", dims: ["agent"] });
        const entry = store.define({ project: "shop", metric: "checkout.ms", dims: ["tool"] });
        expect(entry).toMatchObject({ unit: "ms", dims: ["agent", "tool"] });

        const filtered = store.plan({
            project: "shop",
            metric: "checkout.ms",
            where: [{ dim: "agent", op: "=", value: "worker" }],
        });
        expect(filtered.join("\n")).toContain("events_m1_d");
        const grouped = store.plan({ project: "shop", metric: "checkout.ms", groupBy: ["agent"], since: 0 });
        expect(grouped.join("\n")).toContain("USING INDEX events_m1_d");
        expect(grouped.join("\n")).not.toContain("TEMP B-TREE FOR GROUP BY");
        const undeclared = store.plan({
            project: "shop",
            metric: "checkout.ms",
            where: [{ dim: "dropped", op: "=", value: true }],
        });
        expect(undeclared.join("\n")).not.toContain("events_m1_d");
    });

    test("each filter operator, and since and until", () => {
        const store = seeded();
        const count = (where: Parameters<MetricsStore["query"]>[0]["where"], extra = {}) =>
            store.query({ project: "shop", metric: "checkout.ms", where, ...extra }).rows[0]?.values.count;

        expect(count([{ dim: "agent", op: "=", value: "main" }])).toBe(6);
        expect(count([{ dim: "agent", op: "!=", value: "main" }])).toBe(4);
        expect(count([{ dim: "tool", op: "in", value: ["Bash", "Edit"] }])).toBe(7);
        expect(count([{ dim: "tool", op: "glob", value: "R*" }])).toBe(3);
        expect(count([{ dim: "dropped", op: "=", value: true }])).toBe(1);
        expect(count([{ dim: "session", op: "=", value: null }])).toBe(10);
        expect(count([], { since: T0 + HOUR })).toBe(6);
        expect(count([], { until: T0 + HOUR })).toBe(4);
    });

    test("group by two dims and by the hour, sorted and limited", () => {
        const store = seeded();
        const byAgent = store.query({ project: "shop", metric: "checkout.ms", groupBy: ["agent"] });
        expect(byAgent.rows).toEqual([
            { group: { agent: "worker" }, values: { count: 4, sum: 34 } },
            { group: { agent: "main" }, values: { count: 6, sum: 21 } },
        ]);

        const two = store.query({
            project: "shop",
            metric: "checkout.ms",
            groupBy: ["agent", "tool"],
            aggregates: ["count"],
            sort: { by: "count", descending: true },
            limit: 2,
        });
        expect(two.rows).toHaveLength(2);
        expect(two.rows[0]?.values.count).toBe(2);

        const hours = store.query({
            project: "shop",
            metric: "checkout.ms",
            groupBy: ["time:hour"],
            aggregates: ["count", "min", "max", "avg"],
            sort: { by: "time:hour", descending: false },
        });
        expect(hours.rows).toEqual([
            { group: { "time:hour": T0 }, values: { count: 4, min: 1, max: 4, avg: 2.5 } },
            { group: { "time:hour": T0 + HOUR }, values: { count: 6, min: 5, max: 10, avg: 7.5 } },
        ]);
    });

    test("percentiles: the window function answers what SQLite's percentile() answers", () => {
        const window = seeded("window").query({
            project: "shop",
            metric: "checkout.ms",
            groupBy: ["agent"],
            aggregates: ["p50", "p90", "p99"],
            sort: { by: "agent", descending: false },
        });
        const rounded = (rows: typeof window.rows) =>
            rows.map((row) => Object.values(row.values).map((value) => Math.round((value ?? Number.NaN) * 1000)));
        expect(rounded(window.rows)).toEqual([
            [3500, 5500, 5950],
            [8500, 9700, 9970],
        ]);

        const native = seeded();

        // A SQLite built without percentile() (the CI runner's may be) uses the window path checked above.
        if (native.percentiles === "native") {
            const answer = native.query({
                project: "shop",
                metric: "checkout.ms",
                groupBy: ["agent"],
                aggregates: ["p50", "p90", "p99"],
                sort: { by: "agent", descending: false },
            });
            expect(rounded(answer.rows)).toEqual(rounded(window.rows));
        }
    });

    test("events answer single events with their context, newest first", () => {
        const store = seeded();
        const answer = store.events({
            project: "shop",
            metric: "checkout.ms",
            where: [{ dim: "agent", op: "=", value: "worker" }],
            limit: 2,
        });
        expect(answer.rows.map((row) => row.value)).toEqual([10, 9]);
        expect(answer.rows[0]).toMatchObject({ dims: { agent: "worker", dropped: true }, context: { line: 9 } });
    });

    test("the dim-name guard refuses a name before it reaches SQL", () => {
        const store = seeded();
        const injected = "agent') = 1 OR ('1";
        expect(() => store.query({ project: "shop", metric: "checkout.ms", groupBy: [injected] })).toThrow(
            MetricsInputError
        );
        expect(() =>
            store.query({ project: "shop", metric: "checkout.ms", where: [{ dim: injected, op: "=", value: 1 }] })
        ).toThrow(MetricsInputError);
        expect(() => store.define({ project: "shop", metric: "checkout.ms", dims: ["9lives"] })).toThrow(
            MetricsInputError
        );
        expect(checkEvent({ project: "shop", metric: "m", value: 1, dims: { [injected]: 1 } }, T0)).toMatchObject({
            ok: false,
        });
        expect(checkEvent({ project: "shop", metric: "m", value: 1, at: "2026-11-01T10:00:00Z" }, 0)).toMatchObject({
            ok: true,
            event: { at: T0 },
        });
    });

    test("prune deletes events before a time", () => {
        const store = seeded();
        expect(store.prune(T0 + HOUR)).toBe(4);
        expect(store.eventCount()).toBe(6);
    });
});
