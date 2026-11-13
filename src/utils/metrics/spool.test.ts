import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatLocalDate } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { createMetricsRecorder } from "./client";
import { checkpointSpoolLine, drainSpool, spoolLine } from "./spool";
import { MetricsStore } from "./store";

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const stores: MetricsStore[] = [];

afterEach(() => {
    for (const store of stores.splice(0)) {
        store.close();
    }
});

function setup(): { dir: string; store: MetricsStore } {
    const store = MetricsStore.open({ path: ":memory:" });
    stores.push(store);
    return { dir: mkdtempSync(join(tmpdir(), "metrics-spool-")), store };
}

const line = (value: number) =>
    spoolLine({ project: "shop", metric: "cart.items", at: NOW, value, dims: { kind: "a" } });
const total = (store: MetricsStore) =>
    store.query({ project: "shop", metric: "cart.items", aggregates: ["count", "sum"] }).rows[0]?.values;

describe("metrics spool", () => {
    test("a define line declares the metric's dims, and a define line with a bad name is one bad line", () => {
        const { dir, store } = setup();
        const define = (dims: string[]) =>
            `${SafeJSON.stringify({ v: 1, define: { project: "shop", metric: "cart.items", unit: "count", dims } })}\n`;
        writeFileSync(
            join(dir, `writer-${formatLocalDate(new Date(NOW))}.jsonl`),
            `${define(["kind"])}${line(4)}${define(["no good"])}`
        );

        expect(drainSpool(store, { dir, now: NOW })).toMatchObject({ lines: 3, events: 1, bad: 1 });
        expect(store.catalog()[0]).toMatchObject({ metric: "cart.items", unit: "count", dims: ["kind"], count: 1 });
    });

    test("a checkpoint line marks a checkpoint, a repeat updates it, and a bad one is one bad line", () => {
        const { dir, store } = setup();
        writeFileSync(
            join(dir, `writer-${formatLocalDate(new Date(NOW))}.jsonl`),
            `${checkpointSpoolLine({ project: "shop", name: "v1", at: NOW - 1_000, commit: "abc1234" })}${line(4)}${checkpointSpoolLine({ project: "shop", name: "v1", note: "cache on" })}${checkpointSpoolLine({ project: "shop", name: "no good" })}`
        );

        expect(drainSpool(store, { dir, now: NOW })).toMatchObject({ lines: 4, events: 1, checkpoints: 2, bad: 1 });
        expect(store.checkpoints("shop")).toEqual([
            { project: "shop", name: "v1", at: NOW - 1_000, commit: "abc1234", note: "cache on" },
        ]);
        const grouped = store.query({ project: "shop", metric: "cart.items", groupBy: ["checkpoint"] });
        expect(grouped.rows.map((row) => [row.group.checkpoint, row.values.count])).toEqual([["v1", 1]]);
    });

    test("a partial last line waits for its end, and a second drain adds nothing", () => {
        const { dir, store } = setup();
        const path = join(dir, `writer-${formatLocalDate(new Date(NOW))}.jsonl`);
        const third = line(3);
        writeFileSync(path, `${line(1)}${line(2)}${third.slice(0, 20)}`);

        expect(drainSpool(store, { dir, now: NOW })).toMatchObject({ lines: 2, events: 2, bad: 0 });
        expect(total(store)).toEqual({ count: 2, sum: 3 });
        expect(drainSpool(store, { dir, now: NOW })).toMatchObject({ lines: 0, events: 0 });

        appendFileSync(path, third.slice(20));
        expect(drainSpool(store, { dir, now: NOW })).toMatchObject({ lines: 1, events: 1 });
        expect(drainSpool(store, { dir, now: NOW }).events).toBe(0);
        expect(total(store)).toEqual({ count: 3, sum: 6 });
        expect(existsSync(path)).toBe(true);
    });

    test("a bad line is skipped and counted; the lines around it are kept", () => {
        const { dir, store } = setup();
        const wrongVersion = `${SafeJSON.stringify({ v: 9, project: "shop", metric: "cart.items", value: 1 }, { strict: true })}\n`;
        const badDim = spoolLine({ project: "shop", metric: "cart.items", value: 1, dims: { "no way": 1 } });
        writeFileSync(
            join(dir, `writer-${formatLocalDate(new Date(NOW))}.jsonl`),
            `${line(1)}{not json\n${wrongVersion}${badDim}\n${line(4)}`
        );

        expect(drainSpool(store, { dir, now: NOW })).toMatchObject({ lines: 6, events: 2, bad: 3 });
        expect(total(store)).toEqual({ count: 2, sum: 5 });
    });

    test("a finished file of an earlier day is removed, an unfinished one stays until its tail is stale", () => {
        const { dir, store } = setup();
        const yesterday = formatLocalDate(new Date(NOW - 86_400_000));
        const done = join(dir, `writer-${yesterday}.jsonl`);
        const torn = join(dir, `other-${yesterday}.jsonl`);
        writeFileSync(done, line(1));
        writeFileSync(torn, `${line(2)}{"v":1,"proj`);
        const fresh = new Date(NOW - 60_000);
        utimesSync(torn, fresh, fresh);

        const first = drainSpool(store, { dir, now: NOW });
        expect(first.removed).toEqual([done]);
        expect(existsSync(done)).toBe(false);
        expect(existsSync(torn)).toBe(true);
        expect(store.spoolFiles().map((file) => file.path)).toEqual([torn]);

        const old = new Date(NOW - 3_600_000);
        utimesSync(torn, old, old);
        const second = drainSpool(store, { dir, now: NOW });
        expect(second).toMatchObject({ bad: 1, removed: [torn] });
        expect(total(store)).toEqual({ count: 2, sum: 3 });
    });

    test("record() buffers lines and writes them on flush; the drain takes them in", () => {
        const { dir, store } = setup();
        const recorder = createMetricsRecorder({ writer: "unit", dir, flushMs: 60_000 });
        recorder.record("shop", "cart.items", 5, { kind: "b" }, { note: "first" });
        recorder.record("shop", "cart.items", 7);
        expect(drainSpool(store, { dir }).events).toBe(0);

        recorder.flush();
        expect(drainSpool(store, { dir }).events).toBe(2);
        expect(store.events({ project: "shop", metric: "cart.items" }).rows.map((row) => row.context)).toEqual([
            undefined,
            { note: "first" },
        ]);
    });
});
