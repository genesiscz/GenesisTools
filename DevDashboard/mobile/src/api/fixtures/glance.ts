import type { ForecastDto, GlanceDto } from "@dd/contract";

const WINDOW = {
    bucket: "five_hour",
    kind: "session" as const,
    label: "5-hour",
    utilization: 62,
    resetsAt: "2026-11-04T17:00:00.000Z",
    lastSampleAt: "2026-11-04T14:55:00.000Z",
    ratePctPerHour: 18,
    exhaustAt: "2026-11-04T16:05:00.000Z",
    minutesToExhaust: 70,
    beforeReset: true,
    projectedAtReset: 100,
    resetSinceSample: false,
    stale: false,
};

/** Two invented accounts: one runs out before its reset, one has room. */
export const MOCK_FORECAST: ForecastDto = {
    generatedAt: "2026-11-04T15:00:00.000Z",
    source: "mock",
    elapsedMs: 12,
    accounts: [
        {
            provider: "claude",
            account: "work",
            warning: "5-hour runs out at 16:05, before its reset at 17:00",
            windows: [
                WINDOW,
                { ...WINDOW, bucket: "seven_day", kind: "weekly", label: "Weekly", utilization: 41, resetsAt: "2026-11-08T09:00:00.000Z", exhaustAt: null, minutesToExhaust: null, beforeReset: false },
            ],
        },
        {
            provider: "codex",
            account: "personal",
            warning: null,
            windows: [{ ...WINDOW, utilization: 12, exhaustAt: null, minutesToExhaust: null, beforeReset: false }],
        },
    ],
};

export const MOCK_GLANCE: GlanceDto = {
    generatedAt: "2026-11-04T15:00:00.000Z",
    waiting: {
        total: 4,
        approvals: 1,
        oldest: { title: "Which cache?", project: "shop", provider: "claude", at: "2026-11-04T14:30:00.000Z" },
    },
    fleet: { working: 2, waiting: 1, stalled: 0, idle: 3, total: 6 },
    inbox: [
        {
            id: "d_2_mock",
            session: "00000000-0000-4000-8000-000000000001",
            number: 2,
            title: "Which cache?",
            project: "shop",
            recommended: "a",
            multiple: false,
            letters: [
                { letter: "a", label: "Memory" },
                { letter: "b", label: "Disk" },
            ],
            at: "2026-11-04T14:30:00.000Z",
        },
    ],
    limits: {
        provider: "claude",
        account: "work",
        window: "5-hour",
        utilization: 62,
        resetsAt: "2026-11-04T17:00:00.000Z",
        exhaustAt: "2026-11-04T16:05:00.000Z",
    },
};
