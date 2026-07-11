import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { logger } from "@app/logger";
import { CODEX_AUTH_PATH, codexOAuth, extractAccountId, readCodexAuthJson } from "@app/utils/ai/openai/codex-auth";

export interface OpenAiSubToken {
    token: string;
    accountId?: string;
}

/**
 * Resolve a ChatGPT/Codex access token for an openai-subscription proxy account.
 *
 * Two sources:
 *  - `openaiSub.accountName` set → the named `openai-sub` account in the unified
 *    AI config (refreshed via Codex OAuth and persisted, mirroring the ask
 *    resolver). This is the deploy path.
 *  - otherwise → the Codex CLI cache (`~/.codex/auth.json`), read-only. The CLI
 *    keeps this fresh; the local proxy piggybacks on the machine's `codex login`.
 */
export async function resolveOpenAiSubToken(account: AiProxyAccountConfig): Promise<OpenAiSubToken> {
    const accountName = account.openaiSub?.accountName;

    if (accountName) {
        return resolveFromAiConfig(accountName);
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

async function resolveFromAiConfig(accountName: string): Promise<OpenAiSubToken> {
    const { AIConfig } = await import("@app/utils/ai/AIConfig");
    const config = await AIConfig.load();
    const entry = config.getAccount(accountName);

    if (!entry) {
        throw new Error(`openai-sub account "${accountName}" not found in AI config.`);
    }

    let accessToken = entry.tokens.accessToken;

    if (!accessToken) {
        throw new Error(`No access token for openai-sub account "${accountName}". Run \`tools ask config\`.`);
    }

    if (entry.tokens.expiresAt && codexOAuth.needsRefresh(entry.tokens.expiresAt)) {
        const refreshToken = entry.tokens.refreshToken;

        if (!refreshToken) {
            throw new Error(`Token for "${accountName}" is expired and no refresh token is available.`);
        }

        const refreshed = await codexOAuth.refresh(refreshToken);

        await config.mutate((data) => {
            const acc = data.accounts.find((a) => a.name === accountName);

            if (acc) {
                acc.tokens.accessToken = refreshed.accessToken;
                acc.tokens.refreshToken = refreshed.refreshToken;
                acc.tokens.expiresAt = refreshed.expiresAt;
            }
        });

        accessToken = refreshed.accessToken;
    }

    return { token: accessToken, accountId: extractAccountId(accessToken) };
}
