import { existsSync, unlinkSync } from "node:fs";
import {
    detectGithubCopilotAccount,
    inferAccountNameFromLogin,
    loadConfig,
    saveConfig,
} from "@app/ai-proxy/lib/config";
import { clearCopilotModelsCache } from "@app/ai-proxy/lib/copilot-models-cache";
import { logger, out } from "@app/logger";
import {
    clearGithubCopilotTokenResolutionCache,
    clearSessionCache,
    fetchGithubUserLogin,
} from "@app/utils/ai/github-copilot";
import { copilotDataDir, copilotGhoTokenAuthKey, githubTokenPath } from "@app/utils/ai/github-copilot/paths";
import { runGitHubDeviceLogin } from "@app/utils/oauth";
import { authStorageBackend, setAuthSecret } from "@app/utils/storage";

export async function runAccountsLogin(provider: string, options?: { dataDir?: string }): Promise<void> {
    if (provider !== "github-copilot") {
        out.log.error(`Unknown provider: ${provider}. Supported: github-copilot`);
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
