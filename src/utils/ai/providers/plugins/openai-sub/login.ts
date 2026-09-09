import { unlink } from "node:fs/promises";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { logger, out } from "@genesiscz/utils/logger";
import { callbackStateError, readCallbackCode } from "../../../oauth/callback-code";
import { type StartCallbackListener, startCallbackListener } from "../../../oauth/callback-server";
import { presentAuthorizationUrl } from "../../../oauth/login-ui";
import {
    CODEX_AUTH_PATH,
    CODEX_REDIRECT_URI,
    type CodexTokens,
    codexOAuth,
    extractAccountId,
    extractEmail,
    extractPlanType,
    writeCodexAuthJson,
} from "../../../openai/codex-auth";
import type { AccountFlowContext, LoginOutcome } from "../../account-features";
import { accountFieldsFrom } from "../../account-fields";

/** Native-file compatibility destination; ordinary named login never calls this resolver. */
export function resolveCodexAuthDestination(ctx: AccountFlowContext): string {
    if (ctx.authFile) {
        return ctx.authFile;
    }

    if (ctx.home) {
        return join(ctx.home, "auth.json");
    }

    return ctx.account?.credentials.authFile ?? CODEX_AUTH_PATH;
}

export async function codexLogin(
    ctx: AccountFlowContext,
    startListener: StartCallbackListener = startCallbackListener
): Promise<LoginOutcome> {
    if (ctx.codexBroker && (ctx.home || ctx.authFile)) {
        throw new Error("--broker cannot be combined with --home or --auth-file");
    }

    if (!ctx.interactive) {
        throw new Error("Codex login needs a TTY (browser OAuth + code paste).");
    }

    const authUrl = await codexOAuth.startLogin();
    const expectedState = new URL(authUrl).searchParams.get("state");
    // Up before the browser is sent anywhere, so the redirect cannot beat it.
    // A `null` here means the port is taken and the paste prompt is the flow.
    const listener = await startListener({
        redirectUri: CODEX_REDIRECT_URI,
        verifyState: (state) => callbackStateError(state, expectedState, { required: true }),
    });

    let code: string;
    try {
        const action = await presentAuthorizationUrl({
            authUrl,
            provider: "ChatGPT",
            openUrl: ctx.openUrl,
            interaction: ctx.authorizationInteraction,
            callbackHandled: listener !== null,
        });
        code = await readCallbackCode({
            listener,
            action,
            interaction: ctx.authorizationInteraction,
            expectedState,
        });
    } finally {
        // Every exit runs this: a served callback, a refusal, a cancelled prompt,
        // the deadline. The browser is finished with the socket either way, and
        // `close()` never throws, so it cannot mask why the login is unwinding.
        await listener?.close();
    }

    const spinner = p.spinner();
    spinner.start("Exchanging code for tokens...");

    let tokens: CodexTokens;
    try {
        tokens = await codexOAuth.exchangeCode(code);
        spinner.stop("Tokens received.");
    } catch (err) {
        spinner.stop(`Token exchange failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    }

    if (ctx.home === undefined && ctx.authFile === undefined) {
        return codexLoginOutcome({ tokens });
    }

    const authFile = resolveCodexAuthDestination(ctx);

    // Read the file BEFORE replacing it. The identity guard runs in the CLI layer,
    // after this function has returned, so a refused re-login has to be able to put
    // the previous credential back (PR #360 review t17).
    const previous = await Bun.file(authFile)
        .arrayBuffer()
        .catch(() => undefined);

    await writeCodexAuthJson(authFile, tokens);
    out.println(`  Wrote ${authFile}`);

    return {
        ...codexLoginOutcome({ tokens, authFile }),
        rollback: () => restoreCodexAuthFile(authFile, previous),
    };
}

/**
 * Put `auth.json` back the way it was, or remove the one this login created.
 *
 * Leaving a brand-new file behind would be harmless (no account points at it),
 * but leaving a REPLACED one is the bug: `OpenAISubResolver` reads the path the
 * old account still stores, so the refused identity would keep serving requests.
 */
export async function restoreCodexAuthFile(authFile: string, previous: ArrayBuffer | undefined): Promise<void> {
    if (previous === undefined) {
        await unlink(authFile);
        logger.info({ authFile }, "codex login refused: removed the auth file this login created");
        return;
    }

    await Bun.write(authFile, previous);
    logger.info({ authFile }, "codex login refused: restored the previous auth file");
}

/**
 * The pure half of the login: what the exchanged tokens mean, with no browser,
 * no prompt and no disk. Split out so the identity it proves is testable from
 * invented claims instead of a real OAuth round trip.
 */
export function codexLoginOutcome(
    input: { tokens: CodexTokens } & ({ authFile: string; broker?: false } | { authFile?: never; broker?: true })
): LoginOutcome {
    // The id token carries email and plan; the access token often does not.
    const claims = input.tokens.idToken ?? input.tokens.accessToken;
    const email = extractEmail(claims);
    const planType = extractPlanType(claims);
    const identity = {
        email,
        accountUuid: input.tokens.accountId ?? extractAccountId(claims),
        plan: planType,
    };

    return {
        provider: "openai-sub",
        credentials:
            input.authFile === undefined
                ? {
                      // An explicit empty reference clears the old path through applyLoginOutcome.
                      authFile: "",
                      accessToken: input.tokens.accessToken,
                      refreshToken: input.tokens.refreshToken,
                      expiresAt: input.tokens.expiresAt,
                  }
                : { authFile: input.authFile },
        identity,
        suggestedName: email?.split("@")[0]?.toLowerCase() || "codex",
        suggestedLabel: planType ?? "codex",
        // The uuid is the whole point: without it a re-login of this account has
        // no fingerprint to contradict. The label keeps its own fallback, since
        // an account with no plan claim still displays as "codex".
        accountFields: { ...accountFieldsFrom(identity), label: planType ?? "codex" },
    };
}
