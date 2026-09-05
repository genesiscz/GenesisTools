import { unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import { Browser } from "@genesiscz/utils/browser";
import { logger, out } from "@genesiscz/utils/logger";
import {
    CODEX_AUTH_PATH,
    type CodexTokens,
    codexOAuth,
    extractAccountId,
    extractEmail,
    extractPlanType,
    writeCodexAuthJson,
} from "../../../openai/codex-auth";
import type { AccountFlowContext, LoginOutcome } from "../../account-features";
import { accountFieldsFrom } from "../../account-fields";

/**
 * Browser PKCE login for the ChatGPT/Codex subscription, moved out of
 * `src/ai-proxy/commands/accounts-login.ts` so the proxy command, `tools codex
 * login` and `tools ai accounts login --provider codex` all run it.
 *
 * Decision D3: the result is written as the codex home's `auth.json`, in the
 * shape the official CLI writes, and the account stores that PATH. One token per
 * profile, shared with the CLI and the ChatGPT app, instead of a second copy in
 * the vault that rotates independently.
 */
export async function codexLogin(ctx: AccountFlowContext): Promise<LoginOutcome> {
    if (!ctx.interactive) {
        throw new Error("Codex login needs a TTY (browser OAuth + code paste).");
    }

    const authUrl = await codexOAuth.startLogin();

    p.note(
        [
            "1. Open the URL below in your browser",
            "2. Sign in with your ChatGPT account",
            "3. Authorize Codex",
            "4. Copy the code from the callback page/URL",
        ].join("\n"),
        "OpenAI OAuth Login"
    );

    out.println();
    out.println(`  ${authUrl}`);
    out.println();

    const openBrowser = await p.confirm({ message: "Open URL in browser?", initialValue: true });

    if (p.isCancel(openBrowser)) {
        throw new Error("Cancelled");
    }

    if (openBrowser) {
        await (ctx.openUrl ?? ((url: string) => Browser.open(url).then(() => undefined)))(authUrl);
    }

    const code = await p.text({
        message: "Paste the authorization code:",
        validate: (val) => {
            if (!val?.trim()) {
                return "Code is required";
            }
        },
    });

    if (p.isCancel(code)) {
        throw new Error("Cancelled");
    }

    const spinner = p.spinner();
    spinner.start("Exchanging code for tokens...");

    let tokens: Awaited<ReturnType<typeof codexOAuth.exchangeCode>>;
    try {
        tokens = await codexOAuth.exchangeCode((code as string).trim());
        spinner.stop("Tokens received.");
    } catch (err) {
        spinner.stop(`Token exchange failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    }

    const authFile = ctx.authFile ?? join(ctx.home ?? dirname(CODEX_AUTH_PATH), "auth.json");

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
export function codexLoginOutcome(input: { tokens: CodexTokens; authFile: string }): LoginOutcome {
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
        credentials: { authFile: input.authFile },
        identity,
        suggestedName: email?.split("@")[0]?.toLowerCase() || "codex",
        suggestedLabel: planType ?? "codex",
        // The uuid is the whole point: without it a re-login of this account has
        // no fingerprint to contradict. The label keeps its own fallback, since
        // an account with no plan claim still displays as "codex".
        accountFields: { ...accountFieldsFrom(identity), label: planType ?? "codex" },
    };
}
