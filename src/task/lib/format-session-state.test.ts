import { describe, expect, it } from "bun:test";
import { formatSessionState } from "@app/task/lib/format-session-state";
import type { TaskSessionMeta } from "@app/task/types";

describe("formatSessionState", () => {
    it("returns unknown when meta is null (eval2 bug #3)", () => {
        expect(formatSessionState(null)).toBe("unknown");
    });

    it("returns exited with code and duration", () => {
        const meta: TaskSessionMeta = {
            name: "metro",
            command: "echo",
            mode: "pipe",
            cwd: "/tmp",
            createdAt: Date.now() - 5000,
            lastActivityAt: Date.now(),
            startedAt: new Date(Date.now() - 5000).toISOString(),
            exitCode: 42,
            durationMs: 5000,
        };

        expect(formatSessionState(meta)).toBe("exited (code 42, 5s)");
    });

    it("returns stopped with duration, never the signal's exit code", () => {
        const meta: TaskSessionMeta = {
            name: "metro",
            command: "echo",
            mode: "pipe",
            cwd: "/tmp",
            createdAt: Date.now() - 5000,
            lastActivityAt: Date.now(),
            startedAt: new Date(Date.now() - 5000).toISOString(),
            stopped: true,
            stoppedAt: new Date().toISOString(),
            durationMs: 5000,
        };

        expect(formatSessionState(meta)).toBe("stopped (5s)");
        expect(formatSessionState(meta)).not.toContain("exited");
        expect(formatSessionState(meta)).not.toContain("143");
        expect(formatSessionState(meta)).not.toContain("130");
    });

    it("returns active with running duration when no exit code", () => {
        const meta: TaskSessionMeta = {
            name: "metro",
            command: "echo",
            mode: "pipe",
            cwd: "/tmp",
            createdAt: Date.now() - 60_000,
            lastActivityAt: Date.now(),
            startedAt: new Date(Date.now() - 60_000).toISOString(),
        };

        expect(formatSessionState(meta)).toMatch(/^active \(running 1m \d+s\)$/);
    });
});
