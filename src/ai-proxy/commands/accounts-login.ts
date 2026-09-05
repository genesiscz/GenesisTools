import { existsSync, unlinkSync } from "node:fs";
import { runLogin } from "@app/ai/lib/accounts/run-login";
import {
    detectGithubCopilotAccount,
    inferAccountNameFromLogin,
    loadConfig,
    saveConfig,
} from "@app/ai-proxy/lib/config";
import { clearCopilotModelsCache } from "@app/ai-proxy/lib/copilot-models-cache";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import {
    clearGithubCopilotTokenResolutionCache,
    clearSessionCache,
    fetchGithubUserLogin,
} from "@genesiscz/utils/ai/github-copilot";
import { copilotDataDir, copilotGhoTokenAuthKey, githubTokenPath } from "@genesiscz/utils/ai/github-copilot/paths";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { runGitHubDeviceLogin } from "@genesiscz/utils/oauth";
import { authStorageBackend, setAuthSecret } from "@genesiscz/utils/storage";

const CODEX_PROVIDER_ALIASES = new Set(["codex", "openai", "chatgpt"]);

export async function runAccountsLogin(provider: string, options?: { dataDir?: string }): Promise<void> {
    if (CODEX_PROVIDER_ALIASES.has(provider)) {
        await runCodexLogin();
        return;
    }

    if (provider !== "github-copilot") {
        out.log.error(`Unknown provider: ${provider}. Supported: github-copilot, codex`);
        return;
    }

    const dataDir = copilotDataDir(options?.dataDir);

    out.log.info("Starting GitHub device flow for Copilot…");

    const token = await runGitHubDeviceLogin({
        onUserCode: ({ userCode, verificationUri }) => {
            out.log.info(`Open ${verificationUri}`);
            out.log.info(`Enter code: ${userCode}`);
        },
    });

    await setAuthSecret(copilotGhoTokenAuthKey(dataDir), token);

    const legacyPath = githubTokenPath(dataDir);
    if (existsSync(legacyPath)) {
        try {
            unlinkSync(legacyPath);
            logger.info({ legacyPath }, "accounts-login: removed legacy token file after AuthStorage write");
        } catch (err) {
            logger.warn({ err, legacyPath }, "accounts-login: failed to remove legacy token file; delete it manually");
        }
    }

    clearGithubCopilotTokenResolutionCache();
    clearSessionCache(dataDir);
    clearCopilotModelsCache();

    const login = await fetchGithubUserLogin(token);
    const accountName = inferAccountNameFromLogin(login ?? undefined);
    out.log.success(`Logged in${login ? ` as ${login}` : ""}`);
    out.log.info(`Token saved to ${authStorageBackend().id} (service=${copilotGhoTokenAuthKey(dataDir).service})`);

    const report = await detectGithubCopilotAccount(dataDir);
    if (!report) {
        out.log.warn("Login succeeded but account detection failed.");
        return;
    }

    const detected = report.account;
    const config = await loadConfig();
    const existingIndex = config.accounts.findIndex(
        (account) => account.name === detected.name && account.provider === detected.provider
    );

    if (existingIndex >= 0) {
        config.accounts[existingIndex] = { ...config.accounts[existingIndex], ...detected, enabled: true };
        out.log.info(`Updated existing account: ${detected.name}`);
    } else {
        const duplicateName = config.accounts.some((account) => account.name === detected.name);
        if (duplicateName) {
            detected.name = `${accountName}-copilot`;
        }

        config.accounts.push(detected);
        out.log.info(`Added account: ${detected.name}`);
    }

    await saveConfig(config);
    out.log.info(`Suggested model: ${report.suggestedModel ?? `${detected.name}/github-copilot/claude-sonnet-4`}`);
}

/**
 * Browser PKCE login for the ChatGPT/Codex subscription. Persists the tokens
 * as an `openai-sub` account in the unified AI config, then points (or creates)
 * an ai-proxy `openai-subscription` account at it.
 */
async function runCodexLogin(): Promise<void> {
    if (!isInteractive()) {
        out.log.error("Codex login needs a TTY (browser OAuth + code paste).");
        out.log.info(suggestCommand("tools ai-proxy", { replaceCommand: ["accounts", "login", "codex"] }));
        out.log.info("Alternative: run `codex login` and configure openaiSub.codexAuthPath (CLI-cache mode).");
        return;
    }

    // The ACCOUNT write is the shared lib's, so there is one codex login path
    // rather than two that disagree (decision D4). What stays here is the proxy's
    // own bookkeeping below, which the shared lib knows nothing about.
    const login = await runLogin({ provider: "openai-sub", tool: "tools ai-proxy accounts login codex" });

    if (!login.ok || !login.account) {
        return;
    }

    const accountName = login.account.name;
    const planType = login.account.label;

    const config = await loadConfig();
    const existing = config.accounts.find(
        (item) => item.provider === "openai-subscription" && item.openaiSub?.accountName === accountName
    );

    if (existing) {
        existing.enabled = true;
        out.log.info(`Proxy account "${existing.name}" already references it.`);
    } else {
        const proxyName = config.accounts.some((item) => item.name === "codex") ? `codex-${accountName}` : "codex";
        const proxyAccount: AiProxyAccountConfig = {
            name: proxyName,
            label: planType ? `Codex (${planType})` : "Codex",
            provider: "openai-subscription",
            providerSlug: "codex",
            enabled: true,
            openaiSub: { accountName },
        };
        config.accounts.push(proxyAccount);
        out.log.info(`Added proxy account: ${proxyName}`);
    }

    await saveConfig(config);
    out.log.info(`Try: ${suggestCommand("tools ai-proxy", { replaceCommand: ["models"] })}`);
}
