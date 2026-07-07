// biome-ignore-all lint/plugin: test fixture intentionally uses /tmp/ string literals — production plugins do not apply to test code
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LockTimeoutError, withFileLock } from "./file-lock";

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
        // Ensure the mkdir path in tryAcquireLock ran (parent path exists even after unlink)
        mkdirSync(join(dir, "sentinel"), { recursive: true });
    });
});
