import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    clearPidFile,
    inspectPidFile,
    ownsPidFile,
    readLivePid,
    readPidRecord,
    readSignalablePid,
    writePidFile,
} from "./pidfile";

/** A pid the kernel will never have handed out — the "owner is gone" case. */
const DEAD_PID = 999999999;

describe("pidfile", () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "pidfile-test-"));
        path = join(dir, "test.pid");
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("writes a record carrying the owner's identity, not a bare number", () => {
        const record = writePidFile(path);

        expect(record.pid).toBe(process.pid);
        expect(record.command ?? "").toContain("bun");
        expect(record.writtenAt).toBeGreaterThan(0);

        // The on-disk shape must be the record, since a bare number is exactly
        // what makes a pidfile unverifiable.
        const onDisk = SafeJSON.parse(readFileSync(path, "utf-8")) as { pid: number; command: string | null };
        expect(onDisk.pid).toBe(process.pid);
        expect(onDisk.command).toEqual(record.command);
    });

    test("our own live pidfile classifies as live", () => {
        writePidFile(path);

        const state = inspectPidFile(path);
        expect(state.status).toBe("live");
        expect(readLivePid(path)).toBe(process.pid);
        expect(readSignalablePid(path)).toBe(process.pid);
    });

    test("a recycled pid classifies as foreign, not live", async () => {
        // The incident, reproduced: the recorded owner is gone and the kernel
        // handed its number to an unrelated program. The pid is alive; the
        // identity does not match.
        const stranger = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });

        try {
            writeFileSync(
                path,
                SafeJSON.stringify({ pid: stranger.pid, command: "/opt/genesis/daemon serve", writtenAt: 1 })
            );

            const state = inspectPidFile(path);
            expect(state.status).toBe("foreign");
            expect(readLivePid(path)).toBeNull();
            expect(readSignalablePid(path)).toBeNull();
        } finally {
            stranger.kill();
            await stranger.exited;
        }
    });

    test("a pid recycled onto a process with the SAME command still reads as foreign", () => {
        // The gap a command-line comparison cannot close: a second copy launched
        // exactly the same way. Its start time differs, and that is what decides.
        writePidFile(path);
        const record = readPidRecord(path);

        writeFileSync(path, SafeJSON.stringify({ ...record, startedAt: (record?.startedAt ?? Date.now()) - 600_000 }));

        expect(inspectPidFile(path).status).toBe("foreign");
        expect(readSignalablePid(path)).toBeNull();
    });

    test("a start time inside ps's one-second granularity is still ours", () => {
        writePidFile(path);
        const record = readPidRecord(path);

        writeFileSync(path, SafeJSON.stringify({ ...record, startedAt: (record?.startedAt ?? 0) - 900 }));

        expect(inspectPidFile(path).status).toBe("live");
    });

    test("a departed owner classifies as dead", () => {
        writeFileSync(path, SafeJSON.stringify({ pid: DEAD_PID, command: "whatever", writtenAt: 1 }));

        expect(inspectPidFile(path).status).toBe("dead");
        expect(readLivePid(path)).toBeNull();
        expect(readSignalablePid(path)).toBeNull();
    });

    test("no pidfile reads as none rather than throwing", () => {
        expect(inspectPidFile(path).status).toBe("none");
        expect(readPidRecord(path)).toBeNull();
        expect(readLivePid(path)).toBeNull();
    });

    describe("legacy bare-number pidfiles", () => {
        test("are still readable, and the caller's expectation supplies the missing identity", async () => {
            const stranger = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });

            try {
                writeFileSync(path, String(stranger.pid));

                expect(readPidRecord(path)).toEqual({
                    pid: stranger.pid,
                    command: null,
                    startedAt: null,
                    writtenAt: 0,
                });

                // With an expectation, a recycled pid is still caught.
                const judged = inspectPidFile(path, { expected: (command) => command.includes("genesis-daemon") });
                expect(judged.status).toBe("foreign");
            } finally {
                stranger.kill();
                await stranger.exited;
            }
        });

        test("without an expectation the verdict is unverified, and the two readers disagree on purpose", async () => {
            const stranger = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });

            try {
                writeFileSync(path, String(stranger.pid));

                expect(inspectPidFile(path).status).toBe("unverified");
                // "don't start a second copy" treats unknown identity as ours…
                expect(readLivePid(path)).toBe(stranger.pid);
                // …but nothing may be SIGNALLED on an unproven identity.
                expect(readSignalablePid(path)).toBeNull();
            } finally {
                stranger.kill();
                await stranger.exited;
            }
        });
    });

    test("exclusive write refuses to clobber an existing claim", () => {
        writePidFile(path, { exclusive: true });

        expect(() => writePidFile(path, { exclusive: true })).toThrow();
    });

    test("clearPidFile only removes a file we still own, unless forced", () => {
        writePidFile(path);
        expect(ownsPidFile(path)).toBe(true);

        // A usurper took the slot — our cleanup must not delete their claim.
        writeFileSync(path, SafeJSON.stringify({ pid: DEAD_PID, command: "someone else", writtenAt: 1 }));
        expect(ownsPidFile(path)).toBe(false);
        expect(clearPidFile(path)).toBe(false);
        expect(existsSync(path)).toBe(true);

        expect(clearPidFile(path, { force: true })).toBe(true);
        expect(existsSync(path)).toBe(false);
        expect(clearPidFile(path)).toBe(false);
    });
});
