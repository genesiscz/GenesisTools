import { describe, expect, it } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    type ActivityEvent,
    classifyActivity,
    claudeRecordsToEvents,
    isNotableTransition,
    NOTABLE_STATES,
    taskLinesToEvents,
    taskPidAlive,
} from "./activity";
import { ACTIVITY_TAIL_BYTES, readClaudeActivity } from "./activity-tail";

const T0 = 1_000_000_000_000;
const STALL_MS = 120_000;

function ev(kind: ActivityEvent["kind"], ts: number, extra: Partial<ActivityEvent> = {}): ActivityEvent {
    return { kind, ts, ...extra };
}

const iso = (offset: number): string => new Date(T0 + offset).toISOString();

describe("classifyActivity", () => {
    it("returns FINISHED when the latest event is an exit", () => {
        const events = [ev("start", T0), ev("output", T0 + 100), ev("exit", T0 + 200, { exitCode: 0 })];

        expect(classifyActivity({ events, lastModified: T0 + 200, now: T0 + 5_000, stallTimeoutMs: STALL_MS })).toBe(
            "FINISHED"
        );
    });

    it("returns AWAITING-INPUT when the latest event is a question", () => {
        const events = [ev("output", T0), ev("question", T0 + 50, { text: "May I edit? (y/n)" })];

        expect(classifyActivity({ events, lastModified: T0 + 50, now: T0 + 60, stallTimeoutMs: STALL_MS })).toBe(
            "AWAITING-INPUT"
        );
    });

    it("returns STALLED when alive and silent past the timeout", () => {
        const input = { events: [ev("output", T0)], lastModified: T0, stallTimeoutMs: STALL_MS, pidAlive: true };

        expect(classifyActivity({ ...input, now: T0 + 200_000 })).toBe("STALLED");
    });

    it("returns RUNNING with recent output inside the timeout", () => {
        const input = { events: [ev("output", T0)], lastModified: T0, now: T0 + 5_000, stallTimeoutMs: STALL_MS };

        expect(classifyActivity(input)).toBe("RUNNING");
    });

    it("stalls only past the timeout, not at it", () => {
        const input = { events: [ev("output", T0)], lastModified: T0, stallTimeoutMs: STALL_MS };

        expect(classifyActivity({ ...input, now: T0 + STALL_MS })).toBe("RUNNING");
        expect(classifyActivity({ ...input, now: T0 + STALL_MS + 1 })).toBe("STALLED");
    });

    it("counts a newer file modification time as activity", () => {
        const input = { events: [ev("output", T0)], now: T0 + 200_000, stallTimeoutMs: STALL_MS };

        expect(classifyActivity({ ...input, lastModified: T0 + 190_000 })).toBe("RUNNING");
    });

    it("reclassifies a RUNNING agent whose pid is gone as FINISHED", () => {
        const input = { events: [ev("output", T0)], lastModified: T0, now: T0 + 5_000, stallTimeoutMs: STALL_MS };

        expect(classifyActivity({ ...input, pidAlive: false })).toBe("FINISHED");
    });

    it("prefers an explicit exit event over a gone pid (still FINISHED)", () => {
        const input = {
            events: [ev("exit", T0, { exitCode: 1 })],
            lastModified: T0,
            now: T0 + 5_000,
            stallTimeoutMs: STALL_MS,
        };

        expect(classifyActivity({ ...input, pidAlive: false })).toBe("FINISHED");
    });

    it("lets a question win over a stall (waiting for input is not a stall)", () => {
        const input = { events: [ev("question", T0)], lastModified: T0, now: T0 + 999_999, stallTimeoutMs: STALL_MS };

        expect(classifyActivity({ ...input, pidAlive: true })).toBe("AWAITING-INPUT");
    });

    it("treats an agent with no events as RUNNING when fresh and STALLED when stale", () => {
        const input = { events: [], lastModified: T0, stallTimeoutMs: STALL_MS, pidAlive: true };

        expect(classifyActivity({ ...input, now: T0 + 1_000 })).toBe("RUNNING");
        expect(classifyActivity({ ...input, now: T0 + 200_000 })).toBe("STALLED");
    });
});

describe("isNotableTransition", () => {
    it("notifies on a move into a notable state from a different state", () => {
        expect(isNotableTransition("RUNNING", "FINISHED")).toBe(true);
        expect(isNotableTransition("RUNNING", "STALLED")).toBe(true);
        expect(isNotableTransition("RUNNING", "AWAITING-INPUT")).toBe(true);
    });

    it("notifies on a first sighting that is already notable", () => {
        expect(isNotableTransition(undefined, "FINISHED")).toBe(true);
        expect(isNotableTransition(undefined, "AWAITING-INPUT")).toBe(true);
    });

    it("stays quiet on a first sighting of RUNNING", () => {
        expect(isNotableTransition(undefined, "RUNNING")).toBe(false);
    });

    it("stays quiet when the state is unchanged", () => {
        expect(isNotableTransition("RUNNING", "RUNNING")).toBe(false);
        expect(isNotableTransition("STALLED", "STALLED")).toBe(false);
        expect(isNotableTransition("FINISHED", "FINISHED")).toBe(false);
    });

    it("stays quiet on a recovery into RUNNING", () => {
        expect(isNotableTransition("STALLED", "RUNNING")).toBe(false);
        expect(isNotableTransition("AWAITING-INPUT", "RUNNING")).toBe(false);
    });

    it("notifies on a move between two different notable states", () => {
        expect(isNotableTransition("STALLED", "FINISHED")).toBe(true);
        expect(isNotableTransition("AWAITING-INPUT", "FINISHED")).toBe(true);
    });

    it("does not count RUNNING as notable", () => {
        expect(NOTABLE_STATES.has("RUNNING")).toBe(false);
        expect(NOTABLE_STATES.has("FINISHED")).toBe(true);
    });
});

describe("claudeRecordsToEvents", () => {
    const stop = (reason: string | null, content: unknown[] = []) => ({ stop_reason: reason, content });

    it("does not treat a leading summary (a compacted session) as a finish", () => {
        const events = claudeRecordsToEvents([
            { type: "summary", summary: "earlier context", leafUuid: "x" },
            { type: "user", timestamp: iso(10) },
            { type: "assistant", timestamp: iso(20), message: stop("tool_use") },
        ]);

        expect(events.map((event) => event.kind)).toEqual(["output", "output"]);
    });

    it("treats only the last conversation record as a finish", () => {
        const done = claudeRecordsToEvents([
            { type: "user", timestamp: iso(10) },
            { type: "result", timestamp: iso(500) },
        ]);
        const midResult = claudeRecordsToEvents([
            { type: "result", timestamp: iso(10) },
            { type: "assistant", timestamp: iso(500), message: stop("tool_use") },
        ]);

        expect(done.map((event) => event.kind)).toEqual(["output", "exit"]);
        expect(midResult.map((event) => event.kind)).toEqual(["output", "output"]);
    });

    it("reads an ended turn as a question", () => {
        const events = claudeRecordsToEvents([
            { type: "user", timestamp: iso(10) },
            { type: "assistant", timestamp: iso(400), message: stop("end_turn") },
        ]);

        expect(events.at(-1)?.kind).toBe("question");
    });

    it("reads a trailing AskUserQuestion tool call as a question even mid-turn", () => {
        const events = claudeRecordsToEvents([
            { type: "user", timestamp: iso(10) },
            {
                type: "assistant",
                timestamp: iso(400),
                message: stop("tool_use", [{ type: "tool_use", name: "AskUserQuestion" }]),
            },
        ]);

        expect(events.at(-1)?.kind).toBe("question");
    });

    it("looks past bookkeeping records that follow the last conversation record", () => {
        const events = claudeRecordsToEvents([
            { type: "user", timestamp: iso(10) },
            { type: "assistant", timestamp: iso(400), message: stop("end_turn") },
            { type: "system", subtype: "turn_duration", timestamp: iso(410) },
            { type: "cost-state" },
            { type: "queue-operation", timestamp: iso(420) },
        ]);

        expect(events.map((event) => event.kind)).toEqual(["output", "question"]);
    });

    it("keeps a later prompt from reading as a question", () => {
        const events = claudeRecordsToEvents([
            { type: "assistant", timestamp: iso(400), message: stop("end_turn") },
            { type: "user", timestamp: iso(500) },
        ]);

        expect(events.map((event) => event.kind)).toEqual(["output", "output"]);
    });

    it("skips a record without a timestamp and accepts a numeric ts", () => {
        const events = claudeRecordsToEvents([{ type: "user" }, { type: "user", ts: T0 + 5 }]);

        expect(events).toEqual([{ kind: "output", ts: T0 + 5 }]);
    });

    it("keeps every stamped record as output when none is a conversation record", () => {
        const events = claudeRecordsToEvents([{ type: "system", timestamp: iso(1) }]);

        expect(events).toEqual([{ kind: "output", ts: T0 + 1 }]);
    });

    it("returns no events for no records", () => {
        expect(claudeRecordsToEvents([])).toEqual([]);
    });
});

describe("taskLinesToEvents", () => {
    it("maps log lines to output and an exit line to the finish", () => {
        const events = taskLinesToEvents([
            { type: "meta" },
            { type: "line", ts: T0 + 10, text: "starting" },
            { type: "line", text: "no time, skipped" },
            { type: "exit", code: 2, ts: "2026-06-02T01:35:45.927Z" },
        ]);

        expect(events).toEqual([
            { kind: "output", ts: T0 + 10, text: "starting" },
            { kind: "exit", ts: Date.parse("2026-06-02T01:35:45.927Z"), exitCode: 2 },
        ]);
    });

    it("gives an exit line without a time the timestamp 0", () => {
        expect(taskLinesToEvents([{ type: "exit", code: 0 }])).toEqual([{ kind: "exit", ts: 0, exitCode: 0 }]);
    });

    it("finishes a session from its exit line", () => {
        const events = taskLinesToEvents([
            { type: "line", ts: T0 + 20, text: "===== DONE =====" },
            { type: "exit", code: 0, ts: T0 + 30 },
        ]);

        expect(classifyActivity({ events, lastModified: T0 + 30, now: T0 + 1_000, stallTimeoutMs: STALL_MS })).toBe(
            "FINISHED"
        );
    });
});

describe("taskPidAlive", () => {
    it("reads a recorded exit code as gone, without asking the probe", () => {
        const probe = () => {
            throw new Error("the probe must not run when the exit code is recorded");
        };

        expect(taskPidAlive({ pid: 4242, exitCode: 137 }, probe)).toBe(false);
    });

    it("hands the pid and its recorded command to the probe", () => {
        const seen: Array<[number, string | undefined]> = [];

        taskPidAlive({ pid: 4242, pidCommand: "bash run.sh" }, (pid, command) => {
            seen.push([pid, command]);
            return "live";
        });

        expect(seen).toEqual([[4242, "bash run.sh"]]);
    });

    it("counts live and unverified as alive, dead and foreign as gone", () => {
        const alive = (status: "live" | "unverified" | "dead" | "foreign") => taskPidAlive({ pid: 7 }, () => status);

        expect(alive("live")).toBe(true);
        expect(alive("unverified")).toBe(true);
        expect(alive("dead")).toBe(false);
        expect(alive("foreign")).toBe(false);
    });

    it("has no answer without a pid or an exit code", () => {
        expect(taskPidAlive({ lastActivityAt: T0 }, () => "live")).toBeUndefined();
    });

    it("finishes a quiet session whose pid was recycled", () => {
        const events = taskLinesToEvents([{ type: "line", ts: T0, text: "working" }]);
        const pidAlive = taskPidAlive({ pid: 99, pidCommand: "bash run.sh" }, () => "foreign");

        expect(
            classifyActivity({ events, lastModified: T0, now: T0 + 1_000, stallTimeoutMs: STALL_MS, pidAlive })
        ).toBe("FINISHED");
    });
});

describe("readClaudeActivity", () => {
    function transcript(records: object[], mtimeOffset: number): string {
        const dir = mkdtempSync(join(tmpdir(), "activity-tail-"));
        const path = join(dir, "session.jsonl");
        writeFileSync(path, `${records.map((record) => SafeJSON.stringify(record)).join("\n")}\n`);
        utimesSync(path, (T0 + mtimeOffset) / 1000, (T0 + mtimeOffset) / 1000);

        return path;
    }

    const stop = (reason: string, content: unknown[] = []) => ({ stop_reason: reason, content });

    it("reads an ended turn followed by bookkeeping records as AWAITING-INPUT", () => {
        const path = transcript(
            [
                { type: "user", timestamp: iso(10) },
                { type: "assistant", timestamp: iso(400), message: stop("end_turn") },
                { type: "system", subtype: "turn_duration", timestamp: iso(410) },
                { type: "cost-state", totalCostUsd: 1.5 },
            ],
            410
        );

        expect(readClaudeActivity(path, { now: T0 + 1_000, stallTimeoutMs: STALL_MS })?.state).toBe("AWAITING-INPUT");
    });

    it("reads a finished run as FINISHED", () => {
        const path = transcript(
            [
                { type: "user", timestamp: iso(10) },
                { type: "result", timestamp: iso(500) },
            ],
            500
        );

        expect(readClaudeActivity(path, { now: T0 + 1_000 })?.state).toBe("FINISHED");
    });

    it("reads a working session as RUNNING and the same session, silent for too long, as STALLED", () => {
        const records = [
            { type: "user", timestamp: iso(10) },
            { type: "assistant", timestamp: iso(20), message: stop("tool_use", [{ type: "tool_use", name: "Bash" }]) },
        ];
        const path = transcript(records, 20);

        expect(readClaudeActivity(path, { now: T0 + 1_000, stallTimeoutMs: STALL_MS })?.state).toBe("RUNNING");
        expect(readClaudeActivity(path, { now: T0 + 500_000, stallTimeoutMs: STALL_MS })).toMatchObject({
            state: "STALLED",
            lastActivityAt: T0 + 20,
            silenceMs: 499_980,
        });
    });

    it("reads a question asked mid-turn as AWAITING-INPUT", () => {
        const path = transcript(
            [
                { type: "user", timestamp: iso(10) },
                {
                    type: "assistant",
                    timestamp: iso(400),
                    message: stop("tool_use", [{ type: "tool_use", name: "AskUserQuestion" }]),
                },
            ],
            400
        );

        expect(readClaudeActivity(path, { now: T0 + 1_000 })?.state).toBe("AWAITING-INPUT");
    });

    it("does not treat a mid-file result as a finish", () => {
        const path = transcript(
            [
                { type: "result", timestamp: iso(10) },
                { type: "assistant", timestamp: iso(500), message: stop("tool_use") },
            ],
            500
        );

        expect(readClaudeActivity(path, { now: T0 + 1_000 })?.state).toBe("RUNNING");
    });

    it("finds the last conversation record in the tail of a large transcript", () => {
        const filler = Array.from({ length: 2_000 }, (_, index) => ({
            type: "user",
            timestamp: iso(index),
            message: { content: "x".repeat(100) },
        }));
        const path = transcript(
            [...filler, { type: "assistant", timestamp: iso(3_000), message: stop("end_turn") }],
            3_000
        );

        expect(readClaudeActivity(path, { now: T0 + 4_000 })?.state).toBe("AWAITING-INPUT");
    });

    it("falls back to the modification time when the last record is longer than the tail", () => {
        const huge = {
            type: "assistant",
            timestamp: iso(500),
            message: stop("end_turn", ["y".repeat(ACTIVITY_TAIL_BYTES * 2)]),
        };
        const path = transcript([{ type: "user", timestamp: iso(10) }, huge], 500);

        expect(readClaudeActivity(path, { now: T0 + 1_000 })?.state).toBe("RUNNING");
        expect(readClaudeActivity(path, { now: T0 + 500_000, stallTimeoutMs: STALL_MS })?.state).toBe("STALLED");
    });

    it("returns null for an empty file and for a file that does not exist", () => {
        const dir = mkdtempSync(join(tmpdir(), "activity-tail-"));
        const empty = join(dir, "empty.jsonl");
        writeFileSync(empty, "");

        expect(readClaudeActivity(empty)).toBeNull();
        expect(readClaudeActivity(join(dir, "missing.jsonl"))).toBeNull();
    });
});
