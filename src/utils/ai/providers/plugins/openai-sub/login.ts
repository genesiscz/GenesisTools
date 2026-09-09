import { unlink } from "node:fs/promises";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { logger, out } from "@genesiscz/utils/logger";
import {
    type CallbackListener,
    type StartCallbackListener,
    startCallbackListener,
} from "../../../oauth/callback-server";
import {
    type AuthorizationInteraction,
    type AuthorizationUrlAction,
    presentAuthorizationUrl,
    readAuthorizationCode,
} from "../../../oauth/login-ui";
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

/** One message for every way a callback can fail to belong to this login. */
const MISMATCHED_STATE =
    "OAuth callback state does not match this login. Paste the callback from the current authorization.";

/**
 * The one `state` comparison this flow makes, from both halves: the loopback
 * listener refuses a foreign callback without settling, and the paste prompt
 * refuses one before the exchange.
 *
 * `required` is the difference between them. The listener demands `state`,
 * because a real provider callback always carries it and one without it is some
 * other local process reaching a loopback port. The paste prompt does not,
 * because pasting a bare code with no `#state` is a legitimate thing a user
 * does and has to keep working.
 */
export function callbackStateError(
    state: string | undefined,
    expected: string | null,
    options: { required?: boolean } = {}
): string | undefined {
    if (state === undefined) {
        return options.required ? MISMATCHED_STATE : undefined;
    }

    if (state === expected) {
        return undefined;
    }

    return MISMATCHED_STATE;
}

/**
 * The authorization code, from whichever half of the flow produced it.
 *
 * The listener wins when it is up and the user actually sent a browser at the
 * URL. `none` means they already hold a code from an earlier authorization, and
 * an empty-handed listener (its deadline passed, or the browser finished against
 * the official CLI's own listener) hands the terminal back to the paste prompt
 * that was the entire flow before this existed.
 */
async function readCallbackCode(input: {
    listener: CallbackListener | null;
    action: AuthorizationUrlAction;
    interaction: AuthorizationInteraction | undefined;
    expectedState: string | null;
}): Promise<string> {
    if (input.listener && input.action !== "none") {
        const waiting = p.spinner();
        waiting.start("Waiting for the browser to finish authorizing...");
        const callback = await input.listener.callback;

        if (callback !== null && "error" in callback) {
            waiting.stop("The browser callback was refused.");
            throw new Error(callback.error);
        }

        if (callback !== null) {
            waiting.stop("Authorized in the browser.");
            return callback.code;
        }

        waiting.stop("No callback arrived. Paste the code from the browser instead.");
    }

    const normalized = await readAuthorizationCode(input.interaction);

    if (normalized === null) {
        throw new Error("Cancelled");
    }

    if ("error" in normalized) {
        throw new Error(normalized.error);
    }

    const [code, state] = normalized.code.split("#");
    const mismatch = callbackStateError(state, input.expectedState);

    if (mismatch) {
        throw new Error(mismatch);
    }

    return code;
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
