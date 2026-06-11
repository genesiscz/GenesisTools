import type { LogEntry } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { DASH, duration, logLineText, runOutcome, startedAt } from "@/features/daemon/units";

describe("daemon units — runOutcome", () => {
    it("classifies by exit code (null = running, 0 = ok, else failed)", () => {
        expect(runOutcome({ exitCode: null })).toBe("running");
        expect(runOutcome({ exitCode: 0 })).toBe("ok");
        expect(runOutcome({ exitCode: 1 })).toBe("failed");
        expect(runOutcome({ exitCode: 137 })).toBe("failed");
    });
});

describe("daemon units — duration", () => {
    it("formats ms / s / m+s, em-dash on null", () => {
        expect(duration(940)).toBe("940ms");
        expect(duration(3200)).toBe("3.2s");
        expect(duration(64000)).toBe("1m04s");
        expect(duration(null)).toBe(DASH);
    });
});

describe("daemon units — startedAt", () => {
    it("formats a valid ISO, em-dash on null/invalid", () => {
        expect(startedAt("2026-05-30T14:05:00Z")).toMatch(/\d/);
        expect(startedAt(null)).toBe(DASH);
        expect(startedAt("nope")).toBe(DASH);
    });
});

describe("daemon units — logLineText", () => {
    it("renders meta / stdout / stderr / exit entries", () => {
        const meta: LogEntry = { type: "meta", taskName: "sync", command: "bun sync", runId: "r1", attempt: 1, startedAt: "2026-05-30T14:00:00Z" };
        const out: LogEntry = { type: "stdout", ts: "t", data: "hello\n\n" };
        const exit: LogEntry = { type: "exit", ts: "t", code: 0, duration_ms: 3200 };
        const exitTimeout: LogEntry = { type: "exit", ts: "t", code: null, duration_ms: 600000, timedOut: true };

        expect(logLineText(meta)).toContain("sync");
        expect(logLineText(meta)).toContain("bun sync");
        expect(logLineText(out)).toBe("hello");
        expect(logLineText(exit)).toContain("exit 0");
        expect(logLineText(exit)).toContain("3.2s");
        expect(logLineText(exitTimeout)).toContain("timed out");
    });
});
