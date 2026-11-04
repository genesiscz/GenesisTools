import type { GateLedgerDto } from "@dd/contract";

// Invented gates for the mock agent and the tests: clients, paths and accounts are made up.
const NOW = Date.parse("2026-10-01T12:00:00Z");

export const MOCK_GATES: GateLedgerDto = {
    pending: [
        {
            id: "vault:51001",
            gate: "vault",
            title: "Unlock the vault for deploy-script",
            who: "deploy-script",
            askedAt: new Date(NOW - 40_000).toISOString(),
            window: {
                pid: 51001,
                openedAt: new Date(NOW - 40_000).toISOString(),
                deadline: new Date(NOW + 130_000).toISOString(),
            },
            request: null,
        },
        {
            id: "rm:k7m2p",
            gate: "rm",
            title: "Delete /work/shop/build",
            who: "Checkout flow refactor",
            askedAt: new Date(NOW - 25 * 60_000).toISOString(),
            window: null,
            request: {
                id: "k7m2p",
                reason: "stale build output",
                paths: [{ path: "/work/shop/build", bytes: 48_000_000, reason: "not a preset folder" }],
                expiresAt: new Date(NOW + 23 * 3_600_000).toISOString(),
            },
        },
    ],
    recent: [
        {
            gate: "ai-account",
            event: "allowed",
            at: new Date(NOW - 3_600_000).toISOString(),
            who: "worker",
            title: "openai account work",
        },
    ],
};
