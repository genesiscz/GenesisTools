import * as p from "@clack/prompts";
import { Browser } from "@genesiscz/utils/browser";
import { determineAccountLabel } from "@genesiscz/utils/claude/account-label";
import {
    claudeOAuth,
    fetchOAuthProfile,
    type OAuthProfileResponse,
    type OAuthTokens,
} from "@genesiscz/utils/claude/auth";
import { copyToClipboard } from "@genesiscz/utils/clipboard";
import { logger, out } from "@genesiscz/utils/logger";
import pc from "picocolors";
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

/**
 * `Browser.open`, not a hard-coded `open`: that binary exists on macOS only, so
 * a Linux or Windows login aborted before the code prompt with a spawn error.
 * The shared opener also honours the configured preferred browser and reports a
 * failure instead of throwing, so the URL on screen stays usable (review t13).
 */
async function openInDefaultBrowser(url: string): Promise<void> {
    const result = await Browser.open(url);

    if (!result.success) {
        logger.warn({ url, error: result.error }, "could not open the authorization URL in a browser");
        p.log.warn(`Could not open a browser (${result.error ?? "unknown error"}). Open the URL above by hand.`);
    }
}

/**
 * THROWS `Cancelled` when the user aborts the browser-choice prompt.
 *
 * It returned a boolean before, and a caller that forgot to check it fell
 * straight through to the code prompt — which happened twice while this PR was
 * in review. `claude/index.ts` already maps a `Cancelled` message to a clean
 * exit 0, so throwing makes the abort impossible to ignore instead of relying
 * on every present and future caller remembering to test a return value.
 *
 * The signature IS the regression test: with `Promise<void>` there is no value
 * left to drop. A behavioural test was written and then removed — `mock.module`
 * is process-global in Bun, so stubbing `@clack/prompts` here broke
 * `src/utils/logger/out.test.ts`, which asserts on the REAL clack sentinel.
 */
export async function presentAuthUrl(authUrl: string, openUrl?: (url: string) => Promise<void>): Promise<void> {
    p.note(
        [
            "1. Open the URL below in your browser",
            "2. Log in with your Claude account (if needed)",
            "3. Click 'Authorize' to grant access",
            "4. Copy the code shown on the callback page",
            "   (format: code#state or just the code part)",
        ].join("\n"),
        "OAuth Login"
    );

    out.println();
    out.println(`  ${pc.cyan(authUrl)}`);
    out.println();

    // Never copy the URL unasked: whoever already opened it by hand is holding the
    // CODE in their clipboard, and clobbering that costs them the whole round-trip.
    const action = await p.select({
        message: "How do you want to open it?",
        options: [
            { value: "open", label: "Open in browser now" },
            { value: "copy", label: "Copy the URL to my clipboard", hint: "overwrites whatever is in it" },
            { value: "none", label: "Neither — I already have the code", hint: "clipboard untouched" },
        ],
    });

    if (p.isCancel(action)) {
        throw new Error("Cancelled");
    }

    if (action === "open") {
        await (openUrl ?? openInDefaultBrowser)(authUrl);
    } else if (action === "copy") {
        await copyToClipboard(authUrl, { silent: true });
        p.log.info("URL copied. After authorizing, copy the CODE from the callback page — that is what to paste next.");
    }
}

/**
 * Accept what the user actually has in the clipboard: the bare `code#state`, or
 * the whole callback URL (its `code`/`state` params are pulled out). Declining
 * the browser-open puts the AUTHORIZE url on the clipboard, so that exact
 * mis-paste is caught here instead of failing as "Invalid request format".
 */
export function normalizeAuthorizationCode(input: string): { code: string } | { error: string } {
    const trimmed = input.trim();

    if (!trimmed.startsWith("http")) {
        return { code: trimmed };
    }

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch (error) {
        logger.debug({ error }, "[oauth] pasted value starts with http but is not a parseable URL");
        return { error: "That looks like a URL but could not be parsed. Paste the code shown after authorizing." };
    }

    if (url.pathname.includes("/oauth/authorize")) {
        return {
            error: "That is the authorization URL (what we copied to your clipboard), not the code. Open it, click Authorize, then paste the code from the callback page.",
        };
    }

    const code = url.searchParams.get("code");

    if (!code) {
        return { error: "No `code` parameter in that URL. Paste the code shown after authorizing." };
    }

    const state = url.searchParams.get("state");
    return { code: state ? `${code}#${state}` : code };
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
    const code = await p.text({
        message: "Paste the authorization code:",
        placeholder: "code#state",
        validate: (val) => {
            if (!val?.trim()) {
                return "Code is required";
            }

            const normalized = normalizeAuthorizationCode(val);
            if ("error" in normalized) {
                return normalized.error;
            }
        },
    });

    if (p.isCancel(code)) {
        return { status: "cancelled" };
    }

    const normalized = normalizeAuthorizationCode(code as string);

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
