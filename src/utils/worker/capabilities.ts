/**
 * The single source of truth for what each worker backend can and cannot do.
 *
 * Docs (`plugins/genesis-tools/agents/agent-driver.md`, the handoff-to skill
 * references) point HERE instead of restating these facts in prose, so a
 * backend change cannot silently drift the docs. Callers branch on this —
 * a missing capability is declared, never emulated or silently degraded.
 */

import { type AccountProviderAlias, byHarness, type PerHarness } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessDriver } from "@genesiscz/utils/ai/providers/harness-index";

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
    /**
     * Set when `steer` cannot compare the previous turn before it delivers, carrying the sentence the refusal
     * and the hidden `--expect-turn` flag both quote.
     */
    turnGuardUnsupported?: string;
    /**
     * How bus mail addressed to the worker reaches it. `turn-input`: the daemon delivers it as turn input (merged
     * into a running turn, or a new turn when idle), so the worker must never poll for it. `login-once`: the worker
     * checks with `tools agents login --once`.
     */
    busMail: "turn-input" | "login-once";
    /**
     * Whether the sandbox denies watchman's state directory (`~/.local/state/watchman`), so Jest must run with
     * `--watchman=false`. The fix is the flag, not a writable root: that directory also holds watchman triggers,
     * which run commands outside the sandbox.
     */
    sandboxBlocksWatchman: boolean;
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

/** Each harness's worker capabilities, read from its driver's `worker` part (plugins/<plugin>/harness-worker.ts). */
export const WORKER_CAPABILITIES: Readonly<PerHarness<WorkerCapabilities>> = byHarness(
    (id) => harnessDriver(id).parts.worker
);
