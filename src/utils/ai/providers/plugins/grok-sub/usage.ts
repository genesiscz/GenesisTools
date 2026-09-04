import { withTimeout } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import type { AccountEntry } from "../../../config/schema";
import { resolveGrokSubToken } from "../../../grok/account";
import { GrokSubscriptionClient } from "../../../grok/client";
import type { GrokCreditsConfig, GrokSettings } from "../../../grok/types";
import type {
    AccountUsageFeature,
    AccountUsageSnapshot,
    LimitKind,
    LimitWindow,
    UsagePollOptions,
} from "../../account-features";

/**
 * `accounts.usage` for the SuperGrok subscription (spec 2026-09-04 section 6.7).
 *
 * The source is `GET /billing?format=credits`, the same call the Grok CLI's own `/usage`
 * pane makes. Plain `/billing` answers a different question, on-demand and prepaid MONEY
 * for the calendar month, and on a pure subscription every figure in it stays zero. That
 * is why this used to report 0% for an account that had spent most of its week.
 *
 * The percentages are whole numbers over the CURRENT period, which xAI reports as a
 * rolling seven days (`USAGE_PERIOD_TYPE_WEEKLY`) rather than a calendar month.
 *
 * The floor between two polls is 300s: the figure moves slowly, and the endpoint is behind
 * the same CLI proxy the chat path uses.
 */

const MIN_INTERVAL_MS = 300_000;

/**
 * Ceiling on the two reads one poll makes. `GrokSubscriptionClient.fetch` hands its
 * request straight to `fetch()` with no signal, so a hung proxy would otherwise keep
 * `Promise.all` (and with it the whole daemon round) pending forever.
 */
const REQUEST_TIMEOUT_MS = 20_000;

const GROK_SUB = "grok-sub";

/** The parts of the client a poll uses. Injected so tests never reach the network. */
export interface GrokUsageClient {
    getCredits(): Promise<GrokCreditsConfig>;
    getSettings(): Promise<GrokSettings>;
}

export interface GrokUsageDeps {
    resolveToken?: typeof resolveGrokSubToken;
    createClient?(args: { token: string; authPath: string; probe: boolean }): GrokUsageClient;
}

type PeriodKind = Extract<LimitKind, "weekly" | "monthly">;

/**
 * `USAGE_PERIOD_TYPE_WEEKLY` is the only value observed on a live account. The CLI binary
 * carries a `WEEKLY`/`MONTHLY` label pair, so match on the suffix rather than on the whole
 * constant, and treat anything else as weekly, which is what a subscription bills on.
 */
function periodKindOf(type: string | undefined): PeriodKind {
    if (type?.endsWith("WEEKLY")) {
        return "weekly";
    }

    if (type?.endsWith("MONTHLY")) {
        return "monthly";
    }

    logger.debug({ type }, "[usage] grok reported an unrecognised usage period type, reading it as weekly");
    return "weekly";
}

/** `GrokBuild` reads as `Grok Build`. A product nobody has seen yet still gets a label. */
function productLabel(product: string): string {
    return product.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/** Every window shares the period the percentages were measured over. */
function resetOf(credits: GrokCreditsConfig): string | undefined {
    return credits.currentPeriod?.end ?? credits.billingPeriodEnd;
}

/** The whole subscription allowance: the one number that decides whether work can continue. */
export function toSubscriptionWindow(credits: GrokCreditsConfig): LimitWindow {
    const kind = periodKindOf(credits.currentPeriod?.type);
    const resetsAt = resetOf(credits);

    return {
        key: kind,
        label: kind === "weekly" ? "Weekly" : "Monthly",
        kind,
        percentUsed: credits.creditUsagePercent ?? 0,
        ...(resetsAt === undefined ? {} : { resetsAt }),
    };
}

/** The same allowance split by product, which names what actually spent it. */
export function toProductWindows(credits: GrokCreditsConfig): LimitWindow[] {
    const resetsAt = resetOf(credits);

    return (credits.productUsage ?? []).map((entry) => ({
        key: `product:${entry.product.toLowerCase()}`,
        label: productLabel(entry.product),
        kind: "scoped" as const,
        percentUsed: entry.usagePercent,
        ...(resetsAt === undefined ? {} : { resetsAt }),
    }));
}

/**
 * Pay-as-you-go money, omitted entirely when the account has no on-demand spend. A
 * subscription with no top-up configured reports zero for all of it, and an empty money
 * bar beside a real percentage bar reads as "you have used nothing".
 */
export function toCreditWindow(credits: GrokCreditsConfig): LimitWindow | undefined {
    const usedMinor = credits.onDemandUsed?.val ?? 0;
    const limitMinor = credits.onDemandCap?.val ?? 0;

    if (limitMinor <= 0 && usedMinor <= 0) {
        return undefined;
    }

    const prepaidMinor = credits.prepaidBalance?.val ?? 0;
    const resetsAt = resetOf(credits);

    return {
        key: "credit",
        label: prepaidMinor > 0 ? `Pay-as-you-go (prepaid $${(prepaidMinor / 100).toFixed(2)})` : "Pay-as-you-go",
        kind: "credit",
        percentUsed: limitMinor > 0 ? (usedMinor / limitMinor) * 100 : 0,
        ...(resetsAt === undefined ? {} : { resetsAt }),
        money: {
            usedMinor,
            currency: "USD",
            exponent: 2,
            ...(limitMinor > 0 ? { limitMinor } : {}),
        },
    };
}

/** Display order: the allowance, then what spent it, then money if there is any. */
export function toGrokLimits(credits: GrokCreditsConfig): LimitWindow[] {
    const credit = toCreditWindow(credits);

    return [toSubscriptionWindow(credits), ...toProductWindows(credits), ...(credit === undefined ? [] : [credit])];
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

    const [credits, settings] = await withTimeout(
        Promise.all([client.getCredits(), client.getSettings()]),
        REQUEST_TIMEOUT_MS,
        new Error(`grok usage read timed out after ${REQUEST_TIMEOUT_MS}ms`)
    );
    logger.debug(
        {
            account: account.name,
            tier: settings.subscription_tier_display,
            percentUsed: credits.creditUsagePercent,
            period: credits.currentPeriod?.type,
        },
        "[usage] grok subscription usage read"
    );

    const planName = settings.subscription_tier_display;

    return {
        ...base,
        limits: toGrokLimits(credits),
        native: { credits, settings },
        ...(planName === undefined ? {} : { plan: { name: planName } }),
    };
}

export const grokUsage: AccountUsageFeature = {
    poll: pollGrokAccount,
    minIntervalMs: MIN_INTERVAL_MS,
};
