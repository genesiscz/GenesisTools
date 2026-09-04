import { describe, expect, test } from "bun:test";
import { formatWorkerTurn, resultLineOf, summarizeToolCalls, type WorkerTurnReport } from "./turn-report";

function report(partial: Partial<WorkerTurnReport>): WorkerTurnReport {
    return {
        backend: "grok",
        name: "task",
        turn: 1,
        ended: true,
        exitCode: 0,
        report: "RESULT: done\nAT: milestone 1\nCHANGED: nothing",
        stderr: "",
        toolCalls: [],
        worktree: null,
        logPath: "/tmp/task.turn1.jsonl",
        transcriptHint: "tools grok read --name task --format compact",
        ...partial,
    };
}

describe("summarizeToolCalls", () => {
    test("counts by tool name, most used first, capped with a remainder", () => {
        const calls = [
            ...Array.from({ length: 44 }, () => ({ tool: "read_file" })),
            ...Array.from({ length: 12 }, () => ({ tool: "grep" })),
            { tool: "list_dir" },
            { tool: "write" },
            { tool: "run_terminal_command" },
            { tool: "search_replace" },
            { tool: "todo_write" },
            { tool: "web_search" },
        ];

        expect(summarizeToolCalls(calls)).toBe(
            "62 tool calls (read_file 44, grep 12, list_dir 1, run_terminal_command 1, search_replace 1, todo_write 1, +2 more)"
        );
        expect(summarizeToolCalls([])).toBe("no tool calls");
        expect(summarizeToolCalls([{ tool: "grep" }])).toBe("1 tool call (grep 1)");
    });
});

describe("formatWorkerTurn", () => {
    test("a completed turn: header with the RESULT line, body, hint, success line, exit 0", () => {
        const formatted = formatWorkerTurn(report({ toolCalls: [{ tool: "grep" }, { tool: "grep" }] }));

        expect(formatted.exitCode).toBe(0);
        expect(formatted.body).toBe("RESULT: done\nAT: milestone 1\nCHANGED: nothing");
        expect(formatted.status.map((line) => `${line.level}|${line.text}`)).toEqual([
            "ok|grok task · turn 1 · completed · 2 tool calls (grep 2) · RESULT: done",
            "dim|transcript: tools grok read --name task --format compact",
            "ok|turn 1 completed — verify yourself before trusting this report (log: /tmp/task.turn1.jsonl)",
        ]);
    });

    test("a dead turn: DIED header, clipped stderr naming the err file, exit 1, no success line", () => {
        const formatted = formatWorkerTurn(
            report({
                ended: false,
                exitCode: 1,
                report: "",
                stderr: `Error: ${"x".repeat(700)}`,
                errPath: "/tmp/task.turn1.err",
            })
        );

        expect(formatted.exitCode).toBe(1);
        expect(formatted.body).toBe("");
        expect(formatted.status[0]).toEqual({
            level: "err",
            text: "grok task · turn 1 · DIED (no end event, exit 1) · no tool calls",
        });
        expect(formatted.status[1]?.level).toBe("err");
        expect(formatted.status[1]?.text).toMatch(
            /^stderr: Error: x{593}… \(107 more chars in \/tmp\/task\.turn1\.err\)$/
        );
        expect(formatted.status.some((line) => line.text.includes("verify yourself"))).toBe(false);
    });

    test("the worktree delta keeps its exact wording, warning on zero changes", () => {
        const none = formatWorkerTurn(report({ worktree: { cwd: "/w", changedThisTurn: 0, dirtyTotal: 3 } }));
        expect(none.status[1]).toEqual({
            level: "warn",
            text: "turn 1 changed NOTHING in /w — the turn ended, but the task may be unfinished. Check, then steer to continue.",
        });

        const some = formatWorkerTurn(report({ worktree: { cwd: "/w", changedThisTurn: 2, dirtyTotal: 3 } }));
        expect(some.status[1]).toEqual({ level: "info", text: "turn 1 changed 2 path(s); 3 dirty in total" });
    });

    test("stderr on a completed turn is a warning, not an error", () => {
        const formatted = formatWorkerTurn(report({ stderr: "deprecated flag" }));
        expect(formatted.status[1]).toEqual({ level: "warn", text: "stderr: deprecated flag" });
    });
});

describe("resultLineOf", () => {
    test("finds the contract's RESULT line anywhere in the report, or null", () => {
        expect(resultLineOf("prose\n  RESULT: stopped-at-checkpoint\nAT: x")).toBe("RESULT: stopped-at-checkpoint");
        expect(resultLineOf("no contract here")).toBeNull();
    });
});
