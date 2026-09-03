import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { MonitorDatabase } from "./db";
import { isWorthNotifying, Monitor } from "./monitor";
import { allTargetsResolved } from "./notify-targets";
import { isDue, Scheduler } from "./scheduler";
import {
    DEFAULT_INTERVAL_SEC,
    DEFAULT_TIMEOUT_MS,
    type Incident,
    MASKED_HEADER_VALUE,
    type MonitorEvent,
    type Watcher,
} from "./types";

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
        // db.createWatcher used to carry its own literal 60 / 10_000, so this
        // door kept the old value when the constants moved.
        expect(created.intervalSec).toBe(DEFAULT_INTERVAL_SEC);
        expect(created.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);

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

    test("summarizeAll matches the per-watcher summary it replaced", async () => {
        // summarizeAll now issues four grouped queries instead of four per
        // watcher, so the two paths must still answer identically.
        const db = new MonitorDatabase(":memory:");
        const a = await db.createWatcher({ name: "a", kind: "website", target: "https://a.dev/" });
        const b = await db.createWatcher({ name: "b", kind: "website", target: "https://b.dev/" });
        await db.createWatcher({ name: "silent", kind: "website", target: "https://c.dev/" });

        await db.recordCheck(a.id, { status: "up", latencyMs: 100, httpStatus: 200, detail: "ok" });
        await db.recordCheck(a.id, { status: "down", latencyMs: null, httpStatus: null, detail: "boom" });
        await db.recordCheck(b.id, { status: "up", latencyMs: 300, httpStatus: 200, detail: "ok" });
        await db.startIncident(a.id, "down", "boom");

        const all = await db.summarizeAll();
        const one = await Promise.all(
            (await db.listWatchers()).map((watcher) => db.summarize(watcher as unknown as Watcher))
        );

        expect(all).toEqual(one);
        expect(all.map((summary) => summary.checks24h)).toEqual([2, 1, 0]);
        expect(all[0].openIncident?.detail).toBe("boom");
        expect(all[1].openIncident).toBeNull();
        expect(all[2].recent).toEqual([]);
        expect(all[0].recent.map((point) => point.status)).toEqual(["up", "down"]);
        db.close();
    });

    test("listWatchers only reads the subscriptions of the watchers it returns", async () => {
        const db = new MonitorDatabase(":memory:");
        const notify = await db.createTarget({ name: "ops", channel: "webhook", config: { url: "https://a.dev/h" } });
        await db.createWatcher({
            name: "paused",
            kind: "website",
            target: "https://a.dev/",
            enabled: false,
            targetIds: [notify.id],
        });
        const live = await db.createWatcher({ name: "live", kind: "website", target: "https://b.dev/" });

        const enabled = await db.listWatchers({ enabledOnly: true });

        expect(enabled.map((watcher) => watcher.id)).toEqual([live.id]);
        expect(enabled[0].targetIds).toEqual([]);
        expect((await db.listWatchers()).map((watcher) => watcher.targetIds)).toEqual([[notify.id], []]);
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
        await monitor.close();
    });

    test("close waits for an in-flight check instead of closing the database under it", async () => {
        const monitor = new Monitor({ dbPath: ":memory:" });
        const watcher = await monitor.createWatcher({ name: "slow", kind: "website", target: target() });
        // The handler sleeps, so the check is mid-flight while close() runs. Closing the client
        // there used to reject recordCheck with `database is closed` and lose the row.
        delayMs = 40;

        const running = monitor.runWatcher(watcher.id);
        await monitor.close();
        const outcome = await running;

        expect(outcome?.check.status).toBe("up");
        expect(monitor.isRunning(watcher.id)).toBe(false);
    });

    test("close refuses to start a new check", async () => {
        const monitor = new Monitor({ dbPath: ":memory:" });
        const watcher = await monitor.createWatcher({ name: "after-close", kind: "website", target: target() });

        await monitor.close();

        expect(await monitor.runWatcher(watcher.id)).toBeNull();
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
        await monitor.close();
    });

    test("overview counts paused watchers separately", async () => {
        const monitor = new Monitor({ dbPath: ":memory:" });
        await monitor.createWatcher({ name: "a", kind: "website", target: target(), enabled: false });
        await monitor.createWatcher({ name: "b", kind: "website", target: target() });
        const overview = await monitor.overview();

        expect(overview.counts).toEqual({ total: 2, up: 0, degraded: 0, down: 0, unknown: 1, paused: 1 });
        await monitor.close();
    });
});

describe("isWorthNotifying", () => {
    const incident = (status: "down" | "degraded"): Incident => ({
        id: 1,
        watcherId: 1,
        status,
        startedAt: "2026-09-03T10:00:00.000Z",
        endedAt: null,
        detail: "boom",
    });

    test("entering an outage with no open incident is announced", () => {
        expect(isWorthNotifying({ from: "up", to: "down", open: null })).toBe(true);
        expect(isWorthNotifying({ from: "unknown", to: "degraded", open: null })).toBe(true);
    });

    test("re-entering the same outage through unknown is not announced again", () => {
        // down -> unknown leaves the incident open and lastStatus "unknown", so
        // unknown -> down used to send "<name> is down" a second time. A page
        // that intermittently fails to parse paged on every re-parse.
        expect(isWorthNotifying({ from: "unknown", to: "down", open: incident("down") })).toBe(false);
        expect(isWorthNotifying({ from: "unknown", to: "degraded", open: incident("degraded") })).toBe(false);
    });

    test("escalating degraded to down is still announced", () => {
        expect(isWorthNotifying({ from: "degraded", to: "down", open: incident("degraded") })).toBe(true);
        expect(isWorthNotifying({ from: "down", to: "degraded", open: incident("down") })).toBe(true);
    });

    test("recovery is announced whenever it closes an incident", () => {
        expect(isWorthNotifying({ from: "down", to: "up", open: incident("down") })).toBe(true);
        // down -> unknown -> up: `from` is not an outage, but the incident that
        // was announced is being closed, so the user is told it is over.
        expect(isWorthNotifying({ from: "unknown", to: "up", open: incident("down") })).toBe(true);
    });

    test("unknown itself and an ordinary first up are never announced", () => {
        expect(isWorthNotifying({ from: "down", to: "unknown", open: incident("down") })).toBe(false);
        expect(isWorthNotifying({ from: "unknown", to: "up", open: null })).toBe(false);
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
        mutedUntil: null,
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

    test("a failed first check does not consume the priming run", async () => {
        // safeRunCheck records a row for a check that threw too, so counting
        // check rows made run 1 (down) the "first sync" and run 2 replayed the
        // whole feed as notifications: the exact history dump priming prevents.
        const db = new MonitorDatabase(":memory:");
        const watcher = await db.createWatcher({ name: "feed", kind: "rss", target: "https://a.dev/rss" });

        await db.recordCheck(watcher.id, { status: "down", latencyMs: null, httpStatus: 429, detail: "429" });
        expect(await db.ingestFeedItems(watcher.id, [])).toEqual({ fresh: [], first: true });

        await db.recordCheck(watcher.id, { status: "up", latencyMs: 1, httpStatus: 200, detail: "ok" });
        const second = await db.ingestFeedItems(watcher.id, [item("g1", "old"), item("g2", "older")]);

        expect(second.first).toBe(true);
        expect(second.fresh).toEqual([]);
        expect(await db.listFeedItems(watcher.id, 10)).toHaveLength(2);
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
        await monitor.close();
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
        await monitor.close();
    });
});

describe("Monitor watcher headers", () => {
    test("a patch that drops a header removes it, and the mask keeps the stored value", async () => {
        // The old rule restored every stored header the patch did not mention,
        // so deleting `Authorization` in the dashboard kept sending it forever.
        const monitor = new Monitor({ dbPath: ":memory:" });
        const created = await monitor.createWatcher({
            name: "private site",
            kind: "website",
            target: "https://a.dev/",
            notify: false,
            config: { headers: { Authorization: "Bearer secret", "X-Trace": "on" } },
        });

        const dropped = await monitor.updateWatcher(created.id, { config: { headers: { "X-Trace": "on" } } });
        expect(dropped?.config.headers).toEqual({ "X-Trace": "on" });

        // A round-trip of the masked view keeps what is stored.
        await monitor.updateWatcher(created.id, { config: { headers: { "X-Trace": MASKED_HEADER_VALUE } } });
        expect((await monitor.getWatcher(created.id))?.config.headers).toEqual({ "X-Trace": "on" });

        // A patch with no headers key at all leaves them alone.
        await monitor.updateWatcher(created.id, { config: { expectStatus: 401 } });
        expect((await monitor.getWatcher(created.id))?.config.headers).toEqual({ "X-Trace": "on" });
        await monitor.close();
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
        await monitor.close();
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
            await monitor.close();
            truncating.stop(true);
        }
    });
});

function feedXml(items: Array<{ guid: string; title: string }>): string {
    const entries = items
        .map(
            (item) =>
                `<item><guid>${item.guid}</guid><title>${item.title}</title><link>https://a.dev/${item.guid}</link></item>`
        )
        .join("");

    return `<?xml version="1.0"?><rss version="2.0"><channel><title>ops</title>${entries}</channel></rss>`;
}

describe("Monitor feed delivery", () => {
    test("an item whose webhook failed is redelivered on the next check", async () => {
        // The whole point of storing `delivered`: a webhook that answers 500
        // must not cost the user the item. Every channel reports its outcome
        // rather than throwing, so this only works while `dispatchToTarget`
        // reads the returned boolean.
        let items = [{ guid: "g1", title: "primed" }];
        const feed = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () =>
                new Response(feedXml(items), { headers: { "Content-Type": "application/rss+xml" }, status: 200 }),
        });
        let hookStatus = 500;
        const posted: string[] = [];
        const hook = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                posted.push(await request.text());

                return new Response("", { status: hookStatus });
            },
        });
        const monitor = new Monitor({ dbPath: ":memory:" });

        try {
            const notifyTarget = await monitor.createTarget({
                name: "ops webhook",
                channel: "webhook",
                config: { url: `http://127.0.0.1:${hook.port}/hook` },
            });
            const watcher = await monitor.createWatcher({
                name: "ops feed",
                kind: "rss",
                target: `http://127.0.0.1:${feed.port}/feed.xml`,
                notify: true,
                timeoutMs: 5_000,
                targetIds: [notifyTarget.id],
            });

            // Check 1 primes the history: nothing is announced.
            await monitor.runWatcher(watcher.id);
            expect(posted).toHaveLength(0);

            // Check 2 finds a new item and the webhook is down.
            items = [{ guid: "g2", title: "outage started" }, ...items];
            const failed = await monitor.runWatcher(watcher.id);

            expect(failed?.newItems.map((item) => item.guid)).toEqual(["g2"]);
            expect(posted).toHaveLength(1);
            expect((await monitor.db.listFeedItems(watcher.id, 10)).find((item) => item.guid === "g2")?.delivered).toBe(
                false
            );

            // Check 3 brings nothing new, but the endpoint is back.
            hookStatus = 200;
            const retried = await monitor.runWatcher(watcher.id);

            expect(retried?.newItems).toEqual([]);
            expect(posted).toHaveLength(2);
            expect(posted[1]).toContain("outage started");
            expect((await monitor.db.listFeedItems(watcher.id, 10)).find((item) => item.guid === "g2")?.delivered).toBe(
                true
            );
        } finally {
            await monitor.close();
            feed.stop(true);
            hook.stop(true);
        }
    });

    test("a selected target that no longer exists counts as a failed delivery", async () => {
        const monitor = new Monitor({ dbPath: ":memory:" });
        const first = await monitor.createTarget({ name: "a", channel: "webhook", config: { url: "https://a.dev/h" } });
        const targets = await monitor.listTargets();

        expect(allTargetsResolved([first.id], targets)).toBe(true);
        expect(allTargetsResolved([first.id, first.id + 99], targets)).toBe(false);
        await monitor.close();
    });
});

describe("Scheduler.tick", () => {
    test("launches at most `concurrency` checks and skips a tick already running", async () => {
        delayMs = 300;
        const monitor = new Monitor({ dbPath: ":memory:" });
        const scheduler = new Scheduler(monitor, { concurrency: 2 });

        try {
            for (const name of ["a", "b", "c", "d"]) {
                await monitor.createWatcher({ name, kind: "website", target: target(), notify: false });
            }

            // Both calls start before the first one awaits the database, so the
            // second must see the guard and launch nothing.
            const [firstTick, reentrant] = await Promise.all([scheduler.tick(), scheduler.tick()]);

            expect(firstTick).toBe(2);
            expect(reentrant).toBe(0);
            expect(scheduler.activeRuns).toBe(2);

            // No free slot while those two are in flight.
            expect(await scheduler.tick()).toBe(0);

            await scheduler.drain();
            expect(scheduler.activeRuns).toBe(0);

            // The two that never got a slot are still due.
            expect(await scheduler.tick()).toBe(2);
            await scheduler.drain();
            expect(await scheduler.tick()).toBe(0);
        } finally {
            scheduler.stop();
            await monitor.close();
        }
    });
});
