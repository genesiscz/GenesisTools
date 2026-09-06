import * as p from "@clack/prompts";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";
import type { AccountFlowContext, LoginOutcome } from "../../account-features";
import {
    errorForExchange,
    fetchAndDisplayProfile,
    generateAuthUrl,
    identityFromLogin,
    presentAuthUrl,
    promptAndExchangeCode,
} from "./login";

/**
 * A SECOND grant stored on an account, used only by
 * `tools claude start <name> --keychain`. The account's primary tokens (usage
 * polling) and its long-lived token stay untouched, which is the whole point:
 * the keychain copy must be able to rotate without disturbing them.
 */
export async function anthropicLoginSecondary(ctx: AccountFlowContext): Promise<LoginOutcome> {
    const accountName = ctx.account?.name ?? ctx.requestedName ?? "this account";

    if (!ctx.interactive) {
        throw new Error("login-secondary requires an interactive terminal (code paste).");
    }

    p.intro(pc.bgCyan(pc.black(` secondary login → ${accountName} `)));
    p.log.info(
        `The account's primary tokens (usage polling) and long-lived token stay untouched.\n` +
            `${pc.dim("Log into the matching Anthropic account in the browser before authorizing.")}`
    );

    const authUrl = await generateAuthUrl();

    await presentAuthUrl(authUrl, ctx.openUrl);

    const exchange = await promptAndExchangeCode();

    if (exchange.status !== "ok") {
        // A failed exchange must not borrow the `Cancelled` message: the
        // entrypoints map exactly that to exit 0 (PR #360 review r2 t3).
        out.println(pc.dim(exchange.status === "cancelled" ? "Cancelled — no tokens retrieved." : "No tokens saved."));
        throw errorForExchange(exchange);
    }

    const tokens = exchange.tokens;
    const profile = await fetchAndDisplayProfile(tokens);

    const subscriptionType = profile?.account.has_claude_max ? "max" : profile?.account.has_claude_pro ? "pro" : null;

    return {
        provider: "anthropic-sub",
        credentials: {
            secondary: {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                expiresAt: tokens.expiresAt,
                scopes: tokens.scopes,
                subscriptionType,
                rateLimitTier: profile?.organization.rate_limit_tier ?? null,
                accountUuid: tokens.account?.uuid,
                emailAddress: tokens.account?.email,
                organizationUuid: tokens.organization?.uuid,
            },
        },
        // The sync-back match key is the SECONDARY grant's uuid, so that is what
        // the identity policy compares: an unexpected identity here would route
        // future keychain rotations to the wrong account.
        identity: identityFromLogin(tokens, profile),
    };
}
