import { describe, expect, it } from "bun:test";
import { fakeDriver } from "./fake";
import { isWatchDriverId, WATCH_DRIVER_IDS, WATCH_DRIVERS } from "./registry";

describe("watch driver registry", () => {
    it("names every driver by its table key and loads none at import", () => {
        expect([...WATCH_DRIVER_IDS]).toEqual(["watchman", "parcel"]);
        expect(isWatchDriverId("watchman")).toBe(true);
        expect(isWatchDriverId("toString")).toBe(false);
        expect(isWatchDriverId("fsmonitor")).toBe(false);
    });

    it("every driver states its facts and answers available() without opening a root", async () => {
        for (const id of WATCH_DRIVER_IDS) {
            const driver = await WATCH_DRIVERS[id].load();
            expect(typeof driver.facts.outlivesProcess).toBe("boolean");
            expect(["daemon-cookie", "own-cookie"]).toContain(driver.facts.fence);
            const available = await driver.available();
            expect(typeof available.ok).toBe("boolean");
            await driver.dispose();
        }
    });
});

describe("the driver contract on the fake", () => {
    const root = "/repo";

    it("a null boundary gives a clock only, and a later boundary gives every change after it", async () => {
        const driver = fakeDriver();
        const opened = await driver.open({ root, gitDir: "/repo/.git" });
        expect(opened.ok).toBe(true);

        if (!opened.ok) {
            return;
        }

        const first = await opened.watched.changesSince(null, { fenceMs: 50 });
        expect(first.kind === "changes" && first.changes).toEqual([]);
        driver.emit(root, [{ path: "a.txt", exists: true }]);
        driver.emit(root, [{ path: "b.txt", exists: false }]);
        const clock = first.kind === "changes" ? first.clock : null;
        const second = await opened.watched.changesSince(clock, { fenceMs: 50 });
        expect(second.kind === "changes" && second.changes).toEqual([
            { path: "a.txt", exists: true },
            { path: "b.txt", exists: false },
        ]);
        const third = await opened.watched.changesSince(second.kind === "changes" ? second.clock : null, {
            fenceMs: 50,
        });
        expect(third.kind === "changes" && third.changes).toEqual([]);
    });

    it("a loss is reported once, and a fresh instance refuses an older clock", async () => {
        const driver = fakeDriver();
        const opened = await driver.open({ root, gitDir: "/repo/.git" });

        if (!opened.ok) {
            throw new Error("fake open failed");
        }

        const start = await opened.watched.changesSince(null, { fenceMs: 50 });
        const clock = start.kind === "changes" ? start.clock : "";
        driver.lose(root, "overflow");
        expect(await opened.watched.changesSince(clock, { fenceMs: 50 })).toEqual({ kind: "lost", reason: "overflow" });
        driver.lose(root, "fresh-instance");
        expect((await opened.watched.changesSince(clock, { fenceMs: 50 })).kind).toBe("lost");
        const after = await opened.watched.changesSince(clock, { fenceMs: 50 });
        expect(after.kind === "lost" && after.reason).toBe("fresh-instance");
        expect(opened.watched.instance).toBe("fake-2");
    });

    it("a held fence times out at fenceMs, and a released one answers", async () => {
        const driver = fakeDriver();
        const opened = await driver.open({ root, gitDir: "/repo/.git" });

        if (!opened.ok) {
            throw new Error("fake open failed");
        }

        const release = driver.hold(root);
        const timedOut = await opened.watched.changesSince(null, { fenceMs: 10 });
        expect(timedOut).toEqual({ kind: "lost", reason: "fence-timeout" });
        const pending = opened.watched.changesSince(null, { fenceMs: 5_000 });
        release();
        expect((await pending).kind).toBe("changes");
        await opened.watched.close();
        expect(await opened.watched.changesSince(null, { fenceMs: 10 })).toEqual({ kind: "lost", reason: "closed" });
    });
});
