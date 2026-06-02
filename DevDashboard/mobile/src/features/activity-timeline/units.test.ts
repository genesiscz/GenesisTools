import type { TimelineEvent } from "@dd/contract";
import { eventVisual, groupByHour, hourLabel } from "@/features/activity-timeline/units";
import { describe, expect, it } from "bun:test";

// Fixed local times so the HH buckets are deterministic regardless of the test host's date.
const at = (h: number, m: number): number => new Date(2026, 5, 2, h, m, 0, 0).getTime();

const ev = (over: Partial<TimelineEvent> & Pick<TimelineEvent, "id" | "type" | "ts">): TimelineEvent =>
    ({ title: "t", ...over }) as TimelineEvent;

describe("groupByHour", () => {
    it("buckets events into descending hour groups, preserving in-bucket order", () => {
        const events: TimelineEvent[] = [
            ev({ id: "terminal-a", type: "terminal", ts: at(14, 50), command: "bash", cwd: "/" }),
            ev({ id: "qa-b", type: "qa", ts: at(14, 5), tag: "action", project: "p" }),
            ev({ id: "run-c", type: "run", ts: at(9, 30), runId: "c", exitCode: 0, durationMs: 1 }),
        ];

        const groups = groupByHour(events);
        expect(groups.map((g) => g.hourKey)).toEqual(["14", "09"]);
        expect(groups[0].events.map((e) => e.id)).toEqual(["terminal-a", "qa-b"]);
        expect(groups[1].events.map((e) => e.id)).toEqual(["run-c"]);
    });

    it("returns [] for no events", () => {
        expect(groupByHour([])).toEqual([]);
    });
});

describe("hourLabel", () => {
    it("formats an hour key as HH:00", () => {
        expect(hourLabel("09")).toBe("09:00");
        expect(hourLabel("14")).toBe("14:00");
    });
});

describe("eventVisual", () => {
    it("maps each type to its icon + tone, danger for a failed run", () => {
        expect(eventVisual(ev({ id: "r", type: "run", ts: 0, runId: "r", exitCode: 0, durationMs: 1 })).icon).toBe("cpu");
        expect(eventVisual(ev({ id: "r", type: "run", ts: 0, runId: "r", exitCode: 2, durationMs: 1 })).tone).toBe("danger");
        expect(eventVisual(ev({ id: "q", type: "qa", ts: 0, tag: "action", project: "p" })).icon).toBe("message-square");
        expect(eventVisual(ev({ id: "t", type: "terminal", ts: 0, command: "bash", cwd: "/" })).icon).toBe("terminal");
    });
});
