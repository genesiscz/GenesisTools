import { describe, expect, it } from "bun:test";
import type { WaitingQueue } from "@app/question/lib/inbox/load";
import { buildGlance, closestLimit, fleetCounts } from "./index";

const NOW = new Date("2026-11-04T15:00:00.000Z");

const QUEUE: WaitingQueue = {
    total: 2,
    at: NOW.toISOString(),
    sessions: [
        {
            sessionId: "s-1",
            provider: "claude",
            title: "shop work",
            project: "shop",
            counted: 2,
            items: [
                {
                    kind: "decision",
                    id: "d_2_s-1",
                    number: 2,
                    title: "Which cache?",
                    prompt: "Which cache?",
                    choices: [
                        { id: "a", label: "Memory", rationale: null, recommended: true },
                        { id: "b", label: "Disk", rationale: null, recommended: false },
                    ],
                    recommended: "a",
                    at: "2026-11-04T14:50:00.000Z",
                },
                {
                    kind: "dialog",
                    id: "dlg",
                    title: "Pick a port",
                    prompt: "Pick",
                    choices: [],
                    status: "waiting",
                    source: "dialog",
                    at: "2026-11-04T14:30:00.000Z",
                },
            ],
        },
    ],
} as WaitingQueue;

describe("glance", () => {
    it("counts the fleet by the phase flags", () => {
        expect(
            fleetCounts([
                { label: "thinking" },
                { label: "waiting" },
                { label: "stalled" },
                { label: "idle" },
                { label: "unknown" },
            ])
        ).toEqual({
            working: 1,
            waiting: 1,
            stalled: 1,
            idle: 2,
            total: 5,
        });
    });

    it("picks the fresh window closest to its cap and keeps its run-out time only before the reset", () => {
        const window = {
            bucket: "five_hour",
            kind: "session" as const,
            label: "5h",
            utilization: 40,
            resetsAt: null,
            lastSampleAt: "",
            samples: 3,
            cycleSamples: 3,
            ratePctPerHour: 10,
            basis: null,
            exhaustAt: "2026-11-04T20:00:00.000Z",
            minutesToExhaust: 300,
            beforeReset: false,
            projectedAtReset: null,
            resetSinceSample: false,
            stale: false,
        };
        const limit = closestLimit({
            generatedAt: "",
            source: null,
            elapsedMs: 0,
            accounts: [
                {
                    provider: "claude",
                    account: "work",
                    warning: null,
                    windows: [window, { ...window, label: "7d", utilization: 90, stale: true }],
                },
                {
                    provider: "codex",
                    account: "personal",
                    warning: null,
                    windows: [{ ...window, label: "7d", utilization: 70, beforeReset: true }],
                },
            ],
        });
        expect(limit).toEqual({
            provider: "codex",
            account: "personal",
            window: "7d",
            utilization: 70,
            resetsAt: null,
            exhaustAt: "2026-11-04T20:00:00.000Z",
        });
    });

    it("adds the approvals to the waiting count, and a failed source counts as empty", async () => {
        const glance = await buildGlance(
            {
                waiting: async () => QUEUE,
                approvals: async () => {
                    throw new Error("no cmux");
                },
                fleet: async () => [{ label: "waiting" }],
                forecast: async () => ({ generatedAt: "", source: null, elapsedMs: 0, accounts: [] }),
            },
            NOW
        );

        expect(glance.waiting).toEqual({
            total: 2,
            approvals: 0,
            oldest: { title: "Pick a port", project: "shop", provider: "claude", at: "2026-11-04T14:30:00.000Z" },
        });
        expect(glance.inbox).toEqual([
            {
                id: "d_2_s-1",
                session: "s-1",
                number: 2,
                title: "Which cache?",
                project: "shop",
                recommended: "a",
                letters: [
                    { letter: "a", label: "Memory" },
                    { letter: "b", label: "Disk" },
                ],
                at: "2026-11-04T14:50:00.000Z",
            },
        ]);
        expect(glance.limits).toBeNull();
    });
});
