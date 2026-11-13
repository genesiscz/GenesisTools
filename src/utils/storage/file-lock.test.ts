// biome-ignore-all lint/plugin: test fixture intentionally uses /tmp/ string literals — production plugins do not apply to test code
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_HOLDER_GRACE_MS, serializePidRecord } from "@genesiscz/utils/process/pidfile";
import { LockTimeoutError, withFileLock, withQueuedFileLock } from "./file-lock";

// The race cases (N racers, a fresh claim during arbitration, a steal that finds new bytes) are in
// src/utils/process/claim-takeover.test.ts, with every other caller of the shared takeover.
describe("file-lock: stale/orphaned lock handling", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "file-lock-test-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("acquires a fresh lock and releases it", async () => {
        const lockPath = join(dir, "target.lock");

        const result = await withFileLock(lockPath, async () => "ok", 1000);

        expect(result).toBe("ok");
        expect(existsSync(lockPath)).toBe(false);
    });

    it("steals a 0-byte orphaned lock (owner killed between open and write)", async () => {
        // Simulate the real-world bug: writeFile("wx") created the lock file
        // but the process was SIGKILL'd before writing its PID. A 0-byte lock
        // then blocks every future acquirer.
        const lockPath = join(dir, "target.lock");
        writeFileSync(lockPath, "");
        // Past the shared grace an empty lock is an orphan (claim-takeover.test.ts covers one inside it).
        const created = new Date(Date.now() - EMPTY_HOLDER_GRACE_MS - 1_000);
        utimesSync(lockPath, created, created);

        const result = await withFileLock(lockPath, async () => "acquired", 2000);

        expect(result).toBe("acquired");
        expect(existsSync(lockPath)).toBe(false);
    });

    it("steals a lock owned by a dead PID", async () => {
        const lockPath = join(dir, "target.lock");
        writeFileSync(lockPath, "999999999");

        const result = await withFileLock(lockPath, async () => "acquired", 2000);

        expect(result).toBe("acquired");
        expect(existsSync(lockPath)).toBe(false);
    });

    it("steals a lock whose pid was recycled onto this process from a foreign command", async () => {
        // The own-pid shortcut this replaces treated record.pid === process.pid as
        // "held forever". A recycled number that happens to be ours is the case
        // classifyPidRecord is supposed to catch (foreign command / old start time).
        const lockPath = join(dir, "target.lock");
        writeFileSync(
            lockPath,
            serializePidRecord({
                pid: process.pid,
                command: "/usr/bin/definitely-not-this-process --serve",
                startedAt: Date.now() - 600_000,
                writtenAt: 1,
            })
        );

        const result = await withFileLock(lockPath, async () => "acquired", 2000);

        expect(result).toBe("acquired");
        expect(existsSync(lockPath)).toBe(false);
    });

    it("times out when a live process holds the lock", async () => {
        const lockPath = join(dir, "target.lock");
        writeFileSync(lockPath, String(process.pid));

        await expect(withFileLock(lockPath, async () => "unreached", 200)).rejects.toBeInstanceOf(LockTimeoutError);

        expect(existsSync(lockPath)).toBe(true);
    });

    it("an aborted signal ends a long wait at once, and the locked work never starts", async () => {
        const lockPath = join(dir, "target.lock");
        writeFileSync(lockPath, String(process.pid));
        const controller = new AbortController();
        let ran = false;
        const started = Date.now();
        const waiting = withFileLock(
            lockPath,
            async () => {
                ran = true;
            },
            { timeoutMs: 30_000, signal: controller.signal }
        );

        setTimeout(() => controller.abort(new Error("widget closed")), 100);

        await expect(waiting).rejects.toThrow("widget closed");
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(ran).toBe(false);
        expect(existsSync(lockPath)).toBe(true);
    });

    it("a lock taken after its caller gave up is released without running the work", async () => {
        const lockPath = join(dir, "target.lock");
        const controller = new AbortController();
        controller.abort(new Error("gone"));
        let ran = false;

        await expect(
            withFileLock(
                lockPath,
                async () => {
                    ran = true;
                },
                { signal: controller.signal }
            )
        ).rejects.toThrow("gone");
        expect(ran).toBe(false);
        expect(existsSync(lockPath)).toBe(false);
    });

    it("provides mutual exclusion under contention within one process", async () => {
        const lockPath = join(dir, "target.lock");
        let inFlight = 0;
        let maxInFlight = 0;

        const critical = async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 20));
            inFlight -= 1;
            return "ok";
        };

        const results = await Promise.all([
            withFileLock(lockPath, critical, 5000),
            withFileLock(lockPath, critical, 5000),
            withFileLock(lockPath, critical, 5000),
        ]);

        expect(results).toEqual(["ok", "ok", "ok"]);
        expect(maxInFlight).toBe(1);
        expect(existsSync(lockPath)).toBe(false);
    });

    it("creates the parent directory when missing", async () => {
        const nestedDir = join(dir, "nested", "deep");
        const lockPath = join(nestedDir, "target.lock");

        expect(existsSync(nestedDir)).toBe(false);

        const result = await withFileLock(lockPath, async () => "ok", 2000);

        expect(result).toBe("ok");
        // The parent dir was created and persists — only the lock file itself is cleaned up.
        expect(existsSync(nestedDir)).toBe(true);
    });

    it("a release that cannot read the lock never replaces fn's result", async () => {
        const lockPath = join(dir, "target.lock");

        const result = await withFileLock(lockPath, async () => {
            // Unreadable at release time (EISDIR); the old release threw from `finally`.
            rmSync(lockPath, { force: true });
            mkdirSync(lockPath);
            return "committed";
        });

        expect(result).toBe("committed");
    });
});

describe("file-lock: the arrival-order queue", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "file-lock-queue-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("a caller that takes the lock again at once cannot keep a waiting caller from its turn", async () => {
        const lockPath = join(dir, "vision.lock");
        const order: string[] = [];
        let firstTurn: () => void = () => undefined;
        const holding = new Promise<void>((resolve) => {
            firstTurn = resolve;
        });
        const scan = (async () => {
            for (let frame = 0; frame < 30; frame++) {
                await withQueuedFileLock(
                    lockPath,
                    async () => {
                        order.push("scan");
                        firstTurn();
                        await Bun.sleep(10);
                    },
                    5000
                );
            }
        })();
        await holding;
        await withQueuedFileLock(lockPath, async () => order.push("read"), 5000);
        await scan;

        expect(order.indexOf("read")).toBeLessThanOrEqual(2);
        expect(readdirSync(`${lockPath}.queue`)).toEqual([]);
    });

    it("a ticket of a dead process or one past its deadline does not hold up the queue", async () => {
        const lockPath = join(dir, "vision.lock");
        mkdirSync(`${lockPath}.queue`, { recursive: true });
        writeFileSync(
            join(`${lockPath}.queue`, "000000000000001-000000001-2147483000"),
            `{"pid":2147483000,"at":${Date.now()},"until":9e15}`
        );
        writeFileSync(
            join(`${lockPath}.queue`, "000000000000002-000000001-1"),
            `{"pid":${process.pid},"at":${Date.now()},"until":${Date.now() - 120_000}}`
        );
        writeFileSync(join(`${lockPath}.queue`, "000000000000003-000000001-1"), "not a ticket");

        expect(await withQueuedFileLock(lockPath, async () => "served", 1000)).toBe("served");
        expect(readdirSync(`${lockPath}.queue`)).toEqual([]);
    });

    it("a live older ticket makes a caller wait, and its timeout is a LockTimeoutError", async () => {
        const lockPath = join(dir, "vision.lock");
        mkdirSync(`${lockPath}.queue`, { recursive: true });
        writeFileSync(
            join(`${lockPath}.queue`, "000000000000001-000000001-1"),
            `{"pid":${process.pid},"at":${Date.now()},"until":${Date.now() + 60_000}}`
        );

        await expect(withQueuedFileLock(lockPath, async () => "never", 300)).rejects.toBeInstanceOf(LockTimeoutError);
        expect(readdirSync(`${lockPath}.queue`)).toEqual(["000000000000001-000000001-1"]);
    });
});
