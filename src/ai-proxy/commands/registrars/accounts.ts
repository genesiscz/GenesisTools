import {
    runAccountsAllowEnv,
    runAccountsFailover,
    runAccountsList,
    runAccountsRemove,
    runAccountsSetEnabled,
    runAccountsSetKey,
    runAccountsTest,
} from "@app/ai-proxy/commands/accounts";
import { runAccountsLogin } from "@app/ai-proxy/commands/accounts-login";
import { PROVIDER_ACCOUNT_COMMANDS } from "@app/ai-proxy/lib/providers/account-commands";
import { providerTypes } from "@app/ai-proxy/lib/providers/registry";
import type { Command } from "commander";

export function register(program: Command): void {
    const accountsCmd = program.command("accounts").description("Manage configured accounts");

    accountsCmd
        .command("login <provider>")
        .description("OAuth login for a provider (github-copilot, codex)")
        .action(async (provider: string) => {
            await runAccountsLogin(provider);
        });

    // The subcommands only one provider's accounts take (`status` and `bind` for Codex, `set-routing` for OpenRouter).
    for (const type of providerTypes()) {
        for (const command of PROVIDER_ACCOUNT_COMMANDS[type]) {
            command.register(accountsCmd);
        }
    }

    accountsCmd
        .command("list")
        .description("List configured accounts")
        .action(async () => {
            await runAccountsList();
        });

    accountsCmd
        .command("test <name>")
        .description("Ping upstream for an account")
        .action(async (name: string) => {
            await runAccountsTest(name);
        });

    accountsCmd
        .command("disable <name>")
        .description("Disable an account (kept in config, skipped at runtime)")
        .action(async (name: string) => {
            await runAccountsSetEnabled(name, false);
        });

    accountsCmd
        .command("enable <name>")
        .description("Re-enable a disabled account")
        .action(async (name: string) => {
            await runAccountsSetEnabled(name, true);
        });

    accountsCmd
        .command("failover <name> [state]")
        .description(
            "Show or set (on|off) whether a Codex account moves to its failover list by itself; off by default, so the error reaches the client"
        )
        .action(async (name: string, state?: string) => {
            await runAccountsFailover(name, state);
        });

    accountsCmd
        .command("set-key <name> [key]")
        .description("Choose an api-key account's credential (omit key for a masked interactive chooser)")
        .action(async (name: string, key?: string) => {
            await runAccountsSetKey(name, key);
        });

    accountsCmd
        .command("allow-env <name>")
        .description("Non-interactive form of set-key's env choice (clears any stored key; --off revokes)")
        .option("--off", "revoke the opt-in")
        .option("--env <NAME>", "Read the key from this env var instead of the provider's default name")
        .action(async (name: string, options: { off?: boolean; env?: string }) => {
            await runAccountsAllowEnv(name, !options.off, { envName: options.env });
        });

    accountsCmd
        .command("remove <name>")
        .description("Remove an account from config")
        .action(async (name: string) => {
            await runAccountsRemove(name);
        });
}
