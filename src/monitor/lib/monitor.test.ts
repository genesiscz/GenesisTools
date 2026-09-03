import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { MonitorDatabase } from "./db";
import { Monitor } from "./monitor";
import { isDue } from "./scheduler";
import { MASKED_HEADER_VALUE, type MonitorEvent, type Watcher } from "./types";

let server: ReturnType<typeof Bun.serve>;
let statusCode = 200;
let delayMs = 0;

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch() {
            if (delayMs > 0) {
                await Bun.sleep(delayMs);
            }

            return new Response("hello world", { status: statusCode });
        },
    });
});

afterAll(() => {
    server.stop(true);
});

beforeEach(() => {
    statusCode = 200;
    delayMs = 0;
});

function target(): string {
    return `http://127.0.0.1:${server.port}/`;
}

describe("MonitorDatabase", () => {
    test("creates, updates, lists and deletes watchers", async () => {
        const db = new MonitorDatabase(":memory:");
        const created = await db.createWatcher({ name: "a", kind: "website", target: "https://a.dev/" });

        expect(created.id).toBe(1);
        expect(created.lastStatus).toBe("unknown");
        expect(created.enabled).toBe(true);

        const updated = await db.updateWatcher(1, { enabled: false, config: { expectStatus: 401 } });
        expect(updated?.enabled).toBe(false);
        expect(updated?.config).toEqual({ expectStatus: 401 });
        expect(await db.listWatchers({ enabledOnly: true })).toHaveLength(0);
        expect(await db.listWatchers()).toHaveLength(1);
        expect(await db.deleteWatcher(1)).toBe(true);
        expect(await db.deleteWatcher(1)).toBe(false);
        db.close();
    });

    test("recordCheck denormalizes last_* and summarize computes uptime", async () => {
        const db = new MonitorDatabase(":memory:");
        const watcher = await db.createWatcher({ name: "a", kind: "website", target: "https://a.dev/" });

        await db.recordCheck(watcher.id, { status: "up", latencyMs: 100, httpStatus: 200, detail: "ok" });
        await db.recordCheck(watcher.id, { status: "down", latencyMs: null, httpStatus: null, detail: "boom" });
        await db.recordCheck(watcher.id, { status: "up", latencyMs: 300, httpStatus: 200, detail: "ok" });

        const summary = await db.summarize((await db.getWatcher(watcher.id)) as Watcher);
        expect(summary.lastStatus).toBe("up");
        expect(summary.lastLatencyMs).toBe(300);
        expect(summary.checks24h).toBe(3);
        expect(summary.uptime24h).toBeCloseTo(2 / 3);
        expect(summary.avgLatency24h).toBe(200);
        expect(summary.recent.map((point) => point.status)).toEqual(["up", "down", "up"]);
        expect(await db.listChecks(watcher.id, { limit: 2 })).toHaveLength(2);
        db.close();
    });

    test("deleting a watcher cascades to checks and incidents", async () => {
        const db = new MonitorDatabase(":memory:");
        const watcher = await db.createWatcher({ name: "a", kind: "website", target: "https://a.dev/" });
        await db.recordCheck(watcher.id, { status: "down", latencyMs: null, httpStatus: null, detail: "x" });
        await db.startIncident(watcher.id, "down", "x");
        await db.deleteWatcher(watcher.id);

        expect(await db.listIncidents()).toHaveLength(0);
        expect(await db.listChecks(watcher.id)).toHaveLength(0);
        db.close();
    });
});

describe("Monitor transitions", () => {
    test("opens an incident on down, keeps it through unknown, closes it on up, emits events", async () => {
        const monitor = new Monitor({ dbPath: ":memory:" });
        const events: MonitorEvent["type"][] = [];
        monitor.on((event) => {
            events.push(event.type);
        });
        const watcher = await monitor.createWatcher({
            name: "local",
            kind: "website",
            target: target(),
            notify: false,
            timeoutMs: 2_000,
        });

        statusCode = 200;
        const first = await monitor.runWatcher(watcher.id);
        expect(first?.check.status).toBe("up");
        expect(first?.transition).toEqual({ from: "unknown", to: "up", incident: null });

        statusCode = 503;
        const second = await monitor.runWatcher(watcher.id);
        expect(second?.check.status).toBe("down");
        expect(second?.transition?.incident?.status).toBe("down");
        expect(second?.transition?.incident?.endedAt).toBeNull();

        const third = await monitor.runWatcher(watcher.id);
        expect(third?.transition).toBeNull();
        expect(await monitor.db.listIncidents({ openOnly: true })).toHaveLength(1);

        statusCode = 200;
        const fourth = await monitor.runWatcher(watcher.id);
        expect(fourth?.transition?.to).toBe("up");
        expect(fourth?.transition?.incident?.endedAt).not.toBeNull();
        expect(await monitor.db.listIncidents({ openOnly: true })).toHaveLength(0);

        expect(events).toEqual([
            "watcher:created",
            "watcher:checked",
            "watcher:state",
            "watcher:checked",
            "watcher:state",
            "watcher:checked",
            "watcher:checked",
            "watcher:state",
        ]);
        monitor.close();
    });

    test("latency above degradedAboveMs is degraded and expected status is honoured", async () => {
        const monitor = new Monitor({ dbPath: ":memory:" });
        const watcher = await monitor.createWatcher({
            name: "slow",
            kind: "website",
            target: target(),
            notify: false,
            config: { degradedAboveMs: 20, expectStatus: 503 },
        });

        statusCode = 503;
        delayMs = 60;
        const outcome = await monitor.runWatcher(watcher.id);
        delayMs = 0;

        expect(outcome?.check.status).toBe("degraded");
        expect(outcome?.check.httpStatus).toBe(503);
        expect(outcome?.check.detail).toContain("slower than 20 ms");
        monitor.close();
    });

    test("overview counts paused watchers separately", async () => {
        const monitor = new Monitor({ dbPath: ":memory:" });
        await monitor.createWatcher({ name: "a", kind: "website", target: target(), enabled: false });
        await monitor.createWatcher({ name: "b", kind: "website", target: target() });
        const overview = await monitor.overview();

        expect(overview.counts).toEqual({ total: 2, up: 0, degraded: 0, down: 0, unknown: 1, paused: 1 });
        monitor.close();
    });
});

describe("Scheduler.isDue", () => {
    const base: Watcher = {
        id: 1,
        name: "x",
        kind: "website",
        target: "https://x.dev/",
        config: {},
        intervalSec: 60,
        timeoutMs: 1000,
        enabled: true,
        notify: true,
        createdAt: "2026-09-03T10:00:00.000Z",
        updatedAt: "2026-09-03T10:00:00.000Z",
        lastStatus: "up",
        lastCheckedAt: "2026-09-03T10:00:00.000Z",
        lastLatencyMs: 1,
        lastDetail: null,
        targetIds: [],
    };
    const at = Date.parse("2026-09-03T10:00:00.000Z");

    test("never checked is due", () => {
        expect(isDue({ ...base, lastCheckedAt: null }, at)).toBe(true);
    });

    test("due exactly at the interval, not before", () => {
        expect(isDue(base, at + 59_000)).toBe(false);
        expect(isDue(base, at + 60_000)).toBe(true);
    });
});

describe("MonitorDatabase notify targets", () => {
    test("setWatcherTargets survives a list where every id is unknown", async () => {
        const db = new MonitorDatabase(":memory:");
        const target = await db.createTarget({ name: "ops", channel: "webhook", config: { url: "https://a.dev/h" } });
        const watcher = await db.createWatcher({
            name: "a",
            kind: "website",
            target: "https://a.dev/",
            targetIds: [target.id],
        });

        expect((await db.getWatcher(watcher.id))?.targetIds).toEqual([target.id]);

        // Kysely renders `values([])` as invalid SQL; this used to throw and
        // leave the watcher with no targets and the caller with a 500.
        const updated = await db.updateWatcher(watcher.id, { targetIds: [999] });

        expect(updated?.targetIds).toEqual([]);
        db.close();
    });
});

describe("MonitorDatabase feed items", () => {
    const item = (guid: string, title: string) => ({
        guid,
        title,
        link: null,
        summary: null,
        publishedAt: null,
    });

    test("a first check that ingests nothing does not re-prime on the next one", async () => {
        const db = new MonitorDatabase(":memory:");
        const watcher = await db.createWatcher({ name: "feed", kind: "rss", target: "https://a.dev/rss" });

        // Check 1: the item filter matched nothing, so no row is written.
        await db.recordCheck(watcher.id, { status: "up", latencyMs: 1, httpStatus: 200, detail: "ok" });
        expect(await db.ingestFeedItems(watcher.id, [])).toEqual({ fresh: [], first: true });

        // Check 2, days later: the first matching item must be delivered, not
        // swallowed as history by a second "first sync".
        await db.recordCheck(watcher.id, { status: "up", latencyMs: 1, httpStatus: 200, detail: "ok" });
        const second = await db.ingestFeedItems(watcher.id, [item("g1", "release 1.0")]);

        expect(second.first).toBe(false);
        expect(second.fresh.map((entry) => entry.guid)).toEqual(["g1"]);
        db.close();
    });

    test("the very first check still primes silently", async () => {
        const db = new MonitorDatabase(":memory:");
        const watcher = await db.createWatcher({ name: "feed", kind: "rss", target: "https://a.dev/rss" });

        await db.recordCheck(watcher.id, { status: "up", latencyMs: 1, httpStatus: 200, detail: "ok" });
        const first = await db.ingestFeedItems(watcher.id, [item("g1", "old"), item("g2", "older")]);

        expect(first.first).toBe(true);
        expect(first.fresh).toEqual([]);
        expect(await db.listFeedItems(watcher.id, 10)).toHaveLength(2);
        db.close();
    });
});

describe("Monitor notify target secrets", () => {
    test("a config patch that omits botToken keeps the stored one", async () => {
        const monitor = new Monitor({ dbPath: ":memory:" });
        const created = await monitor.createTarget({
            name: "family",
            channel: "telegram",
            config: { botToken: "123:AAA", chatId: "-100" },
        });

        const updated = await monitor.updateTarget(created.id, { config: { chatId: "-200" } });

        expect(updated?.config).toEqual({ botToken: "123:AAA", chatId: "-200" });
        monitor.close();
    });

    test("an explicit new botToken still replaces the stored one", async () => {
        const monitor = new Monitor({ dbPath: ":memory:" });
        const created = await monitor.createTarget({
            name: "family",
            channel: "telegram",
            config: { botToken: "123:AAA", chatId: "-100" },
        });

        const updated = await monitor.updateTarget(created.id, { config: { botToken: "456:BBB", chatId: "-100" } });

        expect(updated?.config.botToken).toBe("456:BBB");
        monitor.close();
    });
});

describe("Monitor event payloads", () => {
    test("a watcher event masks config.headers while the stored watcher keeps them", async () => {
        // The event stream leaves this process over a WebSocket that no route
        // handler sees, so an `Authorization` header set on a website watcher
        // would otherwise reach every listener verbatim.
        const monitor = new Monitor({ dbPath: ":memory:" });
        const events: MonitorEvent[] = [];
        monitor.on((event) => {
            events.push(event);
        });

        const created = await monitor.createWatcher({
            name: "private site",
            kind: "website",
            target: target(),
            notify: false,
            config: { headers: { Authorization: "Bearer super-secret" } },
        });

        const [event] = events;
        expect(event.type).toBe("watcher:created");
        expect("watcher" in event ? event.watcher.config.headers : null).toEqual({
            Authorization: MASKED_HEADER_VALUE,
        });
        expect(SafeJSON.stringify(events)).not.toContain("super-secret");

        // The check itself must still send the real header.
        expect((await monitor.getWatcher(created.id))?.config.headers).toEqual({
            Authorization: "Bearer super-secret",
        });
        monitor.close();
    });
});

describe("Monitor.runWatcher", () => {
    test("a check that throws still records a row, so the watcher is not due again at once", async () => {
        // `checkRss` reads `await response.text()` outside its own try/catch. A
        // body that ends early rejects there, and unrecorded the watcher keeps
        // `last_checked_at` null: `isDue` stays true and the 1 s scheduler tick
        // re-runs it forever while the card sits on "unknown" with no error.
        const truncating = Bun.listen({
            hostname: "127.0.0.1",
            port: 0,
            socket: {
                data(socket) {
                    // Content-Length promises 4096 bytes; the socket closes after 14.
                    socket.write(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: 4096\r\nConnection: close\r\n\r\n<rss><channel>"
                    );
                    setTimeout(() => socket.end(), 10);
                },
            },
        });
        const monitor = new Monitor({ dbPath: ":memory:" });

        try {
            const watcher = await monitor.createWatcher({
                name: "truncated feed",
                kind: "rss",
                target: `http://127.0.0.1:${truncating.port}/feed.xml`,
                notify: false,
                timeoutMs: 2_000,
            });
            const outcome = await monitor.runWatcher(watcher.id);

            expect(outcome?.check.status).toBe("unknown");
            expect(outcome?.check.detail).toStartWith("check failed:");

            const stored = (await monitor.getWatcher(watcher.id)) as Watcher;
            expect(stored.lastCheckedAt).not.toBeNull();
            expect(isDue(stored, Date.now())).toBe(false);
        } finally {
            monitor.close();
            truncating.stop(true);
        }
    });
});
