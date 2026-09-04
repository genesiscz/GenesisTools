/**
 * The single source of truth for what each worker backend can and cannot do.
 *
 * Docs (`plugins/genesis-tools/agents/agent-driver.md`, the handoff-to skill
 * references) point HERE instead of restating these facts in prose, so a
 * backend change cannot silently drift the docs. Callers branch on this —
 * a missing capability is declared, never emulated or silently degraded.
 */

export type WorkerBackend = "codex" | "grok" | "claude";

export interface WorkerCapabilities {
    /** Mid-turn approval channel (pause + approve/deny) or none at all. */
    approvals: "mid-turn" | "none";
    /** What actually contains writes when the worker goes off-script. */
    sandbox: "workspace-write+roots" | "cwd-jail" | "none";
    /** A mode where the worker physically lacks write/terminal tools. */
    readonlyMode: boolean;
    /** Structured output formats the harness consumes. */
    structuredOutput: string[];
    /** When a correction can reach the worker. */
    steering: "mid-turn" | "between-turns";
    /** Whether a credential/account must be named explicitly at spawn. */
    accountRequired: boolean;
    /** Verbs the GenesisTools CLI exposes for this backend. */
    verbs: string[];
    /** Verbs deliberately absent, with the reason. */
    absentVerbs: Record<string, string>;
}

export const WORKER_CAPABILITIES: Record<WorkerBackend, WorkerCapabilities> = {
    codex: {
        approvals: "mid-turn",
        sandbox: "workspace-write+roots",
        readonlyMode: true,
        structuredOutput: ["app-server JSON-RPC"],
        steering: "mid-turn",
        accountRequired: false,
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
    },
    grok: {
        approvals: "none",
        sandbox: "cwd-jail",
        readonlyMode: true,
        structuredOutput: ["streaming-json (flat NDJSON)"],
        steering: "between-turns",
        accountRequired: false,
        verbs: ["run", "steer", "read", "tail", "status", "stop", "sessions"],
        absentVerbs: {
            approve: "grok has no approval channel (approvals: none) — the cwd jail and the brief are the only brakes",
            deny: "grok has no approval channel (approvals: none)",
        },
    },
    claude: {
        approvals: "none",
        sandbox: "none",
        readonlyMode: false,
        structuredOutput: ["stream-json (NDJSON)", "json"],
        steering: "between-turns",
        accountRequired: true,
        verbs: [
            "worker spawn",
            "worker steer",
            "worker read",
            "worker tail",
            "worker status",
            "worker stop",
            "worker sessions",
        ],
        absentVerbs: {
            approve:
                "claude -p has no approval channel (approvals: none) and no sandbox — hold policy via the brief plus a git-status check",
            deny: "claude -p has no approval channel (approvals: none)",
        },
    },
};
