import type { MorningBriefDto } from "@dd/contract";

// An invented brief for the mock agent and the tests: places, accounts and titles are made up.
export const MOCK_BRIEF: MorningBriefDto = {
    generatedAt: "2026-10-01T04:00:00.000Z",
    commute: {
        from: "Home",
        to: "Office",
        leaveAt: "2026-10-01T05:15:00.000Z",
        arriveAt: "2026-10-01T05:50:00.000Z",
        minutes: 35,
        error: null,
    },
    weather: { label: "Home", tempC: 6.2, description: "Fog", error: null },
    overnight: {
        since: "2026-09-30T16:00:00.000Z",
        sessions: 3,
        commits: 7,
        decisionsAnswered: 2,
        titles: ["Port the parser", "Fix the flaky test", "Review the shop api"],
    },
    decisionsWaiting: 4,
    resets: [
        { provider: "anthropic-sub", account: "work", label: "5h", utilization: 82, resetsAt: "2026-10-01T05:00:00.000Z" },
        { provider: "openai-sub", account: "personal", label: "5h", utilization: 12, resetsAt: null },
    ],
    warnings: [],
};
