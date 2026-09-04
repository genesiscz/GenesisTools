import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import { Browser } from "@genesiscz/utils/browser";
import { out } from "@genesiscz/utils/logger";
import {
    CODEX_AUTH_PATH,
    codexOAuth,
    extractAccountId,
    extractEmail,
    extractPlanType,
    writeCodexAuthJson,
} from "../../../openai/codex-auth";
import type { AccountFlowContext, LoginOutcome } from "../../account-features";

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

    // The id token carries email and plan; the access token often does not.
    const claims = tokens.idToken ?? tokens.accessToken;
    const email = extractEmail(claims);
    const planType = extractPlanType(claims);
    const authFile = ctx.authFile ?? join(ctx.home ?? dirname(CODEX_AUTH_PATH), "auth.json");

    await writeCodexAuthJson(authFile, tokens);
    out.println(`  Wrote ${authFile}`);

    return {
        provider: "openai-sub",
        credentials: { authFile },
        identity: {
            email,
            accountUuid: tokens.accountId ?? extractAccountId(claims),
            plan: planType,
        },
        suggestedName: email?.split("@")[0]?.toLowerCase() || "codex",
        suggestedLabel: planType ?? "codex",
        accountFields: { label: planType ?? "codex" },
    };
}
