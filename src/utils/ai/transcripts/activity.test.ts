import { describe, expect, it } from "bun:test";
import { claudeRecordsToEvents } from "@genesiscz/utils/agent-sessions/readers/claude-turn-state";
import { type ActivityEvent, classifyActivity } from "./activity";

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
