import { aiProxyCommand } from "@app/ai-proxy/lib/command-hints";
import { loadConfig, saveConfig } from "@app/ai-proxy/lib/config";
import type { ProviderAccountCommand } from "@app/ai-proxy/lib/providers/account-commands";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { CodexAccountBinding } from "@genesiscz/utils/ai/openai/account-binding";
import {
    CODEX_AUTH_PATH,
    extractExpiry,
    extractPlanType,
    readCodexAuthJson,
} from "@genesiscz/utils/ai/openai/codex-auth";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

/** One codex proxy account's auth, read without refreshing anything. */
export interface CodexAccountAuthStatus {
    /** The managed login it binds (`openaiSub.accountName`), or undefined for the legacy Codex CLI read. */
    login?: string;
    source: string;
    plan?: string;
    expiresAt?: number;
    error?: string;
}

/**
 * Where a codex proxy account's token comes from. A managed login goes through `CodexAccountBinding`, the one
 * Codex auth engine of ai-proxy, `tools codex run` and `tools codex spawn`, read-only: a status never refreshes,
 * because an OpenAI refresh token is single use. An account without `openaiSub.accountName` is the legacy read of
 * the Codex CLI's own `auth.json`, which GenesisTools never refreshes.
 */
export async function codexAccountAuthStatus(account: AiProxyAccountConfig): Promise<CodexAccountAuthStatus> {
    const login = account.openaiSub?.accountName;

    if (!login) {
        const path = account.openaiSub?.codexAuthPath ?? CODEX_AUTH_PATH;
        const tokens = await readCodexAuthJson(path);

        return {
            source: `legacy Codex CLI login (${path}, read-only)`,
            plan: tokens?.accessToken ? extractPlanType(tokens.accessToken) : undefined,
            expiresAt: tokens?.expiresAt,
            error: tokens?.accessToken ? undefined : "no token",
        };
    }

    try {
        const binding = await CodexAccountBinding.create(login, { allowRefresh: false });
        const tokens = await binding.tokens({ refresh: false });

        return {
            login,
            source: `managed login "${login}"`,
            plan: tokens.chatgptPlanType ?? extractPlanType(tokens.accessToken),
            expiresAt: extractExpiry(tokens.accessToken),
        };
    } catch (err) {
        return { login, source: `managed login "${login}"`, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Auth detail for codex (openai-subscription) accounts: where the token comes
 * from, when it expires, and the ChatGPT plan when the JWT carries it. A legacy
 * account gets the command that binds it to a managed login.
 */
export async function runAccountsStatus(): Promise<void> {
    const config = await loadConfig();
    const codexAccounts = config.accounts.filter((account) => account.provider === "openai-subscription");

    if (codexAccounts.length === 0) {
        out.log.info("No openai-subscription accounts configured.");
        out.log.info(aiProxyCommand(["accounts", "login", "codex"]));
        return;
    }

    for (const account of codexAccounts) {
        const status = await codexAccountAuthStatus(account);
        const failover = account.openaiSub?.failoverAccountNames;
        const expiry = status.expiresAt
            ? `${new Date(status.expiresAt).toLocaleString()}${status.expiresAt < Date.now() ? " (EXPIRED)" : ""}`
            : "unknown";

        out.log.info(`${account.name}${status.plan ? ` (${status.plan})` : ""}${account.enabled ? "" : " [disabled]"}`);
        out.log.info(`  auth:    ${status.source}${status.error ? ` — ${status.error}` : ""}`);
        out.log.info(`  expires: ${expiry}`);

        if (failover && failover.length > 0) {
            out.log.info(`  failover: ${failover.join(", ")}`);
        }

        if (!status.login) {
            await warnLegacyCodexAccount(account.name);
        }
    }
}

/** The legacy read has no refresh and no named owner; offer the managed logins it can bind to instead. */
async function warnLegacyCodexAccount(proxyAccount: string): Promise<void> {
    const store = await AiConfigStore.readOnly();
    const logins = store.accounts({ provider: "openai-sub", enabled: true }).map((entry) => entry.name);

    out.log.warn(
        `  legacy: "${proxyAccount}" reads the Codex CLI's own login (no openaiSub.accountName). GenesisTools never refreshes it, and it is not the shared Codex auth engine.`
    );

    if (logins.length > 0) {
        out.log.info(
            `  bind it to a managed login: ${aiProxyCommand(["accounts", "bind", proxyAccount, "--codex", logins[0]])}`
        );
        out.log.info(`  managed logins: ${logins.join(", ")}`);
        return;
    }

    out.log.info(`  import the Codex CLI's login: ${toolCommand("codex login")} --import-native`);
    out.log.info(`  or log in a new one: ${aiProxyCommand(["accounts", "login", "codex"])}`);
}

/**
 * Point a codex proxy account at a managed `openai-sub` login (`openaiSub.accountName`), so its token comes
 * from `CodexAccountBinding` instead of the legacy read of the Codex CLI's `auth.json`.
 */
export async function runAccountsBind(name: string, options: { codex?: string }): Promise<void> {
    const config = await loadConfig();
    const account = config.accounts.find((item) => item.name === name);

    if (!account) {
        out.log.warn(`Account not found: ${name}`);
        out.log.info(aiProxyCommand(["accounts", "list"]));
        process.exitCode = 1;
        return;
    }

    if (account.provider !== "openai-subscription") {
        out.log.warn(`Account "${name}" is ${account.provider}; bind takes an openai-subscription (codex) account.`);
        process.exitCode = 1;
        return;
    }

    const login = options.codex?.trim();
    const store = await AiConfigStore.readOnly();
    const logins = store.accounts({ provider: "openai-sub", enabled: true }).map((entry) => entry.name);

    if (!login || !logins.includes(login)) {
        out.log.warn(login ? `No enabled Codex login named "${login}".` : "--codex <login> is required.");
        out.log.info(`Managed logins: ${logins.join(", ") || "none"} (${toolCommand("codex login")} <name> adds one)`);
        process.exitCode = 1;
        return;
    }

    account.openaiSub = { ...account.openaiSub, accountName: login };
    delete account.openaiSub.codexAuthPath;
    await saveConfig(config);
    out.log.success(`"${name}" now uses the managed login "${login}".`);
    out.log.info(`Restart the proxy to apply: ${toolCommand("ai-proxy down")} && ${toolCommand("ai-proxy up")}`);
}

/** The `accounts` subcommands only Codex accounts take. */
export const CODEX_ACCOUNT_COMMANDS: readonly ProviderAccountCommand[] = [
    {
        register: (accounts: Command) => {
            accounts
                .command("status")
                .description("Auth detail for codex accounts (source, expiry, plan)")
                .action(async () => {
                    await runAccountsStatus();
                });
        },
    },
    {
        register: (accounts: Command) => {
            accounts
                .command("bind <name>")
                .description(
                    `Point a codex account at a managed login (${toolCommand("codex login")}), instead of the Codex CLI's auth.json`
                )
                .option(
                    "--codex <login>",
                    `The managed openai-sub login, e.g. one listed by \`${toolCommand("ai-proxy accounts status")}\``
                )
                .action(async (name: string, options: { codex?: string }) => {
                    await runAccountsBind(name, options);
                });
        },
    },
];
