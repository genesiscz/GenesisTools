import type { TaskName } from "@genesiscz/utils/ai/config/schema";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { HarnessId } from "@genesiscz/utils/harness/types";

/**
 * The GenesisTools commands the AI modules under `src/utils` name: account setup, defaults, the secret vault and the
 * logins of each provider. This file imports `toolCommand()` and nothing else at runtime, so a util that imports it
 * loads no logger, commander or process helper.
 *
 * Every parameter goes into the line as given. A caller that quoted a value with `shellWord()` before passes the
 * quoted value, so each message stays what it was.
 */

/** Opens the interactive `ask` account setup. */
export function askConfigCommand(): string {
    return toolCommand("ask config");
}

/** Opens the interactive AI config editor. */
export function aiConfigCommand(): string {
    return toolCommand("ai config");
}

/** Lists the configured AI accounts. */
export function aiConfigAccountListCommand(): string {
    return toolCommand("ai config account list");
}

/** Adds an AI account. The flags print in a fixed order: provider, name, tag, env fallback, key on stdin. */
export function aiConfigAccountAddCommand(options: {
    provider: string;
    name?: string;
    tag?: string;
    /** The env variable the account may fall back to (`--use-env`). */
    useEnv?: string;
    /** Reads the API key from stdin, for a line that pipes the key in. */
    apiKeyStdin?: boolean;
}): string {
    const parts = [toolCommand("ai config account add"), `--provider ${options.provider}`];

    if (options.name !== undefined) {
        parts.push(`--name ${options.name}`);
    }

    if (options.tag !== undefined) {
        parts.push(`--tag ${options.tag}`);
    }

    if (options.useEnv !== undefined) {
        parts.push(`--use-env ${options.useEnv}`);
    }

    if (options.apiKeyStdin) {
        parts.push("--api-key-stdin");
    }

    return parts.join(" ");
}

/** Lets an account fall back to the named env variables. */
export function aiConfigAccountEditUseEnvCommand(account: string, envKeys: readonly string[]): string {
    return `${toolCommand("ai config account edit")} ${account} --use-env ${envKeys.join(",")}`;
}

/** Stores an API key, piped in on stdin, in an existing account. */
export function aiConfigAccountEditApiKeyCommand(account: string): string {
    return `${toolCommand("ai config account edit")} ${account} --api-key-stdin`;
}

/** Points an account at its auth file or data folder. */
export function aiConfigAccountEditPathCommand(account: string, flag: "--auth-file" | "--data-dir"): string {
    return `${toolCommand("ai config account edit")} ${account} ${flag} <path>`;
}

/** Enables a disabled account. */
export function aiConfigAccountEnableCommand(accountId: string): string {
    return `${toolCommand("ai config account enable")} ${accountId}`;
}

/** Sets the default account or model of a task. */
export function aiConfigDefaultSetCommand(task: TaskName, target = "<@account/...>"): string {
    return `${toolCommand("ai config default set")} ${task} ${target}`;
}

/** Exports the secret vault to a file. */
export function aiConfigSecretExportCommand(): string {
    return `${toolCommand("ai config secret export")} --out <file>`;
}

/** Imports a vault export. */
export function aiConfigSecretImportCommand(): string {
    return toolCommand("ai config secret import");
}

/** Rotates the vault's master key. */
export function aiConfigSecretRotateCommand(): string {
    return toolCommand("ai config secret rotate");
}

/** Lists the subscription accounts and the credentials each one holds. */
export function aiAccountsListCommand(): string {
    return toolCommand("ai accounts list");
}

/** Logs a subscription account in again. */
export function aiAccountsLoginCommand(account: string, provider: string): string {
    return `${toolCommand("ai accounts login")} ${account} --provider ${provider}`;
}

/** Logs an ai-proxy provider account in. */
export function aiProxyAccountsLoginCommand(provider: string): string {
    return `${toolCommand("ai-proxy accounts login")} ${provider}`;
}

/** The statusline a harness runs through GenesisTools. */
export function aiStatuslineRunCommand(host: HarnessId): string {
    return `${toolCommand("ai statusline run")} --${host}`;
}

/** Logs a Claude subscription account in; without an account, the bare command. */
export function claudeLoginCommand(account?: string): string {
    return account === undefined ? toolCommand("claude login") : `${toolCommand("claude login")} ${account}`;
}

/** Attaches a long-lived token to a Claude subscription account. */
export function claudeLoginLongCommand(account: string): string {
    return `${toolCommand("claude login-long")} ${account}`;
}

/** Logs a Codex account in with a managed grant. */
export function codexLoginCommand(account = "<account>"): string {
    return `${toolCommand("codex login")} ${account}`;
}

/** Logs Codex in and binds the account to a Codex home. */
export function codexLoginHomeCommand(dir = "<dir>"): string {
    return `${toolCommand("codex login")} --home ${dir}`;
}

/** Logs a Grok account in. */
export function grokLoginCommand(account: string): string {
    return `${toolCommand("grok login")} ${account}`;
}

/** Stores a Jev evaluation credential; without a provider, the bare command. */
export function jevLoginCommand(provider?: string): string {
    return provider === undefined ? toolCommand("jev login") : `${toolCommand("jev login")} --provider ${provider}`;
}
