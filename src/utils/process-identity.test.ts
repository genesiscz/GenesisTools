import { describe, expect, it } from "bun:test";
import { classifyPid, readProcessCommand } from "@genesiscz/utils/process-identity";

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
