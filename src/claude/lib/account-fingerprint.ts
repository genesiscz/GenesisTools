import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * Which ACCOUNT a token really bills, checked against the label it is stored
 * under.
 *
 * The failure this exists to catch shipped silently on 2026-08-26: a
 * `login-long` capture for "uzivatel-a" completed in a browser logged into
 * martin, so eleven sessions launched as uzivatel-a all billed martin. Nothing
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

// ── Org-id fingerprint: the free, login-time variant ─────────────────────────

/**
 * The same question as above ("whose token is this?"), answered without spending
 * quota, so it can run on EVERY login instead of only in an opt-in doctor pass.
 *
 * The anchor fingerprint above needs a real completion and only tells you that two
 * labels collide — it cannot tell you, at capture time, that the token you are
 * about to save is the wrong one. This one can: the token-counting endpoint is
 * free, is inference-scoped (so a long-lived setup token reaches it), and its
 * RESPONSE carries `anthropic-organization-id`. Same org id ⇒ same account.
 *
 * Verified 2026-08-29 across 11 accounts: 11 distinct org ids, and the profile and
 * usage endpoints both answer a setup token with `permission_error … scope
 * requirement user:profile` — including for a KNOWN-GOOD account, so that refusal
 * is a scope fact, never an account fact.
 */

const COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";

/** Cheapest model every subscription tier can count against. */
const ORG_PROBE_MODEL = "claude-sonnet-5";

export type OrgProbeVerdict =
    /** The org answered. `organizationUuid` is set. */
    | "ok"
    /** Authenticated, but the org no longer permits OAuth — a lapsed subscription. */
    | "org-dead"
    /** The token itself was rejected (401, or a 403 that is not the org refusal). */
    | "invalid"
    /** Network failure or an unexpected status. Says nothing about the token. */
    | "unreachable";

export interface OrgProbe {
    verdict: OrgProbeVerdict;
    /** Present whenever the server named an org, including on the org-dead 403. */
    organizationUuid?: string;
    status: number;
    /** Trimmed error body, so a surprise gets logged rather than swallowed. */
    detail?: string;
}

/**
 * The org-level refusal. Distinct from the scope refusal a HEALTHY setup token
 * draws on the profile endpoint, and distinct from an expired-token 401. Reading
 * a scope refusal as a dead org is what would report a live account as expired.
 */
export function isOrgDeadRefusal(status: number, body: string): boolean {
    if (status !== 403) {
        return false;
    }

    return /not allowed for this organization/i.test(body);
}

/**
 * Read-only. Spends no quota and creates no provider-side history, so it is safe
 * in a login flow and in a poll loop.
 *
 * Works for BOTH token kinds: a long-lived setup token and a short-lived OAuth
 * access token both carry inference scope, so both get an org id back.
 */
export async function probeTokenOrg(token: string): Promise<OrgProbe> {
    try {
        const res = await fetch(COUNT_TOKENS_URL, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "anthropic-beta": "oauth-2025-04-20",
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
                "user-agent": "claude-cli/2.1.214 (external, cli)",
            },
            body: SafeJSON.stringify({
                model: ORG_PROBE_MODEL,
                messages: [{ role: "user", content: "hi" }],
            }),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });

        const organizationUuid = res.headers.get("anthropic-organization-id") ?? undefined;

        if (res.ok) {
            // A 2xx without the org header proves the token WORKS but not whose
            // it is, and `orgMismatch` treats a missing incoming side as "no
            // mismatch" — so calling that `ok` let an identified account accept
            // a token of unestablished ownership (PR #343 review t1 round 11).
            // Unreachable is the honest verdict: the probe did not answer the
            // question it was asked, so the identified path fails closed.
            if (!organizationUuid) {
                logger.debug(`[org-probe] ${res.status} with no anthropic-organization-id header`);
                return { verdict: "unreachable", status: res.status, detail: "no anthropic-organization-id header" };
            }

            return { verdict: "ok", organizationUuid, status: res.status };
        }

        const body = await res.text().catch(() => "");

        if (isOrgDeadRefusal(res.status, body)) {
            logger.debug(`[org-probe] org ${organizationUuid ?? "unknown"} no longer permits OAuth`);
            return { verdict: "org-dead", organizationUuid, status: res.status, detail: body.slice(0, 200) };
        }

        if (res.status === 401 || res.status === 403) {
            return { verdict: "invalid", organizationUuid, status: res.status, detail: body.slice(0, 200) };
        }

        // A 429 proves authentication but names no org, so it decides nothing here.
        logger.debug(`[org-probe] unexpected ${res.status}: ${body.slice(0, 200)}`);
        return { verdict: "unreachable", organizationUuid, status: res.status, detail: body.slice(0, 200) };
    } catch (error) {
        logger.debug({ error }, "[org-probe] request failed");
        return { verdict: "unreachable", status: 0 };
    }
}

/**
 * Same contract as `identityMismatch`: an UNPROVABLE identity is not a mismatch.
 * When either side is missing there is nothing to compare, and refusing there
 * would block the first login on every account that carries no fingerprint yet.
 */
export function orgMismatch(input: { storedOrg?: string; incomingOrg?: string }): boolean {
    if (!input.storedOrg || !input.incomingOrg) {
        return false;
    }

    return input.storedOrg !== input.incomingOrg;
}
