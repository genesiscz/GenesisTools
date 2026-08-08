import { logger } from "@genesiscz/utils/logger";
import { getClaudeUsageStorage } from "./storage";

/**
 * Per-account polling gate: how long the usage endpoint must be left alone
 * after repeated failures.
 *
 * The poll daemon runs as a FRESH PROCESS every minute, so any cooldown held
 * in a module-level Map is dead on arrival — it never survives to the run it
 * was meant to stop. Five lapsed accounts cost 5,160 guaranteed-failing
 * requests on 2026-08-08 (1,032 each out of 1,082 polls) for exactly that
 * reason. This state therefore lives on disk.
 *
 * The gate is a BACKOFF, not a verdict: it never decides an account is dead,
 * it only spaces out the retries. The authoritative "this subscription cannot
 * run Claude Code" reading comes from the OAuth profile (`planAllowsClaudeCode`
 * in ./subscription), which is re-read every 6h and is not rate-limited.
 */

const GATE_KEY = "poll-gate";
// Long TTL: freshness is decided by our own `blockedUntil` stamps, never by mtime.
const GATE_TTL = "365 days" as const;

export interface GateEntry {
    /** Consecutive failed polls. Any success resets it to 0. */
    failures: number;
    /** Epoch ms before which this account must not be polled at all. */
    blockedUntil: number;
    /** Why it is blocked — surfaced as the account's error row while suppressed. */
    reason: string;
}

export type PollGate = Record<string, GateEntry>;

/**
 * Block duration by consecutive-failure count. The first failure never blocks:
 * a single 429 is routine under shared polling and the force-refresh retry
 * usually clears it inside the same call.
 */
const BACKOFF_LADDER_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];

export const MAX_BACKOFF_MS = BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1];

export function backoffMs(failures: number): number {
    if (failures < 2) {
        return 0;
    }

    return BACKOFF_LADDER_MS[Math.min(failures - 2, BACKOFF_LADDER_MS.length - 1)];
}

/** The blocking entry for an account, or null when it is due to be polled. */
export function blockedEntry(gate: PollGate, account: string, now: number): GateEntry | null {
    const entry = gate[account];

    if (!entry || entry.blockedUntil <= now) {
        return null;
    }

    return entry;
}

/** Record a failed poll and extend the backoff. Returns a new gate. */
export function recordFailure(gate: PollGate, account: string, reason: string, now: number): PollGate {
    const failures = (gate[account]?.failures ?? 0) + 1;

    return {
        ...gate,
        [account]: {
            failures,
            blockedUntil: now + backoffMs(failures),
            reason,
        },
    };
}

/** Drop an account's backoff entirely — a success, a re-login, or an explicit reset. */
export function recordSuccess(gate: PollGate, account: string): PollGate {
    if (!gate[account]) {
        return gate;
    }

    const next = { ...gate };
    delete next[account];
    return next;
}

/** Forget accounts that are no longer configured, so the file cannot grow forever. */
export function pruneGate(gate: PollGate, knownAccounts: readonly string[]): PollGate {
    const known = new Set(knownAccounts);
    const next: PollGate = {};

    for (const [name, entry] of Object.entries(gate)) {
        if (known.has(name)) {
            next[name] = entry;
        }
    }

    return next;
}

export async function loadPollGate(): Promise<PollGate> {
    try {
        return (await getClaudeUsageStorage().getCacheFile<PollGate>(GATE_KEY, GATE_TTL)) ?? {};
    } catch (err) {
        logger.debug({ err }, "[usage] poll gate unreadable; treating every account as due");
        return {};
    }
}

export async function savePollGate(gate: PollGate): Promise<void> {
    try {
        await getClaudeUsageStorage().putCacheFile(GATE_KEY, gate, GATE_TTL);
    } catch (err) {
        // A gate that cannot be written only costs the next poll a retry.
        logger.debug({ err }, "[usage] poll gate could not be saved");
    }
}

/**
 * Clear the backoff for one account (or all of them). Called after a re-login,
 * so a recovered account is polled on the very next run instead of waiting out
 * a 6h block earned while it was dead.
 */
export async function clearPollGate(account?: string): Promise<void> {
    const gate = await loadPollGate();

    if (!account) {
        await savePollGate({});
        logger.debug("[usage] poll gate cleared for all accounts");
        return;
    }

    if (!gate[account]) {
        return;
    }

    await savePollGate(recordSuccess(gate, account));
    logger.debug(`[usage] poll gate cleared for ${account}`);
}
