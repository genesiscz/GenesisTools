/**
 * The single source of truth for what each worker backend can and cannot do.
 *
 * Docs (`plugins/genesis-tools/agents/agent-driver.md`, the handoff-to skill
 * references) point HERE instead of restating these facts in prose, so a
 * backend change cannot silently drift the docs. Callers branch on this —
 * a missing capability is declared, never emulated or silently degraded.
 */

import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";

export type WorkerBackend = AccountProviderAlias;

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
    /**
     * Set when the backend cannot pin an account AT ALL, carrying the reason and the fix.
     *
     * `accountRequired: false` used to cover two different worlds: codex, where `--account` is
     * optional and honoured, and grok, where it could only ever be a silent no-op. Every door
     * quotes this one string, so the hidden flag's description and the refusal cannot drift.
     */
    accountUnsupported?: string;
    /** Verbs the GenesisTools CLI exposes for this backend. */
    verbs: string[];
    /** Verbs deliberately absent, with the reason. */
    absentVerbs: Record<string, string>;
}

/** The sentence a backend that cannot pin an account answers `--account <name>` with. */
export function accountPinRefusal(backend: WorkerBackend, account: string): string | undefined {
    const reason = WORKER_CAPABILITIES[backend].accountUnsupported;

    return reason === undefined ? undefined : `--account ${account} cannot be honoured: ${reason}`;
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
        accountUnsupported:
            "grok pins an auth FILE, not an account, so the flag would silently do nothing. Pass --auth subscription and point GROK_AUTH_PATH at that account's auth.json (references/grok.md).",
        verbs: ["spawn", "steer", "read", "tail", "status", "stop", "interrupt", "sessions"],
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
            "worker interrupt",
            "worker sessions",
        ],
        absentVerbs: {
            approve:
                "claude -p has no approval channel (approvals: none) and no sandbox — hold policy via the brief plus a git-status check",
            deny: "claude -p has no approval channel (approvals: none)",
        },
    },
};
