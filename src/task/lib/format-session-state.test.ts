import { describe, expect, it } from "bun:test";
import type { TaskSessionMeta } from "../types";
import { formatSessionState } from "./format-session-state";

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
            exitCode: 42,
            durationMs: 5000,
        };

        expect(formatSessionState(meta)).toBe("exited (code 42, 5s)");
    });

    it("returns active with running duration when no exit code", () => {
        const meta: TaskSessionMeta = {
            name: "metro",
            command: "echo",
            mode: "pipe",
            cwd: "/tmp",
            createdAt: Date.now() - 60_000,
            lastActivityAt: Date.now(),
        };

        expect(formatSessionState(meta)).toMatch(/^active \(running 1m \d+s\)$/);
    });
});
