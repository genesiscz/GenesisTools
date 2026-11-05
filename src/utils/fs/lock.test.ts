import { FFIType } from "bun:ffi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSystemLibrary } from "@genesiscz/utils/bun/compiler";
import { flockState } from "./flock";
import { acquireLock, getLockHolderPid, isLocked, type LockHandle } from "./lock";

let tempDir: string;
let handles: LockHandle[] = [];

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lock-test-"));
    handles = [];
});

afterEach(async () => {
    for (const handle of handles) {
        await handle.release();
    }

    handles = [];

    try {
        rmSync(tempDir, { recursive: true, force: true });
    } catch {
        // best effort
    }
});

describe("acquireLock", () => {
    test("succeeds on unlocked file", async () => {
        const lockPath = join(tempDir, "test.lock");
        const handle = await acquireLock(lockPath);
        handles.push(handle);
        expect(handle).toBeTruthy();
    });

    test("throws ELOCKED when already locked", async () => {
        const lockPath = join(tempDir, "test.lock");
        const handle1 = await acquireLock(lockPath);
        handles.push(handle1);

        try {
            const handle2 = await acquireLock(lockPath);
            handles.push(handle2);
            throw new Error("Expected acquireLock to throw ELOCKED");
        } catch (err) {
            expect((err as NodeJS.ErrnoException).code).toBe("ELOCKED");
        }
    });

    test("release frees the lock for subsequent acquire", async () => {
        const lockPath = join(tempDir, "test.lock");
        const handle1 = await acquireLock(lockPath);
        await handle1.release();

        const handle2 = await acquireLock(lockPath);
        handles.push(handle2);
        expect(handle2).toBeTruthy();
    });

    test("release is idempotent", async () => {
        const lockPath = join(tempDir, "test.lock");
        const handle = await acquireLock(lockPath);

        // Double release should not throw
        await handle.release();
        await handle.release();
    });
});

describe("isLocked", () => {
    test("returns true while lock is held", async () => {
        const lockPath = join(tempDir, "test.lock");
        const handle = await acquireLock(lockPath);
        handles.push(handle);

        const locked = await isLocked(lockPath);
        expect(locked).toBe(true);
    });

    test("returns false after release", async () => {
        const lockPath = join(tempDir, "test.lock");
        const handle = await acquireLock(lockPath);
        await handle.release();

        const locked = await isLocked(lockPath);
        expect(locked).toBe(false);
    });

    test("returns false for non-existent file", async () => {
        const lockPath = join(tempDir, "nonexistent.lock");
        const locked = await isLocked(lockPath);
        expect(locked).toBe(false);
    });
});

describe("getLockHolderPid", () => {
    test("returns process.pid while lock is held", async () => {
        const lockPath = join(tempDir, "test.lock");
        const handle = await acquireLock(lockPath);
        handles.push(handle);

        const pid = await getLockHolderPid(lockPath);
        expect(pid).toBe(process.pid);
    });

    test("returns null after release", async () => {
        const lockPath = join(tempDir, "test.lock");
        const handle = await acquireLock(lockPath);
        await handle.release();

        const pid = await getLockHolderPid(lockPath);
        expect(pid).toBe(null);
    });
});

describe("flockState", () => {
    // The holder side as a GenesisKit SingleInstance face does it: an exclusive flock kept on its own descriptor.
    const holder = defineSystemLibrary({
        path: "/usr/lib/libSystem.B.dylib",
        platforms: ["darwin"],
        symbols: { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
    });

    test.if(process.platform === "darwin")(
        "reads held while another descriptor holds the lock, free once it lets go",
        () => {
            const lockPath = join(tempDir, "recorder.lock");
            expect(flockState(lockPath)).toBe("free");
            writeFileSync(lockPath, `${process.pid}\n`);
            const calls = holder();
            expect(calls).not.toBeNull();
            const fd = openSync(lockPath, "r+");

            try {
                expect(calls?.flock(fd, 2 | 4)).toBe(0);
                expect(flockState(lockPath)).toBe("held");
                calls?.flock(fd, 8);
                expect(flockState(lockPath)).toBe("free");
            } finally {
                closeSync(fd);
            }
        }
    );
});
