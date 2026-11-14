import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLiveServiceEntry } from "@genesiscz/utils/rpc/service-host";
import type { MetricsEventNotification } from "./protocol";
import { startMetricsService } from "./service";
import { MetricsServiceClient } from "./service-client";
import { appendSpoolLines, spoolLine } from "./spool";

const closing: Array<() => void> = [];

afterEach(() => {
    for (const close of closing.splice(0).reverse()) {
        close();
    }
});

async function started() {
    const root = mkdtempSync(join(tmpdir(), "mx-"));
    const dir = join(root, "service");
    const spool = join(root, "spool");
    const start = await startMetricsService({
        dir,
        dbPath: join(root, "metrics.db"),
        spoolDir: spool,
        idleMs: 0,
        watch: false,
        drainEveryMs: 0,
        code: "0123456789ab",
    });

    if (start.status !== "started") {
        throw new Error("the test service did not start");
    }

    closing.push(() => start.service.stop("test end"));
    const entry = readLiveServiceEntry(dir);

    if (!entry) {
        throw new Error("the test service wrote no service.json");
    }

    const client = await MetricsServiceClient.connect(entry);
    closing.push(() => client.close());
    return { client, spool };
}

describe("metrics service", () => {
    test("ingest, query, events and one tail notification over the socket", async () => {
        const { client, spool } = await started();
        const heard: MetricsEventNotification[] = [];
        const first = Promise.withResolvers<void>();
        await client.subscribe({ project: "shop" }, (event) => {
            heard.push(event);
            first.resolve();
        });

        const ingested = await client.call("ingest", {
            events: [
                { project: "shop", metric: "cart.items", value: 2, dims: { agent: "main" }, context: { note: "a" } },
                { project: "shop", metric: "cart.items", value: 5, dims: { agent: "worker" } },
                { project: "other", metric: "cart.items", value: 1 },
                { project: "shop", metric: "cart.items", value: "three" },
            ],
        });
        expect(ingested).toMatchObject({ accepted: 3, rejected: 1, reasons: [{ index: 3 }] });

        await Promise.race([first.promise, Bun.sleep(2_000)]);
        expect(heard[0]).toMatchObject({ project: "shop", value: 2, door: "rpc", context: { note: "a" } });

        // A spool line written while the service runs is in the next answer: a query drains first.
        appendSpoolLines({
            dir: spool,
            writer: "unit",
            lines: [
                spoolLine({
                    project: "shop",
                    metric: "cart.items",
                    at: Date.now(),
                    value: 10,
                    dims: { agent: "main" },
                }),
            ],
        });
        const query = await client.call("query", {
            project: "shop",
            metric: "cart.items",
            groupBy: ["agent"],
            caller: { tool: "test", pid: process.pid },
        });
        expect(query.rows).toEqual([
            { group: { agent: "main" }, values: { count: 2, sum: 12 } },
            { group: { agent: "worker" }, values: { count: 1, sum: 5 } },
        ]);

        const events = await client.call("events", { project: "shop", metric: "cart.items", limit: 1 });
        expect(events.rows[0]).toMatchObject({ value: 10, dims: { agent: "main" } });

        const own = await client.call("query", { project: "metrics", metric: "ingest.events", groupBy: ["door"] });
        expect(own.rows.map((row) => row.group.door).sort()).toEqual(["rpc", "spool"]);

        await expect(
            client.call("query", { project: "shop", metric: "cart.items", groupBy: ["no way"] })
        ).rejects.toThrow(/dim name/);
    });

    test("checkpoints: add, list and remove, a labelled tail, and a query grouped by checkpoint", async () => {
        const { client } = await started();
        const now = Date.now();
        const heard: MetricsEventNotification[] = [];
        const plain: MetricsEventNotification[] = [];
        const both = Promise.withResolvers<void>();
        await client.subscribe({ project: "shop", withCheckpoint: true }, (event) => {
            heard.push(event);

            if (heard.length === 2) {
                both.resolve();
            }
        });
        const other = await MetricsServiceClient.connect(client.entry);
        closing.push(() => other.close());
        await other.subscribe({ project: "shop" }, (event) => plain.push(event));

        const added = await client.call("checkpoint.add", {
            project: "shop",
            name: "v1",
            at: now - 60_000,
            commit: "abc",
        });
        expect(added).toEqual({ project: "shop", name: "v1", at: now - 60_000, commit: "abc" });
        await client.call("ingest", {
            events: [
                { project: "shop", metric: "cart.items", value: 1, at: now - 120_000 },
                { project: "shop", metric: "cart.items", value: 2, at: now },
            ],
        });
        await Promise.race([both.promise, Bun.sleep(2_000)]);
        expect(heard.map((event) => event.checkpoint)).toEqual(["(before v1)", "v1"]);
        expect(plain.map((event) => event.checkpoint)).toEqual([undefined, undefined]);

        const grouped = await client.call("query", {
            project: "shop",
            metric: "cart.items",
            groupBy: ["checkpoint"],
            sort: { by: "checkpoint", descending: false },
        });
        expect(grouped.rows.map((row) => [row.group.checkpoint, row.values.sum, row.span !== undefined])).toEqual([
            ["(before v1)", 1, true],
            ["v1", 2, true],
        ]);
        expect(await client.call("checkpoint.list", { project: "shop" })).toEqual([added]);
        expect(await client.call("checkpoint.remove", { project: "shop", name: "v1" })).toEqual({ removed: true });
        expect(await client.call("checkpoint.list", {})).toEqual([]);
        await expect(client.call("checkpoint.add", { project: "shop", name: "no good" })).rejects.toThrow(
            /checkpoint name not allowed/
        );
    });

    test("an import batch writes its offset with its events; a repeat of the same lines adds nothing", async () => {
        const { client } = await started();
        const batch = {
            events: [{ project: "shop", metric: "imported", value: 1, at: 1_000 }],
            cursor: { path: "/fixture/old.jsonl", start: 0, end: 40, lines: 1 },
        };
        expect(await client.call("ingest", batch)).toMatchObject({ accepted: 1 });
        expect(await client.call("ingest", batch)).toMatchObject({ accepted: 0, cursorMismatch: { stored: 40 } });

        const status = await client.call("status", {});
        expect(status.spool.files).toEqual([
            expect.objectContaining({ path: "/fixture/old.jsonl", offset: 40, lines: 1 }),
        ]);
        expect((await client.call("catalog", {})).find((entry) => entry.metric === "imported")?.count).toBe(1);
    });

    test("an import cursor that does not move forward is refused, so it cannot be sent again and again", async () => {
        const { client } = await started();
        const event = { project: "shop", metric: "imported", value: 1, at: 1_000 };

        for (const cursor of [
            { path: "/fixture/a.jsonl", start: 0, end: 0, lines: 1 },
            { path: "/fixture/a.jsonl", start: 40, end: 10, lines: 1 },
        ]) {
            await expect(client.call("ingest", { events: [event], cursor })).rejects.toThrow("cursor.end");
        }

        expect((await client.call("catalog", {})).find((entry) => entry.metric === "imported")).toBeUndefined();
    });

    test("prune drains the spool first, so an old event still in it does not come back after the prune", async () => {
        const { client, spool } = await started();
        appendSpoolLines({
            dir: spool,
            writer: "unit",
            lines: [spoolLine({ project: "shop", metric: "old.metric", value: 1, at: 1_000 })],
        });

        expect(await client.call("prune", { before: 2_000 })).toEqual({ removed: 1 });
        await client.call("drain", {});
        expect((await client.call("catalog", {})).find((entry) => entry.metric === "old.metric")?.count ?? 0).toBe(0);
    });

    test("the stop function of a subscription ends it on the service too", async () => {
        const { client } = await started();
        const heard: MetricsEventNotification[] = [];
        const stop = await client.subscribe({ project: "shop" }, (event) => heard.push(event));

        stop();
        // The unsubscribe goes out before this call, and a connection answers in order.
        await client.call("status", {});
        const raw: unknown[] = [];
        client.socket.onNotification((notification) => raw.push(notification));
        await client.call("ingest", { events: [{ project: "shop", metric: "cart.items", value: 1 }] });
        await client.call("status", {});

        expect(heard).toEqual([]);
        expect(raw).toEqual([]);
    });
});
