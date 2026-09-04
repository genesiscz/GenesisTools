import { logger } from "@genesiscz/utils/logger";
import { pollGateCacheKey, USAGE_CACHE_TTL, usageCacheFilePath, usagePollStorage } from "./storage";

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

/**
 * One gate FILE per provider (`poll-gate:<provider>`), so a codex backoff can never suppress
 * an anthropic poll of an account with the same name (spec section 6.3). Inside a file the
 * keys stay bare account names. Old `claude-usage/cache/poll-gate` bytes are NOT migrated:
 * a lost backoff only costs one extra poll, which is due anyway (plan section 3.4).
 *
 * Long TTL: freshness is decided by our own `blockedUntil` stamps, never by mtime.
 */
const GATE_TTL = USAGE_CACHE_TTL;

/**
 * A poll the gate (or a provider's own rule, such as a plan that cannot run Claude Code)
 * refused before any request went out. NOT a failure: counting a skip as one would ratchet
 * the backoff forever without a single request ever being sent.
 *
 * It lives beside the gate rather than in `poll.ts` so a provider plugin can subclass it
 * without importing the poll core, which imports the plugin registry (that would be a cycle).
 */
export class PollSuppressed extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "PollSuppressed";
    }
}

export interface GateEntry {
    /** Consecutive failed polls that REACHED Anthropic. Any success resets it to 0. */
    failures: number;
    /**
     * Consecutive failures that never reached Anthropic, counted on their own
     * ladder. Sharing `failures` let a five-minute wifi drop pre-load the ladder,
     * so the first routine 429 after recovery earned the 6h block instead of none.
     */
    transportFailures?: number;
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

/**
 * Ceiling for a failure that never reached Anthropic at all.
 *
 * The ladder above exists to stop hammering the SERVER with requests that are
 * guaranteed to fail — an expired token, a dead org. A transport failure is a
 * different animal: the laptop slept, the wifi dropped, a VPN came up. No
 * request was ever sent, so there is nothing to protect, and the error says
 * nothing about the account — it hits every account in the same round.
 *
 * Left on the shared ladder, a blip ratchets to the 6h ceiling and then keeps
 * every account dark for six hours AFTER connectivity returns, because nothing
 * retries to discover the network is back. That is exactly what happened on
 * 2026-08-30: an outage starting 07:23Z pinned all seven live accounts until
 * 15:58Z, and the dashboard read "stale 7h ago / fetch failing" on a machine
 * that had been online for hours.
 *
 * Five minutes keeps a genuinely offline machine from retrying every minute,
 * while bounding how long a recovered network goes unnoticed.
 */
const TRANSPORT_MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Codes set when the request never got a response. Verified against Bun 1.3.13:
 * a refused connection AND an unresolvable host both surface as
 * `ConnectionRefused`, and a bad certificate as an OpenSSL code — none of which
 * an account can influence.
 */
const TRANSPORT_ERROR_CODES = new Set([
    "ConnectionRefused",
    "ConnectionClosed",
    "FailedToOpenSocket",
    "ECONNREFUSED",
    "ECONNRESET",
    "ECONNABORTED",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "EPIPE",
]);

/** Fallback for an error that was stringified before it reached the gate. */
const TRANSPORT_MESSAGE_RE =
    /unable to connect|failed to fetch|network (?:is )?(?:down|unreachable)|socket connection was closed|getaddrinfo|dns lookup failed/i;

/** True when the poll failed below HTTP, so no request reached Anthropic. */
export function isTransportFailure(err: unknown): boolean {
    if (typeof err === "object" && err !== null) {
        const code = (err as { code?: unknown }).code;

        if (typeof code === "string" && TRANSPORT_ERROR_CODES.has(code)) {
            return true;
        }

        const causeCode = (err as { cause?: { code?: unknown } }).cause?.code;

        if (typeof causeCode === "string" && TRANSPORT_ERROR_CODES.has(causeCode)) {
            return true;
        }
    }

    return TRANSPORT_MESSAGE_RE.test(String(err));
}

/** The blocking entry for an account, or null when it is due to be polled. */
export function blockedEntry(gate: PollGate, account: string, now: number): GateEntry | null {
    const entry = gate[account];

    if (!entry || entry.blockedUntil <= now) {
        return null;
    }

    return entry;
}

/** Length of the current failure streak, whatever kind of failure it is. */
export function failureStreak(entry: GateEntry | undefined): number {
    return (entry?.failures ?? 0) + (entry?.transportFailures ?? 0);
}

/**
 * Record a failed poll and extend the backoff. Returns a new gate.
 *
 * `transport` marks a failure that never reached Anthropic. It runs its own
 * counter, capped at `TRANSPORT_MAX_BACKOFF_MS` — see that constant for why a
 * local network blip must not earn an account-level 6h block. It must not
 * advance `failures` either: a five-minute outage climbed the shared ladder to
 * five, so the first routine 429 after connectivity returned was blocked for the
 * full six hours the ladder's own comment promises it never would be.
 */
export function recordFailure(
    gate: PollGate,
    account: string,
    reason: string,
    now: number,
    transport = false
): PollGate {
    const previous = gate[account];

    if (transport) {
        const transportFailures = (previous?.transportFailures ?? 0) + 1;

        return {
            ...gate,
            [account]: {
                failures: previous?.failures ?? 0,
                transportFailures,
                blockedUntil: now + Math.min(backoffMs(transportFailures), TRANSPORT_MAX_BACKOFF_MS),
                reason,
            },
        };
    }

    const failures = (previous?.failures ?? 0) + 1;

    return {
        ...gate,
        [account]: {
            failures,
            // The request reached Anthropic, so the network is demonstrably fine.
            transportFailures: 0,
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

export async function loadPollGate(provider: string): Promise<PollGate> {
    try {
        return (await usagePollStorage().getCacheFile<PollGate>(pollGateCacheKey(provider), GATE_TTL)) ?? {};
    } catch (err) {
        logger.debug({ err, provider }, "[usage] poll gate unreadable; treating every account as due");
        return {};
    }
}

export async function savePollGate(provider: string, gate: PollGate): Promise<void> {
    try {
        await usagePollStorage().putCacheFile(pollGateCacheKey(provider), gate, GATE_TTL);
    } catch (err) {
        // A gate that cannot be written only costs the next poll a retry.
        logger.debug({ err, provider }, "[usage] poll gate could not be saved");
    }
}

/**
 * Read-modify-write the gate under ONE lock.
 *
 * `clearPollGate` runs from `tools claude login` / `config` while a poll is already
 * in flight in another process. Unlocked, the poll's later write reinstates the block
 * a re-login just lifted (leaving a recovered account blocked for a full window), and
 * the inverse race erases a freshly recorded failure. Return null to leave the file
 * untouched.
 */
async function mutatePollGate(provider: string, mutate: (gate: PollGate) => PollGate | null): Promise<void> {
    const storage = usagePollStorage();
    const key = pollGateCacheKey(provider);

    try {
        await storage.withFileLock({
            file: usageCacheFilePath(key),
            fn: async () => {
                const next = mutate(await loadPollGate(provider));

                if (next) {
                    await storage.putCacheFile(key, next, GATE_TTL);
                }
            },
            timeout: 10_000,
        });
    } catch (err) {
        logger.debug({ err, provider }, "[usage] poll gate could not be updated");
    }
}

/**
 * Clear the backoff for one account (or all of them). Called after a re-login,
 * so a recovered account is polled on the very next run instead of waiting out
 * a 6h block earned while it was dead.
 */
/**
 * Apply ONE poll's outcomes to the gate, re-reading it inside the lock.
 *
 * The poll loads the gate, then spends seconds on the network. Writing the whole
 * object back afterwards reinstated a block that a re-login had cleared in the
 * meantime. Applying the delta to the CURRENT gate keeps both facts: the account
 * is no longer serving out its old backoff, and this poll's own failure counts once.
 */
export async function applyPollGateOutcomes(args: {
    /** Plugin id. Each provider owns its own gate file. */
    provider: string;
    successes: readonly string[];
    failures: readonly { account: string; reason: string; transport?: boolean }[];
    now: number;
    /** Configured account names, for pruning. Omit on a FILTERED poll — it knows nothing
     * about the accounts it excluded and pruning would wipe their backoff. */
    knownAccounts?: readonly string[];
}): Promise<void> {
    await mutatePollGate(args.provider, (gate) => {
        let next = args.knownAccounts ? pruneGate(gate, args.knownAccounts) : gate;

        for (const account of args.successes) {
            next = recordSuccess(next, account);
        }

        for (const { account, reason, transport } of args.failures) {
            next = recordFailure(next, account, reason, args.now, transport);
        }

        return next;
    });
}

export async function clearPollGate(provider: string, account?: string): Promise<void> {
    await mutatePollGate(provider, (gate) => {
        if (!account) {
            logger.debug(`[usage] poll gate cleared for all ${provider} accounts`);
            return {};
        }

        if (!gate[account]) {
            return null;
        }

        logger.debug(`[usage] poll gate cleared for ${provider}:${account}`);
        return recordSuccess(gate, account);
    });
}
