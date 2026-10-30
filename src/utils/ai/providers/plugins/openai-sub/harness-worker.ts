import type { WorkerCapabilities } from "@genesiscz/utils/worker/capabilities";

/** What a Codex worker (`tools <agent> run --worker`, the driver in its tool) can do. Moved from WORKER_CAPABILITIES. */
export const codexWorker: WorkerCapabilities = {
    approvals: "mid-turn",
    sandbox: "workspace-write+roots",
    readonlyMode: true,
    structuredOutput: ["app-server JSON-RPC"],
    steering: "mid-turn",
    accountRequired: false,
    turnGuardUnsupported: "Codex steering has no turn guard; omit --expect-turn.",
    // A model-side `login --once` only blocked the turn and received the same mail twice; one held the
    // identity's slot for 3+ minutes on 2026-10-13.
    busMail: "turn-input",
    // Jest failed before any test on watchman's `fchmod` (2026-10-13).
    sandboxBlocksWatchman: true,
    verbs: [
        "spawn",
        "steer",
        "interrupt",
        "rollback",
        "read",
        "review",
        "approve",
        "deny",
        "status",
        "sessions",
        "logs",
        "tail",
        "stop",
    ],
    absentVerbs: {},
};
