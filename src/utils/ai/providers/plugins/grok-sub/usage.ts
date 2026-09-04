import { logger } from "@genesiscz/utils/logger";
import type { AccountEntry } from "../../../config/schema";
import { resolveGrokSubToken } from "../../../grok/account";
import { GrokSubscriptionClient } from "../../../grok/client";
import type { GrokBillingConfig, GrokSettings } from "../../../grok/types";
import type { AccountUsageFeature, AccountUsageSnapshot, LimitWindow, UsagePollOptions } from "../../account-features";

/**
 * `accounts.usage` for the SuperGrok subscription (spec 2026-09-04 section 6.7).
 *
 * xAI reports no percentage windows, only a monthly billing credit, so the single window
 * is a `credit` one carrying money. `used` and `monthlyLimit` are in minor units (the
 * billing formatter divides by 100), and the percent is derived here so a reader that only
 * understands bars still has something to draw.
 *
 * The floor between two polls is 300s: a billing figure moves slowly, and the endpoint is
 * behind the same CLI proxy the chat path uses.
 */

const MIN_INTERVAL_MS = 300_000;

const GROK_SUB = "grok-sub";

/** The parts of the client a poll uses. Injected so tests never reach the network. */
export interface GrokUsageClient {
    getBilling(): Promise<GrokBillingConfig>;
    getSettings(): Promise<GrokSettings>;
}

export interface GrokUsageDeps {
    resolveToken?: typeof resolveGrokSubToken;
    createClient?(args: { token: string; authPath: string; probe: boolean }): GrokUsageClient;
}

export function toCreditWindow(billing: GrokBillingConfig): LimitWindow {
    const usedMinor = billing.used?.val ?? 0;
    const limitMinor = billing.monthlyLimit?.val ?? 0;

    return {
        key: "monthly",
        label: "Monthly credit",
        kind: "credit",
        percentUsed: limitMinor > 0 ? (usedMinor / limitMinor) * 100 : 0,
        ...(billing.billingPeriodEnd ? { resetsAt: billing.billingPeriodEnd } : {}),
        money: {
            usedMinor,
            currency: "USD",
            exponent: 2,
            ...(limitMinor > 0 ? { limitMinor } : {}),
        },
    };
}

export async function pollGrokAccount(
    account: AccountEntry,
    opts: UsagePollOptions = {},
    deps: GrokUsageDeps = {}
): Promise<AccountUsageSnapshot> {
    const fetchedAt = new Date().toISOString();
    const base: AccountUsageSnapshot = {
        provider: GROK_SUB,
        accountId: account.id,
        accountName: account.name,
        fetchedAt,
        limits: [],
        ...(account.label === undefined ? {} : { label: account.label }),
    };

    const resolve = deps.resolveToken ?? resolveGrokSubToken;
    // `noRefresh` is the guard at the line that spends the grant: the OIDC refresh
    // rotates a token in a file the Grok CLI owns, so a diagnosis must never trigger it.
    const resolved = await resolve(account.name, {
        ...(account.credentials.authFile === undefined ? {} : { authFile: account.credentials.authFile }),
        ...(opts.probe === undefined ? {} : { noRefresh: opts.probe }),
    });

    const create =
        deps.createClient ??
        ((args: { token: string; authPath: string; probe: boolean }) => new GrokSubscriptionClient(args));
    const client = create({ token: resolved.token, authPath: resolved.authPath, probe: opts.probe ?? false });

    const [billing, settings] = await Promise.all([client.getBilling(), client.getSettings()]);
    logger.debug({ account: account.name, tier: settings.subscription_tier_display }, "[usage] grok billing read");

    const planName = settings.subscription_tier_display;

    return {
        ...base,
        limits: [toCreditWindow(billing)],
        native: { billing, settings },
        ...(planName === undefined ? {} : { plan: { name: planName } }),
    };
}

export const grokUsage: AccountUsageFeature = {
    poll: pollGrokAccount,
    minIntervalMs: MIN_INTERVAL_MS,
};
