// biome-ignore-all lint/plugin: test fixture intentionally uses /tmp/ string literals — production plugins do not apply to test code
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attemptRenameSteal, LockTimeoutError, tryAcquireLock, withFileLock } from "./file-lock";

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

    it("times out when a live process holds the lock", async () => {
        const lockPath = join(dir, "target.lock");
        writeFileSync(lockPath, String(process.pid));

        await expect(withFileLock(lockPath, async () => "unreached", 200)).rejects.toBeInstanceOf(LockTimeoutError);

        expect(existsSync(lockPath)).toBe(true);
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

    it("exactly one of N concurrent racers steals a stale lock (rename-based takeover regression test)", async () => {
        // Regression test for the Jul 3 incident: launchd respawn storm got 31
        // daemon instances racing the same stale pidfile/lock past a
        // check-then-unlink-then-write takeover, and N of them "won". The
        // rename-based steal must guarantee exactly one winner no matter how
        // many racers hit it concurrently.
        const lockPath = join(dir, "target.lock");
        writeFileSync(lockPath, "999999999"); // dead PID — eligible for steal

        const RACER_COUNT = 12;
        const results = await Promise.all(Array.from({ length: RACER_COUNT }, () => tryAcquireLock(lockPath)));

        const winners = results.filter((won) => won === true);
        expect(winners).toHaveLength(1);

        // Exactly one lock file remains, owned by us (the single process all
        // racers ran in), and no leftover `.stale-*` temp files.
        expect(existsSync(lockPath)).toBe(true);
        expect(readFileSync(lockPath, "utf-8").trim()).toBe(String(process.pid));

        expect(readdirSync(dir)).toEqual(["target.lock"]);
    });

    it("a steal that grabs a FRESH lock restores it and loses (TOCTOU guard)", async () => {
        // The stealer validated "999999999" as dead, but by the time its
        // rename lands a live holder has re-acquired the lock. The steal must
        // detect the content mismatch, restore the fresh lock, and lose.
        const lockPath = join(dir, "target.lock");
        writeFileSync(lockPath, "12345");

        const won = await attemptRenameSteal(lockPath, "999999999");

        expect(won).toBe(false);
        expect(readFileSync(lockPath, "utf-8").trim()).toBe("12345"); // restored, not clobbered
        expect(readdirSync(dir)).toEqual(["target.lock"]); // no temp litter
    });
});
