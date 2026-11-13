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

describe("metrics checkpoints", () => {
    const query = (store: MetricsStore, extra: Partial<Parameters<MetricsStore["query"]>[0]>) =>
        store.query({
            project: "shop",
            metric: "checkout.ms",
            sort: { by: "checkpoint", descending: false },
            ...extra,
        });

    /** The seeded events (four at T0, six an hour later) with v1 between them, half an hour after T0. */
    function marked(percentiles?: "native" | "window"): MetricsStore {
        const store = seeded(percentiles);
        store.addCheckpoint({ project: "shop", name: "v1", at: T0 + HOUR / 2, commit: "abc1234", note: "cache on" });
        return store;
    }

    test("a checkpoint is added, updated by name with the fields given, listed and removed", () => {
        const store = open();
        const added = store.addCheckpoint({ project: "shop", name: "v1", commit: "abc1234", data: { pr: 7 } }, T0);
        expect(added).toEqual({ project: "shop", name: "v1", at: T0, commit: "abc1234", data: { pr: 7 } });

        const noted = store.addCheckpoint({ project: "shop", name: "v1", note: "cache on" }, T0 + HOUR);
        expect(noted).toEqual({ ...added, note: "cache on" });
        expect(store.addCheckpoint({ project: "shop", name: "v1", at: T0 + 5 }).at).toBe(T0 + 5);

        store.addCheckpoint({ project: "side", name: "v0", at: T0 - HOUR });
        expect(store.checkpoints().map((each) => `${each.project}/${each.name}`)).toEqual(["shop/v1", "side/v0"]);
        expect(store.checkpoints("shop")).toHaveLength(1);
        expect(() => store.addCheckpoint({ project: "shop", name: "no good" })).toThrow(MetricsInputError);
        expect(store.removeCheckpoint("shop", "v1")).toBe(true);
        expect(store.removeCheckpoint("shop", "v1")).toBe(false);
    });

    test("group by checkpoint: each event under the latest checkpoint at or before it, else before the first", () => {
        expect(
            query(seeded(), { groupBy: ["checkpoint"] }).rows.map((row) => [row.group.checkpoint, row.values])
        ).toEqual([["(none)", { count: 10, sum: 55 }]]);

        const store = marked();
        const rows = query(store, { groupBy: ["checkpoint"], since: T0, until: T0 + 2 * HOUR }).rows;
        expect(rows.map((row) => [row.group.checkpoint, row.values])).toEqual([
            ["(before v1)", { count: 4, sum: 10 }],
            ["v1", { count: 6, sum: 45 }],
        ]);
        // Half an hour before v1 and an hour and a half after it: the same events per hour read as different rates.
        expect(rows[0]?.span).toEqual({ from: T0, to: T0 + HOUR / 2, days: 1 / 48 });
        expect(rows[0]?.perDay).toEqual({ count: 192, sum: 480 });
        expect(rows[1]?.span).toEqual({ from: T0 + HOUR / 2, to: T0 + 2 * HOUR, days: 1 / 16 });
        expect(rows[1]?.perDay).toEqual({ count: 96, sum: 720 });

        const mixed = query(store, {
            groupBy: ["agent", "checkpoint"],
            where: [{ dim: "agent", op: "=", value: "main" }],
        });
        expect(mixed.rows.map((row) => [row.group.checkpoint, row.values.count])).toEqual([
            ["(before v1)", 4],
            ["v1", 2],
        ]);
        expect(mixed.rows[0]?.span).toBeUndefined();

        // Grouped by checkpoint (and time buckets) the spans are read as time ranges: no sort of the whole metric.
        expect(
            store.plan({ project: "shop", metric: "checkout.ms", groupBy: ["checkpoint"] }).join("\n")
        ).not.toContain("TEMP B-TREE FOR GROUP BY");
        const hourly = query(store, {
            groupBy: ["checkpoint", "time:hour"],
            where: [{ dim: "agent", op: "=", value: "main" }],
        });
        expect(hourly.rows.map((row) => [row.group.checkpoint, row.group["time:hour"], row.values.count])).toEqual([
            ["(before v1)", T0, 4],
            ["v1", T0 + HOUR, 2],
        ]);

        const windowed = query(marked("window"), { groupBy: ["checkpoint"], aggregates: ["count", "p50"] });
        expect(windowed.rows.map((row) => [row.group.checkpoint, row.values])).toEqual([
            ["(before v1)", { count: 4, p50: 2.5 }],
            ["v1", { count: 6, p50: 7.5 }],
        ]);
    });

    test("where checkpoint, since and until checkpoint, and events labelled with their checkpoint", () => {
        const store = marked();
        store.addCheckpoint({ project: "shop", name: "v2", at: T0 + HOUR + 6 });
        const count = (extra: Partial<Parameters<MetricsStore["query"]>[0]>) =>
            store.query({ project: "shop", metric: "checkout.ms", ...extra }).rows[0]?.values.count;

        expect(count({ where: [{ dim: "checkpoint", op: "=", value: "v1" }] })).toBe(2);
        expect(count({ where: [{ dim: "checkpoint", op: "=", value: "v2" }] })).toBe(4);
        expect(count({ where: [{ dim: "checkpoint", op: "=", value: "(before v1)" }] })).toBe(4);
        expect(count({ where: [{ dim: "checkpoint", op: "!=", value: "v2" }] })).toBe(6);
        expect(count({ where: [{ dim: "checkpoint", op: "in", value: ["v1", "v2"] }] })).toBe(6);
        expect(() => count({ where: [{ dim: "checkpoint", op: "=", value: "v9" }] })).toThrow(/no such checkpoint/);
        expect(count({ sinceCheckpoint: "v1" })).toBe(6);
        expect(count({ sinceCheckpoint: "v1", untilCheckpoint: "v2" })).toBe(2);
        expect(count({ untilCheckpoint: "v1" })).toBe(4);
        expect(() => count({ sinceCheckpoint: "v9" })).toThrow(/no such checkpoint in project shop/);

        const events = store.events({ project: "shop", metric: "checkout.ms", limit: 20, withCheckpoint: true });
        expect(events.rows.map((row) => row.checkpoint)).toEqual([
            ...Array(4).fill("v2"),
            ...Array(2).fill("v1"),
            ...Array(4).fill("(before v1)"),
        ]);
        expect(store.events({ project: "shop", metric: "checkout.ms", limit: 1 }).rows[0]?.checkpoint).toBeUndefined();
    });
});

describe("a spool chunk in one transaction", () => {
    test("a chunk that fails leaves none of its definitions, and the next write gets a metric id that exists", () => {
        const store = MetricsStore.open({ path: ":memory:" });

        try {
            const cursor = { path: "/fixture/writer-2026-11-11.jsonl", offset: 10, lines: 1 };
            expect(() =>
                store.ingest({
                    definitions: [{ project: "shop", metric: "rolled.back", dims: ["kind"] }],
                    checkpoints: [{ project: "shop", name: "no good" }],
                    events: [],
                    cursor,
                    now: 1_000,
                })
            ).toThrow();
            expect(store.catalog()).toEqual([]);
            expect(store.spoolFile(cursor.path)).toBeUndefined();

            store.insert([{ project: "shop", metric: "rolled.back", at: 1_000, value: 4, dims: {} }]);
            expect(store.catalog()).toEqual([
                expect.objectContaining({ project: "shop", metric: "rolled.back", count: 1 }),
            ]);
        } finally {
            store.close();
        }
    });

    test("a chunk's checkpoint and events commit with its offset, and define answers its own metric's counts", () => {
        const store = MetricsStore.open({ path: ":memory:" });

        try {
            store.insert([{ project: "shop", metric: "other", at: 500, value: 1, dims: {} }]);
            store.ingest({
                definitions: [{ project: "shop", metric: "cart.items", unit: "count", dims: ["kind"] }],
                checkpoints: [{ project: "shop", name: "v1", at: 900 }],
                events: [{ project: "shop", metric: "cart.items", at: 1_000, value: 2, dims: { kind: "a" } }],
                cursor: { path: "/fixture/writer-2026-11-11.jsonl", offset: 10, lines: 1 },
                now: 1_000,
            });

            expect(store.checkpoints("shop").map((checkpoint) => checkpoint.name)).toEqual(["v1"]);
            expect(store.spoolFile("/fixture/writer-2026-11-11.jsonl")?.offset).toBe(10);
            expect(store.define({ project: "shop", metric: "cart.items" })).toMatchObject({
                metric: "cart.items",
                unit: "count",
                dims: ["kind"],
                count: 1,
                first: 1_000,
                last: 1_000,
            });
            expect(store.plan({ project: "shop", metric: "cart.items", groupBy: ["kind"] }).join(" ")).toContain(
                "events_m"
            );
        } finally {
            store.close();
        }
    });
});
