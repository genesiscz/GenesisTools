import { buildProxyModelCatalog } from "@app/ai-proxy/lib/catalog";
import { loadConfig, saveConfig } from "@app/ai-proxy/lib/config";
import { type AccountListRow, displayAccountsTable, displayAccountTestResult } from "@app/ai-proxy/lib/display";
import { apiKeyStatus, findEnvSourceFile } from "@app/ai-proxy/lib/providers/api-key-state";
import { createProvider, isProviderImplemented } from "@app/ai-proxy/lib/providers/registry";
import type { AiProxyAccountConfig, AiProxyProviderType } from "@app/ai-proxy/lib/types";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { CODEX_AUTH_PATH, extractPlanType, readCodexAuthJson } from "@genesiscz/utils/ai/openai/codex-auth";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
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

export async function runAccountsSetEnabled(name: string, enabled: boolean): Promise<void> {
    const config = await loadConfig();
    const account = config.accounts.find((item) => item.name === name);

    if (!account) {
        out.log.warn(`Account not found: ${name}`);
        out.log.info(cmd(["accounts", "list"]));
        return;
    }

    if (account.enabled === enabled) {
        out.log.info(`Account "${name}" is already ${enabled ? "enabled" : "disabled"}`);
        return;
    }

    account.enabled = enabled;
    await saveConfig(config);
    out.log.success(`${enabled ? "Enabled" : "Disabled"} account: ${name} (${account.provider})`);
    out.log.info("Restart the proxy to apply: tools ai-proxy down && tools ai-proxy up");
}

const API_KEY_PROVIDERS = new Set<AiProxyProviderType>(["xai-api-key", "openai"]);

export async function runAccountsSetKey(name: string, key: string | undefined): Promise<void> {
    const config = await loadConfig();
    const account = config.accounts.find((item) => item.name === name);

    if (!account) {
        out.log.warn(`Account not found: ${name}`);
        out.log.info(cmd(["accounts", "list"]));
        return;
    }

    if (!API_KEY_PROVIDERS.has(account.provider)) {
        out.log.warn(`Account "${name}" is ${account.provider} — it authenticates via OAuth, not an API key.`);
        return;
    }

    const trimmed = key?.trim();

    if (trimmed) {
        // Passing the key as argv puts it in shell history and in `ps` for the
        // lifetime of the command — kept for scripts, but say so.
        out.log.warn("A key passed on the command line lands in shell history and is visible to `ps`.");
        out.log.info(`Interactive, masked entry: ${cmd(["accounts", "set-key", name])}`);
        applyStoredKey(account, trimmed);
        await saveConfig(config);
        reportStoredKey(name, account.provider);
        return;
    }

    if (!isInteractive()) {
        out.log.warn(`No key given for "${name}" and this is not a terminal, so nothing was changed.`);
        out.log.info(`Pass the key as an argument, or opt in to the environment key: ${allowEnvHint(name)}`);
        return;
    }

    await chooseCredential({ config, account, name });
}

function applyStoredKey(account: AiProxyAccountConfig, key: string): void {
    account.apiKey = key;
    // A stored key wins over the environment anyway; clearing the opt-in keeps
    // the two fields from describing two different intentions.
    delete account.allowEnvApiKey;
}

function reportStoredKey(name: string, provider: AiProxyProviderType): void {
    out.log.success(`Stored API key for "${name}" (${provider}) in the ai-proxy config.`);
    out.log.warn("This is a billed credential and it now lives in plain text in the ai-proxy config file.");
    out.log.info(RESTART_HINT);
}

function allowEnvHint(name: string): string {
    return cmd(["accounts", "allow-env", name]);
}

const RESTART_HINT = "Restart the proxy to apply: tools ai-proxy down && tools ai-proxy up";

/** Print where the account stands today, then offer the four end states. */
async function chooseCredential(input: {
    config: Awaited<ReturnType<typeof loadConfig>>;
    account: AiProxyAccountConfig;
    name: string;
}): Promise<void> {
    const { account, name } = input;
    const status = apiKeyStatus(account);
    const sourceFile = await findEnvSourceFile(status.envName);
    const envDetail = `${status.envName} is ${status.envPresent ? "set" : "not set"} in this environment · ${
        sourceFile ? `exported from ${sourceFile}` : "source unknown"
    }`;

    out.log.info(
        [
            `Account "${name}" (${account.provider})`,
            status.state === "override"
                ? `  now: a key stored on the account (${status.maskedOverride}) — the environment is ignored`
                : status.state === "env"
                  ? `  now: spends the environment key ${status.envName}`
                  : "  now: no usable credential — routes to this account are refused",
            `  ${envDetail}`,
        ].join("\n")
    );

    const options = [
        {
            value: "env" as const,
            label: `Use the environment variable ${status.envName}`,
            hint: status.envPresent ? (sourceFile ?? "source unknown") : "not currently set",
        },
        { value: "override" as const, label: "Override with a specific key (entered masked)" },
        ...(status.state === "override"
            ? [
                  {
                      value: "remove-override" as const,
                      label: "Remove the stored key and fall back to the environment",
                  },
              ]
            : []),
        { value: "none" as const, label: "Use no key at all (account becomes unusable)" },
    ];

    const choice = await out.select({ message: `Credential for "${name}"`, options });

    if (out.isCancel(choice)) {
        out.log.warn("Cancelled — nothing changed.");
        return;
    }

    if (choice === "override") {
        const entered = await out.password({
            message: `API key for "${name}"`,
            validate: (value) => (value.trim().length > 0 ? undefined : "Enter a key, or cancel."),
        });

        if (out.isCancel(entered)) {
            out.log.warn("Cancelled — nothing changed.");
            return;
        }

        applyStoredKey(account, entered.trim());
        await saveConfig(input.config);
        reportStoredKey(name, account.provider);
        return;
    }

    if (choice === "none") {
        delete account.apiKey;
        delete account.allowEnvApiKey;
        await saveConfig(input.config);
        out.log.success(`"${name}" now has no credential at all.`);
        out.log.warn("The account will not load and every route to it is refused until you set one.");
        out.log.info(RESTART_HINT);
        return;
    }

    delete account.apiKey;
    account.allowEnvApiKey = true;
    await saveConfig(input.config);
    out.log.success(
        choice === "remove-override"
            ? `Removed the stored key for "${name}" — it now spends ${status.envName}.`
            : `"${name}" now spends the environment key ${status.envName}.`
    );

    if (!status.envPresent) {
        out.log.warn(`${status.envName} is not set right now, so the account will not load until it is.`);
    }

    out.log.warn("Every call on this account spends metered money on whatever key the environment holds.");
    out.log.info(RESTART_HINT);
}

export async function runAccountsAllowEnv(name: string, allow: boolean): Promise<void> {
    const config = await loadConfig();
    const account = config.accounts.find((item) => item.name === name);

    if (!account) {
        out.log.warn(`Account not found: ${name}`);
        out.log.info(cmd(["accounts", "list"]));
        return;
    }

    if (!API_KEY_PROVIDERS.has(account.provider)) {
        out.log.warn(`Account "${name}" is ${account.provider} — it authenticates via OAuth, not an API key.`);
        return;
    }

    const hadOverride = Boolean(account.apiKey);

    if (allow) {
        // A stored key would win anyway, so keeping both would leave the config
        // claiming an intention the proxy does not act on.
        delete account.apiKey;
        account.allowEnvApiKey = true;
    } else {
        delete account.allowEnvApiKey;
    }

    await saveConfig(config);

    if (allow) {
        out.log.success(`"${name}" may now resolve its billed API key from the environment.`);

        if (hadOverride) {
            out.log.warn("Removed the key that was stored on the account — the environment key is used instead.");
        }

        out.log.warn("Every call on this account spends metered money on whatever key the environment holds.");
    } else {
        out.log.success(`"${name}" will no longer pick up a billed API key from the environment.`);

        if (!account.apiKey) {
            out.log.warn("It now has no credential at all and will not load until you set one.");
        }
    }

    out.log.info(RESTART_HINT);
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
