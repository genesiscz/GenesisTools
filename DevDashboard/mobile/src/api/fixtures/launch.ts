import type { LaunchOptionsDto } from "@dd/contract";

// Invented accounts and repos for the mock agent and the tests.
export const MOCK_LAUNCH: LaunchOptionsDto = {
    generatedAt: "2026-10-01T12:00:00.000Z",
    agents: [
        {
            id: "claude",
            accounts: [
                { id: "acc_work", name: "work", tier: "ready", sessionLeftPct: 62, longLeftPct: 40, sessions: 2, why: "most weekly headroom" },
                { id: "acc_personal", name: "personal", tier: "session-starved", sessionLeftPct: 4, longLeftPct: 70, sessions: 0, why: "5h window nearly spent" },
                { id: "acc_side", name: "side", tier: "no-data", sessionLeftPct: null, longLeftPct: null, sessions: 0, why: "no usage reading yet" },
            ],
        },
        {
            id: "codex",
            accounts: [
                { id: "acc_shop", name: "shop", tier: "weekly-blocked", sessionLeftPct: 100, longLeftPct: 0, sessions: 0, why: "weekly window spent" },
            ],
        },
        { id: "grok", accounts: [] },
    ],
    repos: ["shop", "site", "notes-app", "infra"],
};
