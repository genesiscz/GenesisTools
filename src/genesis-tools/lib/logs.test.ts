import { describe, expect, it } from "bun:test";
import type { FailureCaller, ToolFailure } from "@genesiscz/utils/cli/failures/record";
import { matchesDayLog, parseDayLogLine, prefilterFor } from "./day-log";
import { groupFailures, matchesFailure, usageGaps } from "./failures";
import { parseProfileLine } from "./profile-log";
import { daysIn, resolveWindow } from "./window";

const NOW = new Date(2026, 9, 22, 16, 0);

function caller(model: string | null, sessionId: string | null): FailureCaller {
    return {
        agent: sessionId ? "claude-code" : "unknown",
        sessionId,
        sessionTitle: null,
        model,
        effort: null,
        aiAgent: null,
        project: "app",
        repoRoot: "/repo",
        branch: "main",
        commitSha: null,
        worktreePath: null,
    };
}

function failure(overrides: Partial<ToolFailure>): ToolFailure {
    return {
        v: 1,
        id: "x",
        at: NOW.toISOString(),
        kind: "usage",
        tool: "git",
        command: "git base",
        argv: ["base", "--repo", "."],
        exitCode: 1,
        message: "error: unknown option '--repo'",
        errorName: null,
        stack: null,
        stderrTail: null,
        fatal: true,
        durationMs: 100,
        pid: 1,
        ppid: 0,
        cwd: "/repo",
        traceId: null,
        toolsRoot: "/repo",
        caller: caller("claude-sonnet-5-5", "s-111"),
        ...overrides,
    };
}

describe("window", () => {
    it("reads relative and clock times and lists every day it touches", () => {
        const window = resolveWindow({ since: "2d", now: NOW });
        expect(window.from).toEqual(new Date(2026, 9, 20, 16, 0));
        expect(daysIn(window)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
        expect(resolveWindow({ since: "09:30", now: NOW }).from).toEqual(new Date(2026, 9, 22, 9, 30));
        expect(() => resolveWindow({ since: "soon", now: NOW })).toThrow("--since soon is not a time");
    });
});

describe("failure filters and groups", () => {
    const rows = [
        failure({ id: "a" }),
        failure({ id: "b", caller: caller("claude-haiku-5-5", "s-222") }),
        failure({ id: "c", kind: "interrupt", exitCode: 130, message: null }),
        failure({
            id: "d",
            kind: "error",
            tool: "ts",
            command: "ts skeleton",
            argv: ["skeleton", "src"],
            message: "boom",
            caller: caller(null, null),
        }),
    ];

    it("leaves interrupts out unless asked and matches model by substring", () => {
        expect(rows.filter((row) => matchesFailure(row, {})).map((row) => row.id)).toEqual(["a", "b", "d"]);
        expect(rows.filter((row) => matchesFailure(row, { interrupts: true })).length).toBe(4);
        expect(rows.filter((row) => matchesFailure(row, { model: "HAIKU" })).map((row) => row.id)).toEqual(["b"]);
        expect(rows.filter((row) => matchesFailure(row, { agent: "unknown" })).map((row) => row.id)).toEqual(["d"]);
        expect(rows.filter((row) => matchesFailure(row, { grep: "--repo" })).map((row) => row.id)).toEqual(["a", "b"]);
    });

    it("counts groups and the sessions and models in each", () => {
        const groups = groupFailures(rows.slice(0, 2).concat(rows[3]), ["tool", "kind"]);
        expect(groups.map((group) => [group.key, group.count, group.sessions, group.models])).toEqual([
            [["git", "usage"], 2, 2, ["claude-sonnet-5-5", "claude-haiku-5-5"]],
            [["ts", "error"], 1, 0, []],
        ]);
    });

    it("groups refused command lines by what was refused, with examples", () => {
        expect(usageGaps(rows)).toEqual([
            {
                tool: "git",
                command: "git base",
                message: "error: unknown option '--repo'",
                count: 2,
                models: ["claude-haiku-5-5", "claude-sonnet-5-5"],
                examples: ["tools git base --repo ."],
            },
        ]);
    });
});

describe("day log", () => {
    const line = '{"level":50,"time":"2026-10-22T13:00:00.000Z","pid":42,"tool":"ai","msg":"[cmux] command failed"}';
    const window = { from: new Date("2026-10-22T12:00:00Z"), to: new Date("2026-10-22T14:00:00Z") };

    it("parses a pino line and filters by level, tool, pid and text", () => {
        const entry = parseDayLogLine(line);
        expect(entry && [entry.level, entry.pid, entry.tool, entry.msg]).toEqual([
            50,
            42,
            "ai",
            "[cmux] command failed",
        ]);
        if (!entry) {
            return;
        }

        expect(matchesDayLog(entry, { window, minLevel: 40, tool: "ai", pid: 42, grep: "CMUX" }, line)).toBe(true);
        expect(matchesDayLog(entry, { window, minLevel: 60 }, line)).toBe(false);
        expect(matchesDayLog(entry, { window: { from: window.to, to: window.to } }, line)).toBe(false);
        expect(parseDayLogLine("not json")).toBeNull();
    });

    it("picks the narrowest rg prefilter, and none for a plain window", () => {
        expect(prefilterFor({ window, pid: 42, tool: "ai" })).toEqual({ pattern: '"pid":42,', fixed: true });
        expect(prefilterFor({ window, minLevel: 50 })).toEqual({ pattern: '"level":(50|60)[,}]', fixed: false });
        expect(prefilterFor({ window, minLevel: 30 })).toBeNull();
    });
});

describe("profile log", () => {
    it("reads milliseconds, seconds and a trace id, and skips a summary line", () => {
        expect(
            parseProfileLine("[profile:cli] claude info exit=0 cpu=254ms rss=78MB caller=shell 160.03ms pid=16615", "d")
        ).toEqual({
            day: "d",
            scope: "cli",
            label: "claude info exit=0 cpu=254ms rss=78MB caller=shell",
            ms: 160.03,
            traceId: null,
            pid: 16615,
        });
        expect(parseProfileLine("[profile:agent-sessions] walk 1.5s trace=2e100b3a pid=9", "d")?.ms).toBe(1500);
        expect(parseProfileLine("── cli ──", "d")).toBeNull();
    });
});
