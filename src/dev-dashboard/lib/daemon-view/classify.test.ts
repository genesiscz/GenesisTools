import { describe, expect, it } from "bun:test";
import type { LogEntry } from "@app/daemon/lib/types";
import { classifyLogLine } from "./classify";

const meta: LogEntry = {
    type: "meta",
    taskName: "sync",
    command: "bun run sync",
    runId: "r1",
    attempt: 1,
    startedAt: "2026-06-02T10:00:00Z",
};
const stdout = (data: string): LogEntry => ({ type: "stdout", ts: "2026-06-02T10:00:01Z", data });
const stderr = (data: string): LogEntry => ({ type: "stderr", ts: "2026-06-02T10:00:01Z", data });
const exitOk: LogEntry = { type: "exit", ts: "2026-06-02T10:00:09Z", code: 0, duration_ms: 8000 };
const exitFail: LogEntry = { type: "exit", ts: "2026-06-02T10:00:09Z", code: 1, duration_ms: 8000 };

describe("classifyLogLine", () => {
    it("classifies a meta header as info", () => {
        expect(classifyLogLine(meta)).toBe("info");
    });

    it("classifies any stderr line as error", () => {
        expect(classifyLogLine(stderr("boom"))).toBe("error");
    });

    it("classifies stdout containing an error keyword as error", () => {
        expect(classifyLogLine(stdout("Error: cannot find module"))).toBe("error");
        expect(classifyLogLine(stdout("Build FAILED"))).toBe("error");
        expect(classifyLogLine(stdout("  ✗ 3 tests failed"))).toBe("error");
    });

    it("classifies stdout containing a warn keyword as warn", () => {
        expect(classifyLogLine(stdout("warning: deprecated API"))).toBe("warn");
        expect(classifyLogLine(stdout("DeprecationWarning: x"))).toBe("warn");
    });

    it("classifies plain stdout as info", () => {
        expect(classifyLogLine(stdout("Compiling module foo"))).toBe("info");
    });

    it("classifies a zero-code exit as exit and a non-zero exit as error", () => {
        expect(classifyLogLine(exitOk)).toBe("exit");
        expect(classifyLogLine(exitFail)).toBe("error");
    });

    it("is case-insensitive on keyword matching", () => {
        expect(classifyLogLine(stdout("ERROR boom"))).toBe("error");
        expect(classifyLogLine(stdout("WARN: heads up"))).toBe("warn");
    });
});
