import { describe, expect, it } from "bun:test";
import type { RunSummary } from "@app/daemon/lib/types";
import { mergeTimeline, type TimelineQaEntry } from "@app/dev-dashboard/lib/timeline/merge";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";

const run = (over: Partial<RunSummary>): RunSummary => ({
    taskName: "sync",
    runId: "r1",
    logFile: "sync.jsonl",
    startedAt: "2026-06-02T09:15:00.000Z",
    exitCode: 0,
    duration_ms: 1200,
    attempt: 1,
    ...over,
});

const qa = (over: Partial<TimelineQaEntry>): TimelineQaEntry => ({
    id: "q1",
    ts: Date.parse("2026-06-02T09:30:00.000Z"),
    tag: "action",
    question: "Why merge in a pure lib?",
    project: "GenesisTools",
    ...over,
});

const term = (over: Partial<TtydSession>): TtydSession => ({
    id: "t1",
    port: 7681,
    command: "bash",
    cwd: "/Users/dev/project",
    pid: 4821,
    startedAt: "2026-06-02T10:05:00.000Z",
    ...over,
});

describe("mergeTimeline", () => {
    const since = Date.parse("2026-06-02T00:00:00.000Z");

    it("interleaves all three sources sorted DESCENDING by ts with correct type tags", () => {
        const events = mergeTimeline({
            runs: [run({ runId: "r1", startedAt: "2026-06-02T09:15:00.000Z" })],
            qaEntries: [qa({ id: "q1", ts: Date.parse("2026-06-02T09:30:00.000Z") })],
            ttydSessions: [term({ id: "t1", startedAt: "2026-06-02T10:05:00.000Z" })],
            since,
        });

        expect(events.map((e) => e.type)).toEqual(["terminal", "qa", "run"]);
        expect(events.map((e) => e.id)).toEqual(["terminal-t1", "qa-q1", "run-r1"]);
        // ts strictly descending.
        expect(events[0].ts).toBeGreaterThan(events[1].ts);
        expect(events[1].ts).toBeGreaterThan(events[2].ts);
    });

    it("drops events strictly older than `since`", () => {
        const events = mergeTimeline({
            runs: [run({ runId: "old", startedAt: "2026-06-01T23:59:59.000Z" })],
            qaEntries: [qa({ id: "today", ts: Date.parse("2026-06-02T08:00:00.000Z") })],
            ttydSessions: [],
            since,
        });

        expect(events.map((e) => e.id)).toEqual(["qa-today"]);
    });

    it("tags a non-zero run exit as a run event carrying its exitCode", () => {
        const [event] = mergeTimeline({
            runs: [run({ runId: "fail", exitCode: 2, startedAt: "2026-06-02T09:00:00.000Z" })],
            qaEntries: [],
            ttydSessions: [],
            since,
        });

        expect(event.type).toBe("run");
        if (event.type === "run") {
            expect(event.exitCode).toBe(2);
            expect(event.runId).toBe("fail");
        }
    });

    it("ignores source rows with an unparseable timestamp (no NaN in the stream)", () => {
        const events = mergeTimeline({
            runs: [run({ runId: "bad", startedAt: "not-a-date" })],
            qaEntries: [qa({ id: "ok", ts: Date.parse("2026-06-02T08:00:00.000Z") })],
            ttydSessions: [],
            since,
        });

        expect(events.every((e) => Number.isFinite(e.ts))).toBe(true);
        expect(events.map((e) => e.id)).toEqual(["qa-ok"]);
    });
});
