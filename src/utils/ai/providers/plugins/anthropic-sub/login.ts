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

export async function promptAndExchangeCode(opts: { expiresIn?: number } = {}): Promise<OAuthTokens | null> {
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
        return null;
    }

    const normalized = normalizeAuthorizationCode(code as string);

    if ("error" in normalized) {
        p.log.error(normalized.error);
        return null;
    }

    const spinner = p.spinner();
    spinner.start("Exchanging code for tokens...");
    try {
        const tokens = await claudeOAuth.exchangeCode(normalized.code, opts);
        spinner.stop("Tokens received.");
        return tokens;
    } catch (err) {
        spinner.stop(`Token exchange failed: ${err}`);
        return null;
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

    const tokens = await promptAndExchangeCode();

    if (!tokens) {
        throw new Error("Cancelled");
    }

    const profile = await fetchOAuthProfile(tokens.accessToken);
    const label = determineAccountLabel(profile);

    return {
        provider: "anthropic-sub",
        credentials: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            refreshExpiresAt: tokens.refreshExpiresAt,
        },
        identity: identityFromLogin(tokens, profile),
        suggestedName: tokens.account?.email?.split("@")[0]?.toLowerCase() ?? "personal",
        suggestedLabel: label,
        accountFields: {
            label,
            // The plan reading comes free with the profile fetched above. Storing
            // it here is what lets a just-renewed account be polled immediately
            // instead of waiting out the 6h recheck window with a stale
            // "claude_free" that keeps it suppressed. The uuids are the
            // fingerprint: an OAuth login is the ONLY place the account uuid can
            // be read, and the org uuid is what lets a later `login-long` prove a
            // pasted setup token belongs to this account.
            ...(profile
                ? {
                      accountUuid: profile.account.uuid,
                      organizationUuid: profile.organization.uuid,
                      subscriptionCreatedAt: profile.organization.subscription_created_at || undefined,
                      subscriptionPlan: profile.organization.organization_type,
                      subscriptionStatus: profile.organization.subscription_status,
                      subscriptionCheckedAt: Date.now(),
                  }
                : {}),
        },
    };
}
