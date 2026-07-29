import type { AiProxyAccountConfig, AiProxyConfig } from "@app/ai-proxy/lib/types";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import {
    type AccountRef,
    accountRef,
    isAccountRef,
    type Referrer,
    refToId,
    registerExternalRefScanner,
} from "@genesiscz/utils/ai/config/refs";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { logger } from "@genesiscz/utils/logger";

/**
 * ai-proxy links its provider entries to AI-config accounts by REF, not by copy.
 *
 * The old link was `grok.accountName` / `anthropicSub.accountName` /
 * `openaiSub.accountName`: a human handle, resolved by name at request time.
 * Renaming an account in `tools ai config` silently broke the proxy's billing
 * link, and nothing in the AI config could tell you the proxy was pointing at it
 * (`referrersOf` walks the AI config only). Both problems are the same problem —
 * the link is not addressable — so it becomes `@account/<immutable id>` plus a
 * scanner that publishes those links back to `referrersOf`.
 *
 * Absorption is FIRST-TIME here: no earlier phase ever wrote a proxy-side id, so
 * `backfillProxyAccountRefs` resolves the legacy name ONCE, writes the ref back
 * and logs the drift. The name fields stay for display and for configs this
 * build has not written yet.
 */

/** Provider types whose upstream credential is an AI-config account, keyed by the field holding its name. */
const LEGACY_NAME_FIELDS = ["grok", "anthropicSub", "openaiSub"] as const;

/** The AI-config account NAME an entry links by, from the pre-ref name fields. */
export function legacyAccountNameOf(account: AiProxyAccountConfig): string | undefined {
    for (const field of LEGACY_NAME_FIELDS) {
        const name = account[field]?.accountName;

        if (name) {
            return name;
        }
    }

    return undefined;
}

export function proxyAccountRefOf(account: AiProxyAccountConfig): AccountRef | undefined {
    return isAccountRef(account.account) ? account.account : undefined;
}

/**
 * The AccountEntry this proxy entry bills. Ref first (immutable), legacy name
 * second, so a config this build has not rewritten yet keeps working.
 */
export function resolveProxyAccountEntry(
    account: AiProxyAccountConfig,
    store: AiConfigStore
): AccountEntry | undefined {
    const ref = proxyAccountRefOf(account);

    if (ref) {
        const byId = store.account(refToId(ref));

        if (byId) {
            return byId;
        }

        logger.warn(
            { proxyAccount: account.name, ref },
            "ai-proxy: account ref points at an AI-config account that no longer exists"
        );
    }

    const name = legacyAccountNameOf(account);
    return name ? store.account(name) : undefined;
}

export interface AccountRefDrift {
    proxyAccount: string;
    accountName: string;
    ref: AccountRef;
}

export interface BackfillResult {
    accounts: AiProxyAccountConfig[];
    drifts: AccountRefDrift[];
}

/**
 * Write `@account/<id>` onto every entry that still links by name only.
 *
 * Pure over the account list — the caller decides whether to persist, so a read
 * path (`models`, `status`) can resolve refs without a config write.
 */
export function backfillProxyAccountRefs(accounts: AiProxyAccountConfig[], store: AiConfigStore): BackfillResult {
    const drifts: AccountRefDrift[] = [];

    const next = accounts.map((account) => {
        if (proxyAccountRefOf(account)) {
            return account;
        }

        const name = legacyAccountNameOf(account);

        if (!name) {
            return account;
        }

        const entry = store.account(name);

        if (!entry) {
            logger.warn(
                { proxyAccount: account.name, accountName: name },
                "ai-proxy: no AI-config account by that name — leaving the legacy name link in place"
            );
            return account;
        }

        const ref = accountRef(entry.id);
        drifts.push({ proxyAccount: account.name, accountName: name, ref });

        return { ...account, account: ref };
    });

    return { accounts: next, drifts };
}

/**
 * Backfill the refs ONCE and persist them. Called from the serve bootstrap, so
 * the rewrite happens on a path that already writes nothing per request.
 *
 * Never fatal: a proxy whose AI config is missing or unreadable still serves the
 * accounts whose credentials live in its own config.
 */
export async function ensureProxyAccountRefs(io: {
    load: () => Promise<AiProxyConfig>;
    save: (config: AiProxyConfig) => Promise<void>;
}): Promise<AiProxyConfig> {
    const config = await io.load();

    try {
        const store = await AiConfigStore.load();
        const { accounts, drifts } = backfillProxyAccountRefs(config.accounts, store);

        if (drifts.length === 0) {
            return config;
        }

        const next = { ...config, accounts };
        await io.save(next);
        logger.info({ drifts }, "ai-proxy: absorbed name-based account links into @account refs");

        return next;
    } catch (err) {
        logger.warn({ err }, "ai-proxy: could not absorb account refs — keeping the name-based links");
        return config;
    }
}

/**
 * `referrersOf` answers "what breaks if I delete this account". Without this
 * scanner it answers it for the AI config alone, and deleting an account the
 * proxy bills would look free.
 */
export async function scanAiProxyAccountRefs(load: () => Promise<AiProxyConfig>): Promise<Referrer[]> {
    const found: Referrer[] = [];

    try {
        const config = await load();

        config.accounts.forEach((account, index) => {
            const ref = proxyAccountRefOf(account);

            if (ref) {
                found.push({ path: `accounts[${index}].account`, ref });
            }
        });
    } catch (err) {
        // A missing or unreadable proxy config must not break `tools ai config link`.
        logger.debug({ err }, "ai-proxy: ref scan could not read the proxy config");
    }

    return found;
}

let scannerRegistered = false;

/**
 * Register the scanner. Idempotent, and takes its loader by argument so the
 * scanner never pulls the config store into a process that does not use it.
 */
export function registerAiProxyRefScanner(load: () => Promise<AiProxyConfig>): void {
    if (scannerRegistered) {
        return;
    }

    registerExternalRefScanner("ai-proxy", () => scanAiProxyAccountRefs(load));
    scannerRegistered = true;
}

export function _resetAiProxyRefScannerForTest(): void {
    scannerRegistered = false;
}
