import { effectiveLeftPct, extractCompactLimits } from "@app/claude/lib/usage/compact-limits";
import { fableStatusForAccount, weeklyStatusForAccount } from "@app/claude/lib/usage/fable-guard";
import type { Cached } from "@app/claude/lib/usage/shared-cache";
import type { TokenVerdict } from "@genesiscz/utils/claude/token-verify";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";

/**
 * `tools claude doctor` — find pinned sessions that SILENTLY bill the wrong
 * account. Claude Code falls back to the keychain login whenever the pinned
 * token's request fails (401 expired token, 429 exhausted bucket), so a
 * session can look pinned while every turn bills the keychain. All of this
 * is detectable from outside: the process env carries the pin, the config
 * carries the current token, and the usage cache carries the buckets.
 *
 * 🛑 This is a DIAGNOSTIC: it must never mutate. Callers resolve tokens with
 * `noRefresh` and read the usage cache with `peekSharedUsage`, so diagnosing
 * an account can never spend its single-use refresh token.
 */

/** One claude process that carries a `tools cc` pin in its env. */
export interface PinnedProcess {
    pid: number;
    tty: string;
    account: string;
    token: string;
    /** From `--model` argv when present. */
    model?: string;
    /** Agent-team teammate (`--agent-id`) rather than a user-facing session. */
    isAgent: boolean;
}

/** All processes sharing one (account, token) pair — one auth identity. */
export interface SessionGroup {
    account: string;
    token: string;
    processes: PinnedProcess[];
}

export type DoctorProblem =
    | "expired-token" // token 401s → every turn bills the keychain
    | "stale-token" // token differs from config (works today, orphaned by the next recapture)
    | "unknown-account" // pin names an account the config no longer has
    | "fable-blocked" // Fable session, account's Fable bucket dead → bills the keychain
    | "weekly-blocked" // account's all-model weekly dead → every turn 429s → bills the keychain
    | "session-blocked"; // 5h window spent → every turn 429s until it resets → bills the keychain

/** Checks that could NOT be run — reported as "unverified", never as green. */
export type DoctorUncertainty =
    | "probe-unreachable" // token liveness unknown (network/API failure)
    | "no-usage-data" // account absent from the usage cache — bucket state unknown
    | "usage-data-stale"; // cache too old / entry errored or replayed — bucket state unknown

/**
 * A bucket verdict is a claim about CURRENT billing, so the snapshot behind
 * it must be recent. The daemon polls every ~30s; anything older than this
 * is a coin flip, not evidence.
 */
export const MAX_USAGE_AGE_MS = 15 * 60 * 1000;

export interface Diagnosis {
    group: SessionGroup;
    problems: DoctorProblem[];
    unverified: DoctorUncertainty[];
}

/**
 * The LAUNCH-time model from argv — every form the launcher accepts:
 * `--model X`, `--model=X`, `-m X`. NOTE: an in-session `/model` switch does
 * not change argv, so this is the model the session STARTED on (documented
 * limitation — the fix for a flagged session is a relaunch).
 */
export function modelFromArgv(words: string[]): string | undefined {
    for (let i = 0; i < words.length; i++) {
        if (words[i] === "--model" || words[i] === "-m") {
            return words[i + 1];
        }

        if (words[i].startsWith("--model=")) {
            return words[i].slice("--model=".length);
        }
    }

    return undefined;
}

/**
 * Parse `ps eww -o pid=,tty=,command=` output lines. `eww` appends the
 * process's env as KEY=VALUE words after the argv, which is where the pin
 * (TOOLS_CLAUDE_ACCOUNT) and token live. Lines without a pin are dropped.
 */
export function parsePinnedProcesses(psOutput: string): PinnedProcess[] {
    const processes: PinnedProcess[] = [];

    for (const line of psOutput.split("\n")) {
        const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);

        if (!match) {
            continue;
        }

        const words = match[3].split(/\s+/);
        const envOf = (key: string) => words.find((w) => w.startsWith(`${key}=`))?.slice(key.length + 1);

        const account = envOf("TOOLS_CLAUDE_ACCOUNT");
        const token = envOf("CLAUDE_CODE_OAUTH_TOKEN");

        if (!account || !token) {
            continue;
        }

        processes.push({
            pid: Number(match[1]),
            tty: match[2],
            account,
            token,
            model: modelFromArgv(words),
            isAgent: words.some((w) => w === "--agent-id" || w.startsWith("--agent-id=")),
        });
    }

    return processes;
}

/** Group processes by auth identity (account + exact token). */
export function groupSessions(processes: PinnedProcess[]): SessionGroup[] {
    const groups = new Map<string, SessionGroup>();

    for (const proc of processes) {
        const key = `${proc.account} ${proc.token}`;
        const group = groups.get(key) ?? { account: proc.account, token: proc.token, processes: [] };
        group.processes.push(proc);
        groups.set(key, group);
    }

    return [...groups.values()];
}

/**
 * Assign problems to one session group. `tokenVerdict` comes from a read-only
 * probe (probeLongLivedToken); bucket states come from the usage cache.
 * "unreachable" never becomes a verdict — it is reported as unverified.
 */
export function diagnoseGroup(
    group: SessionGroup,
    accounts: AIAccountEntry[],
    cached: Cached | null,
    tokenVerdict: TokenVerdict,
    now: Date = new Date()
): Diagnosis {
    const problems: DoctorProblem[] = [];
    const unverified: DoctorUncertainty[] = [];
    const account = accounts.find((a) => a.name === group.account);

    if (!account) {
        problems.push("unknown-account");
    } else if (account.tokens.longLivedToken && group.token !== account.tokens.longLivedToken) {
        problems.push("stale-token");
    }

    if (tokenVerdict === "invalid") {
        problems.push("expired-token");
    } else if (tokenVerdict === "unreachable") {
        // Liveness UNKNOWN is not liveness OK — surface it, never absorb it.
        unverified.push("probe-unreachable");
    }

    // Bucket checks only make sense when the token itself still authenticates,
    // and only on a FRESH, successful snapshot — the fable-guard helpers
    // report "available" for unknown accounts by design (a launch gate must
    // not block blindly), and the cache is served at any age with possibly
    // replayed entries. A doctor claiming CURRENT billing must not call
    // unknown or stale healthy (nor red).
    if (tokenVerdict !== "invalid") {
        const entry = cached?.accounts.find((a) => a.accountName === group.account);

        if (!entry?.usage) {
            unverified.push("no-usage-data");
        } else if (entry.error || entry.stale || !cached || now.getTime() - cached.fetchedAt > MAX_USAGE_AGE_MS) {
            unverified.push("usage-data-stale");
        } else if (!weeklyStatusForAccount(cached.accounts, group.account, now).available) {
            problems.push("weekly-blocked");
        } else if (effectiveLeftPct(extractCompactLimits(entry.usage).session, now) <= 0) {
            problems.push("session-blocked");
        } else if (
            group.processes.some((proc) => proc.model?.startsWith("claude-fable")) &&
            !fableStatusForAccount(cached.accounts, group.account, now).available
        ) {
            problems.push("fable-blocked");
        }
    }

    return { group, problems, unverified };
}

/** Problems that mean turns are billing the keychain RIGHT NOW. */
export function billsKeychain(problems: DoctorProblem[]): boolean {
    return problems.some(
        (p) => p === "expired-token" || p === "fable-blocked" || p === "weekly-blocked" || p === "session-blocked"
    );
}

/**
 * The identity absorbing fallback turns, resolved with AUTHORITY over
 * latency: keychain credentials first, the offline ~/.claude.json marker only
 * as fallback. A resolver failure degrades to the marker — it must never abort
 * doctor. Injectable for tests; the command binds the real keychain helpers.
 */
export async function resolveKeychainIdentity(deps: {
    readPayload: () => Promise<{ claudeAiOauth?: unknown } | null>;
    resolveUuid: (oauth: unknown) => Promise<string | undefined>;
    offlineUuid: () => Promise<string | undefined>;
    onDegrade: (err: unknown) => void;
}): Promise<string | undefined> {
    let uuid: string | undefined;

    try {
        const payload = await deps.readPayload();
        uuid = payload?.claudeAiOauth ? await deps.resolveUuid(payload.claudeAiOauth) : undefined;
    } catch (err) {
        deps.onDegrade(err);
    }

    return uuid ?? (await deps.offlineUuid());
}

/**
 * The configured account owning a keychain identity, or undefined when the
 * identity is unknown. The `uuid !== undefined` guard is the whole point:
 * `find(a => a.secondary?.accountUuid === undefined)` matches the FIRST
 * account that has no secondary login, so an unmanaged keychain would be
 * attributed to whichever account happens to sit first in the config.
 */
export function accountOwningKeychain(accounts: AIAccountEntry[], uuid: string | undefined): string | undefined {
    if (!uuid) {
        return undefined;
    }

    return accounts.find((a) => a.secondary?.accountUuid === uuid)?.name;
}

export const UNCERTAINTY_TEXT: Record<DoctorUncertainty, string> = {
    "probe-unreachable": "could not verify the token (probe unreachable) — liveness unknown",
    "no-usage-data": "no usage data for this account — bucket state unknown",
    "usage-data-stale": "usage snapshot too old or replayed — bucket state unknown (wait for the next poll)",
};

/**
 * What went wrong. These describe the FAILURE, not its consequence: whether a
 * failing pin lands on someone else's bill or simply dies depends on there
 * being a keychain login at all, which `fallbackSuffix` states separately.
 */
export const PROBLEM_TEXT: Record<DoctorProblem, string> = {
    "expired-token": "token expired (401) — every turn falls back to the keychain login",
    "stale-token": "token differs from config — launched before the last recapture",
    "unknown-account": "pin names an account the config no longer has",
    "fable-blocked": "Fable bucket exhausted — Fable turns 429 and fall back to the keychain login",
    "weekly-blocked": "weekly quota exhausted — every turn 429s and falls back to the keychain login",
    "session-blocked": "5h window exhausted — every turn 429s and falls back until the window resets",
};

/**
 * Who actually absorbs the fallback. With no keychain login there is nothing
 * to fall back ONTO, so the turns just fail — saying "billing X" there would
 * be a fabricated claim.
 */
export function fallbackSuffix(problem: DoctorProblem, keychainLabel: string | undefined): string {
    if (!billsKeychain([problem])) {
        return "";
    }

    return keychainLabel ? ` → billing ${keychainLabel}` : " → no keychain login, so these turns just fail";
}
