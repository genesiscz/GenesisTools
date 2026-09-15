import { describe, expect, it, spyOn } from "bun:test";
import { classifyPid, processStartMs, readProcessCommand } from "@genesiscz/utils/process-identity";

/** Above macOS/Linux pid ceilings, so `kill(pid, 0)` is guaranteed ESRCH. */
const NEVER_ALLOCATED_PID = 4_194_304;

describe("readProcessCommand", () => {
    it("reads our own command line", () => {
        const command = readProcessCommand(process.pid);

        expect(command).not.toBeNull();
        expect(command).toContain("bun");
    });

    it("returns null for a dead pid", () => {
        expect(readProcessCommand(NEVER_ALLOCATED_PID)).toBeNull();
    });
});

describe("classifyPid", () => {
    it("reports dead for a never-allocated pid", () => {
        expect(classifyPid(NEVER_ALLOCATED_PID, "anything")).toEqual({
            status: "dead",
            pid: NEVER_ALLOCATED_PID,
        });
    });

    it("reports unverified when no expectation was recorded", () => {
        expect(classifyPid(process.pid)).toEqual({ status: "unverified", pid: process.pid });
    });

    it("reports live when the recorded command matches exactly", () => {
        const command = readProcessCommand(process.pid);

        if (command === null) {
            // Windows / no-ps environment: classifyPid degrades to unverified.
            expect(classifyPid(process.pid, "whatever").status).toBe("unverified");
            return;
        }

        expect(classifyPid(process.pid, command).status).toBe("live");
    });

    it("reports foreign when the recorded command mismatches (pid reuse)", () => {
        const state = classifyPid(process.pid, "/usr/bin/definitely-not-this-process --serve");

        expect(state.status).toBe("foreign");
        expect(state.command).toBeDefined();
    });

    it("supports predicate expectations", () => {
        expect(classifyPid(process.pid, (command) => command.includes("bun")).status).toBe("live");
        expect(classifyPid(process.pid, () => false).status).toBe("foreign");
    });

    it("reports dead for invalid pids", () => {
        expect(classifyPid(0).status).toBe("dead");
        expect(classifyPid(-5).status).toBe("dead");
    });
});

describe("own-pid lookups are read once per process", () => {
    // Regression for the spawn storm behind CI run 35003930205: `buildPidRecord()` asked `ps`
    // for the current process's command AND start time on every lock acquire, 143 spawns per
    // run of src/scripts/lib/journal.test.ts. Both values are constants for the process
    // lifetime. The spy sits on the primitive that spends the resource, and the foreign-pid
    // arm is the negative control proving the spy sees spawns and the cache is own-pid only.
    it("readProcessCommand and processStartMs spawn `ps` at most once for process.pid", () => {
        const spawnSync = spyOn(Bun, "spawnSync");

        try {
            readProcessCommand(process.pid);
            processStartMs(process.pid);
            const warm = spawnSync.mock.calls.length;

            for (let i = 0; i < 10; i++) {
                expect(readProcessCommand(process.pid)).not.toBeNull();
                expect(processStartMs(process.pid)).not.toBeNull();
            }

            expect(spawnSync.mock.calls.length).toBe(warm);

            // Negative control: a live pid that is not ours is still looked up every time.
            const before = spawnSync.mock.calls.length;
            readProcessCommand(process.ppid);
            readProcessCommand(process.ppid);
            expect(spawnSync.mock.calls.length).toBe(before + 2);
        } finally {
            spawnSync.mockRestore();
        }
    });
});
