import type { PollGate } from "@genesiscz/utils/ai/usage-poll/poll-gate";
import * as core from "@genesiscz/utils/ai/usage-poll/poll-gate";

/**
 * The poll gate moved to `@genesiscz/utils/ai/usage-poll/poll-gate` and became per-provider
 * (spec 2026-09-04 section 6.3). This door keeps the claude-only callers (`api.ts`,
 * `tools claude config`, `rename-account`) on the `anthropic-sub` gate without passing the
 * provider at every call site.
 */
export const CLAUDE_GATE_PROVIDER = "anthropic-sub";

export {
    backoffMs,
    blockedEntry,
    failureStreak,
    type GateEntry,
    isTransportFailure,
    MAX_BACKOFF_MS,
    type PollGate,
    pruneGate,
    recordFailure,
    recordSuccess,
} from "@genesiscz/utils/ai/usage-poll/poll-gate";

export function loadPollGate(): Promise<PollGate> {
    return core.loadPollGate(CLAUDE_GATE_PROVIDER);
}

export function savePollGate(gate: PollGate): Promise<void> {
    return core.savePollGate(CLAUDE_GATE_PROVIDER, gate);
}

export function applyPollGateOutcomes(args: {
    successes: readonly string[];
    failures: readonly { account: string; reason: string; transport?: boolean }[];
    now: number;
    knownAccounts?: readonly string[];
}): Promise<void> {
    return core.applyPollGateOutcomes({ provider: CLAUDE_GATE_PROVIDER, ...args });
}

export function clearPollGate(account?: string): Promise<void> {
    return core.clearPollGate(CLAUDE_GATE_PROVIDER, account);
}
