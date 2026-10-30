import type { WorkerCapabilities } from "@genesiscz/utils/worker/capabilities";

/** What a Claude Code worker (`tools <agent> run --worker`, the driver in its tool) can do. Moved from WORKER_CAPABILITIES. */
export const claudeWorker: WorkerCapabilities = {
    approvals: "none",
    sandbox: "none",
    readonlyMode: false,
    structuredOutput: ["stream-json (NDJSON)", "json"],
    steering: "between-turns",
    accountRequired: true,
    busMail: "login-once",
    // No sandbox at all.
    sandboxBlocksWatchman: false,
    verbs: [
        "worker spawn",
        "worker steer",
        "worker read",
        "worker tail",
        "worker status",
        "worker stop",
        "worker interrupt",
        "worker sessions",
    ],
    absentVerbs: {
        approve:
            "claude -p has no approval channel (approvals: none) and no sandbox — hold policy via the brief plus a git-status check",
        deny: "claude -p has no approval channel (approvals: none)",
    },
};
