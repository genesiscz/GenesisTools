import { unlink } from "node:fs/promises";
import * as p from "@clack/prompts";
import { logger, out } from "@genesiscz/utils/logger";
import { writeGrokAuthEntry } from "../../../grok/auth-write";
import { GROK_REDIRECT_URI, type GrokTokens, grokOAuth, identityFromGrokTokens } from "../../../grok/oauth";
import { grokAuthPath } from "../../../grok/paths";
import { callbackStateError, readCallbackCode } from "../../../oauth/callback-code";
import { type StartCallbackListener, startCallbackListener } from "../../../oauth/callback-server";
import { presentAuthorizationUrl } from "../../../oauth/login-ui";
import type { AccountFlowContext, AccountIdentity, LoginOutcome } from "../../account-features";
import { accountFieldsFrom } from "../../account-fields";

/** Where `--home` / `--auth-file` put the login; a named login without either never calls this. */
export function resolveGrokAuthDestination(ctx: AccountFlowContext): string {
    if (ctx.authFile) {
        return ctx.authFile;
    }

    if (ctx.home) {
        return grokAuthPath(ctx.home);
    }

    return ctx.account?.credentials.authFile ?? grokAuthPath();
}

/**
 * The browser login for a SuperGrok subscription, the shape `codexLogin` has: xAI's own
 * OIDC flow with PKCE, a loopback listener on the CLI's registered redirect, the paste
 * prompt as the fallback, and the grant stored in the vault. With `--home` or `--auth-file`
 * the same grant is written into a Grok CLI auth file instead, so the CLI can use it too.
 *
 * Until this existed `tools grok login` could only bind the file `grok login` writes, so a
 * later `grok login` on the real CLI silently re-pointed every bound account (issue #377).
 */
export async function grokLogin(
    ctx: AccountFlowContext,
    startListener: StartCallbackListener = startCallbackListener
): Promise<LoginOutcome> {
    if (!ctx.interactive) {
        throw new Error("Grok login needs a TTY (browser OAuth + code paste).");
    }

    const authUrl = await grokOAuth.startLogin();
    const expectedState = new URL(authUrl).searchParams.get("state");
    // Up before the browser is sent anywhere, so the redirect cannot beat it.
    // A `null` here means the port is taken and the paste prompt is the flow.
    const listener = await startListener({
        redirectUri: GROK_REDIRECT_URI,
        verifyState: (state) => callbackStateError(state, expectedState, { required: true }),
    });

    let code: string;
    try {
        const action = await presentAuthorizationUrl({
            authUrl,
            provider: "Grok",
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
        // Every exit runs this: a served callback, a refusal, a cancelled prompt, the
        // deadline. `close()` never throws, so it cannot mask why the login is unwinding.
        await listener?.close();
    }

    const spinner = p.spinner();
    spinner.start("Exchanging code for tokens...");

    let tokens: GrokTokens;
    try {
        tokens = await grokOAuth.exchangeCode(code);
        spinner.stop("Tokens received.");
    } catch (err) {
        spinner.stop(`Token exchange failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    }

    if (ctx.home === undefined && ctx.authFile === undefined) {
        return grokLoginOutcome({ tokens });
    }

    const authFile = resolveGrokAuthDestination(ctx);

    // Read the file BEFORE replacing it: the identity guard runs in the CLI layer, after
    // this function has returned, so a refused re-login must be able to put it back.
    const previous = await Bun.file(authFile)
        .arrayBuffer()
        .catch(() => undefined);

    await writeGrokAuthEntry(authFile, tokens);
    out.println(`  Wrote ${authFile}`);

    return {
        ...grokLoginOutcome({ tokens, authFile }),
        rollback: () => restoreGrokAuthFile(authFile, previous),
    };
}

/** Put the auth file back the way it was, or remove the one this login created. */
export async function restoreGrokAuthFile(authFile: string, previous: ArrayBuffer | undefined): Promise<void> {
    if (previous === undefined) {
        await unlink(authFile);
        logger.info({ authFile }, "grok login refused: removed the auth file this login created");
        return;
    }

    await Bun.write(authFile, previous);
    logger.info({ authFile }, "grok login refused: restored the previous auth file");
}

/**
 * The pure half of the login: what the exchanged tokens mean, with no browser, no prompt
 * and no disk. Split out the way `codexLoginOutcome` is, so the identity it proves is
 * testable from invented claims instead of a real OAuth round trip.
 */
export function grokLoginOutcome(input: { tokens: GrokTokens; authFile?: string }): LoginOutcome {
    const who = identityFromGrokTokens(input.tokens);
    // The same wording `identityOf` derives from a bound file, so a re-login compares like with like.
    const plan = who.tier === undefined ? undefined : `tier ${who.tier}`;
    const identity: AccountIdentity = {
        ...(who.email === undefined ? {} : { email: who.email }),
        ...(who.userId === undefined ? {} : { accountUuid: who.userId }),
        ...(plan === undefined ? {} : { plan }),
    };

    return {
        provider: "grok-sub",
        credentials:
            input.authFile === undefined
                ? {
                      // An explicit empty reference clears the old path through applyLoginOutcome.
                      authFile: "",
                      accessToken: input.tokens.accessToken,
                      ...(input.tokens.refreshToken === undefined ? {} : { refreshToken: input.tokens.refreshToken }),
                      expiresAt: input.tokens.expiresAt,
                  }
                : { authFile: input.authFile },
        identity,
        suggestedName: who.email?.split("@")[0]?.toLowerCase() || "grok",
        suggestedLabel: plan ?? "grok",
        // The uuid is what a re-login of this account gets compared against.
        accountFields: { ...accountFieldsFrom(identity), label: plan ?? "grok" },
    };
}
