import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { tryWithPathArbitration, withPathArbitrationSync } from "@genesiscz/utils/process/path-arbitration";
import * as identity from "@genesiscz/utils/process-identity";
import {
    attemptStaleTakeover,
    buildPidRecord,
    claimPidFile,
    classifyPidRecord,
    clearPidFile,
    inspectPidFile,
    ownsPidFile,
    readLivePid,
    readPidRecord,
    readSignalablePid,
    writePidFile,
    writePidFileWhenFree,
} from "./pidfile";
import { awaitStart, closeStartGate, passStartGate, releaseStartGate, startGatePath } from "./start-gate";

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
        const stranger = Bun.spawn(["sleep", "30"], { env: process.env, stdout: "ignore", stderr: "ignore" });

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

    test("a child read before its exec records no command, so the live child is not taken for a recycled pid", async () => {
        // Linux spawns by fork then exec: until the exec the child shows this process's command line, and the
        // kernel read is fast enough to see it. The start time is the same before and after the exec.
        const child = Bun.spawn(["sleep", "30"], { env: process.env, stdout: "ignore", stderr: "ignore" });
        const real = identity.readProcessCommand;
        const own = real(process.pid);
        const read = spyOn(identity, "readProcessCommand").mockImplementation((pid) =>
            pid === child.pid ? own : real(pid)
        );

        try {
            const record = buildPidRecord(child.pid);
            read.mockRestore();

            expect(own).not.toBeNull();
            expect(record.command).toBeNull();
            expect(record.startedAt).not.toBeNull();
            expect(classifyPidRecord(record).status).toBe("unverified");
        } finally {
            read.mockRestore();
            child.kill();
            await child.exited;
        }
    });

    test("a record without a command is still foreign when its start time is another process's", () => {
        const startedAt = identity.processStartMs(process.pid);

        expect(startedAt).not.toBeNull();
        expect(
            classifyPidRecord({ pid: process.pid, command: null, startedAt: (startedAt ?? 0) - 600_000, writtenAt: 0 })
                .status
        ).toBe("foreign");
    });

    test("classifyPidRecord is the same verdict inspectPidFile uses, including start-time reuse", () => {
        writePidFile(path);
        const record = readPidRecord(path);

        expect(record).not.toBeNull();

        if (!record) {
            return;
        }

        if (!record.command || record.startedAt === null) {
            return;
        }

        expect(classifyPidRecord(record).status).toBe("live");

        const recycled = { ...record, startedAt: record.startedAt - 600_000 };
        expect(classifyPidRecord(recycled).status).toBe("foreign");
    });

    test("a start time inside ps's one-second granularity is still ours", () => {
        writePidFile(path);
        const record = readPidRecord(path);

        writeFileSync(path, SafeJSON.stringify({ ...record, startedAt: (record?.startedAt ?? 0) - 900 }));

        const { status } = inspectPidFile(path);

        // The claim under test: `ps -o etime=` resolves to whole seconds, so a
        // sub-second difference must never be read as a recycled pid.
        expect(status).not.toBe("foreign");

        // "live" is the strong verdict, and it needs `ps` to have answered — it is
        // the only source of both the recorded command and the start time, and the
        // code degrades to "unverified" on purpose when it says nothing. That is
        // not hypothetical: in the 16-way parallel suite on a loaded machine the
        // spawn failed once in five full runs and this read "unverified". An empty
        // recorded command is that same failure, caught at write time.
        if (record?.command) {
            expect(status).toBe("live");
        }
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
            const stranger = Bun.spawn(["sleep", "30"], { env: process.env, stdout: "ignore", stderr: "ignore" });

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
            const stranger = Bun.spawn(["sleep", "30"], { env: process.env, stdout: "ignore", stderr: "ignore" });

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

    test("stale takeover cannot rename a fresh pidfile during claim arbitration", async () => {
        let releaseOwner: () => void = () => {};
        let ownerReady: () => void = () => {};
        const ownerStarted = new Promise<void>((resolve) => {
            ownerReady = resolve;
        });
        const ownerRelease = new Promise<void>((resolve) => {
            releaseOwner = resolve;
        });
        const owner = tryWithPathArbitration(path, async () => {
            writeFileSync(path, String(process.pid));
            ownerReady();
            await ownerRelease;
        });
        await ownerStarted;

        expect(await attemptStaleTakeover(path, String(DEAD_PID))).toBe(false);
        expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));

        releaseOwner();
        expect((await owner).acquired).toBe(true);
    });

    test("a failed arbiter release does not replace the callback's result", async () => {
        // A directory replaced by a file makes proper-lockfile's rmdir fail, so release() rejects.
        const breakArbiter = () => {
            const arbiter = `${path}.claim-arbitration.lock`;
            rmSync(arbiter, { recursive: true, force: true });
            writeFileSync(arbiter, "");
        };

        expect(
            await tryWithPathArbitration(path, async () => {
                breakArbiter();
                return "claimed";
            })
        ).toEqual({ acquired: true, value: "claimed" });

        rmSync(`${path}.claim-arbitration.lock`, { force: true });
        expect(
            withPathArbitrationSync(path, () => {
                breakArbiter();
                return "claimed";
            })
        ).toBe("claimed");
    });

    test("writePidFileWhenFree waits out brief arbiter contention, and a stuck arbiter still fails within its bound", async () => {
        const arbiter = `${path}.claim-arbitration.lock`;
        mkdirSync(arbiter);
        setTimeout(() => rmSync(arbiter, { recursive: true, force: true }), 150);

        expect((await writePidFileWhenFree(path)).pid).toBe(process.pid);

        mkdirSync(arbiter);
        const started = Date.now();
        await expect(writePidFileWhenFree(path, { waitMs: 150 })).rejects.toThrow(/already being held/);
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(() => writePidFile(path)).toThrow(/already being held/);
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

    test("claimPidFile creates a missing file and its folder, and takes over a dead, recycled, unreadable or own claim", async () => {
        const nested = join(dir, "deeper", "test.pid");
        expect(await claimPidFile(nested)).toEqual({ status: "claimed", tookOver: false });
        expect(readPidRecord(nested)?.pid).toBe(process.pid);

        const stale = [
            SafeJSON.stringify({ pid: DEAD_PID, command: "gone", writtenAt: 1 }),
            SafeJSON.stringify({ ...buildPidRecord(), command: "/usr/bin/another-program" }),
            "not a pid",
            SafeJSON.stringify(buildPidRecord()),
        ];

        for (const content of stale) {
            writeFileSync(path, content);
            expect(await claimPidFile(path)).toEqual({ status: "claimed", tookOver: true });
            expect(readPidRecord(path)?.pid).toBe(process.pid);
        }

        expect(readdirSync(dir).sort()).toEqual(["deeper", "test.pid"]);
    });

    test("claimPidFile leaves a live owner's claim, and a caller's rule can keep any other claim", async () => {
        const owner = Bun.spawn(["sleep", "30"], { env: process.env, stdout: "ignore", stderr: "ignore" });

        try {
            writePidFile(path, { pid: owner.pid });
            const before = readFileSync(path, "utf8");

            expect(await claimPidFile(path)).toMatchObject({
                status: "held",
                state: { status: "live", pid: owner.pid },
            });
            expect(readFileSync(path, "utf8")).toBe(before);
        } finally {
            owner.kill();
            await owner.exited;
        }

        writeFileSync(path, "not a pid");
        const onlyStale = (state: { status: string }) => state.status === "dead" || state.status === "foreign";

        expect(await claimPidFile(path, { reclaimable: onlyStale })).toEqual({
            status: "held",
            state: { status: "none" },
        });
        expect(readFileSync(path, "utf8")).toBe("not a pid");
    });

    test("claimPidFile is lost when every takeover round loses, and throws a write error that is not EEXIST", async () => {
        writeFileSync(path, "not a pid");
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let ready: () => void = () => {};
        const started = new Promise<void>((resolve) => {
            ready = resolve;
        });
        // Another claimer holds the path's arbiter, so each takeover round loses.
        const other = tryWithPathArbitration(path, async () => {
            ready();
            await held;
        });
        await started;

        expect(await claimPidFile(path, { attempts: 2, retryMs: 1 })).toEqual({ status: "lost" });
        expect(readFileSync(path, "utf8")).toBe("not a pid");
        release();
        await other;

        const notAFolder = join(dir, "file-not-folder");
        writeFileSync(notAFolder, "x");

        await expect(claimPidFile(join(notAFolder, "test.pid"))).rejects.toThrow();
    });
});

/**
 * A spawner that gives up and a child that starts late (`tools recorder start` after `movies.record` timed out) race
 * for one claim. The fake recorders below stand in for the child: each passes the gate when it would start recording.
 */
describe("start gate", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "start-gate-test-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    /** A fake recorder: after `arriveMs` it passes the gate, and `startMs` later its entry shows in `live`. */
    function fakeRecorder(gate: string, live: string[], opts: { arriveMs: number; startMs?: number }) {
        const seen: { turn?: string } = {};
        const done = (async () => {
            await Bun.sleep(opts.arriveMs);
            const turn = await passStartGate(gate);
            seen.turn = turn.status;

            if (turn.status === "passed" && opts.startMs !== undefined) {
                await Bun.sleep(opts.startMs);
                live.push("recording");
            }
        })();
        return { seen, done };
    }

    const timings = { timeoutMs: 80, graceMs: 120, pollMs: 5 };

    test("a recorder that starts in time is the answer and holds the gate until it ends", async () => {
        const gate = startGatePath(dir);
        const live: string[] = [];
        const stops: Array<number | null> = [];
        const child = fakeRecorder(gate, live, { arriveMs: 5, startMs: 5 });
        const outcome = await awaitStart({
            gate,
            find: () => live[0],
            stop: (pid) => {
                stops.push(pid);
            },
            ...timings,
        });
        await child.done;
        expect(outcome).toEqual({ status: "started", value: "recording", late: false });
        expect(child.seen.turn).toBe("passed");
        expect(stops).toEqual([]);
        expect(existsSync(gate)).toBe(true);
        releaseStartGate(gate);
        expect(existsSync(gate)).toBe(false);
    });

    test("a recorder that arrives after the timeout finds the start cancelled and records nothing", async () => {
        const gate = startGatePath(dir);
        const live: string[] = [];
        const child = fakeRecorder(gate, live, { arriveMs: 150, startMs: 0 });
        const outcome = await awaitStart({ gate, find: () => live[0], stop: () => {}, ...timings });
        expect(outcome).toEqual({ status: "cancelled" });
        await child.done;
        expect(child.seen.turn).toBe("cancelled");
        expect(live).toEqual([]);
        // The late recorder was the last to read the gate, so it removes it.
        expect(existsSync(gate)).toBe(false);
    });

    test("a recorder past the gate when the wait ends still reaches its owner within the grace", async () => {
        const gate = startGatePath(dir);
        const live: string[] = [];
        const child = fakeRecorder(gate, live, { arriveMs: 70, startMs: 40 });
        const outcome = await awaitStart({ gate, find: () => live[0], stop: () => {}, ...timings });
        await child.done;
        expect(outcome).toEqual({ status: "started", value: "recording", late: true });
    });

    test("a recorder past the gate that never starts is stopped by its pid", async () => {
        const gate = startGatePath(dir);
        const live: string[] = [];
        const stops: Array<number | null> = [];
        const child = fakeRecorder(gate, live, { arriveMs: 5 });
        const outcome = await awaitStart({
            gate,
            find: () => live[0],
            stop: (pid) => {
                stops.push(pid);
            },
            ...timings,
        });
        await child.done;
        // The fake recorder runs in this process, so the pid the gate holds is this one.
        expect(outcome).toEqual({ status: "stopped", pid: process.pid });
        expect(stops).toEqual([process.pid]);
    });

    test("closing first wins, and a second close or pass sees the gate taken", async () => {
        const gate = startGatePath(dir);
        expect(await closeStartGate(gate)).toEqual({ status: "cancelled" });
        expect(await passStartGate(gate)).toEqual({ status: "cancelled" });
        const other = startGatePath(dir);
        expect(await passStartGate(other)).toEqual({ status: "passed" });
        expect(await closeStartGate(other)).toEqual({ status: "passed", pid: process.pid });
    });

    test("a gate path is new each time and lives in the folder given", () => {
        const a = startGatePath(dir);
        const b = startGatePath(dir);
        expect(a).not.toBe(b);
        expect(a.startsWith(dir)).toBe(true);
    });
});
