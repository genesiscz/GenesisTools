import { describe, expect, test } from "bun:test";
import type { EffortJournalRecord } from "@app/azure-devops/timelog-effort-journal";
import { planEffortRestore } from "./effort-restore";

const id = "56489ac9-aaaa-bbbb-cccc-ddddeeeeffff";

function journal(overrides: Partial<EffortJournalRecord> = {}): EffortJournalRecord {
    return {
        ts: "2026-08-19T13:03:11.482Z",
        workItemId: 296936,
        timeLogIds: [id],
        minutes: 120,
        remainingBefore: 10,
        completedBefore: 4,
        remainingAfter: 8,
        completedAfter: 6,
        ...overrides,
    };
}

describe("planEffortRestore", () => {
    test("exact journal restore after a 2h add", () => {
        const plan = planEffortRestore({
            workItemId: 296936,
            minutes: 120,
            timeLogId: id,
            currentRemaining: 8,
            currentCompleted: 6,
            journal: journal(),
        });
        expect(plan).toMatchObject({
            reason: "exact-journal",
            remainingAfter: 10,
            completedAfter: 4,
        });
        expect(plan.warning).toBeUndefined();
    });

    test("exact journal restore survives a Remaining clamp", () => {
        const plan = planEffortRestore({
            workItemId: 303818,
            minutes: 390,
            timeLogId: id,
            currentRemaining: 0,
            currentCompleted: 6.5,
            journal: journal({
                workItemId: 303818,
                minutes: 390,
                remainingBefore: 3,
                completedBefore: 0,
                remainingAfter: 0,
                completedAfter: 6.5,
            }),
        });
        expect(plan.reason).toBe("exact-journal");
        expect(plan.remainingAfter).toBe(3);
        expect(plan.completedAfter).toBe(0);
    });

    test("no journal uses arithmetic and warns", () => {
        const plan = planEffortRestore({
            workItemId: 296936,
            minutes: 480,
            timeLogId: id,
            currentRemaining: 0,
            currentCompleted: 38,
            journal: null,
        });
        expect(plan.reason).toBe("approximate-no-journal");
        expect(plan.remainingAfter).toBe(8);
        expect(plan.completedAfter).toBe(30);
        expect(plan.warning).toContain("before journaling shipped");
    });

    test("multi-id journal falls back to this entry's hours only", () => {
        const plan = planEffortRestore({
            workItemId: 1,
            minutes: 60,
            timeLogId: id,
            currentRemaining: 0,
            currentCompleted: 10,
            journal: journal({
                timeLogIds: [id, "other-1", "other-2", "other-3", "other-4"],
                minutes: 300,
                remainingBefore: 5,
                completedBefore: 5,
                remainingAfter: 0,
                completedAfter: 10,
            }),
        });
        expect(plan.reason).toBe("approximate-multi-id");
        expect(plan.remainingAfter).toBe(1);
        expect(plan.completedAfter).toBe(9);
        expect(plan.warning).toContain("5 entries");
    });

    test("drifted fields fall back to arithmetic", () => {
        const plan = planEffortRestore({
            workItemId: 296936,
            minutes: 120,
            timeLogId: id,
            currentRemaining: 7,
            currentCompleted: 9,
            journal: journal(),
        });
        expect(plan.reason).toBe("approximate-drifted");
        expect(plan.remainingAfter).toBe(9);
        expect(plan.completedAfter).toBe(7);
        expect(plan.warning).toContain("have changed");
    });
});
