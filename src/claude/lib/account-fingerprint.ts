import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * Which ACCOUNT a token really bills, checked against the label it is stored
 * under.
 *
 * The failure this exists to catch shipped silently on 2026-08-26: a
 * `login-long` capture for "uzivatel-a" completed in a browser logged into
 * foltyn, so eleven sessions launched as uzivatel-a all billed foltyn. Nothing
 * in the config, the process env, or the statusline could see it — every layer
 * repeats the label it was given. Only the server knows.
 *
 * The server tells you through the unified rate-limit headers: each account has
 * its own 5h and 7d window anchors. Two tokens reporting the SAME pair of reset
 * epochs are the same account, because those anchors are set by that account's
 * own first use of each window.
 *
 * 🛑 This spends quota (one 1-token completion per token), so it is never part
 * of a default diagnostic run — `tools claude doctor --identity` opts in.
 */

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const PROBE_TIMEOUT_MS = 20_000;

export interface AccountFingerprint {
    /** Epoch seconds when the 5h window resets — an account-specific anchor. */
    fiveHourReset: string | null;
    /** Epoch seconds when the 7d window resets. */
    sevenDayReset: string | null;
    fiveHourUtilization: string | null;
    sevenDayUtilization: string | null;
}

export interface FingerprintResult {
    account: string;
    fingerprint: AccountFingerprint | null;
    /** Why no fingerprint could be taken (HTTP status text or error message). */
    error: string | null;
}

/**
 * Identity key for grouping. Utilization is deliberately NOT part of it: it
 * moves between two probes taken seconds apart, which would split one account
 * into two "identities" and hide the duplicate this check exists to find.
 */
export function fingerprintKey(fp: AccountFingerprint): string | null {
    if (!fp.fiveHourReset && !fp.sevenDayReset) {
        return null;
    }

    return `${fp.fiveHourReset ?? "?"}|${fp.sevenDayReset ?? "?"}`;
}

export interface DuplicateGroup {
    key: string;
    accounts: string[];
}

/**
 * Accounts whose tokens report the same window anchors — i.e. one real account
 * stored under several names. Single-account groups are not returned: they are
 * the normal case.
 */
export function findDuplicateAccounts(results: FingerprintResult[]): DuplicateGroup[] {
    const byKey = new Map<string, string[]>();

    for (const result of results) {
        if (!result.fingerprint) {
            continue;
        }

        const key = fingerprintKey(result.fingerprint);

        if (!key) {
            continue;
        }

        const list = byKey.get(key) ?? [];

        // A repeated label is one account probed twice, not a duplicate identity.
        if (!list.includes(result.account)) {
            list.push(result.account);
        }

        byKey.set(key, list);
    }

    return [...byKey.entries()]
        .filter(([, accounts]) => accounts.length > 1)
        .map(([key, accounts]) => ({ key, accounts: [...accounts].sort() }));
}

export function fingerprintFromHeaders(headers: Headers): AccountFingerprint {
    return {
        fiveHourReset: headers.get("anthropic-ratelimit-unified-5h-reset"),
        sevenDayReset: headers.get("anthropic-ratelimit-unified-7d-reset"),
        fiveHourUtilization: headers.get("anthropic-ratelimit-unified-5h-utilization"),
        sevenDayUtilization: headers.get("anthropic-ratelimit-unified-7d-utilization"),
    };
}

/**
 * One 1-token completion, read for its rate-limit headers.
 *
 * A 429 still carries the headers and still identifies the account, so it is a
 * usable fingerprint rather than a failure — an exhausted account is exactly
 * the one you most want to attribute correctly.
 */
export async function fingerprintToken(account: string, token: string): Promise<FingerprintResult> {
    try {
        const res = await fetch(MESSAGES_URL, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "anthropic-beta": "oauth-2025-04-20",
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
                "user-agent": "claude-cli/2.1.214 (external, cli)",
            },
            body: SafeJSON.stringify({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 1,
                messages: [{ role: "user", content: "hi" }],
            }),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });

        const fingerprint = fingerprintFromHeaders(res.headers);

        if (!res.ok && res.status !== 429) {
            const body = await res.text().catch(() => "");
            logger.debug({ account, status: res.status }, "[fingerprint] probe rejected");
            return { account, fingerprint: null, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
        }

        if (!fingerprintKey(fingerprint)) {
            return { account, fingerprint: null, error: "response carried no rate-limit headers" };
        }

        return { account, fingerprint, error: null };
    } catch (error) {
        logger.debug({ error, account }, "[fingerprint] probe failed");
        return { account, fingerprint: null, error: error instanceof Error ? error.message : String(error) };
    }
}
