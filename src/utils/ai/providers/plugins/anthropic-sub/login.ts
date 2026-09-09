import * as p from "@clack/prompts";
import { determineAccountLabel } from "@genesiscz/utils/claude/account-label";
import {
    claudeOAuth,
    fetchOAuthProfile,
    type OAuthProfileResponse,
    type OAuthTokens,
} from "@genesiscz/utils/claude/auth";
import { logger, out } from "@genesiscz/utils/logger";
import pc from "picocolors";
import { presentAuthorizationUrl, readAuthorizationCode } from "../../../oauth/login-ui";
import type { AccountFlowContext, AccountIdentity, LoginOutcome } from "../../account-features";
import { accountFieldsFrom } from "../../account-fields";

/**
 * The Anthropic browser OAuth flow, moved out of `src/claude/commands/config.ts`
 * so `tools claude login` and `tools ai accounts login --provider claude` run the
 * same code. Nothing here writes to the config: the flow returns a
 * `LoginOutcome` and the CLI layer decides what to store.
 */

export async function generateAuthUrl(scopes?: string): Promise<string> {
    const spinner = p.spinner();
    spinner.start("Generating authorization URL...");
    const authUrl = await claudeOAuth.startLogin(scopes);
    spinner.stop("Authorization URL ready.");
    return authUrl;
}

export { normalizeAuthorizationCode } from "../../../oauth/login-ui";

export async function presentAuthUrl(authUrl: string, openUrl?: (url: string) => Promise<void>): Promise<void> {
    await presentAuthorizationUrl({ authUrl, provider: "Claude", openUrl });
}

/**
 * Why the code prompt produced no tokens.
 *
 * It used to answer `null` for all three outcomes, and every caller turned that
 * into `Error("Cancelled")` — the one message both entrypoints map to a clean
 * exit 0. An expired code or a network failure therefore reported the login as
 * cancelled AND exited 0 (PR #360 review r2 t3). `login-long` retries on either,
 * so the distinction is carried in the result rather than thrown from here.
 */
export type CodeExchange =
    | { status: "ok"; tokens: OAuthTokens }
    | { status: "cancelled" }
    | { status: "failed"; reason: string };

/**
 * The error a non-ok exchange deserves.
 *
 * `Cancelled` is load-bearing: both `tools claude` and `tools ai` map exactly
 * that message to exit 0, so it may only be used when the user actually aborted.
 * A failure gets its own message, and therefore exit 1.
 */
export function errorForExchange(exchange: Exclude<CodeExchange, { status: "ok" }>): Error {
    if (exchange.status === "cancelled") {
        return new Error("Cancelled");
    }

    return new Error(`Token exchange failed: ${exchange.reason}`);
}

export async function promptAndExchangeCode(opts: { expiresIn?: number } = {}): Promise<CodeExchange> {
    const normalized = await readAuthorizationCode();

    if (normalized === null) {
        return { status: "cancelled" };
    }

    // A value the prompt's own validator already rejects cannot reach here, so
    // this is a bad paste rather than an abort either way.
    if ("error" in normalized) {
        p.log.error(normalized.error);
        return { status: "failed", reason: normalized.error };
    }

    const spinner = p.spinner();
    spinner.start("Exchanging code for tokens...");
    try {
        const tokens = await claudeOAuth.exchangeCode(normalized.code, opts);
        spinner.stop("Tokens received.");
        return { status: "ok", tokens };
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        spinner.stop(`Token exchange failed: ${reason}`);
        logger.warn({ err }, "[oauth] authorization code exchange failed");
        return { status: "failed", reason };
    }
}

export async function fetchAndDisplayProfile(tokens: OAuthTokens): Promise<OAuthProfileResponse | undefined> {
    const spinner = p.spinner();
    spinner.start("Fetching account profile...");
    const profile = await fetchOAuthProfile(tokens.accessToken);
    spinner.stop("Profile fetched.");

    const infoLines: string[] = [];

    if (tokens.account) {
        infoLines.push(`${pc.dim("Account:")} ${pc.cyan(tokens.account.email)}`);
    }

    if (tokens.organization) {
        infoLines.push(`${pc.dim("Organization:")} ${tokens.organization.name}`);
    }

    if (profile) {
        const sub = profile.organization.subscription_status;
        const tier = profile.organization.rate_limit_tier;
        infoLines.push(`${pc.dim("Subscription:")} ${sub} (${tier})`);
    }

    infoLines.push(`${pc.dim("Scopes:")} ${tokens.scopes.join(", ")}`);
    infoLines.push(`${pc.dim("Expires:")} ${new Date(tokens.expiresAt).toLocaleString()}`);
    infoLines.push(`${pc.dim("Refresh:")} ${pc.green("available")} — token will auto-refresh`);

    p.note(infoLines.join("\n"), "Account Authorized");
    return profile;
}

/** Everything the browser round-trip proved about who authorized. */
export function identityFromLogin(tokens: OAuthTokens, profile: OAuthProfileResponse | undefined): AccountIdentity {
    return {
        email: profile?.account.email ?? tokens.account?.email,
        accountUuid: profile?.account.uuid ?? tokens.account?.uuid,
        organizationUuid: profile?.organization.uuid ?? tokens.organization?.uuid,
        plan: determineAccountLabel(profile),
    };
}

export async function anthropicLogin(ctx: AccountFlowContext): Promise<LoginOutcome> {
    if (!ctx.interactive) {
        throw new Error(
            "Claude login needs an interactive terminal: the callback page prints a code that has to be pasted."
        );
    }

    const authUrl = await generateAuthUrl();

    await presentAuthUrl(authUrl, ctx.openUrl);

    const exchange = await promptAndExchangeCode();

    if (exchange.status !== "ok") {
        if (exchange.status === "cancelled") {
            // `Cancelled` exits 0 silently at both entrypoints, so the abort needs a
            // line of its own — `tools claude login` printed one before the flow
            // moved here, and `loginSecondary` still does (gap/cli).
            out.println(pc.dim("Login cancelled."));
        }

        throw errorForExchange(exchange);
    }

    const profile = await fetchOAuthProfile(exchange.tokens.accessToken);

    return anthropicLoginOutcome({ tokens: exchange.tokens, profile });
}

/**
 * The pure half of the login: what the exchanged tokens and the profile mean,
 * with no browser, no prompt and no network. Split out the way `codexLoginOutcome`
 * is, so the fingerprint it stores is testable from invented claims.
 */
export function anthropicLoginOutcome(input: {
    tokens: OAuthTokens;
    profile: OAuthProfileResponse | undefined;
}): LoginOutcome {
    const { tokens, profile } = input;
    const identity = identityFromLogin(tokens, profile);
    const label = determineAccountLabel(profile);

    return {
        provider: "anthropic-sub",
        credentials: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            refreshExpiresAt: tokens.refreshExpiresAt,
        },
        identity,
        suggestedName: tokens.account?.email?.split("@")[0]?.toLowerCase() ?? "personal",
        suggestedLabel: label,
        accountFields: {
            label,
            // The uuids come off the RESOLVED identity, which falls back to the
            // OAuth token claims. Only `accountFields` reaches the stored account,
            // so gating them on the profile meant a login during a profile outage
            // saved working credentials with no fingerprint at all, and the next
            // login by a stranger had nothing to contradict (review r2 t2).
            ...accountFieldsFrom(identity),
            // The plan reading, in contrast, genuinely only exists in the profile.
            // Storing it here is what lets a just-renewed account be polled
            // immediately instead of waiting out the 6h recheck window with a
            // stale "claude_free" that keeps it suppressed.
            ...(profile
                ? {
                      subscriptionCreatedAt: profile.organization.subscription_created_at || undefined,
                      subscriptionPlan: profile.organization.organization_type,
                      subscriptionStatus: profile.organization.subscription_status,
                      subscriptionCheckedAt: Date.now(),
                  }
                : {}),
        },
    };
}
