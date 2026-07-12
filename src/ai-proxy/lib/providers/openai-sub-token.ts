import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { logger } from "@app/logger";
import {
    CODEX_AUTH_PATH,
    codexOAuth,
    extractAccountId,
    readCodexAuthJson,
    resolveCodexAccountToken,
} from "@app/utils/ai/openai/codex-auth";

export interface OpenAiSubToken {
    token: string;
    accountId?: string;
}

/**
 * Resolve a ChatGPT/Codex access token for an openai-subscription proxy account.
 *
 * Two sources:
 *  - `openaiSub.accountName` set → the named `openai-sub` account in the unified
 *    AI config, via the canonical single-flight resolveCodexAccountToken().
 *    This is the deploy path.
 *  - otherwise → the Codex CLI cache (`~/.codex/auth.json`), read-only. The CLI
 *    keeps this fresh; the local proxy piggybacks on the machine's `codex login`.
 */
export async function resolveOpenAiSubToken(account: AiProxyAccountConfig): Promise<OpenAiSubToken> {
    const accountName = account.openaiSub?.accountName;

    if (accountName) {
        return resolveCodexAccountToken(accountName);
    }

    return resolveFromCodexCli(account.openaiSub?.codexAuthPath);
}

async function resolveFromCodexCli(authPath?: string): Promise<OpenAiSubToken> {
    const path = authPath ?? CODEX_AUTH_PATH;
    const tokens = await readCodexAuthJson(path);

    if (!tokens?.accessToken) {
        throw new Error(
            `No Codex CLI auth at ${path}. Run \`codex login\`, or set openaiSub.accountName to a configured openai-sub account.`
        );
    }

    if (tokens.expiresAt && codexOAuth.needsRefresh(tokens.expiresAt)) {
        logger.warn(
            { path },
            "ai-proxy: Codex CLI token is expired — run `codex login` (the proxy does not write the CLI cache)"
        );
    }

    return { token: tokens.accessToken, accountId: tokens.accountId ?? extractAccountId(tokens.accessToken) };
}
