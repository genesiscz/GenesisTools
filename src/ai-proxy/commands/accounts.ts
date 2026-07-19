import { buildProxyModelCatalog } from "@app/ai-proxy/lib/catalog";
import { loadConfig, saveConfig } from "@app/ai-proxy/lib/config";
import { type AccountListRow, displayAccountsTable, displayAccountTestResult } from "@app/ai-proxy/lib/display";
import { createProvider, isProviderImplemented } from "@app/ai-proxy/lib/providers/registry";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { CODEX_AUTH_PATH, extractPlanType, readCodexAuthJson } from "@genesiscz/utils/ai/openai/codex-auth";
import { suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";

function cmd(replaceCommand: string[]): string {
    return suggestCommand("tools ai-proxy", { replaceCommand });
}

export async function runAccountsList(): Promise<void> {
    const config = await loadConfig();
    const rows: AccountListRow[] = [];

    for (const account of config.accounts) {
        const modelCount = (await buildProxyModelCatalog([account])).length;
        rows.push({ account, modelCount });
    }

    displayAccountsTable(rows);
}

export async function runAccountsTest(name: string): Promise<void> {
    const config = await loadConfig();
    const account = config.accounts.find((item) => item.name === name);

    if (!account) {
        out.println();
        out.printlnErr(`  Account not found: ${name}`);
        out.println();
        out.println(`  ${suggestCommand("tools ai-proxy", { replaceCommand: ["accounts", "list"] })}`);
        out.println();
        return;
    }

    if (!account.enabled) {
        out.println();
        out.printlnErr(`  Account "${name}" is disabled in config.`);
        out.println();
        out.println(`  ${cmd(["config", "show"])}`);
        out.println();
        return;
    }

    if (!isProviderImplemented(account.provider)) {
        out.println();
        out.printlnErr(`  Provider not implemented for runtime yet: ${account.provider}`);
        out.println(`  Account "${name}" is configured but has no catalog/runtime adapter.`);
        out.println();
        out.println(`  ${cmd(["accounts", "list"])}`);
        out.println(`  ${cmd(["config", "show"])}`);
        out.println();
        return;
    }

    try {
        const provider = await createProvider(account);
        const usage = await provider.getUsage();
        const models = await provider.listModels();

        displayAccountTestResult({
            name,
            provider: account.provider,
            providerSlug: account.providerSlug,
            summary: usage.summary,
            modelCount: models.length,
            modelsSample: models.map((model) => model.id),
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        out.println();
        out.printlnErr(`  Upstream test failed for "${name}"`);
        out.printlnErr(`  ${message}`);
        out.println();
        out.println(`  ${cmd(["config", "detect"])}`);
        out.println(`  ${cmd(["config", "show"])}`);
        out.println(`  ${cmd(["status"])}`);
        out.println();
    }
}

/**
 * Auth detail for codex (openai-subscription) accounts: where the token comes
 * from, when it expires, and the ChatGPT plan when the JWT carries it.
 */
export async function runAccountsStatus(): Promise<void> {
    const config = await loadConfig();
    const codexAccounts = config.accounts.filter((account) => account.provider === "openai-subscription");

    if (codexAccounts.length === 0) {
        out.log.info("No openai-subscription accounts configured.");
        out.log.info(cmd(["accounts", "login", "codex"]));
        return;
    }

    const aiConfig = await AIConfig.load();

    for (const account of codexAccounts) {
        const accountName = account.openaiSub?.accountName;
        let source: string;
        let accessToken: string | undefined;
        let expiresAt: number | undefined;

        if (accountName) {
            const entry = aiConfig.getAccount(accountName);

            if (!entry) {
                out.log.warn(`${account.name}: AI-config account "${accountName}" not found`);
                continue;
            }

            if (entry.tokens.authFile) {
                source = `codex-auth.json (${entry.tokens.authFile})`;
                const tokens = await readCodexAuthJson(entry.tokens.authFile);
                accessToken = tokens?.accessToken;
                expiresAt = tokens?.expiresAt;
            } else {
                source = `ai-config (${accountName})`;
                accessToken = entry.tokens.accessToken;
                expiresAt = entry.tokens.expiresAt;
            }
        } else {
            const path = account.openaiSub?.codexAuthPath ?? CODEX_AUTH_PATH;
            source = `codex-auth.json (${path})`;
            const tokens = await readCodexAuthJson(path);
            accessToken = tokens?.accessToken;
            expiresAt = tokens?.expiresAt;
        }

        const plan = accessToken ? extractPlanType(accessToken) : undefined;
        const failover = account.openaiSub?.failoverAccountNames;
        const expiry = expiresAt
            ? `${new Date(expiresAt).toLocaleString()}${expiresAt < Date.now() ? " (EXPIRED)" : ""}`
            : "unknown";

        out.log.info(`${account.name}${plan ? ` (${plan})` : ""}${account.enabled ? "" : " [disabled]"}`);
        out.log.info(`  auth:    ${accessToken ? source : `${source} — NO TOKEN`}`);
        out.log.info(`  expires: ${expiry}`);

        if (failover && failover.length > 0) {
            out.log.info(`  failover: ${failover.join(", ")}`);
        }
    }
}

export async function runAccountsRemove(name: string): Promise<void> {
    const config = await loadConfig();
    const before = config.accounts.length;
    config.accounts = config.accounts.filter((account) => account.name !== name);

    if (config.accounts.length === before) {
        out.log.warn(`Account not found: ${name}`);
        out.log.info(cmd(["accounts", "list"]));
        return;
    }

    await saveConfig(config);
    out.log.success(`Removed account: ${name}`);
}
